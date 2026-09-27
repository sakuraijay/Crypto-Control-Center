/**
 * profitProtection — REDUCE_POSITION_70PCT 실제 실행 계획 (6H-2 §6).
 *
 *  - 현재 size의 정확히 70%를 정밀도/최소 주문 단위에 맞춰 보수적으로 내림
 *  - rounding 후에도 70% 초과 금지
 *  - 잔여 30%가 GMX 최소 포지션 미만이면 100% 종료
 *  - 결정적 idempotency key: risk:profit-protect:<ManilaDayKey>:<positionKey>
 *  - 동일 포지션 70% 축소 최대 1회 — 서버 재시작 후에도 중복 금지 (영속 기록)
 *  - timeout/5xx/decode/저장 실패 → UNRESOLVED, 자동 retry 금지
 */

import { manilaDayStartIso } from './manilaTime';

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const PROFIT_PROTECT_REDUCTION_FRACTION = 0.7;
/** size 정밀도 (USD) — 보수적 내림 단위 */
export const REDUCTION_SIZE_PRECISION_USD = 0.01;

/**
 * GMX 최소 포지션 명목가 기준 (USD, 보수적) — 축소 후 잔여가 이 값 미만이면
 * 부분 축소 대신 100% 종료로 전환한다 (§6).
 */
export const GMX_MIN_POSITION_NOTIONAL_USD = 2;

/** Manila 거래일 키 (YYYY-MM-DD) — idempotency key 구성요소 */
export function manilaDayKey(now: Date): string {
  return manilaDayStartIso(now).slice(0, 10);
}

export function buildProfitProtectKey(dayKey: string, positionKey: string): string {
  return `risk:profit-protect:${dayKey}:${positionKey}`;
}

export type ReductionPlan =
  | { ok: true; fullClose: false; reduceSizeUsd: number; remainingSizeUsd: number }
  | { ok: true; fullClose: true; reduceSizeUsd: number; remainingSizeUsd: 0 }
  | { ok: false; reason: string };

/**
 * 70% 축소 크기 계산 — 보수적 내림, 70% 초과 절대 금지.
 * 잔여가 GMX 최소 포지션 미만이면 100% 종료로 전환.
 */
export function computeReduction(args: {
  openSizeUsd: number;
  minPositionNotionalUsd: number;
  precisionUsd?: number;
}): ReductionPlan {
  const { openSizeUsd, minPositionNotionalUsd } = args;
  const precision = args.precisionUsd ?? REDUCTION_SIZE_PRECISION_USD;
  if (!fin(openSizeUsd) || openSizeUsd <= 0) return { ok: false, reason: 'open size 비정상 — 축소 불가' };
  if (!fin(minPositionNotionalUsd) || minPositionNotionalUsd < 0) return { ok: false, reason: '최소 포지션 기준 비정상' };
  if (!fin(precision) || precision <= 0) return { ok: false, reason: 'precision 비정상' };

  // 보수적 내림 — 부동소수점 오차로 70%를 넘지 않도록 EPS 차감 후 내림
  const raw = openSizeUsd * PROFIT_PROTECT_REDUCTION_FRACTION;
  let reduceSizeUsd = Math.floor((raw + 1e-9) / precision) * precision;
  if (reduceSizeUsd > raw + 1e-9) reduceSizeUsd -= precision;
  reduceSizeUsd = Math.max(0, Number(reduceSizeUsd.toFixed(8)));

  if (reduceSizeUsd > openSizeUsd * PROFIT_PROTECT_REDUCTION_FRACTION + 1e-9) {
    return { ok: false, reason: 'rounding 후 70% 초과 — 거부' };
  }

  const remaining = Number((openSizeUsd - reduceSizeUsd).toFixed(8));
  if (remaining < minPositionNotionalUsd) {
    // 잔여가 최소 미만 → 100% 종료
    return { ok: true, fullClose: true, reduceSizeUsd: openSizeUsd, remainingSizeUsd: 0 };
  }
  return { ok: true, fullClose: false, reduceSizeUsd, remainingSizeUsd: remaining };
}

// ── 실행 기록 (1회 제한 · 재시작 내구성) ──────────────────────────────────────

export type ProfitProtectStatus = 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'UNRESOLVED';

export interface ProfitProtectRecord {
  idempotencyKey: string;
  positionKey: string;
  dayKey: string;
  /** PAPER durable recovery plan. Optional only for records written before the
   * atomic REDUCE70 reservation format was introduced. */
  originalSizeUsd?: number;
  reduceSizeUsd: number;
  remainingSizeUsd?: number;
  fullClose: boolean;
  status: ProfitProtectStatus;
  orderKey: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 동일 포지션 재축소 가능 여부 — 기록이 있으면 어떤 상태든 재실행 금지 (§6) */
export function canExecuteReduction(existing: ProfitProtectRecord | undefined | null):
  { ok: true } | { ok: false; reason: string; blocksNewEntries: boolean } {
  if (!existing) return { ok: true };
  const blocks = existing.status === 'CANCELLED' || existing.status === 'FAILED' || existing.status === 'UNRESOLVED';
  return {
    ok: false,
    reason: `70% 축소 기록 존재 (${existing.idempotencyKey}, status=${existing.status}) — 동일 포지션 재축소 금지`,
    blocksNewEntries: blocks, // CANCELLED/FAILED/UNRESOLVED → 신규 진입도 차단 (§6)
  };
}

/** 축소 결과 확인 전 후속 주문 가능 여부 (§6 — 남은 size 추정 후속 주문 금지) */
export function canPlaceFollowUpOrders(rec: ProfitProtectRecord | undefined | null): boolean {
  if (!rec) return true;
  return rec.status === 'CONFIRMED';
}
