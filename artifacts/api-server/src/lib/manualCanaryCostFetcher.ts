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
  peerHost: string | null;
}

export interface CostReadinessAttemptDiagnostics {
  failures: CostReadinessComponentFailure[];
  attemptCount: number;
  failoverCount: number;
  attemptedAtMs: number;
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

function sourceForComponent(component: string): string {
  if (component === 'funding' || component === 'borrowing') return 'GMX_API_MARKETS_TICKERS';
  if (component === 'priceImpact') return 'GMX_API_MARKETS_INFO+PRICE_CACHE+SDK';
  if (component === 'gasExecution') return 'RPC_DATASTORE+ETH_PRICE_CACHE';
  if (component === 'costSnapshotFetchedAt') return 'COST_COMPONENT_TIMESTAMPS';
  return 'RPC_DATASTORE';
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
  const apiAttempts = new Map<string, GmxApiResult<unknown>>();
  const fresh = createProductionFetchers({
    getCachedPrices,
    getCachedChange24h,
    fetchGmxCandles,
    fetchOfficialJson: async (path) => {
      const apiPath = path.startsWith('/v1/') ? path.slice(3) : path;
      const r = await transport.getJson(apiPath);
      apiAttempts.set(path, r);
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
  const failures = missing.map((component): CostReadinessComponentFailure => {
    const sourceId = sourceForComponent(component);
    const apiResult = component === 'funding' || component === 'borrowing'
      ? apiAttempts.get('/v1/markets/tickers')
      : component === 'priceImpact'
        ? apiAttempts.get('/v1/markets/info')
        : undefined;
    if (apiResult && !apiResult.ok) {
      return {
        component,
        sourceId,
        failureClass: publicFailureClass(apiResult.kind),
        peerHost: apiResult.peerHost,
      };
    }
    return {
      component,
      sourceId,
      failureClass: sourceId.startsWith('RPC_') ? 'rpc'
        : sourceId.includes('PRICE_CACHE') ? 'cache'
          : 'validation',
      peerHost: null,
    };
  });
  const attempts = [...apiAttempts.values()];
  return {
    breakdown,
    diagnostics: {
      failures,
      attemptCount: attempts.reduce((sum, result) => sum + (result.attemptCount ?? 0), 0),
      failoverCount: attempts.reduce((sum, result) => sum + (result.failoverCount ?? 0), 0),
      attemptedAtMs,
    },
  };
}
