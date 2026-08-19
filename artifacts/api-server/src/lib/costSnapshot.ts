/**
 * costSnapshot — 주문 전 비용 스냅샷 (6H-2 §4).
 *
 * 원칙 (fail-closed):
 *  - 고정 수수료율 fallback 금지, 임의의 0 금지, stale snapshot 금지
 *  - 다른 market/direction/orderType/상위 주문금액에 quote 재사용 금지
 *  - 음수·NaN·비정상 거부, positive impact는 비용 상쇄에 20%까지만 반영
 *  - LIVE 조회 실패/readonly 플래그 꺼짐 → COST_DATA_UNAVAILABLE (가짜 성공 금지)
 *  - PAPER도 공식 GMX read-only 입력만 사용 (6H-2A §3 — source=PAPER_GMX_ESTIMATE).
 *    고정 모델값(구 PAPER_MODEL)·수수료 0 정의는 실행 경로에서 완전 제거됨.
 *  - 값 누락과 실제 0을 구분 — 필드 부재를 0으로 추정하는 행위 금지.
 */

export const COST_DATA_UNAVAILABLE = 'COST_DATA_UNAVAILABLE';

/**
 * PAPER_GMX_ESTIMATE = PAPER 시뮬용, 그러나 데이터 출처는 LIVE와 동일한
 * 공식 GMX read-only 조회다 (합성/고정 모델 아님).
 */
export type CostSnapshotSource = 'GMX_API' | 'RPC_DATASTORE' | 'PAPER_GMX_ESTIMATE';

export interface CostSnapshot {
  market: string;
  isLong: boolean;
  orderType: 'MarketIncrease' | 'MarketDecrease';
  notionalUsd: number;
  positionFeeUsd: number;
  executionFeeUsd: number;
  /** 부호 있는 추정 impact — 양수 = 불리(비용), 음수 = 유리(rebate) */
  estimatedPriceImpactUsd: number;
  fundingFeeUsd: number;
  borrowingFeeUsd: number;
  estimatedExitFeeUsd: number;
  /** 청산 시 추정 impact (부호 있음) — 명시적 0 허용, 누락 금지 */
  estimatedExitPriceImpactUsd: number;
  /** 보유시간 누적용 시간당 funding rate (notional 대비 비율). null = 데이터 누락(UNAVAILABLE) */
  fundingRatePerHourFraction: number | null;
  /** 보유시간 누적용 시간당 borrowing rate. null = 데이터 누락(UNAVAILABLE) */
  borrowingRatePerHourFraction: number | null;
  totalEstimatedRoundTripCostUsd: number;
  source: CostSnapshotSource;
  blockNumber: number | null;
  apiTimestamp: string | null;
  fetchedAt: string;
  expiresAt: string;
}

export interface CostSnapshotExpectation {
  market: string;
  isLong: boolean;
  orderType: 'MarketIncrease' | 'MarketDecrease';
  notionalUsd: number;
}

export type CostValidation =
  | { ok: true; effectiveRoundTripCostUsd: number; roundTripFraction: number }
  | { ok: false; reason: string };

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonNeg = (v: unknown): v is number => fin(v) && v >= 0;

/** positive impact가 상쇄할 수 있는 최대 비율 (다른 비용 합계 대비) */
export const MAX_POSITIVE_IMPACT_OFFSET_FRACTION = 0.2;

/** 스냅샷 유효기간 기본값 (ms) */
export const COST_SNAPSHOT_TTL_MS = 60_000;

/**
 * 6H-2B §10 — 실행 적격(execution-eligible) 최대 age.
 * 표시/분석용 cache(10분)는 주문 적격성 판단에 절대 사용 금지 —
 * OPEN prepare 직전에 이 창(30초) 안의 스냅샷만 인정한다.
 */
export const EXECUTION_ELIGIBLE_MAX_AGE_MS = 30_000;

/** §10 — 위험감소(reduce/close) 주문이 비용 확보 실패로 나아갈 때의 상태 태그 */
export const UNRESOLVED_SAFETY_EXIT = 'UNRESOLVED_SAFETY_EXIT';

/**
 * §10 — 실행 적격성 검증: 일반 validateCostSnapshot 전체 + fetchedAt 30초 창.
 * 재조회 실패·초과 = OPEN 차단 (fail-closed). 위험감소 주문은 호출측에서
 * UNRESOLVED_SAFETY_EXIT로 계속 진행하되 상태를 남긴다.
 */
export function validateExecutionEligibleSnapshot(
  snap: CostSnapshot | null | undefined,
  expected: CostSnapshotExpectation,
  nowMs: number,
): CostValidation {
  const base = validateCostSnapshot(snap, expected, nowMs);
  if (!base.ok) return base;
  const fetched = Date.parse((snap as CostSnapshot).fetchedAt);
  if (nowMs - fetched > EXECUTION_ELIGIBLE_MAX_AGE_MS) {
    return { ok: false, reason: `실행 적격 초과: 스냅샷 age ${(nowMs - fetched) / 1000}s > ${EXECUTION_ELIGIBLE_MAX_AGE_MS / 1000}s — 재조회 필요 (fail-closed)` };
  }
  return base;
}

/** 오류 메시지 새니타이즈 — URL/토큰 패턴 제거 (§13.14) */
export function sanitizeCostError(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s"']+/gi, '[URL]')
    .replace(/(api[-_]?key|token|secret|authorization)[=:]\s*[^\s&"']+/gi, '$1=[REDACTED]');
}

export function validateCostSnapshot(
  snap: CostSnapshot | null | undefined,
  expected: CostSnapshotExpectation,
  nowMs: number,
): CostValidation {
  if (!snap) return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: 비용 스냅샷 없음` };

  // 결속: market / direction / orderType
  if (snap.market.toLowerCase() !== expected.market.toLowerCase()) {
    return { ok: false, reason: '다른 market의 quote 재사용 금지' };
  }
  if (snap.isLong !== expected.isLong) return { ok: false, reason: '다른 direction의 quote 재사용 금지' };
  if (snap.orderType !== expected.orderType) return { ok: false, reason: '다른 orderType의 quote 재사용 금지' };

  // notional 결속 — 상위 주문금액에 하위 quote 재사용 금지 (1% 허용오차)
  if (!fin(snap.notionalUsd) || snap.notionalUsd <= 0) return { ok: false, reason: 'snapshot notional 비정상' };
  if (expected.notionalUsd > snap.notionalUsd * 1.01) {
    return { ok: false, reason: `상위 주문금액($${expected.notionalUsd.toFixed(2)})에 하위 quote($${snap.notionalUsd.toFixed(2)}) 재사용 금지` };
  }

  // 수치 유효성 — 음수/NaN 거부 (impact만 부호 허용)
  for (const [k, v] of Object.entries({
    positionFeeUsd: snap.positionFeeUsd, executionFeeUsd: snap.executionFeeUsd,
    fundingFeeUsd: snap.fundingFeeUsd, borrowingFeeUsd: snap.borrowingFeeUsd,
    estimatedExitFeeUsd: snap.estimatedExitFeeUsd,
  })) {
    if (!nonNeg(v)) return { ok: false, reason: `${k} 음수/NaN — 거부` };
  }
  if (!fin(snap.estimatedPriceImpactUsd)) return { ok: false, reason: 'estimatedPriceImpactUsd NaN — 거부' };
  if (!fin(snap.estimatedExitPriceImpactUsd)) return { ok: false, reason: 'estimatedExitPriceImpactUsd NaN/누락 — 거부 (누락≠0)' };
  if (!fin(snap.totalEstimatedRoundTripCostUsd)) return { ok: false, reason: 'total NaN — 거부' };
  // rate 필드는 null(누락) 허용 — 단 보유시간 비용 누적 시 UNAVAILABLE 처리됨.
  // 값이 있으면 음수/NaN 거부 (funding은 이론상 음수 가능하나 보수적으로 0 하한).
  for (const [k, v] of [['fundingRatePerHourFraction', snap.fundingRatePerHourFraction],
                        ['borrowingRatePerHourFraction', snap.borrowingRatePerHourFraction]] as const) {
    if (v !== null && !nonNeg(v)) return { ok: false, reason: `${k} 음수/NaN — 거부` };
  }

  // staleness
  const fetched = Date.parse(snap.fetchedAt);
  const expires = Date.parse(snap.expiresAt);
  if (!Number.isFinite(fetched) || !Number.isFinite(expires)) return { ok: false, reason: '스냅샷 시각 파싱 불가' };
  if (fetched > nowMs + 5_000) return { ok: false, reason: '스냅샷 fetchedAt이 미래 — 거부' };
  if (nowMs > expires) return { ok: false, reason: `stale snapshot (expiresAt=${snap.expiresAt}) — 거부` };

  // positive impact 상쇄 제한 (진입+청산 impact 합산)
  const otherCosts = snap.positionFeeUsd + snap.executionFeeUsd + snap.fundingFeeUsd
    + snap.borrowingFeeUsd + snap.estimatedExitFeeUsd;
  const impactCost = Math.max(
    snap.estimatedPriceImpactUsd + snap.estimatedExitPriceImpactUsd,
    -(otherCosts * MAX_POSITIVE_IMPACT_OFFSET_FRACTION),
  );
  const effective = otherCosts + impactCost;
  if (!fin(effective) || effective < 0) return { ok: false, reason: '유효 비용 비정상 — 거부' };

  return { ok: true, effectiveRoundTripCostUsd: effective, roundTripFraction: effective / snap.notionalUsd };
}

// ── 공식 GMX read-only 비용 스냅샷 조회 (주입식 — 실제 네트워크 호출 금지) ──────
// PAPER와 LIVE는 동일한 조회 경로를 사용하며 source 태그만 다르다 (6H-2A §3).
// 구 PAPER_COST_MODEL(고정 모델값)·buildPaperCostSnapshot은 완전 제거됨 —
// 비용 데이터를 확보하지 못하면 PAPER도 신규 진입하지 않는다 (NO_TRADE).

/** fetchCosts 결과 — 모든 필수 필드는 명시적 값이어야 함. 누락(undefined)≠0. */
export interface FetchedCostFields {
  positionFeeUsd: number; executionFeeUsd: number; estimatedPriceImpactUsd: number;
  fundingFeeUsd: number; borrowingFeeUsd: number; estimatedExitFeeUsd: number;
  /** 청산 시 추정 impact — 공식 데이터가 명시적으로 0을 반환한 경우만 0 */
  estimatedExitPriceImpactUsd: number;
  /** 시간당 rate — 데이터가 없으면 null (0으로 추정 금지) */
  fundingRatePerHourFraction: number | null;
  borrowingRatePerHourFraction: number | null;
  blockNumber: number | null; apiTimestamp: string | null;
}

export interface LiveCostFetchers {
  /** readonly 플래그 상태 — false면 조회 없이 COST_DATA_UNAVAILABLE */
  readonlyEnabled: boolean;
  /** 비용 필드 조회 (mock/fixture 주입) — 하나라도 실패/결측이면 전체 실패 */
  fetchCosts?: (args: { market: string; isLong: boolean; notionalUsd: number }) => Promise<FetchedCostFields>;
}

export interface ExecutionEligibleCostEvidence {
  market: string;
  isLong: boolean;
  observedAtMs: number;
}

let executionEligibleEvidence: ExecutionEligibleCostEvidence | null = null;

export function recordExecutionEligibleCostEvidence(
  snap: CostSnapshot,
  expected: CostSnapshotExpectation,
  nowMs: number,
): boolean {
  const valid = validateExecutionEligibleSnapshot(snap, expected, nowMs);
  if (!valid.ok) return false;
  executionEligibleEvidence = {
    market: snap.market,
    isLong: snap.isLong,
    observedAtMs: Date.parse(snap.fetchedAt),
  };
  return true;
}

export function getExecutionEligibleCostEvidence(nowMs: number = Date.now()): {
  fresh: boolean;
  evidence: ExecutionEligibleCostEvidence | null;
} {
  return {
    fresh: executionEligibleEvidence !== null
      && nowMs - executionEligibleEvidence.observedAtMs <= EXECUTION_ELIGIBLE_MAX_AGE_MS,
    evidence: executionEligibleEvidence,
  };
}

export function __resetExecutionEligibleCostEvidenceForTests(): void {
  executionEligibleEvidence = null;
}

/** 필수 USD 비용 필드 — 누락(undefined/null)을 0으로 추정하는 행위 금지 (§3) */
const REQUIRED_COST_FIELDS = [
  'positionFeeUsd', 'executionFeeUsd', 'estimatedPriceImpactUsd',
  'fundingFeeUsd', 'borrowingFeeUsd', 'estimatedExitFeeUsd', 'estimatedExitPriceImpactUsd',
] as const;

async function fetchCostSnapshotWithSource(
  args: { market: string; isLong: boolean; orderType: 'MarketIncrease' | 'MarketDecrease'; notionalUsd: number; now: Date },
  fetchers: LiveCostFetchers,
  source: CostSnapshotSource,
): Promise<{ ok: true; snapshot: CostSnapshot } | { ok: false; reason: string }> {
  if (!fetchers.readonlyEnabled) {
    return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: readonly 네트워크 플래그 비활성 — 비용 조회 불가 (가짜 성공 금지)` };
  }
  if (!fetchers.fetchCosts) {
    return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: 비용 조회 경로 미구성` };
  }
  try {
    const c = await fetchers.fetchCosts({ market: args.market, isLong: args.isLong, notionalUsd: args.notionalUsd });
    // 값 누락 ≠ 실제 0 — 필드가 없으면 즉시 실패 (0으로 추정 금지)
    for (const k of REQUIRED_COST_FIELDS) {
      if (!fin((c as unknown as Record<string, unknown>)[k])) {
        return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: ${k} 값 누락/비수치 — 0으로 추정 금지` };
      }
    }
    // rate 필드는 명시적 null(누락 표시)만 허용, undefined는 계약 위반
    if (c.fundingRatePerHourFraction === undefined || c.borrowingRatePerHourFraction === undefined) {
      return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: funding/borrowing rate 필드 부재 — 누락은 null로 명시해야 함` };
    }
    const sourceObservedAtMs = c.apiTimestamp === null ? args.now.getTime() : Date.parse(c.apiTimestamp);
    if (!Number.isFinite(sourceObservedAtMs) || sourceObservedAtMs > args.now.getTime() + 5_000) {
      return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: 비용 관측 시각 비정상` };
    }
    const snap: CostSnapshot = {
      market: args.market, isLong: args.isLong, orderType: args.orderType, notionalUsd: args.notionalUsd,
      positionFeeUsd: c.positionFeeUsd, executionFeeUsd: c.executionFeeUsd,
      estimatedPriceImpactUsd: c.estimatedPriceImpactUsd,
      fundingFeeUsd: c.fundingFeeUsd, borrowingFeeUsd: c.borrowingFeeUsd,
      estimatedExitFeeUsd: c.estimatedExitFeeUsd,
      estimatedExitPriceImpactUsd: c.estimatedExitPriceImpactUsd,
      fundingRatePerHourFraction: c.fundingRatePerHourFraction,
      borrowingRatePerHourFraction: c.borrowingRatePerHourFraction,
      source,
      blockNumber: c.blockNumber, apiTimestamp: c.apiTimestamp,
      totalEstimatedRoundTripCostUsd:
        c.positionFeeUsd + c.executionFeeUsd + c.estimatedPriceImpactUsd + c.estimatedExitPriceImpactUsd
        + c.fundingFeeUsd + c.borrowingFeeUsd + c.estimatedExitFeeUsd,
      fetchedAt: new Date(sourceObservedAtMs).toISOString(),
      expiresAt: new Date(sourceObservedAtMs + COST_SNAPSHOT_TTL_MS).toISOString(),
    };
    const valid = validateCostSnapshot(snap, args, args.now.getTime());
    if (!valid.ok) return { ok: false, reason: sanitizeCostError(valid.reason) };
    return { ok: true, snapshot: snap };
  } catch (err) {
    return { ok: false, reason: `${COST_DATA_UNAVAILABLE}: ${sanitizeCostError((err as Error).message)}` };
  }
}

export async function fetchLiveCostSnapshot(
  args: { market: string; isLong: boolean; orderType: 'MarketIncrease' | 'MarketDecrease'; notionalUsd: number; now: Date },
  fetchers: LiveCostFetchers,
): Promise<{ ok: true; snapshot: CostSnapshot } | { ok: false; reason: string }> {
  return fetchCostSnapshotWithSource(args, fetchers, 'GMX_API');
}

/**
 * PAPER 비용 스냅샷 — LIVE와 동일한 공식 read-only 조회, source만 PAPER_GMX_ESTIMATE.
 * 조회 실패 시 PAPER도 신규 진입 금지 (NO_TRADE: COST_DATA_UNAVAILABLE).
 * 네트워크 장애 시 이전 quote fallback 금지 — 호출자는 stale 캐시를 재사용하면 안 된다.
 */
export async function fetchPaperCostSnapshot(
  args: { market: string; isLong: boolean; orderType: 'MarketIncrease' | 'MarketDecrease'; notionalUsd: number; now: Date },
  fetchers: LiveCostFetchers,
): Promise<{ ok: true; snapshot: CostSnapshot } | { ok: false; reason: string }> {
  return fetchCostSnapshotWithSource(args, fetchers, 'PAPER_GMX_ESTIMATE');
}
