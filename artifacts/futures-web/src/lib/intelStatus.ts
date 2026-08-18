/**
 * 6I-1 §15 — Market Intelligence read-only 조회 헬퍼.
 * 조회 실패 = Unavailable (가짜 0/NORMAL 렌더 금지).
 */
import { apiUrl } from '@/lib/apiUrl';

export interface IntelRegimeRow {
  market: string;
  regime: string;
  strength: number;
  dataQuality: string;
  basis: string;
  tradeAllowed: boolean;
}

/** 6I-2 §11 — MI Runtime 관측치 (서버 저장 상태만) */
export interface IntelRuntime {
  mode: 'SHADOW_ONLY';
  inFlight: boolean;
  currentCycleId: string | null;
  skippedInFlight: number;
  timeoutCount: number;
  failedCount: number;
  shutdownRequested: boolean;
  lastAttempt: {
    cycleId: string; windowKey: number; status: string;
    startedAtMs: number; finishedAtMs: number | null; error: string | null;
  } | null;
  lastRecordStale: boolean;
  requestStats?: {
    requests: number; ok: number; http429: number; http5xx: number;
    timeouts: number; invalidPayload: number; maxLatencyMs: number; totalLatencyMs: number;
  } | null;
  dataSourceStats?: {
    candleRequests: number; candleCacheHits: number; candleCacheMisses: number;
    candleDeduped: number; marketsRequests: number; marketsCacheHits: number;
    budgetExceededCount: number; backoffSkips: number;
  } | null;
}

export interface IntelStatus {
  available: boolean;
  mode?: 'SHADOW_ONLY';
  stale?: boolean;
  runtime?: IntelRuntime;
  reason?: string;
  cycleId?: string;
  at?: string;
  universeCount?: number;
  shortlistCount?: number;
  shortlistSymbols?: string[];
  degraded?: boolean;
  degradedReason?: string | null;
  dataQuality?: string;
  decision?: string;
  blockedReason?: string | null;
  noTradeReasons?: string[];
  regimes?: IntelRegimeRow[];
  cycleCount?: number;
  noTradeCycles?: number;
  lastError?: string | null;
}

/** 6I-3 — 후보 비용 breakdown (성분 null=실측 미확보, 0 위장 금지) */
export interface CostBreakdownView {
  entryFeeUsd: number | null;
  estimatedExitFeeUsd: number | null;
  fundingCostUsd: number | null;
  borrowingCostUsd: number | null;
  priceImpactUsd: number | null;
  slippageUsd: number | null;
  gasExecutionFeeUsd: number | null;
  latencyRiskReserveUsd: number | null;
  failureRiskReserveUsd: number | null;
  holdingHoursAssumed: number | null;
  costBasis: string | null;
  costSource: string | null;
  costSnapshotFetchedAtMs: number | null;
  /** 6I-4 — rate 출처 pin (endpoint+SDK 버전+단위 계약) */
  sourcePin?: string | null;
  /** 6I-4 — 성분별 관측 시각 (stale 감사용) */
  componentObservedAtMs?: {
    feeParamsAtMs: number | null;
    ratesAtMs: number | null;
    ethPriceAtMs: number | null;
  } | null;
}

/** 6I-3 — regime×방향 bucket 보정 표본 관측치 */
export interface CalibrationBucketView {
  key: string;
  decisiveSamples: number;
  targetCount: number;
  stopCount: number;
  noneCount: number;
  requiredSamples: number;
  reason: string | null;
}

export interface OpportunityRow {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  regime: string;
  dataQuality: string;
  rawSignalScore: number;
  winProbability: number | null;
  calibrationStatus: string;
  expectedNetValueUsd: number | null;
  expectedRMultiple: number | null;
  uncalibratedRankingScore: number | null;
  totalExpectedCostUsd?: number | null;
  costBreakdown?: CostBreakdownView | null;
  calibrationBucket?: CalibrationBucketView | null;
  rank: number | null;
  selected: boolean;
  decision: string;
  rejectionReasons: string[];
}

export interface OpportunitiesLatest {
  available: boolean;
  reason?: string;
  cycleId?: string;
  decision?: string;
  noTradeReasons?: string[];
  candidates: OpportunityRow[];
}

/** 6I-2 §10 — 표본 성숙도 (승격 플래그는 항상 false) */
export interface ShadowMaturity {
  sampleCount4h: number;
  ambiguousCount: number;
  directionCounts: { LONG: number; SHORT: number };
  regimeCounts: Record<string, number>;
  researchPreviewEligible: boolean;
  manualReviewSampleEligible: boolean;
  calibrationEligible: boolean;
  autoPromotionAllowed: false;
  autonomousLiveEligible: false;
  blockedReasons: string[];
}

export interface CounterfactualSummary {
  evaluated: number;
  byLabel: Record<string, number>;
}

export type ShadowMetricsResponse =
  | ({ status: 'INSUFFICIENT_SAMPLE'; sampleCount: number; required: number; autoPromotionAllowed: false } & ShadowMetricsExtras)
  | ({ status: 'OK'; sampleCount: number; autoPromotionAllowed: false } & ShadowMetricsExtras & Record<string, unknown>);

export interface ShadowMetricsExtras {
  mode?: 'SHADOW_ONLY';
  maturity?: ShadowMaturity;
  counterfactual?: CounterfactualSummary;
}

/** 6I-2 §11 — Outcome Enrichment 상태 */
export interface EnrichmentStatus {
  mode: 'SHADOW_ONLY';
  lastRun: {
    scanned: number; enriched: number; enriched1h: number;
    ambiguous: number; incomplete: number; exhausted: number; atMs: number;
  } | null;
  backlog: {
    dueCount: number;
    oldestPendingDecidedAtMs: number | null;
    terminalCount: number;
    ambiguousCount: number;
    complete4hCount: number;
  };
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(apiUrl(path));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export const fetchIntelStatus = () => getJson<IntelStatus>('market-intelligence/status');
export const fetchOpportunitiesLatest = () => getJson<OpportunitiesLatest>('opportunities/latest');
export const fetchShadowMetrics = () => getJson<ShadowMetricsResponse>('shadow/metrics');
export const fetchEnrichmentStatus = () => getJson<EnrichmentStatus>('shadow/enrichment');

/** §7·§15 — 보정 확률 표시 규칙: null=미보정 문구, 절대 %로 위장 금지 */
export function formatWinProbability(p: number | null, calibrationStatus: string): string {
  if (p === null || calibrationStatus !== 'CALIBRATED') return '미보정 (표본 부족)';
  return `${(p * 100).toFixed(1)}%`;
}

/** 6I-3 — bucket 표본 진행 표시 (n/200) — 없으면 null 반환 (표시 생략) */
export function formatBucketSamples(b: CalibrationBucketView | null | undefined): string | null {
  if (!b) return null;
  return `${b.decisiveSamples}/${b.requiredSamples} 표본`;
}

/** 6I-3 — 총비용 표시: null=산출 불가 (누락 성분 0 위장 금지) */
export function formatTotalCost(v: number | null | undefined): string {
  if (v === null || v === undefined) return '산출 불가';
  return `$${v.toFixed(2)}`;
}

/** 6I-3 — 비용 breakdown 요약 문자열 (null 성분은 '미확보' 표기) */
/** 6I-4 — 성분별 관측 시각 tooltip 문자열 (미확보=—, 위장 금지) */
export function formatComponentObservedAt(t: CostBreakdownView['componentObservedAtMs']): string | undefined {
  if (!t) return undefined;
  const f = (v: number | null) => (v === null ? '—' : new Date(v).toLocaleTimeString());
  return `관측 시각 — 수수료/impact 계수: ${f(t.feeParamsAtMs)} · rate/OI: ${f(t.ratesAtMs)} · ETH가: ${f(t.ethPriceAtMs)}`;
}

export function costComponentLines(c: CostBreakdownView | null | undefined): { label: string; value: string }[] {
  if (!c) return [];
  const f = (v: number | null) => (v === null ? '미확보' : `$${v.toFixed(4)}`);
  return [
    { label: '진입 수수료', value: f(c.entryFeeUsd) },
    { label: '청산 수수료', value: f(c.estimatedExitFeeUsd) },
    { label: 'Funding', value: f(c.fundingCostUsd) },
    { label: 'Borrowing', value: f(c.borrowingCostUsd) },
    { label: 'Price impact', value: f(c.priceImpactUsd) },
    { label: 'Slippage', value: f(c.slippageUsd) },
    { label: '실행 gas', value: f(c.gasExecutionFeeUsd) },
    { label: '지연 예비비', value: f(c.latencyRiskReserveUsd) },
    { label: '실패 예비비', value: f(c.failureRiskReserveUsd) },
  ];
}

/** 6I-3 — bucket 보정 상태 응답 */
export interface CalibrationResponse {
  mode: 'SHADOW_ONLY';
  atMs: number;
  requiredSamplesPerBucket: number;
  buckets: (CalibrationBucketView & {
    bucketKey: string; regime: string; direction: 'LONG' | 'SHORT';
    winProbability: number | null; status: string; lastDecisiveAtMs: number | null;
  })[];
}
export const fetchCalibration = () => getJson<CalibrationResponse>('shadow/calibration');

/** 순기대값 표시 — null=산출 불가 (0으로 위장 금지) */
export function formatExpectedNetValue(v: number | null): string {
  if (v === null) return '산출 불가';
  return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
}

/** §15 필수 고지 문구 */
export const INTEL_NOTICE_MONITORING = '24시간 감시 중 — 거래 기회가 없으면 NO_TRADE가 정상입니다';
export const INTEL_NOTICE_NO_GUARANTEE = '예상값은 수익 보장이 아닙니다';
export const INTEL_NOTICE_SHADOW = '현재 전략은 PAPER/SHADOW 검증 중이며 자동 LIVE 승격되지 않습니다';
