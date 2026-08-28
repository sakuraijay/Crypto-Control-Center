/**
 * Task #144 — PAPER runtime diagnostics safety and fail-closed state mapping.
 *
 * All network-facing capabilities are injected. No real RPC/API/DB call occurs.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetPaperRuntimeReadinessForTests,
  clearPaperEconomicEdgeEvidence,
  getPaperEconomicEdgeEvidenceSnapshot,
  getPaperRuntimeReadinessSnapshot,
  PAPER_DEPLOYMENT_EVIDENCE_MAX_AGE_MS,
  runPaperRuntimeReadinessCycle,
  setPaperEconomicEdgeEvidenceFromIntelCycle,
  startPaperRuntimeReadinessScheduler,
  stopPaperRuntimeReadinessScheduler,
} from '../lib/paperRuntimeReadiness';
import {
  __resetExecutionEligibleCostEvidenceForTests,
  getExecutionEligibleCostEvidence,
  type CostSnapshot,
} from '../lib/costSnapshot';
import { MARKET_BY_SYMBOL_SERVER } from '../lib/gmxMarkets';
import { INTEL_MEASURED_COST_SOURCE } from '../intel/costEngine';
import { COST_SOURCE_PIN } from '../intel/dataSource';
import type { RelayReadonlyClient } from '../lib/relayReadonlyClient';

const NOW = 1_777_000_000_000;
const ENV = {
  WORKER_ENGINE_MODE: 'PAPER',
  GMX_API_READONLY_ENABLED: 'true',
  GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
} as NodeJS.ProcessEnv;

function costSnapshot(symbol: 'BTC' | 'ETH'): CostSnapshot {
  const observedAtMs = NOW - 4_000;
  return {
    market: MARKET_BY_SYMBOL_SERVER.get(symbol)!.marketToken,
    isLong: true,
    orderType: 'MarketIncrease',
    notionalUsd: 20,
    positionFeeUsd: 0.012,
    executionFeeUsd: 0.428188,
    estimatedPriceImpactUsd: 0,
    fundingFeeUsd: 0.000461,
    borrowingFeeUsd: 0.000363,
    estimatedExitFeeUsd: 0.012,
    estimatedExitPriceImpactUsd: 0,
    totalEstimatedRoundTripCostUsd: 0.453012,
    source: 'GMX_API',
    blockNumber: null,
    apiTimestamp: new Date(observedAtMs).toISOString(),
    fetchedAt: new Date(observedAtMs).toISOString(),
    expiresAt: new Date(observedAtMs + 60_000).toISOString(),
    fundingRatePerHourFraction: 0.000461 / 20,
    borrowingRatePerHourFraction: 0.000363 / 20,
  };
}

function canaryResult(options: {
  btcSource?: string;
  omitEthDecimals?: boolean;
  costFailures?: ReadonlyArray<'BTC' | 'ETH'>;
} = {}) {
  const costResult = (symbol: 'BTC' | 'ETH') => {
    if (!options.costFailures?.includes(symbol)) {
      return {
        ok: true as const,
        reason: null,
        snapshot: costSnapshot(symbol),
        roundTripCostUsd: 0.453012,
      };
    }
    const failedPrerequisite = {
      component: 'fundingBorrowingRates',
      sourceId: 'GMX_API_MARKETS_TICKERS',
      failureClass: '5xx' as const,
      httpStatus: 503,
      peerHost: 'arbitrum.gmxapi.ai',
      peerPath: ['arbitrum.gmxapi.io', 'arbitrum.gmxapi.ai'],
    };
    return {
      ok: false as const,
      reason: 'COST_DATA_UNAVAILABLE',
      snapshot: null,
      roundTripCostUsd: null,
      diagnostics: {
        firstFailure: { ...failedPrerequisite, peerPath: [...failedPrerequisite.peerPath] },
        failures: [{ ...failedPrerequisite, peerPath: [...failedPrerequisite.peerPath] }],
        sourceTraces: [{
          sourceId: 'GMX_API_MARKETS_TICKERS',
          attempts: [
            { peerHost: 'arbitrum.gmxapi.io', failureClass: '5xx' as const, httpStatus: 503 },
            { peerHost: 'arbitrum.gmxapi.ai', failureClass: '5xx' as const, httpStatus: 503 },
          ],
          attemptCount: 2,
          retryCount: 0,
          failoverCount: 1,
        }],
        attemptCount: 2,
        retryCount: 0,
        failoverCount: 1,
        attemptedAtMs: NOW - 500,
      },
    };
  };
  return {
    decimals: {
      BTC: { ok: true, detail: 'BTC verified' },
      ETH: { ok: true, detail: 'ETH verified' },
    },
    costs: {
      BTC: costResult('BTC'),
      ETH: costResult('ETH'),
    },
    decimalsSnapshot: [
      {
        key: 'btc',
        decimals: 8,
        source: options.btcSource ?? 'sdk-synthetic+onchain-no-code',
        tokenAddress: MARKET_BY_SYMBOL_SERVER.get('BTC')!.indexToken,
        verifiedAtMs: NOW - 3_000,
        ageMs: 3_000,
        stale: false,
      },
      ...(options.omitEthDecimals ? [] : [{
        key: 'eth',
        decimals: 18,
        source: 'sdk+onchain',
        tokenAddress: MARKET_BY_SYMBOL_SERVER.get('ETH')!.indexToken,
        verifiedAtMs: NOW - 3_000,
        ageMs: 3_000,
        stale: false,
      }]),
    ],
  };
}

function readonlyClient(chainId = 42161): RelayReadonlyClient {
  return {
    getChainId: vi.fn(async () => chainId),
    getCode: vi.fn(async () => '0x1234' as `0x${string}`),
    getGasPrice: vi.fn(async () => 1n),
    getTransactionReceipt: vi.fn(async () => ({})),
    getLogs: vi.fn(async () => []),
    getBlockTimestamp: vi.fn(async () => 1n),
    readContract: vi.fn(async () => 0n),
  };
}

function depsFrom(result = canaryResult()) {
  const client = readonlyClient();
  return {
    env: ENV,
    nowMs: () => NOW,
    refreshCanary: vi.fn(async () => ({
      decimals: result.decimals,
      costs: result.costs,
    })),
    decimalsSnapshot: vi.fn(() => result.decimalsSnapshot),
    createReadonlyClient: vi.fn(() => ({ ok: true as const, client })),
    refreshDeployment: vi.fn(async () => ({
      attempted: true,
      atMs: NOW - 2_000,
      ok: true,
      manifestVersion: 1,
      basis: ['verified'],
      failures: [],
    })),
  };
}

beforeEach(() => {
  __resetPaperRuntimeReadinessForTests();
  __resetExecutionEligibleCostEvidenceForTests();
});

afterEach(() => {
  __resetPaperRuntimeReadinessForTests();
});

describe('PAPER runtime readiness cycle', () => {
  it('PAPER/read-only gate가 꺼지면 외부 read callback도 0회다', async () => {
    const deps = depsFrom();
    deps.env = {
      ...ENV,
      WORKER_ENGINE_MODE: 'LIVE',
      GMX_API_READONLY_ENABLED: 'false',
    };

    const status = await runPaperRuntimeReadinessCycle({ deps });

    expect(deps.refreshCanary).not.toHaveBeenCalled();
    expect(deps.createReadonlyClient).not.toHaveBeenCalled();
    expect(deps.refreshDeployment).not.toHaveBeenCalled();
    expect(status.scheduler.lastFailureId).toBe('PAPER_MODE_REQUIRED');
    expect(status.decimals.BTC.state).toBe('not_evaluated');
    expect(status.costs.BTC.state).toBe('not_evaluated');
  });

  it('BTC/ETH decimals와 deployment/RPC를 검증하고 $0.453011 > $0.40을 차단한다', async () => {
    const deps = depsFrom();

    const status = await runPaperRuntimeReadinessCycle({
      deps,
      forceDeployment: true,
    });

    expect(status.boundary).toBe('READ_ONLY_NOT_EXECUTION_AUTHORIZATION');
    expect(status.decimals.BTC).toMatchObject({
      state: 'verified',
      decimals: 8,
      source: 'sdk-synthetic+onchain-no-code',
    });
    expect(status.decimals.ETH).toMatchObject({
      state: 'verified',
      decimals: 18,
      source: 'sdk+onchain',
    });
    expect(status.deployment.state).toBe('verified');
    expect(status.rpc).toMatchObject({ state: 'verified', chainId: 42161 });
    expect(status.costs.BTC.effectiveRoundTripCostUsd).toBe(0.453012);
    expect(status.costs.BTC.evidenceRole).toBe('OBSERVATIONAL_READ_ONLY');
    expect(status.costs.BTC.observationalFresh).toBe(true);
    expect(status.costs.BTC.capUsd).toBe(0.4);
    expect(status.costs.BTC.capDeltaUsd).toBeCloseTo(0.053012, 6);
    expect(status.costs.BTC.capExcessUsd).toBeCloseTo(0.053012, 6);
    expect(status.costs.BTC.capExcessRatePct).toBeCloseTo((0.053012 / 0.4) * 100, 8);
    expect(status.costs.BTC.totalCostRatePct).toBeCloseTo((0.453012 / 20) * 100, 8);
    expect(status.costs.BTC.requiredCostReductionUsd).toBeCloseTo(0.053012, 6);
    expect(status.costs.BTC.requiredCostReductionPct).toBeCloseTo((0.053012 / 0.453012) * 100, 8);
    expect(status.costs.BTC.breakEvenGrossMoveUsd).toBe(0.453012);
    expect(status.costs.BTC.breakEvenGrossMovePct).toBeCloseTo((0.453012 / 20) * 100, 8);
    expect(status.costs.BTC.tradingFeesUsd).toBe(0.024);
    expect(status.costs.BTC.priceImpactTotalUsd).toBe(0);
    expect(status.costs.BTC.carryCostUsd).toBeCloseTo(0.000824, 9);
    expect(status.costs.BTC.otherCostUsd).toBe(0);
    expect(status.costs.BTC.withinCap).toBe(false);
    expect(status.costs.BTC.blockReason).toContain('고정 $0.40 cap');
    expect(status.costs.BTC.executionSnapshot).toMatchObject({
      fresh: true,
      eligible: false,
      authorized: false,
      maxAgeMs: 30_000,
      failureId: 'COST_BTC_CAP_EXCEEDED',
    });
    expect(status.costs.BTC.executionSnapshot.blockReason).toContain('OPEN/Canary fail-closed 차단');
    expect(status.economics.BTC).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'EXPECTED_GROSS_EDGE_UNAVAILABLE',
      candidateNotionalUsd: 20,
      technicalMinimumNotionalUsd: 2.2,
    });
    expect(status.economics.ETH).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'EXPECTED_GROSS_EDGE_UNAVAILABLE',
      candidateNotionalUsd: 20,
    });
    expect(status.blockerIds).toContain('btc_cost_cap');

    // Diagnostic cache must never create execution-eligible authorization.
    expect(getExecutionEligibleCostEvidence(NOW)).toEqual({
      fresh: false,
      evidence: null,
    });
  });

  it('accepted current Intel LONG candidate edge makes BTC/ETH economics available and expires/resets fail-closed', async () => {
    await runPaperRuntimeReadinessCycle({ deps: depsFrom(), forceDeployment: true });
    setPaperEconomicEdgeEvidenceFromIntelCycle({
      cycleId: 'intel-current',
      recordNowMs: NOW,
      generation: 1,
      decision: 'NO_TRADE',
      candidates: (['BTC', 'ETH'] as const).map((symbol) => ({
        symbol,
        direction: 'LONG',
        decision: 'SHADOW_ONLY',
        dataQuality: 'GOOD',
        finalNotionalUsd: 20,
        expectedGrossWinUsd: 1,
        totalExpectedCostUsd: 0.2,
        cost: {
          holdingHoursAssumed: 1,
          costSnapshotFetchedAtMs: NOW - 4_000,
          costSource: INTEL_MEASURED_COST_SOURCE,
          sourcePin: COST_SOURCE_PIN,
          entryFeeUsd: 0.01, estimatedExitFeeUsd: 0.01, fundingCostUsd: 0.01,
          borrowingCostUsd: 0.01, priceImpactUsd: 0, slippageUsd: 0,
          gasExecutionFeeUsd: 0.1, latencyRiskReserveUsd: 0, failureRiskReserveUsd: 0,
        },
      })),
    });
    const current = getPaperRuntimeReadinessSnapshot(NOW, ENV);
    expect(current.economics.BTC).toMatchObject({
      state: 'AVAILABLE', candidateNotionalUsd: 20, expectedGrossEdgeUsd: 1,
    });
    expect(current.economics.ETH.state).toBe('AVAILABLE');

    // A fresh, valid edge may still not justify extrapolating the $20 quote.
    setPaperEconomicEdgeEvidenceFromIntelCycle({
      cycleId: 'intel-too-small-edge',
      recordNowMs: NOW,
      generation: 2,
      decision: 'NO_TRADE',
      candidates: (['BTC', 'ETH'] as const).map((symbol) => ({
        symbol, direction: 'LONG', decision: 'SHADOW_ONLY', dataQuality: 'GOOD',
        finalNotionalUsd: 20, expectedGrossWinUsd: 0.2, totalExpectedCostUsd: 0.2,
        cost: {
          holdingHoursAssumed: 1, costSnapshotFetchedAtMs: NOW - 4_000,
          costSource: INTEL_MEASURED_COST_SOURCE, sourcePin: COST_SOURCE_PIN,
          entryFeeUsd: 0.01, estimatedExitFeeUsd: 0.01, fundingCostUsd: 0.01,
          borrowingCostUsd: 0.01, priceImpactUsd: 0, slippageUsd: 0,
          gasExecutionFeeUsd: 0.1, latencyRiskReserveUsd: 0, failureRiskReserveUsd: 0,
        },
      })),
    });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.BTC).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'ECONOMIC_MINIMUM_OUTSIDE_EVIDENCE_DOMAIN',
    });

    expect(getPaperRuntimeReadinessSnapshot(NOW + 60_001, ENV).economics.BTC).toMatchObject({
      state: 'UNAVAILABLE', reason: 'EXPECTED_GROSS_EDGE_UNAVAILABLE',
    });
    clearPaperEconomicEdgeEvidence();
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.ETH.state).toBe('UNAVAILABLE');
  });

  it('rejects stale, mismatched, and invalid Intel candidate evidence', () => {
    const bad = (overrides: Record<string, unknown>) => setPaperEconomicEdgeEvidenceFromIntelCycle({
      cycleId: 'intel-bad', recordNowMs: NOW, generation: 1, decision: 'SELECTED',
      candidates: [{
        symbol: 'BTC', direction: 'LONG', decision: 'SHADOW_ONLY', dataQuality: 'GOOD',
        finalNotionalUsd: 20, expectedGrossWinUsd: 1, totalExpectedCostUsd: 0.2,
        cost: {
          holdingHoursAssumed: 1, costSnapshotFetchedAtMs: NOW - 1_000, costSource: INTEL_MEASURED_COST_SOURCE,
          sourcePin: COST_SOURCE_PIN,
          entryFeeUsd: 0.01, estimatedExitFeeUsd: 0.01, fundingCostUsd: 0.01,
          borrowingCostUsd: 0.01, priceImpactUsd: 0, slippageUsd: 0,
          gasExecutionFeeUsd: 0.1, latencyRiskReserveUsd: 0, failureRiskReserveUsd: 0,
        },
        ...overrides,
      }] as never,
    });
    bad({ direction: 'SHORT' });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.BTC.state).toBe('UNAVAILABLE');
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toBeNull();
    bad({ dataQuality: 'DEGRADED' });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.BTC.state).toBe('UNAVAILABLE');
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toBeNull();
    bad({ dataQuality: 'INVALID' });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.BTC.state).toBe('UNAVAILABLE');
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toBeNull();
    bad({ dataQuality: 'UNAVAILABLE' });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.BTC.state).toBe('UNAVAILABLE');
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toBeNull();
    bad({ cost: {
      holdingHoursAssumed: 1, costSnapshotFetchedAtMs: NOW - 1_000, costSource: 'SPOOFED',
      sourcePin: COST_SOURCE_PIN,
      entryFeeUsd: 0.01, estimatedExitFeeUsd: 0.01, fundingCostUsd: 0.01,
      borrowingCostUsd: 0.01, priceImpactUsd: 0, slippageUsd: 0,
      gasExecutionFeeUsd: 0.1, latencyRiskReserveUsd: 0, failureRiskReserveUsd: 0,
    } });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.BTC.state).toBe('UNAVAILABLE');
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toBeNull();
    bad({ cost: {
      holdingHoursAssumed: 1, costSnapshotFetchedAtMs: NOW - 1_000, costSource: INTEL_MEASURED_COST_SOURCE,
      sourcePin: null,
      entryFeeUsd: 0.01, estimatedExitFeeUsd: 0.01, fundingCostUsd: 0.01,
      borrowingCostUsd: 0.01, priceImpactUsd: 0, slippageUsd: 0,
      gasExecutionFeeUsd: 0.1, latencyRiskReserveUsd: 0, failureRiskReserveUsd: 0,
    } });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.BTC.state).toBe('UNAVAILABLE');
    expect(getPaperEconomicEdgeEvidenceSnapshot('BTC')).toBeNull();
    bad({ finalNotionalUsd: Number.NaN });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.BTC.state).toBe('UNAVAILABLE');
    bad({ cost: {
      holdingHoursAssumed: 1, costSnapshotFetchedAtMs: NOW - 60_001, costSource: INTEL_MEASURED_COST_SOURCE,
      sourcePin: COST_SOURCE_PIN,
      entryFeeUsd: 0.01, estimatedExitFeeUsd: 0.01, fundingCostUsd: 0.01,
      borrowingCostUsd: 0.01, priceImpactUsd: 0, slippageUsd: 0,
      gasExecutionFeeUsd: 0.1, latencyRiskReserveUsd: 0, failureRiskReserveUsd: 0,
    } });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.BTC.state).toBe('UNAVAILABLE');
    setPaperEconomicEdgeEvidenceFromIntelCycle({
      cycleId: 'blocked', recordNowMs: NOW, generation: 1, decision: 'BLOCKED', candidates: [],
    });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).economics.BTC.state).toBe('UNAVAILABLE');
  });

  it('wrong source와 partial decimals evidence는 verified로 승격하지 않는다', async () => {
    const result = canaryResult({
      btcSource: 'cache-only',
      omitEthDecimals: true,
    });
    const status = await runPaperRuntimeReadinessCycle({
      deps: depsFrom(result),
      forceDeployment: true,
    });

    expect(status.decimals.BTC).toMatchObject({
      state: 'failed',
      failureId: 'DECIMALS_BTC_UNAVAILABLE',
    });
    expect(status.decimals.ETH).toMatchObject({
      state: 'failed',
      failureId: 'DECIMALS_ETH_UNAVAILABLE',
    });
    expect(status.blockerIds).toEqual(expect.arrayContaining([
      'btc_decimals',
      'eth_decimals',
    ]));
  });

  it('not-evaluated, verified, stale, failed 상태를 구분한다', async () => {
    const initial = getPaperRuntimeReadinessSnapshot(NOW, ENV);
    expect(initial.deployment.state).toBe('not_evaluated');
    expect(initial.rpc.state).toBe('not_evaluated');

    const deps = depsFrom();
    const verified = await runPaperRuntimeReadinessCycle({
      deps,
      forceDeployment: true,
    });
    expect(verified.deployment.state).toBe('verified');
    expect(verified.rpc.state).toBe('verified');

    const stale = getPaperRuntimeReadinessSnapshot(
      NOW + PAPER_DEPLOYMENT_EVIDENCE_MAX_AGE_MS + 1,
      ENV,
    );
    expect(stale.deployment.state).toBe('stale');
    expect(stale.rpc.state).toBe('stale');
    expect(stale.costs.BTC.state).toBe('stale');
    expect(stale.costs.BTC).toMatchObject({
      observationalFresh: false,
      capUsd: null,
      effectiveRoundTripCostUsd: null,
      totalCostRatePct: null,
      capExcessUsd: null,
      capExcessRatePct: null,
      requiredCostReductionUsd: null,
      requiredCostReductionPct: null,
      breakEvenGrossMoveUsd: null,
      breakEvenGrossMovePct: null,
      positionFeeUsd: null,
      source: null,
    });
    expect(stale.costs.BTC.blockReason).toContain('COST_BTC_STALE');
    expect(stale.costs.BTC.executionSnapshot).toMatchObject({
      fresh: false,
      eligible: false,
      authorized: false,
      failureId: 'COST_BTC_EXECUTION_SNAPSHOT_INELIGIBLE',
    });

    __resetPaperRuntimeReadinessForTests();
    const failedDeps = depsFrom();
    const failed = await runPaperRuntimeReadinessCycle({
      deps: {
        ...failedDeps,
        createReadonlyClient: vi.fn(() => ({
          ok: false as const,
          reason: 'unavailable',
        })),
      },
      forceDeployment: true,
    });
    expect(failed.deployment.state).toBe('failed');
    expect(failed.rpc.state).toBe('failed');
  });

  it('relay read-only flag가 꺼지면 deployment/RPC는 실패가 아니라 미평가이며 RPC 0회다', async () => {
    const deps = depsFrom();
    deps.env = {
      ...ENV,
      GMX_RELAY_READONLY_NETWORK_ENABLED: 'false',
    };

    const status = await runPaperRuntimeReadinessCycle({
      deps,
      forceDeployment: true,
    });

    expect(deps.createReadonlyClient).not.toHaveBeenCalled();
    expect(deps.refreshDeployment).not.toHaveBeenCalled();
    expect(status.deployment).toMatchObject({
      state: 'not_evaluated',
      failureId: 'DEPLOYMENT_READONLY_DISABLED',
    });
    expect(status.rpc).toMatchObject({
      state: 'not_evaluated',
      failureId: 'RPC_READONLY_DISABLED',
    });
  });

  it('invalid cost snapshot은 파생값 전체를 비우고 fail-closed 차단 사유만 남긴다', async () => {
    const result = canaryResult();
    const btcCost = result.costs.BTC;
    if (!btcCost.ok || !btcCost.snapshot) throw new Error('BTC fixture snapshot required');
    btcCost.snapshot.positionFeeUsd = Number.NaN;

    const status = await runPaperRuntimeReadinessCycle({
      deps: depsFrom(result),
      forceDeployment: true,
    });

    expect(status.costs.BTC.state).toBe('failed');
    expect(status.costs.BTC.failureId).toBe('COST_BTC_INVALID');
    expect(status.costs.BTC).toMatchObject({
      capUsd: null,
      positionFeeUsd: null,
      executionFeeUsd: null,
      effectiveRoundTripCostUsd: null,
      totalCostRatePct: null,
      capExcessUsd: null,
      requiredCostReductionUsd: null,
      requiredCostReductionPct: null,
      breakEvenGrossMoveUsd: null,
      breakEvenGrossMovePct: null,
      withinCap: null,
      source: null,
    });
    expect(status.costs.BTC.blockReason).toContain('COST_BTC_INVALID');
    expect(status.blockerIds).toContain('btc_cost_snapshot');
    expect(getExecutionEligibleCostEvidence(NOW).fresh).toBe(false);
  });

  it('금액을 포함한 notional 결속 실패도 공개 사유에서는 금액을 제거한다', async () => {
    const result = canaryResult();
    const btcCost = result.costs.BTC;
    if (!btcCost.ok || !btcCost.snapshot) throw new Error('BTC fixture snapshot required');
    btcCost.snapshot.notionalUsd = 1;

    const status = await runPaperRuntimeReadinessCycle({
      deps: depsFrom(result),
      forceDeployment: true,
    });
    const btc = status.costs.BTC;

    expect(btc.state).toBe('failed');
    expect(btc.failureId).toBe('COST_BTC_INVALID');
    expect(btc.effectiveRoundTripCostUsd).toBeNull();
    expect(btc.capUsd).toBeNull();
    expect(btc.capExcessUsd).toBeNull();
    expect(btc.blockReason).toBe(
      'COST_BTC_INVALID — read-only 비용 snapshot 검증 실패 (금액 비공개, fail-closed)',
    );
    expect(btc.blockReason).not.toContain('$');
    expect(btc.executionSnapshot.blockReason).not.toContain('$');
  });

  it('비용 실패 성분·안전한 source·응답 분류·failover와 시각을 보존한다', async () => {
    const status = await runPaperRuntimeReadinessCycle({
      deps: depsFrom(canaryResult({ costFailures: ['BTC'] })),
      forceDeployment: true,
    });

    expect(status.costs.BTC).toMatchObject({
      state: 'failed',
      capUsd: null,
      effectiveRoundTripCostUsd: null,
      capDeltaUsd: null,
      withinCap: null,
      diagnostics: {
        firstFailure: {
          component: 'fundingBorrowingRates',
          sourceId: 'GMX_API_MARKETS_TICKERS',
          failureClass: '5xx',
          httpStatus: 503,
          peerHost: 'arbitrum.gmxapi.ai',
          peerPath: ['arbitrum.gmxapi.io', 'arbitrum.gmxapi.ai'],
        },
        failures: [{
          component: 'fundingBorrowingRates',
          sourceId: 'GMX_API_MARKETS_TICKERS',
          failureClass: '5xx',
          httpStatus: 503,
          peerHost: 'arbitrum.gmxapi.ai',
          peerPath: ['arbitrum.gmxapi.io', 'arbitrum.gmxapi.ai'],
        }],
        sourceTraces: [{
          sourceId: 'GMX_API_MARKETS_TICKERS',
          attempts: [
            { peerHost: 'arbitrum.gmxapi.io', failureClass: '5xx', httpStatus: 503 },
            { peerHost: 'arbitrum.gmxapi.ai', failureClass: '5xx', httpStatus: 503 },
          ],
          attemptCount: 2,
          retryCount: 0,
          failoverCount: 1,
        }],
        attemptCount: 2,
        retryCount: 0,
        failoverCount: 1,
        lastAttemptAtMs: NOW - 500,
        lastSuccessAtMs: null,
        lastFailureAtMs: NOW - 500,
      },
    });
    expect(status.costs.ETH).toMatchObject({
      state: 'verified',
      capUsd: 0.4,
      effectiveRoundTripCostUsd: 0.453012,
      diagnostics: {
        firstFailure: null,
        failures: [],
      },
    });
  });

  it('BTC-only, ETH-only, 동시 실패를 symbol별로 독립 보존한다', async () => {
    for (const failedSymbols of [
      ['BTC'] as const,
      ['ETH'] as const,
      ['BTC', 'ETH'] as const,
    ]) {
      __resetPaperRuntimeReadinessForTests();
      const status = await runPaperRuntimeReadinessCycle({
        deps: depsFrom(canaryResult({ costFailures: failedSymbols })),
        forceDeployment: true,
      });
      for (const symbol of ['BTC', 'ETH'] as const) {
        if (failedSymbols.includes(symbol as never)) {
          expect(status.costs[symbol]).toMatchObject({
            state: 'failed',
            capUsd: null,
            effectiveRoundTripCostUsd: null,
            withinCap: null,
          });
        } else {
          expect(status.costs[symbol]).toMatchObject({
            state: 'verified',
            capUsd: 0.4,
            effectiveRoundTripCostUsd: 0.453012,
          });
        }
      }
    }
  });

  it('corrupt 진단 입력은 allowlist 밖 값을 폐기하고 금액/cap을 fail-closed로 유지한다', async () => {
    const result = canaryResult({ costFailures: ['BTC'] });
    const btc = result.costs.BTC;
    if (btc.ok) throw new Error('BTC failure fixture required');
    (btc as unknown as { reason: string; diagnostics: unknown }).reason =
      'token=SHOULD_NOT_LEAK https://evil.example/path?secret=value';
    (btc as unknown as { reason: string; diagnostics: unknown }).diagnostics = {
      failures: [{
        component: 'token=SHOULD_NOT_LEAK',
        sourceId: 'https://evil.example/path?secret=value',
        failureClass: 'credential_error',
        httpStatus: 999,
        peerHost: 'evil.example',
        peerPath: ['evil.example'],
      }],
      sourceTraces: [{
        sourceId: 'https://evil.example',
        attempts: [{ peerHost: 'evil.example', failureClass: 'secret', httpStatus: 999 }],
        attemptCount: 999,
        retryCount: 999,
        failoverCount: 999,
      }],
      attemptCount: 999,
      retryCount: 999,
      failoverCount: 999,
      attemptedAtMs: Number.POSITIVE_INFINITY,
    };

    const status = await runPaperRuntimeReadinessCycle({
      deps: depsFrom(result),
      forceDeployment: true,
    });

    expect(status.costs.BTC).toMatchObject({
      state: 'failed',
      capUsd: null,
      effectiveRoundTripCostUsd: null,
      capDeltaUsd: null,
      withinCap: null,
      diagnostics: {
        firstFailure: {
          component: 'unknown',
          sourceId: 'EXECUTION_COST_READINESS',
          failureClass: 'unavailable',
          httpStatus: null,
          peerHost: null,
          peerPath: [],
        },
        sourceTraces: [],
        attemptCount: 16,
        retryCount: 16,
        failoverCount: 16,
        lastAttemptAtMs: NOW,
      },
    });
    const serialized = JSON.stringify(status.costs.BTC);
    expect(serialized).not.toContain('SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('secret=value');
  });

  it('stop→restart 중 진행 중 cycle을 보존하고 외부 read를 겹치지 않는다', async () => {
    const result = canaryResult();
    let releaseFirst: (() => void) | null = null;
    let activeReads = 0;
    let maxActiveReads = 0;
    let callCount = 0;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const deps = depsFrom(result);
    deps.refreshCanary = vi.fn(async () => {
      callCount += 1;
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      if (callCount === 1) await firstRead;
      activeReads -= 1;
      return {
        decimals: result.decimals,
        costs: result.costs,
      };
    });

    startPaperRuntimeReadinessScheduler({ deps, forceDeployment: true });
    await vi.waitFor(() => expect(deps.refreshCanary).toHaveBeenCalledTimes(1));
    stopPaperRuntimeReadinessScheduler();
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).scheduler.inFlight).toBe(true);

    startPaperRuntimeReadinessScheduler({ deps, forceDeployment: true });
    expect(deps.refreshCanary).toHaveBeenCalledTimes(1);
    releaseFirst!();

    await vi.waitFor(() => expect(deps.refreshCanary).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).scheduler.inFlight).toBe(false);
    });
    stopPaperRuntimeReadinessScheduler();
    expect(maxActiveReads).toBe(1);
  });

  it('동시 explicit refresh 호출은 하나의 active cycle에 합류한다', async () => {
    const result = canaryResult();
    let releaseRead: (() => void) | null = null;
    let activeReads = 0;
    let maxActiveReads = 0;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const deps = depsFrom(result);
    deps.refreshCanary = vi.fn(async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await readGate;
      activeReads -= 1;
      return {
        decimals: result.decimals,
        costs: result.costs,
      };
    });

    const first = runPaperRuntimeReadinessCycle({ deps, forceDeployment: true });
    await vi.waitFor(() => expect(deps.refreshCanary).toHaveBeenCalledTimes(1));
    const joined = [
      runPaperRuntimeReadinessCycle({ deps, forceDeployment: true }),
      runPaperRuntimeReadinessCycle({ deps, forceDeployment: true }),
    ];

    expect(deps.refreshCanary).toHaveBeenCalledTimes(1);
    releaseRead!();
    const statuses = await Promise.all([first, ...joined]);

    expect(deps.refreshCanary).toHaveBeenCalledTimes(1);
    expect(maxActiveReads).toBe(1);
    expect(statuses.every((status) =>
      status.boundary === 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION')).toBe(true);
    expect(getExecutionEligibleCostEvidence(NOW)).toEqual({
      fresh: false,
      evidence: null,
    });
  });

  it('process reset 뒤 scheduler가 evidence를 한 번만 안전하게 재구성한다', async () => {
    const deps = depsFrom();
    await runPaperRuntimeReadinessCycle({ deps, forceDeployment: true });
    expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).deployment.state).toBe('verified');

    __resetPaperRuntimeReadinessForTests();
    const cold = getPaperRuntimeReadinessSnapshot(NOW, ENV);
    expect(cold.deployment.state).toBe('not_evaluated');
    expect(cold.rpc.state).toBe('not_evaluated');
    expect(cold.scheduler.running).toBe(false);
    expect(cold.costs.BTC).toMatchObject({
      state: 'not_evaluated',
      capUsd: null,
      effectiveRoundTripCostUsd: null,
      diagnostics: {
        firstFailure: null,
        failures: [],
        sourceTraces: [],
        attemptCount: 0,
        retryCount: 0,
        failoverCount: 0,
        lastAttemptAtMs: null,
        lastSuccessAtMs: null,
        lastFailureAtMs: null,
      },
    });

    startPaperRuntimeReadinessScheduler({ deps, forceDeployment: true });
    startPaperRuntimeReadinessScheduler({ deps, forceDeployment: true });
    await vi.waitFor(() => {
      expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).scheduler.inFlight).toBe(false);
      expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).deployment.state).toBe('verified');
    });
    stopPaperRuntimeReadinessScheduler();

    expect(deps.refreshCanary).toHaveBeenCalledTimes(2);
    expect(deps.refreshDeployment).toHaveBeenCalledTimes(2);
    expect(getExecutionEligibleCostEvidence(NOW)).toEqual({
      fresh: false,
      evidence: null,
    });
  });

  it('실패 후 명시적 retry도 이전 cycle 종료 뒤 한 번만 수행한다', async () => {
    const result = canaryResult();
    let activeReads = 0;
    let maxActiveReads = 0;
    const deps = depsFrom(result);
    deps.refreshCanary = vi.fn()
      .mockImplementationOnce(async () => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        activeReads -= 1;
        throw new Error('injected readonly failure');
      })
      .mockImplementationOnce(async () => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        activeReads -= 1;
        return {
          decimals: result.decimals,
          costs: result.costs,
        };
      });

    const failed = await runPaperRuntimeReadinessCycle({ deps, forceDeployment: true });
    expect(failed.scheduler.lastFailureId).toBe('PAPER_READINESS_REFRESH_ERROR');

    const retried = await Promise.all([
      runPaperRuntimeReadinessCycle({ deps, forceDeployment: true }),
      runPaperRuntimeReadinessCycle({ deps, forceDeployment: true }),
    ]);

    expect(deps.refreshCanary).toHaveBeenCalledTimes(2);
    expect(maxActiveReads).toBe(1);
    expect(retried.every((status) => status.deployment.state === 'verified')).toBe(true);
    expect(getExecutionEligibleCostEvidence(NOW).fresh).toBe(false);
  });

  it('거부된 shared cycle 뒤 scheduler generation을 정확히 한 번 시작하고 unhandled rejection을 만들지 않는다', async () => {
    const result = canaryResult();
    const deps = depsFrom(result);
    const nowMs = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('injected pre-cycle failure');
      })
      .mockReturnValue(NOW);
    deps.nowMs = nowMs;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const failedSharedCycle = runPaperRuntimeReadinessCycle({
        deps,
        forceDeployment: true,
      });
      expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).scheduler.inFlight).toBe(true);

      startPaperRuntimeReadinessScheduler({ deps, forceDeployment: true });
      await expect(failedSharedCycle).rejects.toThrow('injected pre-cycle failure');
      await vi.waitFor(() => {
        expect(deps.refreshCanary).toHaveBeenCalledTimes(1);
        expect(getPaperRuntimeReadinessSnapshot(NOW, ENV).scheduler.inFlight).toBe(false);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(deps.refreshDeployment).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      stopPaperRuntimeReadinessScheduler();
    }
  });
});

describe('structural safety contract', () => {
  it('scheduler module에 DB writer·signer·preflight·execution capability가 없다', () => {
    const source = readFileSync(
      new URL('../lib/paperRuntimeReadiness.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/@workspace\/db/);
    expect(source).not.toMatch(/\bdb\.(insert|update|delete)\b/);
    expect(source).not.toMatch(/^import\s+(?!type\b).*from\s+['"]\.\/manualCanary(?:Deps)?['"];?$/m);
    expect(source).toContain("import { MANUAL_CANARY_CAPS } from './manualCanaryCaps'");
    expect(source).not.toMatch(/recordExecutionEligibleCostEvidence/);
    expect(source).not.toMatch(/initializeDelegatedSigner|decrypt|runGmxLivePreflight/);
    expect(source).not.toMatch(/prepareOrder|submitOrder|executeLiveTestOrder|fundTransfer/);
    expect(source).not.toMatch(/readyForControlledCanary|stopExecutionAvailable|refreshStopExecutionCapability/);
    expect(source).toContain("import('./manualCanaryReadonlyEvidence')");
    expect(source).not.toContain("import('./manualCanaryDeps')");
  });

  it('PAPER readonly adapter import graph root에 DB/signer/execution modules가 없다', () => {
    const source = readFileSync(
      new URL('../lib/manualCanaryReadonlyEvidence.ts', import.meta.url),
      'utf8',
    );
    const imports = (source.match(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm) ?? [])
      .join('\n');
    expect(imports).not.toMatch(
      /@workspace\/db|drizzle|delegatedSigner|executionIntent|relayLifecycle|liveTestExecutor|protectionExecutor|aiWorker|executionEvidence|ownerApproval|manualCanaryDeps/,
    );
    expect(source).not.toMatch(
      /\b(?:db\.(?:insert|update|delete)|recordExecutionEligibleCostEvidence|prepare|submit|placeOrder|closePosition)\s*\(/,
    );
    expect(source).toContain('fetchLiveCostSnapshot');
    expect(source).toContain('resolveIndexTokenDecimals');
  });

  it('readiness route는 execution-heavy manualCanaryDeps에서 evidence를 import하지 않는다', () => {
    const source = readFileSync(
      new URL('../routes/gmxapi.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("from '../lib/gmxApiReadinessCoordinator'");
    expect(source).not.toContain("from '../lib/manualCanaryDeps'");
  });
});
