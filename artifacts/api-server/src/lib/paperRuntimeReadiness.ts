/**
 * PAPER runtime readiness evidence.
 *
 * A bounded background diagnostic loop warms process-memory evidence using only
 * allowlisted public reads. This module has no DB writer, signer, preflight-token,
 * signing, prepare/submit, order, protection, transfer, HWM, or trading-capital
 * capability. Its cache is display-only and is never execution authorization.
 */
import {
  COST_SNAPSHOT_TTL_MS,
  sanitizeCostError,
  validateCostSnapshot,
  type CostSnapshot,
} from './costSnapshot';
import { MANUAL_CANARY_CAPS } from './manualCanaryCaps';
import {
  DECIMALS_VERIFIED_MAX_AGE_MS,
  getDecimalsCacheSnapshot,
} from './indexTokenDecimals';
import { MARKET_BY_SYMBOL_SERVER } from './gmxMarkets';
import {
  createRelayReadonlyClient,
  type RelayReadonlyClient,
} from './relayReadonlyClient';
import {
  refreshDeploymentReadOnlyEvidence,
} from './relayReadinessRefresh';
import {
  isRelayReadonlyNetworkEnabled,
  type DeploymentVerificationState,
} from './relayActivationStatus';

export const PAPER_READINESS_REFRESH_INTERVAL_MS = 45_000;
export const PAPER_DEPLOYMENT_REFRESH_INTERVAL_MS = 5 * 60_000;
export const PAPER_DEPLOYMENT_EVIDENCE_MAX_AGE_MS = 10 * 60_000;
export const PAPER_COST_HOLDING_HOURS = 1;
export const PAPER_COST_NOTIONAL_USD = 20;

const SYMBOLS = ['BTC', 'ETH'] as const;
const ACCEPTED_DECIMALS_SOURCES = new Set([
  'sdk+onchain',
  'sdk-synthetic+onchain-no-code',
]);
type CanarySymbol = (typeof SYMBOLS)[number];
export type PaperEvidenceDisplayState = 'not_evaluated' | 'verified' | 'stale' | 'failed';

type ManualCanaryReadonlyModule = typeof import('./manualCanaryReadonlyEvidence');
type CanaryRefreshResult = Awaited<
  ReturnType<ManualCanaryReadonlyModule['refreshManualCanaryReadonlyEvidence']>
>;

interface EvidenceAttempt<T> {
  evaluated: boolean;
  lastAttemptAtMs: number | null;
  lastAttemptOk: boolean;
  failureId: string | null;
  detail: string | null;
  lastGood: T | null;
}

interface DecimalsObservation {
  decimals: number;
  source: string;
  tokenAddress: string;
  observedAtMs: number;
}

interface CostObservation {
  snapshot: CostSnapshot;
  effectiveRoundTripCostUsd: number;
  observedAtMs: number;
}

interface RpcObservation {
  chainId: number;
  observedAtMs: number;
}

interface DeploymentObservation {
  manifestVersion: number | null;
  observedAtMs: number;
}

export interface PaperEvidenceMeta {
  state: PaperEvidenceDisplayState;
  attemptedAtMs: number | null;
  observedAtMs: number | null;
  ageMs: number | null;
  fresh: boolean;
  failureId: string | null;
  detail: string | null;
}

export interface PaperDecimalsEvidenceView extends PaperEvidenceMeta {
  decimals: number | null;
  source: string | null;
  tokenAddress: string | null;
}

export interface PaperDeploymentEvidenceView extends PaperEvidenceMeta {
  manifestVersion: number | null;
}

export interface PaperRpcEvidenceView extends PaperEvidenceMeta {
  chainId: number | null;
}

export interface PaperCostReadinessDiagnosticsView {
  failures: Array<{
    component: string;
    sourceId: string;
    failureClass: string;
    peerHost: string | null;
  }>;
  attemptCount: number;
  failoverCount: number;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
}

export interface PaperCostEvidenceView extends PaperEvidenceMeta {
  symbol: CanarySymbol;
  direction: 'LONG';
  notionalUsd: number;
  holdingHours: number;
  capUsd: number;
  positionFeeUsd: number | null;
  executionFeeUsd: number | null;
  estimatedPriceImpactUsd: number | null;
  fundingFeeUsd: number | null;
  borrowingFeeUsd: number | null;
  estimatedExitFeeUsd: number | null;
  estimatedExitPriceImpactUsd: number | null;
  tradingFeesUsd: number | null;
  priceImpactTotalUsd: number | null;
  carryCostUsd: number | null;
  otherCostUsd: number | null;
  effectiveRoundTripCostUsd: number | null;
  totalCostRatePct: number | null;
  capDeltaUsd: number | null;
  capExcessUsd: number | null;
  requiredCostReductionUsd: number | null;
  requiredCostReductionPct: number | null;
  breakEvenGrossMoveUsd: number | null;
  breakEvenGrossMovePct: number | null;
  withinCap: boolean | null;
  blockReason: string | null;
  source: string | null;
  apiTimestamp: string | null;
  fetchedAt: string | null;
  diagnostics: PaperCostReadinessDiagnosticsView;
}

export interface PaperRuntimeReadinessView {
  boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION';
  paperMode: boolean;
  readonlyEnabled: boolean;
  scheduler: {
    running: boolean;
    inFlight: boolean;
    intervalMs: number;
    lastAttemptAtMs: number | null;
    lastCompletedAtMs: number | null;
    lastSuccessAtMs: number | null;
    nextRefreshAtMs: number | null;
    lastFailureId: string | null;
  };
  decimals: Record<CanarySymbol, PaperDecimalsEvidenceView>;
  deployment: PaperDeploymentEvidenceView;
  rpc: PaperRpcEvidenceView;
  costs: Record<CanarySymbol, PaperCostEvidenceView>;
  blockerIds: string[];
  manualActionHolds: Array<{
    id: string;
    requestedAt: string;
    requiredAction: string;
    resumeCondition: string;
  }>;
}

export interface PaperReadinessCycleDeps {
  env: NodeJS.ProcessEnv;
  nowMs(): number;
  refreshCanary(): Promise<CanaryRefreshResult>;
  decimalsSnapshot(nowMs: number): ReturnType<typeof getDecimalsCacheSnapshot>;
  createReadonlyClient(env: NodeJS.ProcessEnv):
    | { ok: true; client: RelayReadonlyClient }
    | { ok: false; reason: string };
  refreshDeployment(args: {
    env: NodeJS.ProcessEnv;
    readonlyClient: RelayReadonlyClient | null;
    nowMs(): number;
  }): Promise<DeploymentVerificationState>;
}

export interface PaperReadinessCycleOptions {
  deps?: Partial<PaperReadinessCycleDeps>;
  forceDeployment?: boolean;
  preloadedCanary?: CanaryRefreshResult;
}

const emptyAttempt = <T>(): EvidenceAttempt<T> => ({
  evaluated: false,
  lastAttemptAtMs: null,
  lastAttemptOk: false,
  failureId: null,
  detail: null,
  lastGood: null,
});

let decimalsState: Record<CanarySymbol, EvidenceAttempt<DecimalsObservation>> = {
  BTC: emptyAttempt(),
  ETH: emptyAttempt(),
};
let costState: Record<CanarySymbol, EvidenceAttempt<CostObservation>> = {
  BTC: emptyAttempt(),
  ETH: emptyAttempt(),
};
const emptyCostDiagnostics = (): PaperCostReadinessDiagnosticsView => ({
  failures: [],
  attemptCount: 0,
  failoverCount: 0,
  lastAttemptAtMs: null,
  lastSuccessAtMs: null,
  lastFailureAtMs: null,
});
let costDiagnosticsState: Record<CanarySymbol, PaperCostReadinessDiagnosticsView> = {
  BTC: emptyCostDiagnostics(),
  ETH: emptyCostDiagnostics(),
};
let deploymentState = emptyAttempt<DeploymentObservation>();
let rpcState = emptyAttempt<RpcObservation>();

let running = false;
let inFlight = false;
let coordinatorInFlight = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let activeCyclePromise: Promise<PaperRuntimeReadinessView> | null = null;
let schedulerGeneration = 0;
let lastAttemptAtMs: number | null = null;
let lastCompletedAtMs: number | null = null;
let lastSuccessAtMs: number | null = null;
let nextRefreshAtMs: number | null = null;
let lastFailureId: string | null = null;

const DEFAULT_DEPS: PaperReadinessCycleDeps = {
  env: process.env,
  nowMs: () => Date.now(),
  refreshCanary: async () => {
    const deps = await import('./manualCanaryReadonlyEvidence');
    return deps.refreshManualCanaryReadonlyEvidence();
  },
  decimalsSnapshot: getDecimalsCacheSnapshot,
  createReadonlyClient: createRelayReadonlyClient,
  refreshDeployment: refreshDeploymentReadOnlyEvidence,
};

const HOLD_REQUESTED_AT = '2026-08-20T13:59:15Z';
const MANUAL_ACTION_HOLDS: PaperRuntimeReadinessView['manualActionHolds'] = [
  {
    id: 'owner_approval',
    requestedAt: HOLD_REQUESTED_AT,
    requiredAction: '현재 owner-wallet payload를 운영자가 명시적으로 승인',
    resumeCondition: '사용자 복귀 후 release SHA, PAPER/LIVE 잠금, payload, deployment 재검증',
  },
  {
    id: 'metamask_signature',
    requestedAt: HOLD_REQUESTED_AT,
    requiredAction: '운영자가 정확한 payload를 직접 검토하고 서명',
    resumeCondition: '최신 보안 상태 재검증 후 wallet 사용 가능 확인',
  },
  {
    id: 'delegated_signer_activation',
    requestedAt: HOLD_REQUESTED_AT,
    requiredAction: 'binding/revocation 검토 후 별도 활성화 승인',
    resumeCondition: '최신 read-only signer/deployment 검사와 명시적 승인',
  },
  {
    id: 'live_canary',
    requestedAt: HOLD_REQUESTED_AT,
    requiredAction: '모든 blocker 해소 후 bounded Canary 별도 승인',
    resumeCondition: '최신 CI/release/deployment/RPC/decimals/cost/stop evidence와 안전 검토',
  },
  {
    id: 'real_orders_funds',
    requestedAt: HOLD_REQUESTED_AT,
    requiredAction: '정확한 주문/자금 action 별도 승인',
    resumeCondition: 'action-specific 승인; 시간 경과로 추정 금지',
  },
];

function evidenceMeta<T extends { observedAtMs: number }>(
  entry: EvidenceAttempt<T>,
  nowMs: number,
  maxAgeMs: number,
): PaperEvidenceMeta {
  const observedAtMs = entry.lastGood?.observedAtMs ?? null;
  const ageMs = observedAtMs === null ? null : Math.max(0, nowMs - observedAtMs);
  let state: PaperEvidenceDisplayState;
  if (!entry.evaluated) state = 'not_evaluated';
  else if (!entry.lastAttemptOk || entry.lastGood === null) state = 'failed';
  else if (ageMs === null || ageMs > maxAgeMs) state = 'stale';
  else state = 'verified';
  return {
    state,
    attemptedAtMs: entry.lastAttemptAtMs,
    observedAtMs,
    ageMs,
    fresh: state === 'verified',
    failureId: state === 'verified' ? null : entry.failureId,
    detail: entry.detail,
  };
}

function setNotEvaluated<T>(
  entry: EvidenceAttempt<T>,
  atMs: number,
  failureId: string,
  detail: string,
): void {
  entry.evaluated = false;
  entry.lastAttemptAtMs = atMs;
  entry.lastAttemptOk = false;
  entry.failureId = failureId;
  entry.detail = detail;
}

function setFailure<T>(
  entry: EvidenceAttempt<T>,
  atMs: number,
  failureId: string,
  detail: string,
): void {
  entry.evaluated = true;
  entry.lastAttemptAtMs = atMs;
  entry.lastAttemptOk = false;
  entry.failureId = failureId;
  entry.detail = detail;
}

function setSuccess<T>(
  entry: EvidenceAttempt<T>,
  atMs: number,
  observation: T,
  detail: string,
): void {
  entry.evaluated = true;
  entry.lastAttemptAtMs = atMs;
  entry.lastAttemptOk = true;
  entry.failureId = null;
  entry.detail = detail;
  entry.lastGood = observation;
}

function findDecimalsObservation(
  symbol: CanarySymbol,
  entries: ReturnType<typeof getDecimalsCacheSnapshot>,
): DecimalsObservation | null {
  const token = MARKET_BY_SYMBOL_SERVER.get(symbol)?.indexToken.toLowerCase();
  if (!token) return null;
  const found = entries.find((entry) =>
    entry.tokenAddress.toLowerCase() === token
    && !entry.stale
    && ACCEPTED_DECIMALS_SOURCES.has(entry.source),
  );
  if (!found) return null;
  return {
    decimals: found.decimals,
    source: found.source,
    tokenAddress: found.tokenAddress,
    observedAtMs: found.verifiedAtMs,
  };
}

function updateCanaryEvidence(
  result: CanaryRefreshResult,
  atMs: number,
  decimalsEntries: ReturnType<typeof getDecimalsCacheSnapshot>,
): boolean {
  let allObserved = true;
  for (const symbol of SYMBOLS) {
    const decimalResult = result.decimals[symbol];
    const decimalObservation = findDecimalsObservation(symbol, decimalsEntries);
    if (decimalResult?.ok && decimalObservation) {
      setSuccess(decimalsState[symbol], atMs, decimalObservation, decimalResult.detail);
    } else {
      allObserved = false;
      setFailure(
        decimalsState[symbol],
        atMs,
        `DECIMALS_${symbol}_UNAVAILABLE`,
        decimalResult?.detail ?? `${symbol} decimals cache evidence 없음`,
      );
    }

    const costResult = result.costs[symbol];
    const reportedDiagnostics = costResult?.diagnostics;
    const previousDiagnostics = costDiagnosticsState[symbol];
    const attemptAtMs = reportedDiagnostics?.attemptedAtMs ?? atMs;
    costDiagnosticsState[symbol] = {
      failures: reportedDiagnostics?.failures.map((failure) => ({ ...failure })) ?? [],
      attemptCount: reportedDiagnostics?.attemptCount ?? 0,
      failoverCount: reportedDiagnostics?.failoverCount ?? 0,
      lastAttemptAtMs: attemptAtMs,
      lastSuccessAtMs: previousDiagnostics.lastSuccessAtMs,
      lastFailureAtMs: previousDiagnostics.lastFailureAtMs,
    };
    if (costResult?.ok) {
      const market = MARKET_BY_SYMBOL_SERVER.get(symbol)?.marketToken;
      const validated = market
        ? validateCostSnapshot(costResult.snapshot, {
          market,
          isLong: true,
          orderType: 'MarketIncrease',
          notionalUsd: PAPER_COST_NOTIONAL_USD,
        }, atMs)
        : { ok: false as const, reason: `${symbol} market registry 없음` };
      const observedAtMs = Date.parse(costResult.snapshot.apiTimestamp ?? '');
      if (validated.ok && Number.isFinite(observedAtMs) && observedAtMs > 0) {
        costDiagnosticsState[symbol].lastSuccessAtMs = attemptAtMs;
        costDiagnosticsState[symbol].failures = [];
        setSuccess(costState[symbol], atMs, {
          snapshot: { ...costResult.snapshot },
          effectiveRoundTripCostUsd: validated.effectiveRoundTripCostUsd,
          observedAtMs,
        }, '공식 GMX read-only 비용 성분 관측 완료');
      } else {
        allObserved = false;
        costDiagnosticsState[symbol].lastFailureAtMs = attemptAtMs;
        if (costDiagnosticsState[symbol].failures.length === 0) {
          costDiagnosticsState[symbol].failures = [{
            component: 'snapshotValidation',
            sourceId: 'EXECUTION_COST_SNAPSHOT',
            failureClass: 'validation',
            peerHost: null,
          }];
        }
        setFailure(
          costState[symbol],
          atMs,
          `COST_${symbol}_INVALID`,
          validated.ok
            ? 'upstream 비용 관측 시각 비정상'
            : sanitizeCostError(validated.reason),
        );
      }
    } else {
      allObserved = false;
      costDiagnosticsState[symbol].lastFailureAtMs = attemptAtMs;
      if (costDiagnosticsState[symbol].failures.length === 0) {
        costDiagnosticsState[symbol].failures = [{
          component: 'unknown',
          sourceId: 'EXECUTION_COST_READINESS',
          failureClass: 'unavailable',
          peerHost: null,
        }];
      }
      setFailure(
        costState[symbol],
        atMs,
        `COST_${symbol}_UNAVAILABLE`,
        sanitizeCostError(costResult?.reason ?? '비용 관측 실패'),
      );
    }
  }
  return allObserved;
}

function deploymentRefreshDue(nowMs: number, force: boolean): boolean {
  if (force) return true;
  return deploymentState.lastAttemptAtMs === null
    || nowMs - deploymentState.lastAttemptAtMs >= PAPER_DEPLOYMENT_REFRESH_INTERVAL_MS;
}

async function updateDeploymentAndRpc(
  deps: PaperReadinessCycleDeps,
  atMs: number,
): Promise<boolean> {
  if (!isRelayReadonlyNetworkEnabled(deps.env)) {
    const detail = 'GMX_RELAY_READONLY_NETWORK_ENABLED 비활성 — 외부 호출 0회';
    setNotEvaluated(deploymentState, atMs, 'DEPLOYMENT_READONLY_DISABLED', detail);
    setNotEvaluated(rpcState, atMs, 'RPC_READONLY_DISABLED', detail);
    return false;
  }

  const clientResult = deps.createReadonlyClient(deps.env);
  if (!clientResult.ok) {
    setFailure(deploymentState, atMs, 'DEPLOYMENT_CLIENT_UNAVAILABLE', 'read-only RPC client 생성 실패');
    setFailure(rpcState, atMs, 'RPC_CLIENT_UNAVAILABLE', 'read-only RPC client 생성 실패');
    return false;
  }

  let rpcOk = false;
  try {
    const chainId = await clientResult.client.getChainId();
    if (chainId === 42161) {
      rpcOk = true;
      setSuccess(rpcState, atMs, { chainId, observedAtMs: atMs }, 'Arbitrum One chainId 42161 확인');
    } else {
      setFailure(rpcState, atMs, 'RPC_CHAIN_MISMATCH', `chainId ${chainId} ≠ 42161`);
    }
  } catch {
    setFailure(rpcState, atMs, 'RPC_READ_FAILED', 'Arbitrum read-only RPC 조회 실패');
  }

  try {
    const result = await deps.refreshDeployment({
      env: deps.env,
      readonlyClient: clientResult.client,
      nowMs: deps.nowMs,
    });
    if (result.attempted && result.ok && result.atMs !== null) {
      setSuccess(deploymentState, atMs, {
        manifestVersion: result.manifestVersion,
        observedAtMs: result.atMs,
      }, 'manifest/router/DataStore/EventEmitter read-only 검증 완료');
      return rpcOk;
    }
    setFailure(
      deploymentState,
      atMs,
      'DEPLOYMENT_VERIFICATION_FAILED',
      result.failures[0] ?? '배포 read-only 검증 실패',
    );
  } catch {
    setFailure(deploymentState, atMs, 'DEPLOYMENT_VERIFICATION_ERROR', '배포 read-only 검증 예외');
  }
  return false;
}

/**
 * One bounded PAPER/read-only cycle. in-flight mutex prevents overlap between
 * timer and any explicit read-only refresh request.
 */
async function performPaperRuntimeReadinessCycle(
  options: PaperReadinessCycleOptions,
  deps: PaperReadinessCycleDeps,
): Promise<PaperRuntimeReadinessView> {
  const atMs = deps.nowMs();

  lastAttemptAtMs = atMs;
  if (deps.env.WORKER_ENGINE_MODE !== 'PAPER') {
    lastCompletedAtMs = atMs;
    lastFailureId = 'PAPER_MODE_REQUIRED';
    return getPaperRuntimeReadinessSnapshot(atMs, deps.env);
  }
  if (deps.env.GMX_API_READONLY_ENABLED !== 'true') {
    lastCompletedAtMs = atMs;
    lastFailureId = 'GMX_API_READONLY_REQUIRED';
    return getPaperRuntimeReadinessSnapshot(atMs, deps.env);
  }

  let canaryOk = false;
  let deploymentOk = true;
  try {
    const canary = options.preloadedCanary ?? await deps.refreshCanary();
    const afterCanaryMs = deps.nowMs();
    canaryOk = updateCanaryEvidence(
      canary,
      afterCanaryMs,
      deps.decimalsSnapshot(afterCanaryMs),
    );
    if (deploymentRefreshDue(afterCanaryMs, options.forceDeployment === true)) {
      deploymentOk = await updateDeploymentAndRpc(deps, afterCanaryMs);
    } else {
      deploymentOk =
        evidenceMeta(
          deploymentState,
          afterCanaryMs,
          PAPER_DEPLOYMENT_EVIDENCE_MAX_AGE_MS,
        ).state === 'verified'
        && evidenceMeta(
          rpcState,
          afterCanaryMs,
          PAPER_DEPLOYMENT_EVIDENCE_MAX_AGE_MS,
        ).state === 'verified';
    }
    const cycleOk = canaryOk && deploymentOk;
    lastCompletedAtMs = deps.nowMs();
    lastFailureId = cycleOk ? null : 'PAPER_READINESS_INCOMPLETE';
    if (cycleOk) lastSuccessAtMs = lastCompletedAtMs;
  } catch {
    lastCompletedAtMs = deps.nowMs();
    lastFailureId = 'PAPER_READINESS_REFRESH_ERROR';
  }
  return getPaperRuntimeReadinessSnapshot(deps.nowMs(), deps.env);
}

/**
 * One bounded PAPER/read-only cycle. All callers join the same active promise,
 * so explicit refreshes and scheduler generations cannot overlap external reads.
 */
export async function runPaperRuntimeReadinessCycle(
  options: PaperReadinessCycleOptions = {},
): Promise<PaperRuntimeReadinessView> {
  const deps: PaperReadinessCycleDeps = { ...DEFAULT_DEPS, ...options.deps };
  if (activeCyclePromise) {
    await activeCyclePromise;
    return getPaperRuntimeReadinessSnapshot(deps.nowMs(), deps.env);
  }

  const cyclePromise = performPaperRuntimeReadinessCycle(options, deps);
  activeCyclePromise = cyclePromise;
  inFlight = true;
  try {
    return await cyclePromise;
  } finally {
    if (activeCyclePromise === cyclePromise) {
      activeCyclePromise = null;
      inFlight = false;
    }
  }
}

export function setPaperRuntimeReadinessCoordinatorInFlight(value: boolean): void {
  coordinatorInFlight = value;
}

function costView(symbol: CanarySymbol, nowMs: number): PaperCostEvidenceView {
  const entry = costState[symbol];
  const meta = evidenceMeta(entry, nowMs, COST_SNAPSHOT_TTL_MS);
  const cap = MANUAL_CANARY_CAPS.maxRoundTripCostUsd;
  const usable = meta.state === 'verified' && entry.lastGood !== null;
  const observation = usable ? entry.lastGood : null;
  const snapshot = observation?.snapshot ?? null;
  const total = observation?.effectiveRoundTripCostUsd ?? null;
  const tradingFees = snapshot
    ? snapshot.positionFeeUsd + snapshot.estimatedExitFeeUsd
    : null;
  const priceImpactTotal = snapshot
    ? snapshot.estimatedPriceImpactUsd + snapshot.estimatedExitPriceImpactUsd
    : null;
  const carryCost = snapshot
    ? snapshot.fundingFeeUsd + snapshot.borrowingFeeUsd
    : null;
  const displayedComponentSum = snapshot && tradingFees !== null
    && priceImpactTotal !== null && carryCost !== null
    ? tradingFees + snapshot.executionFeeUsd + priceImpactTotal + carryCost
    : null;
  const rawOtherCost = total !== null && displayedComponentSum !== null
    ? total - displayedComponentSum
    : null;
  const otherCost = rawOtherCost !== null && Math.abs(rawOtherCost) < 0.00001
    ? 0
    : rawOtherCost;
  const totalCostRatePct = total !== null
    ? (total / PAPER_COST_NOTIONAL_USD) * 100
    : null;
  const capDelta = total !== null ? total - cap : null;
  const capExcess = capDelta !== null ? Math.max(0, capDelta) : null;
  const requiredReductionPct = total !== null && capExcess !== null
    ? (total === 0 ? 0 : (capExcess / total) * 100)
    : null;
  const blockReason = meta.state === 'verified'
    ? (capExcess !== null && capExcess > 0
      ? `${symbol} round-trip 비용이 고정 $${cap.toFixed(2)} cap을 $${capExcess.toFixed(6)} 초과`
      : null)
    : meta.state === 'stale'
      ? `COST_${symbol}_STALE — read-only 비용 snapshot이 만료됨`
      : meta.state === 'failed'
        ? `${meta.failureId ?? `COST_${symbol}_FAILED`} — ${meta.detail ?? '비용 snapshot 검증 실패'}`
        : `COST_${symbol}_NOT_EVALUATED — read-only 비용 snapshot 미평가`;
  return {
    ...meta,
    symbol,
    direction: 'LONG',
    notionalUsd: PAPER_COST_NOTIONAL_USD,
    holdingHours: PAPER_COST_HOLDING_HOURS,
    capUsd: cap,
    positionFeeUsd: snapshot?.positionFeeUsd ?? null,
    executionFeeUsd: snapshot?.executionFeeUsd ?? null,
    estimatedPriceImpactUsd: snapshot?.estimatedPriceImpactUsd ?? null,
    fundingFeeUsd: snapshot?.fundingFeeUsd ?? null,
    borrowingFeeUsd: snapshot?.borrowingFeeUsd ?? null,
    estimatedExitFeeUsd: snapshot?.estimatedExitFeeUsd ?? null,
    estimatedExitPriceImpactUsd: snapshot?.estimatedExitPriceImpactUsd ?? null,
    tradingFeesUsd: tradingFees,
    priceImpactTotalUsd: priceImpactTotal,
    carryCostUsd: carryCost,
    otherCostUsd: otherCost,
    effectiveRoundTripCostUsd: total,
    totalCostRatePct,
    capDeltaUsd: capDelta,
    capExcessUsd: capExcess,
    requiredCostReductionUsd: capExcess,
    requiredCostReductionPct: requiredReductionPct,
    breakEvenGrossMoveUsd: total,
    breakEvenGrossMovePct: totalCostRatePct,
    withinCap: total === null ? null : total <= cap,
    blockReason,
    source: snapshot?.source ?? null,
    apiTimestamp: snapshot?.apiTimestamp ?? null,
    fetchedAt: snapshot?.fetchedAt ?? null,
    diagnostics: {
      ...costDiagnosticsState[symbol],
      failures: costDiagnosticsState[symbol].failures.map((failure) => ({ ...failure })),
    },
  };
}

export function getPaperRuntimeReadinessSnapshot(
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): PaperRuntimeReadinessView {
  const decimals = Object.fromEntries(SYMBOLS.map((symbol) => {
    const entry = decimalsState[symbol];
    const meta = evidenceMeta(entry, nowMs, DECIMALS_VERIFIED_MAX_AGE_MS);
    return [symbol, {
      ...meta,
      decimals: entry.lastGood?.decimals ?? null,
      source: entry.lastGood?.source ?? null,
      tokenAddress: entry.lastGood?.tokenAddress ?? null,
    }];
  })) as Record<CanarySymbol, PaperDecimalsEvidenceView>;

  const costs = {
    BTC: costView('BTC', nowMs),
    ETH: costView('ETH', nowMs),
  };
  const deploymentMeta = evidenceMeta(
    deploymentState,
    nowMs,
    PAPER_DEPLOYMENT_EVIDENCE_MAX_AGE_MS,
  );
  const rpcMeta = evidenceMeta(rpcState, nowMs, PAPER_DEPLOYMENT_EVIDENCE_MAX_AGE_MS);

  const blockerIds: string[] = [];
  if (env.WORKER_ENGINE_MODE !== 'PAPER') blockerIds.push('paper_mode');
  if (env.GMX_API_READONLY_ENABLED !== 'true') blockerIds.push('read_only');
  for (const symbol of SYMBOLS) {
    if (decimals[symbol].state !== 'verified') blockerIds.push(`${symbol.toLowerCase()}_decimals`);
    if (costs[symbol].state !== 'verified') blockerIds.push(`${symbol.toLowerCase()}_cost_snapshot`);
    else if (costs[symbol].withinCap === false) blockerIds.push(`${symbol.toLowerCase()}_cost_cap`);
  }
  if (deploymentMeta.state !== 'verified') blockerIds.push('deployment');
  if (rpcMeta.state !== 'verified') blockerIds.push('rpc');
  blockerIds.push(...MANUAL_ACTION_HOLDS.map((hold) => hold.id));

  return {
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    paperMode: env.WORKER_ENGINE_MODE === 'PAPER',
    readonlyEnabled: env.GMX_API_READONLY_ENABLED === 'true',
    scheduler: {
      running,
      inFlight: inFlight || coordinatorInFlight,
      intervalMs: PAPER_READINESS_REFRESH_INTERVAL_MS,
      lastAttemptAtMs,
      lastCompletedAtMs,
      lastSuccessAtMs,
      nextRefreshAtMs,
      lastFailureId,
    },
    decimals,
    deployment: {
      ...deploymentMeta,
      manifestVersion: deploymentState.lastGood?.manifestVersion ?? null,
    },
    rpc: {
      ...rpcMeta,
      chainId: rpcState.lastGood?.chainId ?? null,
    },
    costs,
    blockerIds: [...new Set(blockerIds)],
    manualActionHolds: MANUAL_ACTION_HOLDS.map((hold) => ({ ...hold })),
  };
}

function scheduleNext(
  generation: number,
  options: PaperReadinessCycleOptions,
): void {
  if (!running || generation !== schedulerGeneration) return;
  nextRefreshAtMs = Date.now() + PAPER_READINESS_REFRESH_INTERVAL_MS;
  timer = setTimeout(() => {
    if (!running || generation !== schedulerGeneration) return;
    timer = null;
    nextRefreshAtMs = null;
    launchScheduledCycle(generation, options);
  }, PAPER_READINESS_REFRESH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function launchScheduledCycle(
  generation: number,
  options: PaperReadinessCycleOptions,
): void {
  if (!running || generation !== schedulerGeneration) return;
  const scheduledRun = options.deps
    ? runPaperRuntimeReadinessCycle(options)
    : import('./gmxApiReadinessCoordinator')
      .then(({ runGmxApiReadinessRefresh }) =>
        runGmxApiReadinessRefresh({
          forceDeployment: options.forceDeployment,
        }))
      .then((result) => result.paperRuntimeReadiness);
  void scheduledRun
    .catch(() => undefined)
    .finally(() => scheduleNext(generation, options));
}

export function startPaperRuntimeReadinessScheduler(
  options: PaperReadinessCycleOptions = {},
): void {
  if (running) return;
  running = true;
  const generation = ++schedulerGeneration;
  if (activeCyclePromise) {
    void activeCyclePromise.finally(() => launchScheduledCycle(generation, options));
    return;
  }
  launchScheduledCycle(generation, options);
}

export function stopPaperRuntimeReadinessScheduler(): void {
  running = false;
  schedulerGeneration += 1;
  nextRefreshAtMs = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function __resetPaperRuntimeReadinessForTests(): void {
  stopPaperRuntimeReadinessScheduler();
  coordinatorInFlight = false;
  decimalsState = { BTC: emptyAttempt(), ETH: emptyAttempt() };
  costState = { BTC: emptyAttempt(), ETH: emptyAttempt() };
  costDiagnosticsState = { BTC: emptyCostDiagnostics(), ETH: emptyCostDiagnostics() };
  deploymentState = emptyAttempt();
  rpcState = emptyAttempt();
  lastAttemptAtMs = null;
  lastCompletedAtMs = null;
  lastSuccessAtMs = null;
  lastFailureId = null;
}
