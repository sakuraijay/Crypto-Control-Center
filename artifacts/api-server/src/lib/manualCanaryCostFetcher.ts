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
import { createGmxApiTransport } from './gmxApiTransport';

export async function buildFreshExecutionCostBreakdown(args: {
  marketToken: string;
  symbol: string;
  isLong: boolean;
  notionalUsd: number;
  holdingHours: number;
}): Promise<CostBreakdownUsd | null> {
  const transport = createGmxApiTransport(process.env);
  if (!transport.readonlyEnabled) return null;
  const fresh = createProductionFetchers({
    getCachedPrices,
    getCachedChange24h,
    fetchGmxCandles,
    fetchOfficialJson: async (path) => {
      const apiPath = path.startsWith('/v1/') ? path.slice(3) : path;
      const r = await transport.getJson(apiPath);
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
  return buildCandidateCostBreakdown({
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
}