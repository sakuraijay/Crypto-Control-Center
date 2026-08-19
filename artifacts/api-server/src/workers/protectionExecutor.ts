/**
 * protectionExecutor — 6H-2B §5·§6·§8 보호 주문 오케스트레이션.
 *
 * 순서 계약 (§5):
 *   OPEN 온체인 확정 → authoritative position readback → INITIAL_STOP durable
 *   record(PLANNED) → prepare → binding → 서명 → 단일 peer 1회 submit →
 *   reconciliation → orderKey 영속 → ACTIVE.
 *  - OPEN submit 수락만으로 stop 흐름 시작 금지 (확정 증거 필수 입력).
 *  - ACTIVE는 온체인/GMX 공식 증거(orderKey) 이후에만.
 *  - 자동 재제출 금지: 동일 protectionId의 submitAttempts ≥ 1이면 재제출 거부.
 *
 * 실제 제출 함수는 주입식(submitFn) — 운영 wiring은 liveTestExecutor가 담당하고
 * 테스트는 mock을 주입한다. LIVE 잠금 환경에서는 submitFn 도달 전에 activation
 * gate가 차단하므로 네트워크 호출 0회가 유지된다.
 */
import {
  buildProtectionId, planProtection, transitionProtection, markProtectionActive,
  getProtection, listBlockingProtections, judgeProtection, recordProtectionEvidenceFields,
  type ProtectionPurpose, type ProtectionStatus,
} from '../lib/protectionOrders';
import { manilaDayKey } from '../lib/profitProtection';

// ── 주입식 제출 함수 ──────────────────────────────────────────────────────────

export interface ProtectionSubmitRequest {
  parentOpenIntentId: string;
  /** OPEN confirmation에서 읽은 exact GMX position key. */
  positionKey: string;
  /** 서버가 확인한 Manual Canary OPEN lineage에서만 true. */
  manualCanary: boolean;
  purpose: ProtectionPurpose;
  symbol: string;
  marketAddress: string;
  isLong: boolean;
  sizeDeltaUsd: number;
  /** STOP류만 — USD trigger (EMERGENCY_CLOSE는 null = MarketDecrease) */
  triggerPriceUsd: number | null;
  acceptablePriceUsd: number | null;
  protectionId: string;
}

export type ProtectionSubmitOutcome =
  | { status: 'ACCEPTED'; requestId: string | null; typedDataDigest: string | null }
  | { status: 'UNRESOLVED'; reason: string }
  | { status: 'FAILED_PRE_BROADCAST'; reason: string };

export type ProtectionSubmitFn = (req: ProtectionSubmitRequest) => Promise<ProtectionSubmitOutcome>;

let _submitFn: ProtectionSubmitFn | null = null;
export function setProtectionSubmitFn(fn: ProtectionSubmitFn | null): void { _submitFn = fn; }

// ── §5 — OPEN 확정 후 INITIAL_STOP 생성 ──────────────────────────────────────

export interface ConfirmedOpenEvidence {
  parentOpenIntentId: string;
  /** 온체인 확정 증거 (OrderExecuted tx 또는 authoritative readback) 요약 */
  evidence: string;
  positionKey: string;
  symbol: string;
  marketAddress: string;
  isLong: boolean;
  /** authoritative readback으로 확인된 실제 포지션 크기 (USD) */
  confirmedSizeUsd: number;
  /** parentOpenIntentId가 Manual Canary 결정적 ID인 경우에만 설정한다. */
  manualCanary?: true;
}

export interface InitialStopPlanInput {
  open: ConfirmedOpenEvidence;
  triggerPriceUsd: number;
  acceptablePriceUsd: number;
  now?: Date;
}

export type StopCreationResult =
  | { ok: true; protectionId: string; finalStatus: ProtectionStatus }
  | {
      ok: false;
      protectionId: string | null;
      reason: string;
      emergencyCloseRequired: boolean;
      currentStatus?: ProtectionStatus;
    };

function existingStopNeedsEmergency(status: string): boolean {
  // PREPARED/SUBMITTING은 다른 동시 pass가 CAS claim을 획득한 in-flight 상태다.
  // startup reconciliation이 crash 잔존 상태를 UNRESOLVED로 바꾸기 전에는
  // loser pass가 emergency close를 발동하면 안 된다.
  return !['PREPARED', 'SUBMITTING', 'SUBMITTED', 'ACTIVE'].includes(status);
}

async function lostStopTransitionResult(
  protectionId: string,
  fallbackReason: string,
): Promise<StopCreationResult> {
  const current = await getProtection(protectionId);
  if (!current) {
    return {
      ok: false,
      protectionId,
      reason: `${fallbackReason}; 현재 상태 재조회 실패`,
      emergencyCloseRequired: true,
    };
  }
  return {
    ok: false,
    protectionId,
    reason: `${fallbackReason}; 현재 상태 ${current.status}/attempts=${current.submitAttempts}`,
    emergencyCloseRequired: existingStopNeedsEmergency(current.status),
    currentStatus: current.status as ProtectionStatus,
  };
}

/**
 * INITIAL_STOP 전체 수명주기 1회 실행. 실패 지점별 처리:
 *  - durable 저장 실패 → 제출 0회, emergency close 요구 (포지션 무방비)
 *  - 제출 UNRESOLVED → 상태 UNRESOLVED, 재제출 금지, emergency close 요구
 *  - 제출 확정 실패 → CANCELLED(pre-broadcast), emergency close 요구
 *  - 수락 → SUBMITTED (ACTIVE 승격은 reconciliation이 온체인 증거로 수행)
 */
export async function createInitialStopAfterOpenConfirmed(
  input: InitialStopPlanInput,
): Promise<StopCreationResult> {
  const o = input.open;
  if (!Number.isFinite(o.confirmedSizeUsd) || o.confirmedSizeUsd <= 0) {
    return { ok: false, protectionId: null, reason: 'authoritative 포지션 크기 비정상 — stop 생성 불가', emergencyCloseRequired: true };
  }
  if (!Number.isFinite(input.triggerPriceUsd) || input.triggerPriceUsd <= 0) {
    return { ok: false, protectionId: null, reason: 'stop trigger 비정상 — stop 생성 불가', emergencyCloseRequired: true };
  }
  const planned = await planProtection({
    parentOpenIntentId: o.parentOpenIntentId,
    positionKey: o.positionKey,
    purpose: 'INITIAL_STOP',
    symbol: o.symbol,
    marketAddress: o.marketAddress,
    isLong: o.isLong,
    sizeDeltaUsd: o.confirmedSizeUsd,
    triggerPriceUsd: input.triggerPriceUsd,
    acceptablePriceUsd: input.acceptablePriceUsd,
    dayKey: manilaDayKey(input.now ?? new Date()),
  });
  if (!planned.ok) {
    return { ok: false, protectionId: null, reason: planned.reason, emergencyCloseRequired: true };
  }
  const id = planned.protectionId;

  // 자동 재제출 금지 — 기존 레코드가 PLANNED가 아니면 이 흐름은 재개하지 않는다.
  const row = await getProtection(id);
  if (!row) return { ok: false, protectionId: id, reason: '보호 주문 재조회 실패 — 제출 0회 (fail-closed)', emergencyCloseRequired: true };
  if (row.status !== 'PLANNED' || row.submitAttempts > 0) {
    return {
      ok: false,
      protectionId: id,
      reason: `기존 보호 주문 상태 ${row.status}/attempts=${row.submitAttempts} — 자동 재제출 금지`,
      emergencyCloseRequired: existingStopNeedsEmergency(row.status),
      currentStatus: row.status as ProtectionStatus,
    };
  }
  if (!_submitFn) {
    return { ok: false, protectionId: id, reason: 'stop 제출 함수 미구성 — 제출 0회', emergencyCloseRequired: true };
  }

  // PREPARED → SUBMITTING 커밋 후에만 제출 (재시작 시 UNRESOLVED 취급 지점)
  const t1 = await transitionProtection(id, 'PLANNED', 'PREPARED');
  if (!t1.ok) return lostStopTransitionResult(id, t1.reason);
  const t2 = await transitionProtection(id, 'PREPARED', 'SUBMITTING', { incrementSubmitAttempts: true });
  if (!t2.ok) return lostStopTransitionResult(id, t2.reason);

  let outcome: ProtectionSubmitOutcome;
  try {
    outcome = await _submitFn({
      parentOpenIntentId: o.parentOpenIntentId,
      positionKey: o.positionKey,
      manualCanary: o.manualCanary === true,
      purpose: 'INITIAL_STOP', symbol: o.symbol, marketAddress: o.marketAddress,
      isLong: o.isLong, sizeDeltaUsd: o.confirmedSizeUsd,
      triggerPriceUsd: input.triggerPriceUsd, acceptablePriceUsd: input.acceptablePriceUsd,
      protectionId: id,
    });
  } catch {
    outcome = { status: 'UNRESOLVED', reason: 'stop 제출 예외 — 결과 불명' };
  }

  if (outcome.status === 'ACCEPTED') {
    const t3 = await transitionProtection(id, 'SUBMITTING', 'SUBMITTED', {
      requestId: outcome.requestId, typedDataDigest: outcome.typedDataDigest,
      evidence: o.evidence,
    });
    if (!t3.ok) {
      // 수락됐는데 영속 실패 — UNRESOLVED로 강등 시도, 신규 진입 차단 유지
      await transitionProtection(id, 'SUBMITTING', 'UNRESOLVED', { error: 'SUBMITTED 영속 실패' });
      return { ok: false, protectionId: id, reason: 'stop 수락됐으나 orderKey/requestId 영속 실패 — UNRESOLVED', emergencyCloseRequired: true };
    }
    return { ok: true, protectionId: id, finalStatus: 'SUBMITTED' };
  }
  if (outcome.status === 'UNRESOLVED') {
    await transitionProtection(id, 'SUBMITTING', 'UNRESOLVED', { error: outcome.reason });
    return { ok: false, protectionId: id, reason: outcome.reason, emergencyCloseRequired: true };
  }
  // FAILED_PRE_BROADCAST — SUBMITTING에서는 CANCELLED 직행이 없으므로 UNRESOLVED 대신
  // pre-broadcast 확정 근거가 있는 경우에만 SUBMITTED 건너뛰고 종결 불가 → UNRESOLVED가
  // 아닌 별도 규칙: SUBMITTING→UNRESOLVED 후 reconciliation이 증거로 CANCELLED 처리한다.
  await transitionProtection(id, 'SUBMITTING', 'UNRESOLVED', { error: `pre-broadcast 실패: ${outcome.reason}` });
  return { ok: false, protectionId: id, reason: outcome.reason, emergencyCloseRequired: true };
}

/**
 * OPEN은 확정됐지만 stop 제출 선행조건이 하나라도 사라진 경우의 durable 차단 기록.
 * 네트워크 제출은 호출하지 않고 INITIAL_STOP을 UNRESOLVED로 고정해 자동 재시도를
 * 금지한다. 호출자는 이어서 deterministic EMERGENCY_CLOSE를 최대 1회 시도한다.
 */
export async function recordInitialStopHandoffFailure(
  input: InitialStopPlanInput,
  reason: string,
): Promise<StopCreationResult> {
  const o = input.open;
  if (!Number.isFinite(o.confirmedSizeUsd) || o.confirmedSizeUsd <= 0
      || !Number.isFinite(input.triggerPriceUsd) || input.triggerPriceUsd <= 0
      || !Number.isFinite(input.acceptablePriceUsd) || input.acceptablePriceUsd <= 0) {
    return { ok: false, protectionId: null, reason: 'INITIAL_STOP 실패 기록 입력 비정상', emergencyCloseRequired: true };
  }
  const planned = await planProtection({
    parentOpenIntentId: o.parentOpenIntentId,
    positionKey: o.positionKey,
    purpose: 'INITIAL_STOP',
    symbol: o.symbol,
    marketAddress: o.marketAddress,
    isLong: o.isLong,
    sizeDeltaUsd: o.confirmedSizeUsd,
    triggerPriceUsd: input.triggerPriceUsd,
    acceptablePriceUsd: input.acceptablePriceUsd,
    dayKey: manilaDayKey(input.now ?? new Date()),
  });
  if (!planned.ok) {
    return { ok: false, protectionId: null, reason: planned.reason, emergencyCloseRequired: true };
  }
  const row = await getProtection(planned.protectionId);
  if (!row) {
    return { ok: false, protectionId: planned.protectionId, reason: 'INITIAL_STOP 실패 기록 재조회 실패', emergencyCloseRequired: true };
  }
  if (row.status === 'UNRESOLVED') {
    return { ok: false, protectionId: planned.protectionId, reason, emergencyCloseRequired: true };
  }
  if (row.status !== 'PLANNED' || row.submitAttempts > 0) {
    return {
      ok: false,
      protectionId: planned.protectionId,
      reason: `기존 보호 주문 상태 ${row.status}/attempts=${row.submitAttempts} — 실패 기록 중복 전이 금지`,
      emergencyCloseRequired: existingStopNeedsEmergency(row.status),
      currentStatus: row.status as ProtectionStatus,
    };
  }
  const transitioned = await transitionProtection(
    planned.protectionId,
    'PLANNED',
    'UNRESOLVED',
    { error: reason, evidence: o.evidence },
  );
  return transitioned.ok
    ? { ok: false, protectionId: planned.protectionId, reason, emergencyCloseRequired: true }
    : lostStopTransitionResult(planned.protectionId, transitioned.reason);
}

// ── §6 — emergency close (전량 MarketDecrease, 최대 1회) ─────────────────────

export interface EmergencyCloseInput {
  parentOpenIntentId: string;
  positionKey: string;
  symbol: string;
  marketAddress: string;
  isLong: boolean;
  /** authoritative 전체 포지션 크기 (초과 금지·전량) */
  fullSizeUsd: number;
  reason: string;
  manualCanary?: true;
  now?: Date;
}

/**
 * 비상 전량 종료 — 결정적 key(prot:<intentId>:EMERGENCY_CLOSE)로 최대 1회.
 * 모호한 결과 = UNRESOLVED (신규 진입 전면 차단은 listBlockingProtections가 담당).
 */
export async function runEmergencyClose(input: EmergencyCloseInput): Promise<StopCreationResult> {
  if (!Number.isFinite(input.fullSizeUsd) || input.fullSizeUsd <= 0) {
    return { ok: false, protectionId: null, reason: '포지션 크기 비정상 — emergency close 불가 (수동 개입 필요)', emergencyCloseRequired: true };
  }
  const planned = await planProtection({
    parentOpenIntentId: input.parentOpenIntentId,
    positionKey: input.positionKey,
    purpose: 'EMERGENCY_CLOSE',
    symbol: input.symbol,
    marketAddress: input.marketAddress,
    isLong: input.isLong,
    sizeDeltaUsd: input.fullSizeUsd,
    triggerPriceUsd: null,
    acceptablePriceUsd: null,
    dayKey: manilaDayKey(input.now ?? new Date()),
  });
  if (!planned.ok) return { ok: false, protectionId: null, reason: planned.reason, emergencyCloseRequired: true };
  const id = planned.protectionId;
  const row = await getProtection(id);
  if (!row) return { ok: false, protectionId: id, reason: 'emergency close 레코드 재조회 실패', emergencyCloseRequired: true };
  if (row.status !== 'PLANNED' || row.submitAttempts > 0) {
    // 이미 시도됨 — 최대 1회 규칙. 재제출 금지, 상태는 reconciliation이 해소.
    return { ok: false, protectionId: id, reason: `emergency close 이미 시도됨 (${row.status}) — 재제출 금지, 수동/증거 해소 대기`, emergencyCloseRequired: false };
  }
  if (!_submitFn) return { ok: false, protectionId: id, reason: 'emergency close 제출 함수 미구성', emergencyCloseRequired: true };

  const t1 = await transitionProtection(id, 'PLANNED', 'PREPARED', { evidence: input.reason });
  if (!t1.ok) return { ok: false, protectionId: id, reason: t1.reason, emergencyCloseRequired: true };
  const t2 = await transitionProtection(id, 'PREPARED', 'SUBMITTING', { incrementSubmitAttempts: true });
  if (!t2.ok) return { ok: false, protectionId: id, reason: t2.reason, emergencyCloseRequired: true };

  let outcome: ProtectionSubmitOutcome;
  try {
    outcome = await _submitFn({
      parentOpenIntentId: input.parentOpenIntentId,
      positionKey: input.positionKey,
      manualCanary: input.manualCanary === true,
      purpose: 'EMERGENCY_CLOSE', symbol: input.symbol, marketAddress: input.marketAddress,
      isLong: input.isLong, sizeDeltaUsd: input.fullSizeUsd,
      triggerPriceUsd: null, acceptablePriceUsd: null, protectionId: id,
    });
  } catch {
    outcome = { status: 'UNRESOLVED', reason: 'emergency close 제출 예외 — 결과 불명' };
  }
  if (outcome.status === 'ACCEPTED') {
    const t3 = await transitionProtection(id, 'SUBMITTING', 'SUBMITTED', {
      requestId: outcome.requestId, typedDataDigest: outcome.typedDataDigest,
    });
    if (!t3.ok) {
      await transitionProtection(id, 'SUBMITTING', 'UNRESOLVED', { error: 'SUBMITTED 영속 실패' });
      return { ok: false, protectionId: id, reason: 'emergency close 수락됐으나 영속 실패 — UNRESOLVED', emergencyCloseRequired: false };
    }
    return { ok: true, protectionId: id, finalStatus: 'SUBMITTED' };
  }
  await transitionProtection(id, 'SUBMITTING', 'UNRESOLVED', { error: outcome.reason });
  return { ok: false, protectionId: id, reason: outcome.reason, emergencyCloseRequired: false };
}

// ── §9 — reconciliation 적용 + startup coverage 점검 ─────────────────────────

export interface ProtectionEvidenceRowInput {
  id: string;
  requestId: string | null;
  orderKey: string | null;
  marketAddress: string;
  isLong: boolean;
  /** 6H-2D §3 — 의미 결속 기대값 전달 */
  purpose: string | null;
  sizeDeltaUsd: number | null;
  triggerPriceUsd: number | null;
  decimalsUsed: number | null;
  emitterAddress: string | null;
}

export interface ProtectionEvidenceFetch {
  /** requestId/orderKey 기반 증거 수집 (온체인 이벤트 + GMX status). 실패 = null */
  (row: ProtectionEvidenceRowInput): Promise<{
    apiStatus: string | null;
    onchainOrderKey: string | null;
    onchainExecuted: boolean;
    onchainCancelled: boolean;
    onchainFrozen: boolean;
    positionExists: boolean | null;
    /** 6H-2D §5 — 모호 증거 = 전이 금지 + 차단 (명시 결선) */
    ambiguous?: boolean;
    ambiguousReasons?: string[];
    semanticOk?: boolean | null;
    semanticMismatches?: string[];
    receiptStatus?: 'success' | 'reverted' | null;
    receiptBlockNumber?: string | null;
  } | null>;
}

export interface ReconcileProtectionsSummary {
  checked: number;
  transitioned: number;
  emergencyCloseRequired: string[]; // positionKey 목록
  blockNewOpens: boolean;
  /** 6H-2D §5 — ambiguous 증거 건수 + 사유 (reconciliation complete=false 근거) */
  ambiguousCount: number;
  ambiguousReasons: string[];
}

/** 활성 보호 주문 전수 재판정 — 증거 수집 실패 = 전이 없음 + 신규 OPEN 차단 */
export async function reconcileProtections(fetchEvidence: ProtectionEvidenceFetch): Promise<ReconcileProtectionsSummary> {
  const listed = await listBlockingProtections();
  if (!listed.ok) return { checked: 0, transitioned: 0, emergencyCloseRequired: [], blockNewOpens: true, ambiguousCount: 0, ambiguousReasons: ['보호 주문 목록 조회 실패'] };
  let transitioned = 0;
  const emergency: string[] = [];
  let block = false;
  let ambiguousCount = 0;
  const ambiguousReasons: string[] = [];
  for (const row of listed.rows) {
    let ev: Awaited<ReturnType<ProtectionEvidenceFetch>> = null;
    try {
      ev = await fetchEvidence({
        id: row.id, requestId: row.requestId, orderKey: row.orderKey,
        marketAddress: row.marketAddress, isLong: row.isLong,
        purpose: row.purpose ?? null,
        sizeDeltaUsd: row.sizeDeltaUsd == null ? null : Number(row.sizeDeltaUsd),
        triggerPriceUsd: row.triggerPriceUsd == null ? null : Number(row.triggerPriceUsd),
        decimalsUsed: row.decimalsUsed ?? null,
        emitterAddress: row.emitterAddress ?? null,
      });
    } catch { ev = null; }
    if (!ev) { block = true; continue; }
    // ── 6H-2D §5 — ambiguous 명시 게이트: 어떤 전이도 금지 + 차단 + durable 기록 ──
    if (ev.ambiguous) {
      block = true;
      ambiguousCount += 1;
      const reason = (ev.ambiguousReasons ?? []).join('; ') || '모호 증거';
      ambiguousReasons.push(`${row.id}: ${reason}`);
      await recordProtectionEvidenceFields(row.id, { ambiguousReason: reason.slice(0, 500) });
      continue;
    }
    // 의미 결속 명시 불일치 = 위조/오결속 의심 — 전이 금지 + 차단 (§3)
    if (ev.semanticOk === false) {
      block = true;
      const mm = (ev.semanticMismatches ?? []).join('; ') || '의미 결속 불일치';
      await recordProtectionEvidenceFields(row.id, { semanticBindingOk: false, semanticMismatches: mm.slice(0, 500) });
      continue;
    }
    const j = judgeProtection({
      currentStatus: row.status as ProtectionStatus,
      apiStatus: ev.apiStatus,
      onchainOrderKey: ev.onchainOrderKey,
      onchainExecuted: ev.onchainExecuted,
      onchainCancelled: ev.onchainCancelled,
      onchainFrozen: ev.onchainFrozen,
      positionExists: ev.positionExists,
    });
    if (j.blockNewOpens) block = true;
    if (j.emergencyCloseRequired) emergency.push(row.positionKey);
    if (j.nextStatus) {
      const res = j.nextStatus === 'ACTIVE' && ev.onchainOrderKey
        ? await markProtectionActive(row.id, row.status as ProtectionStatus, ev.onchainOrderKey, j.reason)
        : await transitionProtection(row.id, row.status as ProtectionStatus, j.nextStatus, { evidence: j.reason });
      if (res.ok) transitioned += 1; else block = true;
    }
  }
  return {
    checked: listed.rows.length, transitioned,
    emergencyCloseRequired: [...new Set(emergency)],
    blockNewOpens: block,
    ambiguousCount, ambiguousReasons,
  };
}

export interface StartupCoverageInput {
  /** authoritative open positions (null = 조회 실패 → 차단) */
  positions: { positionKey: string; marketAddress: string; isLong: boolean; sizeUsd: number }[] | null;
  /** 현재 ACTIVE 상태의 보호 주문 positionKey 집합 */
  activeStopPositionKeys: Set<string>;
}

export interface StartupCoverageResult {
  ok: boolean;
  uncovered: { positionKey: string; sizeUsd: number }[];
  blockNewOpens: boolean;
  reason: string | null;
}

/** §6 — startup: open position인데 ACTIVE stop이 없으면 emergency close 대상 */
export function checkStartupProtectionCoverage(input: StartupCoverageInput): StartupCoverageResult {
  if (input.positions === null) {
    return { ok: false, uncovered: [], blockNewOpens: true, reason: 'authoritative 포지션 조회 실패 — 신규 OPEN 차단 (fail-closed)' };
  }
  const uncovered = input.positions
    .filter(p => !input.activeStopPositionKeys.has(p.positionKey))
    .map(p => ({ positionKey: p.positionKey, sizeUsd: p.sizeUsd }));
  return {
    ok: uncovered.length === 0,
    uncovered,
    blockNewOpens: uncovered.length > 0,
    reason: uncovered.length > 0 ? `ACTIVE stop 없는 포지션 ${uncovered.length}건 — emergency close 필요` : null,
  };
}

export { buildProtectionId };
