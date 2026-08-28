/**
 * Manual Canary 실행 적격 비용 adapter.
 * SHADOW Intel의 순수 계산기/readonly parser만 재사용하며, 실행 모듈 의존성은
 * lib 쪽에 둬 Intel의 구조적 SHADOW_ONLY 경계를 유지한다.
 */
import { createProductionFetchers } from '../intel/dataSource';
import { buildCandidateCostBreakdown } from '../intel/costEngine';
import { createGmxCostReader, createProductionCostReaderClient } from '../intel/gmxCostReader';
import type { CostBreakdownUsd } from '../intel/candidate';
import { getCachedPrices, getCachedChange24h, fetchGmxCandles } from '../routes/gmx';
import { lookupSdkIndexToken, ARBITRUM_CHAIN_ID } from './indexTokenDecimals';
import {
  createGmxApiTransport,
  type GmxApiErrorKind,
  type GmxApiResult,
} from './gmxApiTransport';
import { EXECUTION_ELIGIBLE_MAX_AGE_MS } from './costSnapshot';

export type CostReadinessFailureClass =
  | 'config'
  | 'timeout'
  | 'network'
  | '4xx'
  | '429'
  | '5xx'
  | 'decode'
  | 'rpc'
  | 'cache'
  | 'validation'
  | 'unavailable';

export interface CostReadinessComponentFailure {
  component: string;
  sourceId: string;
  failureClass: CostReadinessFailureClass;
  httpStatus: number | null;
  peerHost: string | null;
  peerPath: string[];
}

export interface CostReadinessSourceTrace {
  sourceId: string;
  attempts: Array<{
    peerHost: string;
    failureClass: CostReadinessFailureClass | null;
    httpStatus: number | null;
  }>;
  attemptCount: number;
  retryCount: number;
  failoverCount: number;
}

export interface CostReadinessAttemptDiagnostics {
  firstFailure: CostReadinessComponentFailure | null;
  failures: CostReadinessComponentFailure[];
  sourceTraces: CostReadinessSourceTrace[];
  attemptCount: number;
  retryCount: number;
  failoverCount: number;
  attemptedAtMs: number;
  components?: CostReadinessComponentDiagnostic[];
}

export type CostReadinessComponentState =
  | 'SUCCESS'
  | 'FAILED'
  | 'MISSING'
  | 'STALE';

export interface CostReadinessComponentDiagnostic {
  componentId:
    | 'TICKERS'
    | 'MARKETS_INFO'
    | 'SDK_PRICE_IMPACT'
    | 'FUNDING'
    | 'BORROWING';
  sourceId:
    | 'GMX_API_MARKETS_TICKERS'
    | 'GMX_API_MARKETS_INFO'
    | 'GMX_SDK_PRICE_IMPACT';
  state: CostReadinessComponentState;
  code: string;
  observedAtMs: number | null;
  ageMs: number | null;
  fresh: boolean;
}

export function oldestRequiredImpactObservedAtMs(
  marketsInfoObservedAtMs: number | null | undefined,
  indexPriceObservedAtMs: number | null | undefined,
): number | null {
  return typeof marketsInfoObservedAtMs === 'number'
    && Number.isFinite(marketsInfoObservedAtMs)
    && marketsInfoObservedAtMs > 0
    && typeof indexPriceObservedAtMs === 'number'
    && Number.isFinite(indexPriceObservedAtMs)
    && indexPriceObservedAtMs > 0
    ? Math.min(marketsInfoObservedAtMs, indexPriceObservedAtMs)
    : null;
}

export interface FreshExecutionCostObservation {
  breakdown: CostBreakdownUsd;
  diagnostics: CostReadinessAttemptDiagnostics;
}

function publicFailureClass(kind: GmxApiErrorKind): CostReadinessFailureClass {
  if (kind === 'rate_limited') return '429';
  if (kind === 'http_5xx') return '5xx';
  if (kind === 'http_4xx') return '4xx';
  return kind;
}

function missingCostComponents(cost: CostBreakdownUsd): string[] {
  const missing: string[] = [];
  if (cost.entryFeeUsd === null) missing.push('entryFee');
  if (cost.estimatedExitFeeUsd === null) missing.push('exitFee');
  if (cost.fundingCostUsd === null) missing.push('funding');
  if (cost.borrowingCostUsd === null) missing.push('borrowing');
  if (cost.priceImpactUsd === null || cost.impactDetail === null) missing.push('priceImpact');
  if (cost.gasExecutionFeeUsd === null) missing.push('gasExecution');
  if (cost.costSnapshotFetchedAtMs === null) missing.push('costSnapshotFetchedAt');
  return missing;
}

function peerPath(result: GmxApiResult<unknown> | undefined): string[] {
  if (!result) return [];
  const traced = result.attemptTrace?.map((attempt) => attempt.peerHost) ?? [];
  return traced.length > 0
    ? traced
    : result.peerHost === null ? [] : [result.peerHost];
}

function failure(args: {
  component: string;
  sourceId: string;
  fallbackClass: CostReadinessFailureClass;
  apiResult?: GmxApiResult<unknown>;
}): CostReadinessComponentFailure {
  const apiResult = args.apiResult;
  return {
    component: args.component,
    sourceId: args.sourceId,
    failureClass: apiResult && !apiResult.ok
      ? publicFailureClass(apiResult.kind)
      : args.fallbackClass,
    httpStatus: apiResult?.httpStatus ?? null,
    peerHost: apiResult?.peerHost ?? null,
    peerPath: peerPath(apiResult),
  };
}

function latestApiResult(
  attempts: Array<{ path: string; result: GmxApiResult<unknown> }>,
  path: string,
): GmxApiResult<unknown> | undefined {
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    if (attempts[i].path === path) return attempts[i].result;
  }
  return undefined;
}

function toSourceTrace(
  sourceId: string,
  result: GmxApiResult<unknown>,
): CostReadinessSourceTrace {
  const attempts = result.attemptTrace?.map((attempt) => ({
    peerHost: attempt.peerHost,
    failureClass: attempt.kind === null ? null : publicFailureClass(attempt.kind),
    httpStatus: attempt.httpStatus,
  })) ?? [];
  return {
    sourceId,
    attempts,
    attemptCount: result.attemptCount ?? attempts.length,
    retryCount: result.retryCount ?? 0,
    failoverCount: result.failoverCount ?? 0,
  };
}

export function classifyCostReadinessComponent(args: {
  componentId: CostReadinessComponentDiagnostic['componentId'];
  sourceId: CostReadinessComponentDiagnostic['sourceId'];
  apiResult?: GmxApiResult<unknown>;
  available: boolean;
  observedAtMs: number | null | undefined;
  nowMs: number;
}): CostReadinessComponentDiagnostic {
  const observedAtMs = typeof args.observedAtMs === 'number'
    && Number.isFinite(args.observedAtMs)
    && args.observedAtMs > 0
    ? args.observedAtMs
    : null;
  const ageMs = observedAtMs === null ? null : args.nowMs - observedAtMs;
  const stale = ageMs !== null
    && (ageMs < 0 || ageMs > EXECUTION_ELIGIBLE_MAX_AGE_MS);
  const failed = args.apiResult !== undefined && !args.apiResult.ok;
  const state: CostReadinessComponentState = failed
    ? 'FAILED'
    : !args.available || observedAtMs === null
      ? 'MISSING'
      : stale
        ? 'STALE'
        : 'SUCCESS';
  const suffix = failed && args.apiResult && !args.apiResult.ok
    ? publicFailureClass(args.apiResult.kind).toUpperCase()
    : state;
  return {
    componentId: args.componentId,
    sourceId: args.sourceId,
    state,
    code: `COST_${args.componentId}_${suffix}`,
    observedAtMs,
    ageMs,
    fresh: state === 'SUCCESS',
  };
}

export async function buildFreshExecutionCostBreakdown(args: {
  marketToken: string;
  symbol: string;
  isLong: boolean;
  notionalUsd: number;
  holdingHours: number;
}): Promise<CostBreakdownUsd | null> {
  const observation = await buildFreshExecutionCostObservation(args);
  return observation?.breakdown ?? null;
}

export async function buildFreshExecutionCostObservation(args: {
  marketToken: string;
  symbol: string;
  isLong: boolean;
  notionalUsd: number;
  holdingHours: number;
}): Promise<FreshExecutionCostObservation | null> {
  const attemptedAtMs = Date.now();
  const transport = createGmxApiTransport(process.env);
  if (!transport.readonlyEnabled) return null;
  const apiAttempts: Array<{ path: string; result: GmxApiResult<unknown> }> = [];
  const fresh = createProductionFetchers({
    getCachedPrices,
    getCachedChange24h,
    fetchGmxCandles,
    fetchOfficialJson: async (path) => {
      const apiPath = path.startsWith('/v1/') ? path.slice(3) : path;
      const r = await transport.getJson(apiPath);
      apiAttempts.push({ path, result: r });
      return r.ok
        ? { ok: true, data: r.data }
        : { ok: false, rateLimited: r.kind === 'rate_limited' };
    },
  });
  const reader = createGmxCostReader({ client: createProductionCostReaderClient() });
  const nowMs = Date.now();
  const [feeParams, rates, ethTick, impactInputs, indexTick] = await Promise.all([
    reader.readMarketFeeParams(args.marketToken, nowMs),
    fresh.fetchers.fetchMarketCostInputs?.(args.marketToken) ?? Promise.resolve(null),
    fresh.fetchers.fetchPrice('ETH'),
    fresh.fetchers.fetchMarketImpactInputs?.(args.marketToken) ?? Promise.resolve(null),
    fresh.fetchers.fetchPrice(args.symbol),
  ]);
  const sdkIdx = lookupSdkIndexToken(ARBITRUM_CHAIN_ID, args.marketToken);
  const breakdown = buildCandidateCostBreakdown({
    marketToken: args.marketToken,
    isLong: args.isLong,
    notionalUsd: args.notionalUsd,
    holdingHours: args.holdingHours,
    feeParams,
    rates,
    ethPriceUsd: ethTick?.price ?? null,
    ethPriceObservedAtMs: ethTick?.observedAtMs ?? null,
    impact: {
      inputs: impactInputs,
      indexTokenDecimals: sdkIdx.ok ? sdkIdx.sdkDecimals : null,
      sdkIndexTokenAddress: sdkIdx.ok ? sdkIdx.indexTokenAddress : null,
      indexPriceUsd: indexTick?.price ?? null,
      indexPriceObservedAtMs: indexTick?.observedAtMs ?? null,
    },
    nowMs,
  });
  const missing = missingCostComponents(breakdown);
  const tickersResult = latestApiResult(apiAttempts, '/v1/markets/tickers');
  const marketsInfoResult = latestApiResult(apiAttempts, '/v1/markets/info');
  const impactObservedAtMs = oldestRequiredImpactObservedAtMs(
    impactInputs?.observedAtMs,
    indexTick?.observedAtMs,
  );
  const failures: CostReadinessComponentFailure[] = [];

  // 실제 prerequisite 순서로만 기록한다. downstream null 성분을 중복 원인으로
  // 나열하지 않아 firstFailure가 항상 한 개의 결정적 원인을 가리키게 한다.
  if (feeParams === null) {
    failures.push(failure({
      component: 'feeParams',
      sourceId: 'RPC_DATASTORE',
      fallbackClass: 'rpc',
    }));
  }
  if (rates === null) {
    failures.push(failure({
      component: 'fundingBorrowingRates',
      sourceId: 'GMX_API_MARKETS_TICKERS',
      fallbackClass: 'validation',
      apiResult: tickersResult,
    }));
  }
  if (ethTick === null) {
    failures.push(failure({
      component: 'ethPrice',
      sourceId: 'ETH_PRICE_CACHE',
      fallbackClass: 'cache',
    }));
  }
  if (impactInputs === null) {
    failures.push(failure({
      component: 'impactInputs',
      sourceId: 'GMX_API_MARKETS_INFO',
      fallbackClass: 'validation',
      apiResult: marketsInfoResult,
    }));
  }
  if (!sdkIdx.ok) {
    failures.push(failure({
      component: 'indexTokenRegistry',
      sourceId: 'SDK_MARKET_REGISTRY',
      fallbackClass: 'validation',
    }));
  }
  if (indexTick === null) {
    failures.push(failure({
      component: 'indexPrice',
      sourceId: 'INDEX_PRICE_CACHE',
      fallbackClass: 'cache',
    }));
  }

  if (failures.length === 0) {
    for (const component of missing) {
      const apiResult = component === 'funding' || component === 'borrowing'
        ? tickersResult
        : component === 'priceImpact' ? marketsInfoResult : undefined;
      const sourceId = component === 'funding' || component === 'borrowing'
        ? 'GMX_API_MARKETS_TICKERS'
        : component === 'priceImpact'
          ? 'GMX_API_MARKETS_INFO'
          : component === 'costSnapshotFetchedAt'
            ? 'COST_COMPONENT_TIMESTAMPS'
            : 'COST_ENGINE';
      failures.push(failure({
        component,
        sourceId,
        fallbackClass: 'validation',
        apiResult,
      }));
    }
  }

  const sourceTraces = apiAttempts.map(({ path, result }) =>
    toSourceTrace(
      path === '/v1/markets/tickers'
        ? 'GMX_API_MARKETS_TICKERS'
        : path === '/v1/markets/info'
          ? 'GMX_API_MARKETS_INFO'
          : 'GMX_API_READONLY',
      result,
    ));
  const attempts = apiAttempts.map(({ result }) => result);
  const components: CostReadinessComponentDiagnostic[] = [
    classifyCostReadinessComponent({
      componentId: 'TICKERS',
      sourceId: 'GMX_API_MARKETS_TICKERS',
      apiResult: tickersResult,
      available: rates !== null,
      observedAtMs: rates?.observedAtMs,
      nowMs,
    }),
    classifyCostReadinessComponent({
      componentId: 'MARKETS_INFO',
      sourceId: 'GMX_API_MARKETS_INFO',
      apiResult: marketsInfoResult,
      available: impactInputs !== null,
      observedAtMs: impactInputs?.observedAtMs,
      nowMs,
    }),
    classifyCostReadinessComponent({
      componentId: 'SDK_PRICE_IMPACT',
      sourceId: 'GMX_SDK_PRICE_IMPACT',
      available: breakdown.impactDetail !== null
        && breakdown.impactDetail !== undefined
        && impactInputs !== null
        && indexTick !== null,
      observedAtMs: impactObservedAtMs,
      nowMs,
    }),
    classifyCostReadinessComponent({
      componentId: 'FUNDING',
      sourceId: 'GMX_API_MARKETS_TICKERS',
      apiResult: tickersResult,
      available: rates !== null && breakdown.fundingCostUsd !== null,
      observedAtMs: rates?.observedAtMs,
      nowMs,
    }),
    classifyCostReadinessComponent({
      componentId: 'BORROWING',
      sourceId: 'GMX_API_MARKETS_TICKERS',
      apiResult: tickersResult,
      available: rates !== null && breakdown.borrowingCostUsd !== null,
      observedAtMs: rates?.observedAtMs,
      nowMs,
    }),
  ];
  return {
    breakdown,
    diagnostics: {
      firstFailure: failures[0] ? { ...failures[0], peerPath: [...failures[0].peerPath] } : null,
      failures: failures.map((entry) => ({ ...entry, peerPath: [...entry.peerPath] })),
      sourceTraces,
      attemptCount: attempts.reduce((sum, result) => sum + (result.attemptCount ?? 0), 0),
      retryCount: attempts.reduce((sum, result) => sum + (result.retryCount ?? 0), 0),
      failoverCount: attempts.reduce((sum, result) => sum + (result.failoverCount ?? 0), 0),
      attemptedAtMs,
      components,
    },
  };
}
