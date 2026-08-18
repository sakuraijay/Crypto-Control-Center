/**
 * protectionOrders — 6H-2B §3 durable 보호 주문 상태 머신 + DB 계층.
 *
 * 규칙:
 *  - 모든 전이는 조건부 UPDATE(현재 status 일치)로만 수행 — 경합 시 전이 실패.
 *  - terminal(EXECUTED/CANCELLED) 역행 금지. UNRESOLVED/FROZEN에서의 해소는
 *    온체인/GMX 공식 증거로만 (자동 재제출 금지).
 *  - position/purpose당 활성 1개는 DB 부분 unique index가 강제 —
 *    insert 충돌 = 이미 활성 보호 주문 존재 → 새 제출 금지.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, protectionOrdersTable, type ProtectionOrderRow } from '@workspace/db';

export type ProtectionPurpose = 'INITIAL_STOP' | 'PROFIT_FLOOR_STOP' | 'EMERGENCY_CLOSE';

export type ProtectionStatus =
  | 'PLANNED' | 'PREPARED' | 'SUBMITTING' | 'SUBMITTED'
  | 'ACTIVE' | 'EXECUTED' | 'CANCELLED' | 'UNRESOLVED' | 'FROZEN';

export const PROTECTION_TERMINAL: readonly ProtectionStatus[] = ['EXECUTED', 'CANCELLED'];
export const PROTECTION_ACTIVE_SET: readonly ProtectionStatus[] =
  ['PLANNED', 'PREPARED', 'SUBMITTING', 'SUBMITTED', 'ACTIVE', 'UNRESOLVED', 'FROZEN'];
/** 신규 OPEN을 차단하는 상태 (해소 전 진입 금지) */
export const PROTECTION_BLOCKING_SET: readonly ProtectionStatus[] =
  ['PLANNED', 'PREPARED', 'SUBMITTING', 'SUBMITTED', 'UNRESOLVED', 'FROZEN'];

/** 허용 전이 — 여기 없는 전이는 전부 거부 (역행·건너뛰기 금지) */
export const ALLOWED_TRANSITIONS: Record<ProtectionStatus, readonly ProtectionStatus[]> = {
  PLANNED:    ['PREPARED', 'UNRESOLVED', 'CANCELLED'],
  PREPARED:   ['SUBMITTING', 'UNRESOLVED', 'CANCELLED'],
  SUBMITTING: ['SUBMITTED', 'UNRESOLVED'],
  SUBMITTED:  ['ACTIVE', 'UNRESOLVED', 'FROZEN', 'CANCELLED', 'EXECUTED'],
  ACTIVE:     ['EXECUTED', 'CANCELLED', 'FROZEN', 'UNRESOLVED'],
  UNRESOLVED: ['ACTIVE', 'EXECUTED', 'CANCELLED', 'FROZEN'],
  FROZEN:     ['EXECUTED', 'CANCELLED'],
  EXECUTED:   [],
  CANCELLED:  [],
};

export function isTransitionAllowed(from: ProtectionStatus, to: ProtectionStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** 결정적 protectionId — 재시작/중복 호출에도 동일 (idempotency key) */
export function buildProtectionId(parentOpenIntentId: string, purpose: ProtectionPurpose): string {
  return `prot:${parentOpenIntentId}:${purpose}`;
}

export interface PlanProtectionInput {
  parentOpenIntentId: string;
  positionKey: string;
  purpose: ProtectionPurpose;
  symbol: string;
  marketAddress: string;
  isLong: boolean;
  sizeDeltaUsd: number;
  triggerPriceUsd: number | null;
  acceptablePriceUsd: number | null;
  dayKey: string;
}

export type PlanProtectionResult =
  | { ok: true; protectionId: string; created: boolean }
  | { ok: false; reason: string };

/**
 * PLANNED 행 생성 (제출 전 durable 커밋). 동일 id 재호출 = created:false (기존 유지).
 * 같은 position/purpose에 다른 활성 행이 있으면 unique index 충돌 → 거부.
 */
export async function planProtection(input: PlanProtectionInput): Promise<PlanProtectionResult> {
  const id = buildProtectionId(input.parentOpenIntentId, input.purpose);
  try {
    const existing = await db.select().from(protectionOrdersTable).where(eq(protectionOrdersTable.id, id));
    if (existing.length > 0) return { ok: true, protectionId: id, created: false };
    await db.insert(protectionOrdersTable).values({
      id,
      parentOpenIntentId: input.parentOpenIntentId,
      positionKey: input.positionKey,
      purpose: input.purpose,
      symbol: input.symbol,
      marketAddress: input.marketAddress,
      isLong: input.isLong,
      sizeDeltaUsd: input.sizeDeltaUsd.toFixed(4),
      triggerPriceUsd: input.triggerPriceUsd === null ? null : input.triggerPriceUsd.toFixed(8),
      acceptablePriceUsd: input.acceptablePriceUsd === null ? null : input.acceptablePriceUsd.toFixed(8),
      dayKey: input.dayKey,
      status: 'PLANNED',
    });
    return { ok: true, protectionId: id, created: true };
  } catch (e: unknown) {
    // unique index 충돌 = 동일 position/purpose 활성 보호 주문 존재 (fail-closed)
    return { ok: false, reason: `보호 주문 durable 저장 실패/중복 활성 — 제출 금지 (${(e as Error)?.name ?? 'error'})` };
  }
}

export interface TransitionPatch {
  requestId?: string | null;
  orderKey?: string | null;
  typedDataDigest?: string | null;
  evidence?: string | null;
  error?: string | null;
  incrementSubmitAttempts?: boolean;
  // ── 6H-2C §3·§4 — durable 증거 필드 ──
  decimalsUsed?: number | null;
  decimalsSource?: string | null;
  decimalsTokenAddress?: string | null;
  decimalsVerifiedAt?: Date | null;
  emitterAddress?: string | null;
  createdTxHash?: string | null;
  executedTxHash?: string | null;
  cancelledTxHash?: string | null;
  frozenTxHash?: string | null;
  evidenceBlockNumber?: string | null;
  actionBudgetSnapshot?: string | null;
}

export type TransitionResult = { ok: true } | { ok: false; reason: string };

/** 조건부 UPDATE 전이 — from 상태가 일치할 때만 적용. 0행 = 전이 실패. */
export async function transitionProtection(
  id: string,
  from: ProtectionStatus,
  to: ProtectionStatus,
  patch: TransitionPatch = {},
): Promise<TransitionResult> {
  if (!isTransitionAllowed(from, to)) {
    return { ok: false, reason: `허용되지 않은 전이 ${from}→${to} — 거부 (terminal 역행/건너뛰기 금지)` };
  }
  try {
    const set: Record<string, unknown> = { status: to, updatedAt: new Date() };
    if (patch.requestId !== undefined) set.requestId = patch.requestId;
    if (patch.orderKey !== undefined) set.orderKey = patch.orderKey;
    if (patch.typedDataDigest !== undefined) set.typedDataDigest = patch.typedDataDigest;
    if (patch.evidence !== undefined) set.evidence = patch.evidence;
    if (patch.error !== undefined) set.error = patch.error;
    if (patch.incrementSubmitAttempts) {
      set.submitAttempts = sql`${protectionOrdersTable.submitAttempts} + 1`;
    }
    if (patch.decimalsUsed !== undefined) set.decimalsUsed = patch.decimalsUsed;
    if (patch.decimalsSource !== undefined) set.decimalsSource = patch.decimalsSource;
    if (patch.decimalsTokenAddress !== undefined) set.decimalsTokenAddress = patch.decimalsTokenAddress;
    if (patch.decimalsVerifiedAt !== undefined) set.decimalsVerifiedAt = patch.decimalsVerifiedAt;
    if (patch.emitterAddress !== undefined) set.emitterAddress = patch.emitterAddress;
    if (patch.createdTxHash !== undefined) set.createdTxHash = patch.createdTxHash;
    if (patch.executedTxHash !== undefined) set.executedTxHash = patch.executedTxHash;
    if (patch.cancelledTxHash !== undefined) set.cancelledTxHash = patch.cancelledTxHash;
    if (patch.frozenTxHash !== undefined) set.frozenTxHash = patch.frozenTxHash;
    if (patch.evidenceBlockNumber !== undefined) set.evidenceBlockNumber = patch.evidenceBlockNumber;
    if (patch.actionBudgetSnapshot !== undefined) set.actionBudgetSnapshot = patch.actionBudgetSnapshot;
    const rows = await db.update(protectionOrdersTable)
      .set(set as never)
      .where(and(eq(protectionOrdersTable.id, id), eq(protectionOrdersTable.status, from)))
      .returning({ id: protectionOrdersTable.id });
    if (rows.length === 0) return { ok: false, reason: `전이 실패: ${id}가 ${from} 상태가 아님 (경합/중복 방지)` };
    return { ok: true };
  } catch {
    return { ok: false, reason: '보호 주문 전이 DB 오류 — fail-closed' };
  }
}

/** ACTIVE 전이 전용 — orderKey 필수 (온체인/공식 증거 없이 ACTIVE 금지) */
export async function markProtectionActive(
  id: string,
  from: ProtectionStatus,
  orderKey: string,
  evidence: string,
): Promise<TransitionResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(orderKey)) {
    return { ok: false, reason: 'orderKey 형식 오류 — ACTIVE 전이 금지 (증거 필수)' };
  }
  return transitionProtection(id, from, 'ACTIVE', { orderKey, evidence });
}

/** §3 — 상태 전이 없이 decimals/budget/의미결속 증거만 durable 기록 (제출 직전·재판정 시 호출) */
export async function recordProtectionEvidenceFields(id: string, patch: {
  decimalsUsed?: number; decimalsSource?: string; decimalsTokenAddress?: string;
  decimalsVerifiedAt?: Date; actionBudgetSnapshot?: string; emitterAddress?: string;
  // ── 6H-2D §2·§3·§4 ──
  autoCancelEncoded?: boolean; semanticBindingOk?: boolean; semanticMismatches?: string;
  receiptStatus?: string; receiptBlockNumber?: string; ambiguousReason?: string;
}): Promise<boolean> {
  try {
    const rows = await db.update(protectionOrdersTable)
      .set({ ...patch, updatedAt: new Date() } as never)
      .where(eq(protectionOrdersTable.id, id))
      .returning({ id: protectionOrdersTable.id });
    return rows.length > 0;
  } catch { return false; }
}

export async function getProtection(id: string): Promise<ProtectionOrderRow | null> {
  try {
    const rows = await db.select().from(protectionOrdersTable).where(eq(protectionOrdersTable.id, id));
    return rows[0] ?? null;
  } catch { return null; }
}

export type ProtectionListResult = { ok: true; rows: ProtectionOrderRow[] } | { ok: false };

/** 활성(non-terminal) 보호 주문 전체 — 조회 실패 = ok:false (fail-closed 판단은 호출측) */
export async function listActiveProtections(): Promise<ProtectionListResult> {
  try {
    const rows = await db.select().from(protectionOrdersTable)
      .where(inArray(protectionOrdersTable.status, [...PROTECTION_ACTIVE_SET]));
    return { ok: true, rows };
  } catch { return { ok: false }; }
}

/** 신규 OPEN 차단 상태의 보호 주문 (PLANNED~SUBMITTED, UNRESOLVED, FROZEN) */
export async function listBlockingProtections(): Promise<ProtectionListResult> {
  try {
    const rows = await db.select().from(protectionOrdersTable)
      .where(inArray(protectionOrdersTable.status, [...PROTECTION_BLOCKING_SET]));
    return { ok: true, rows };
  } catch { return { ok: false }; }
}

// ── §9 판정 (순수 함수 — reconciliation 규칙) ────────────────────────────────

export interface ProtectionJudgmentInput {
  currentStatus: ProtectionStatus;
  /** GMX API status 문자열 (참고용 — 단독으로 terminal 전이 금지) */
  apiStatus: string | null;
  /** 온체인 OrderCreated 관측 orderKey (허용 emitter EventLog2 기반) */
  onchainOrderKey: string | null;
  onchainExecuted: boolean;
  onchainCancelled: boolean;
  onchainFrozen: boolean;
  /** authoritative 포지션 존재 여부 (null = 조회 실패) */
  positionExists: boolean | null;
}

export interface ProtectionJudgment {
  nextStatus: ProtectionStatus | null; // null = 전이 없음 (유지)
  emergencyCloseRequired: boolean;
  blockNewOpens: boolean;
  reason: string;
}

/**
 * §9 — 증거 교차검증 판정:
 *  - status 문자열만으로 terminal 전이 금지 — 온체인 증거 필수.
 *  - FROZEN 관측 = FROZEN + 신규 진입 차단.
 *  - 포지션이 존재하는데 ACTIVE stop 증거가 없으면 emergency close 요구.
 */
export function judgeProtection(input: ProtectionJudgmentInput): ProtectionJudgment {
  const cur = input.currentStatus;
  if (PROTECTION_TERMINAL.includes(cur)) {
    return { nextStatus: null, emergencyCloseRequired: false, blockNewOpens: false, reason: 'terminal — 유지' };
  }
  if (input.onchainFrozen) {
    return { nextStatus: cur === 'FROZEN' ? null : 'FROZEN', emergencyCloseRequired: true, blockNewOpens: true, reason: 'OrderFrozen 온체인 관측 — 체결 불확실, 차단 + 비상 종료 요구' };
  }
  if (input.onchainExecuted) {
    return { nextStatus: 'EXECUTED', emergencyCloseRequired: false, blockNewOpens: false, reason: 'OrderExecuted 온체인 확인' };
  }
  if (input.onchainCancelled) {
    const posOpen = input.positionExists === true;
    return {
      nextStatus: 'CANCELLED',
      emergencyCloseRequired: posOpen,
      blockNewOpens: posOpen,
      reason: posOpen ? 'stop 취소 확인 + 포지션 잔존 — 무방비, 비상 종료 요구' : 'stop 취소 확인 (포지션 없음)',
    };
  }
  // 온체인 orderKey 확인 = ACTIVE 승격 (SUBMITTED/UNRESOLVED에서만)
  if (input.onchainOrderKey && (cur === 'SUBMITTED' || cur === 'UNRESOLVED')) {
    return { nextStatus: 'ACTIVE', emergencyCloseRequired: false, blockNewOpens: false, reason: 'OrderCreated 온체인 확인 — ACTIVE' };
  }
  // API가 terminal 문자열을 주장해도 온체인 증거 없으면 전이하지 않는다 (§9)
  if (input.apiStatus && ['executed', 'cancelled'].includes(input.apiStatus)) {
    return { nextStatus: null, emergencyCloseRequired: false, blockNewOpens: true, reason: `API status='${input.apiStatus}'이나 온체인 증거 없음 — 전이 보류, 신규 OPEN 차단` };
  }
  if (input.positionExists === null) {
    return { nextStatus: null, emergencyCloseRequired: false, blockNewOpens: true, reason: '포지션 조회 실패 — 판정 불가, 신규 OPEN 차단 (fail-closed)' };
  }
  if (input.positionExists && cur !== 'ACTIVE') {
    return { nextStatus: null, emergencyCloseRequired: cur === 'UNRESOLVED' || cur === 'SUBMITTING', blockNewOpens: true, reason: `포지션 존재 + stop ${cur} (미확보) — 신규 OPEN 차단${cur === 'UNRESOLVED' || cur === 'SUBMITTING' ? ' + 비상 종료 요구' : ''}` };
  }
  return { nextStatus: null, emergencyCloseRequired: false, blockNewOpens: PROTECTION_BLOCKING_SET.includes(cur), reason: '증거 없음 — 유지' };
}
