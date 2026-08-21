/**
 * Manual Canary/PAPER 공용 read-only evidence adapter.
 *
 * 이 모듈은 공개 GMX/RPC read만 수행한다. DB/Drizzle, signer, execution
 * intent/relay lifecycle, order/close, protection, AI worker, execution-evidence
 * writer, owner approval capability를 import하거나 노출하지 않는다.
 */
import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';

import {
  fetchLiveCostSnapshot,
  validateExecutionEligibleSnapshot,
  type CostSnapshot,
  type FetchedCostFields,
} from './costSnapshot';
import {
  ARBITRUM_CHAIN_ID,
  resolveIndexTokenDecimals,
} from './indexTokenDecimals';
import { MARKET_BY_SYMBOL_SERVER } from './gmxMarkets';
import {
  buildFreshExecutionCostObservation,
  type CostReadinessAttemptDiagnostics,
} from './manualCanaryCostFetcher';

export const MANUAL_CANARY_READONLY_SYMBOLS = ['BTC', 'ETH'] as const;
export type ManualCanaryReadonlySymbol = (typeof MANUAL_CANARY_READONLY_SYMBOLS)[number];

export interface ReadonlyCheckOutcome {
  ok: boolean;
  detail: string;
}

export interface ManualCanaryReadonlyEvidence {
  decimals: Record<string, ReadonlyCheckOutcome>;
  costs: Record<string,
    | { ok: true; reason: null; snapshot: CostSnapshot; roundTripCostUsd: number; diagnostics?: CostReadinessAttemptDiagnostics }
    | { ok: false; reason: string; snapshot: null; roundTripCostUsd: null; diagnostics?: CostReadinessAttemptDiagnostics }
  >;
}

export type ManualCanaryReadonlyCostResult =
  | { ok: true; snapshot: CostSnapshot; roundTripCostUsd: number; diagnostics?: CostReadinessAttemptDiagnostics }
  | { ok: false; reason: string; diagnostics?: CostReadinessAttemptDiagnostics };

export interface ManualCanaryReadonlyReaders {
  resolveDecimals(symbol: string): Promise<ReadonlyCheckOutcome>;
  fetchCost(args: {
    symbol: string;
    isLong: boolean;
    notionalUsd: number;
  }): Promise<ManualCanaryReadonlyCostResult>;
}

const outcome = (ok: boolean, detail: string): ReadonlyCheckOutcome => ({ ok, detail });

let injectedCostFetcher: ((args: {
  market: string;
  symbol: string;
  isLong: boolean;
  notionalUsd: number;
}) => Promise<FetchedCostFields>) | null = null;
let injectedReadonlyReaders: Partial<ManualCanaryReadonlyReaders> | null = null;

export function __setManualCanaryCostFetcherForTests(
  fetcher: typeof injectedCostFetcher,
): void {
  injectedCostFetcher = fetcher;
}

export function __setManualCanaryReadonlyReadersForTests(
  readers: Partial<ManualCanaryReadonlyReaders> | null,
): void {
  injectedReadonlyReaders = readers;
}

async function fetchMeasuredCanaryCosts(args: {
  market: string;
  symbol: string;
  isLong: boolean;
  notionalUsd: number;
}, onDiagnostics?: (diagnostics: CostReadinessAttemptDiagnostics) => void): Promise<FetchedCostFields> {
  if (injectedCostFetcher) return injectedCostFetcher(args);
  const observation = await buildFreshExecutionCostObservation({
    marketToken: args.market,
    symbol: args.symbol,
    isLong: args.isLong,
    notionalUsd: args.notionalUsd,
    holdingHours: 1,
  });
  const cost = observation?.breakdown ?? null;
  if (observation) onDiagnostics?.(observation.diagnostics);
  const impact = cost?.impactDetail;
  const required = [
    cost?.entryFeeUsd,
    cost?.estimatedExitFeeUsd,
    cost?.fundingCostUsd,
    cost?.borrowingCostUsd,
    cost?.gasExecutionFeeUsd,
    cost?.costSnapshotFetchedAtMs,
  ];
  if (!cost || !impact || required.some((value) =>
    typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('공식 GMX 비용 성분 일부 미확보 — 실행 적격 스냅샷 생성 금지');
  }
  return {
    positionFeeUsd: cost.entryFeeUsd!,
    executionFeeUsd: cost.gasExecutionFeeUsd!,
    estimatedPriceImpactUsd: Math.max(0, -impact.entryImpactUsd),
    fundingFeeUsd: cost.fundingCostUsd!,
    borrowingFeeUsd: cost.borrowingCostUsd!,
    estimatedExitFeeUsd: cost.estimatedExitFeeUsd!,
    estimatedExitPriceImpactUsd: Math.max(0, -impact.exitImpactUsd),
    fundingRatePerHourFraction: cost.fundingCostUsd! / args.notionalUsd,
    borrowingRatePerHourFraction: cost.borrowingCostUsd! / args.notionalUsd,
    blockNumber: null,
    apiTimestamp: new Date(cost.costSnapshotFetchedAtMs!).toISOString(),
  };
}

async function fetchOnchainErc20Decimals(tokenAddress: string): Promise<number | null> {
  const url = process.env.GMX_RPC_URL?.trim();
  if (!url) return null;
  try {
    const client = createPublicClient({
      chain: arbitrum,
      transport: http(url, { timeout: 8_000 }),
    });
    if (await client.getChainId() !== ARBITRUM_CHAIN_ID) return null;
    const value = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: [{
        type: 'function',
        name: 'decimals',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint8' }],
      }],
      functionName: 'decimals',
    });
    return typeof value === 'number' ? value : Number(value);
  } catch {
    return null;
  }
}

async function fetchOnchainCodePresence(tokenAddress: string): Promise<boolean | null> {
  const url = process.env.GMX_RPC_URL?.trim();
  if (!url) return null;
  try {
    const client = createPublicClient({
      chain: arbitrum,
      transport: http(url, { timeout: 8_000 }),
    });
    if (await client.getChainId() !== ARBITRUM_CHAIN_ID) return null;
    const code = await client.getBytecode({
      address: tokenAddress as `0x${string}`,
    });
    return code !== undefined && code !== '0x';
  } catch {
    return null;
  }
}

export async function resolveCanarySymbolDecimals(
  symbol: string,
): Promise<ReadonlyCheckOutcome> {
  const market = MARKET_BY_SYMBOL_SERVER.get(symbol);
  if (!market) return outcome(false, `${symbol} 시장 미확인`);
  try {
    const result = await resolveIndexTokenDecimals({
      chainId: ARBITRUM_CHAIN_ID,
      marketAddress: market.marketToken,
      fetchOnchainDecimals: fetchOnchainErc20Decimals,
      fetchOnchainCode: fetchOnchainCodePresence,
    });
    return result.ok
      ? outcome(true, `${symbol} SDK+온체인 교차검증 완료`)
      : outcome(false, `${symbol}: ${result.reason}`);
  } catch {
    return outcome(false, `${symbol} decimals 검증 실패 (fail-closed)`);
  }
}

export async function fetchManualCanaryReadonlyCost(args: {
  symbol: string;
  isLong: boolean;
  notionalUsd: number;
}): Promise<ManualCanaryReadonlyCostResult> {
  const market = MARKET_BY_SYMBOL_SERVER.get(args.symbol);
  if (!market) return { ok: false, reason: '시장 미확인' };
  let diagnostics: CostReadinessAttemptDiagnostics | undefined;
  const result = await fetchLiveCostSnapshot(
    {
      market: market.marketToken,
      isLong: args.isLong,
      orderType: 'MarketIncrease',
      notionalUsd: args.notionalUsd,
      now: new Date(),
    },
    {
      readonlyEnabled: process.env.GMX_API_READONLY_ENABLED === 'true',
      fetchCosts: ({ market: marketAddress, isLong, notionalUsd }) =>
        fetchMeasuredCanaryCosts({
          market: marketAddress,
          symbol: args.symbol,
          isLong,
          notionalUsd,
        }, (value) => { diagnostics = value; }),
    },
  );
  if (!result.ok) return { ok: false, reason: result.reason, diagnostics };
  const expected = {
    market: market.marketToken,
    isLong: args.isLong,
    orderType: 'MarketIncrease' as const,
    notionalUsd: args.notionalUsd,
  };
  const validated = validateExecutionEligibleSnapshot(
    result.snapshot,
    expected,
    Date.now(),
  );
  if (!validated.ok) return { ok: false, reason: validated.reason, diagnostics };
  return {
    ok: true,
    snapshot: result.snapshot,
    roundTripCostUsd: validated.effectiveRoundTripCostUsd,
    diagnostics,
  };
}

export async function refreshManualCanaryReadonlyEvidence(
): Promise<ManualCanaryReadonlyEvidence> {
  const decimals: ManualCanaryReadonlyEvidence['decimals'] = {};
  const costs: ManualCanaryReadonlyEvidence['costs'] = {};
  const decimalsReader =
    injectedReadonlyReaders?.resolveDecimals ?? resolveCanarySymbolDecimals;
  const costReader =
    injectedReadonlyReaders?.fetchCost ?? fetchManualCanaryReadonlyCost;
  for (const symbol of MANUAL_CANARY_READONLY_SYMBOLS) {
    decimals[symbol] = await decimalsReader(symbol);
    const cost = await costReader({
      symbol,
      isLong: true,
      notionalUsd: 20,
    });
    costs[symbol] = cost.ok
      ? {
        ok: true,
        reason: null,
        snapshot: cost.snapshot,
        roundTripCostUsd: cost.roundTripCostUsd,
        diagnostics: cost.diagnostics,
      }
      : {
        ok: false,
        reason: cost.reason,
        snapshot: null,
        roundTripCostUsd: null,
        diagnostics: cost.diagnostics,
      };
  }
  return { decimals, costs };
}
