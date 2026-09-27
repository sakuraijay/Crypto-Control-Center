/**
 * closeAllOrchestrator — CLOSE_ALL_POSITIONS 안전 종료 orchestration (6H-2 §9, §10).
 *
 *  - 실제 포지션 전수 기준 포지션별 결정적 close intent
 *  - reduce-only 의미 서버 검증: size 초과 금지·방향 반전 금지·반대 포지션 생성 금지
 *  - submit 단일 1회, 실패 시 재주문 금지 → UNRESOLVED 후 운영자 확인
 *  - 전부 terminal 확인 전 lock 유지, 부분 종료도 신규 진입 금지
 *  - 미해결 close가 있으면 날짜 rollover에 의한 잠금 해제 금지
 */

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface OpenPositionSummary {
  positionKey: string;
  marketAddress: string;
  isLong: boolean;
  sizeUsd: number;
}

export interface CloseIntentPlan {
  intentId: string;           // 결정적 — risk:close-all:<dayKey>:<positionKey>
  positionKey: string;
  marketAddress: string;
  isLong: boolean;            // 종료 대상 포지션의 방향 (MarketDecrease 대상)
  closeSizeUsd: number;       // = open size (초과 금지)
  reduceOnly: true;
}

export function buildCloseAllPlan(args: {
  dayKey: string;
  positions: OpenPositionSummary[];
}): { ok: true; intents: CloseIntentPlan[] } | { ok: false; reason: string } {
  const intents: CloseIntentPlan[] = [];
  for (const p of args.positions) {
    if (!fin(p.sizeUsd) || p.sizeUsd <= 0) {
      return { ok: false, reason: `포지션 ${p.positionKey} size 비정상 — close-all 계획 불가 (fail-closed)` };
    }
    intents.push({
      intentId: `risk:close-all:${args.dayKey}:${p.positionKey}`,
      positionKey: p.positionKey,
      marketAddress: p.marketAddress,
      isLong: p.isLong,
      closeSizeUsd: p.sizeUsd,
      reduceOnly: true,
    });
  }
  return { ok: true, intents };
}

/** reduce-only 의미 검증 (§9) — close는 위험을 늘리거나 방향을 바꿀 수 없다 */
export function validateCloseOrder(args: {
  closeSizeUsd: number;
  openSizeUsd: number;
  closeTargetIsLong: boolean;
  openIsLong: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (!fin(args.closeSizeUsd) || args.closeSizeUsd <= 0) return { ok: false, reason: 'close size 비정상 — 거부' };
  if (!fin(args.openSizeUsd) || args.openSizeUsd <= 0) return { ok: false, reason: 'open size 불명 — close 검증 불가 (fail-closed)' };
  if (args.closeTargetIsLong !== args.openIsLong) {
    return { ok: false, reason: 'close 방향이 열린 포지션과 불일치 — 반대 포지션 생성 위험, 거부' };
  }
  if (args.closeSizeUsd > args.openSizeUsd * (1 + 1e-9)) {
    return { ok: false, reason: `close size($${args.closeSizeUsd.toFixed(2)}) > open size($${args.openSizeUsd.toFixed(2)}) — 반대 포지션 생성 금지, 거부` };
  }
  return { ok: true };
}

// ── 진행 상태 요약 ────────────────────────────────────────────────────────────

export type CloseIntentStatus = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'UNRESOLVED';

export interface CloseAllProgress {
  intentId: string;
  positionKey: string;
  status: CloseIntentStatus;
}

export interface CloseAllSummary {
  total: number;
  confirmed: number;
  terminalFailed: number;   // FAILED/CANCELLED
  unresolved: number;
  pending: number;
  allTerminal: boolean;     // 전부 CONFIRMED/FAILED/CANCELLED
  allConfirmed: boolean;
  /** 전부 terminal 확인 전 또는 일부 실패 → 신규 진입 잠금 유지 */
  lockRequired: boolean;
  /** 미해결(UNRESOLVED/PENDING/SUBMITTED) close 존재 시 날짜 rollover 잠금 해제 금지 */
  rolloverAllowed: boolean;
}

export function summarizeCloseAll(progress: CloseAllProgress[]): CloseAllSummary {
  const total = progress.length;
  const confirmed = progress.filter(p => p.status === 'CONFIRMED').length;
  const terminalFailed = progress.filter(p => p.status === 'FAILED' || p.status === 'CANCELLED').length;
  const unresolved = progress.filter(p => p.status === 'UNRESOLVED').length;
  const pending = progress.filter(p => p.status === 'PENDING' || p.status === 'SUBMITTED').length;
  const allTerminal = total > 0 && confirmed + terminalFailed === total;
  const allConfirmed = total > 0 && confirmed === total;
  return {
    total, confirmed, terminalFailed, unresolved, pending,
    allTerminal, allConfirmed,
    // 부분 실패·미해결·진행 중 → 잠금 유지; 전부 확정 종료여야 해제 가능
    lockRequired: total > 0 && !allConfirmed,
    rolloverAllowed: unresolved === 0 && pending === 0,
  };
}
