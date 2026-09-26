import { describe, expect, it } from 'vitest';
import type { SignalEligibilityDecision } from '../intel/signalLifecycleV2';
import {
  evaluateStrategyNetEdgeResearch,
  STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
  type StrategyNetEdgeCostEvidence,
} from '../intel/strategyNetEdgeResearchGateV1';
import type { StrategySignal } from '../intel/strategySignalV2';

const NOW = Date.parse('2026-09-05T00:00:00.000Z');

function cost(options: {
  holdingHorizonHours?: number;
  observedAtMs?: number;
  expiresAtMs?: number;
  tradingBps?: number;
  fundingBps?: number;
  borrowingBps?: number;
  impactBps?: number;
  networkBps?: number;
} = {}): StrategyNetEdgeCostEvidence {
  const notionalUsd = 1_000;
  const holdingHorizonHours = options.holdingHorizonHours ?? 12;
  const observedAtMs = options.observedAtMs ?? NOW - 1_000;
  const values = {
    trading: options.tradingBps ?? 10,
    funding: options.fundingBps ?? 3,
    borrowing: options.borrowingBps ?? 2,
    impact: options.impactBps ?? 4,
    network: options.networkBps ?? 1,
  };
  const part = (bps: number) => ({ bps, usd: bps / 10 });
  const quote = (direction: 'LONG' | 'SHORT') => ({
    direction,
    market: '0x1111111111111111111111111111111111111111',
    orderType: 'MarketIncrease' as const,
    notionalUsd,
    holdingHorizonHours,
    source: 'PAPER_GMX_ESTIMATE' as const,
    blockNumber: null,
    observedAtMs,
    fetchedAtMs: observedAtMs,
    expiresAtMs: options.expiresAtMs ?? observedAtMs + 60_000,
    fundingRatePerHourFraction: part(values.funding).usd / notionalUsd / holdingHorizonHours,
    borrowingRatePerHourFraction: part(values.borrowing).usd / notionalUsd / holdingHorizonHours,
    positionFee: part(values.trading / 2),
    exitFee: part(values.trading / 2),
    funding: part(values.funding),
    borrowing: part(values.borrowing),
    priceImpact: part(values.impact),
    network: part(values.network),
    totalRoundTripCost: part(values.trading + values.funding + values.borrowing
      + values.impact + values.network),
  });
  return {
    schemaVersion: STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION,
    market: '0x1111111111111111111111111111111111111111',
    notionalUsd,
    holdingHorizonHours,
    observedAtMs,
    bidirectionalValidated: true,
    holdingCostsDerivedFromRates: true,
    holdingCostProjectionMethod: 'ENTRY_RATE_CONSTANT',
    conservativeBasisDirection: 'LONG',
    directionalQuotes: { LONG: quote('LONG'), SHORT: quote('SHORT') },
  };
}

function signal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    schemaVersion: 'strategy-signal/v2',
    signalId: 'BTC:TREND_PULLBACK:LONG:15m:1',
    strategyId: 'TREND_PULLBACK',
    symbol: 'BTC',
    regime: 'TREND_UP',
    direction: 'LONG',
    confidence: 85,
    entryZoneLow: 99,
    entryZoneHigh: 101,
    proposedEntryPrice: 100,
    structuralStop: 99,
    stopDistancePct: 1,
    invalidationPrice: 99,
    targets: [{ price: 103, expectedR: 3, allocationPct: 100 }],
    grossExpectedEdgeBps: 300,
    expectedCostsBps: 20,
    netExpectedEdgeBps: 280,
    expectedNetRR: 2.8,
    higherTimeframeTrend: 'TREND_UP',
    marketStructure: 'BULLISH',
    confirmationPattern: 'BULLISH_REJECTION',
    sourceTimeframes: ['4h', '1h', '15m'],
    sourceCandleCloseTime: 1,
    dataQuality: 'GOOD',
    volumeConfirmation: true,
    reasons: [],
    warnings: [],
    ...overrides,
  };
}

function eligibility(overrides: Partial<SignalEligibilityDecision> = {}): SignalEligibilityDecision {
  return {
    configVersion: 'signal-lifecycle/v1',
    signalId: signal().signalId,
    eligible: true,
    codes: ['ELIGIBLE'],
    blockedUntilCandleCloseTime: null,
    strategyConsecutiveLosses: 0,
    symbolConsecutiveLosses: 0,
    reasons: ['eligible'],
    warnings: [],
    ...overrides,
  };
}

describe('Strategy Net-Edge Research Gate', () => {
  it('marks only a high-confidence higher-timeframe signal with ample net edge as research eligible', () => {
    const result = evaluateStrategyNetEdgeResearch({
      signal: signal(),
      costEvidence: cost(),
      eligibility: eligibility(),
      evaluatedAt: NOW,
    });
    expect(result).toMatchObject({
      researchLabel: 'PAPER_SHADOW_RESEARCH',
      eligible: true,
      breakEvenMoveBps: 25,
      minimumRequiredPriceMoveBps: 55,
      grossEdgeToCostRatio: 15,
      netEdgeToCostRatio: 13.75,
      expectedNetRR: 2.75,
      holdingHorizonHours: 12,
      cooldownSatisfied: true,
      executionAuthorized: false,
      approvalCreationAllowed: false,
      paperPositionMutationAllowed: false,
      livePositionMutationAllowed: false,
      capitalSizingUsed: false,
      plannedSeedUsed: false,
      riskAuthority: 'NOT_EVALUATED',
    });
    expect(result.expectedNetEdge).toEqual({ bps: 275, usd: 27.5 });
    expect(result.costEvidence).toMatchObject({
      bidirectionalValidated: true,
      holdingCostsDerivedFromRates: true,
      directionalQuotes: {
        LONG: {
          positionFee: { usd: 0.5, bps: 5 },
          exitFee: { usd: 0.5, bps: 5 },
          funding: { usd: 0.3, bps: 3 },
          borrowing: { usd: 0.2, bps: 2 },
          priceImpact: { usd: 0.4, bps: 4 },
          network: { usd: 0.1, bps: 1 },
        },
        SHORT: { direction: 'SHORT' },
      },
    });
  });

  it('fails closed to NO_TRADE when total cost overwhelms the expected move', () => {
    const result = evaluateStrategyNetEdgeResearch({
      signal: signal({ grossExpectedEdgeBps: 80, expectedCostsBps: 60,
        netExpectedEdgeBps: 20, expectedNetRR: 0.2 }),
      costEvidence: cost({ tradingBps: 20, fundingBps: 10, borrowingBps: 10,
        impactBps: 15, networkBps: 5 }),
      eligibility: eligibility(),
      evaluatedAt: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.researchLabel).toBe('NO_TRADE');
    expect(result.expectedNetEdge?.bps).toBe(15);
    expect(result.reasons.join(' ')).toContain('비용 대비 충분하지 않음');
  });

  it('applies stricter turnover and R/R policy to short-horizon mean reversion', () => {
    const rangeSignal = signal({
      signalId: 'BTC:RANGE_MEAN_REVERSION:LONG:15m:1',
      strategyId: 'RANGE_MEAN_REVERSION',
      regime: 'RANGE',
      confidence: 85,
      grossExpectedEdgeBps: 90,
      expectedCostsBps: 20,
      stopDistancePct: 0.5,
    });
    const result = evaluateStrategyNetEdgeResearch({
      signal: rangeSignal,
      costEvidence: cost({ holdingHorizonHours: 4 }),
      eligibility: eligibility({ signalId: rangeSignal.signalId }),
      evaluatedAt: NOW,
    });
    expect(result.policy).toMatchObject({ researchPriority: 3, turnoverPenaltyBps: 15,
      minimumExpectedNetRR: 2 });
    expect(result.eligible).toBe(false);
    expect(result.expectedNetRR).toBe(1.1);
    expect(result.reasons.join(' ')).toContain('Net R:R');
  });

  it('keeps cooldown veto and rejects missing or mismatched cost evidence', () => {
    const blocked = evaluateStrategyNetEdgeResearch({
      signal: signal(),
      costEvidence: cost(),
      eligibility: eligibility({ eligible: false, codes: ['STOP_LOSS_COOLDOWN'] }),
      evaluatedAt: NOW,
    });
    expect(blocked.eligible).toBe(false);
    expect(blocked.cooldownCodes).toEqual(['STOP_LOSS_COOLDOWN']);

    const mismatched = evaluateStrategyNetEdgeResearch({
      signal: signal({ expectedCostsBps: 21 }),
      costEvidence: cost(),
      eligibility: eligibility(),
      evaluatedAt: NOW,
    });
    expect(mismatched.eligible).toBe(false);
    expect(mismatched.reasons.join(' ')).toContain('불일치');

    const missing = evaluateStrategyNetEdgeResearch({
      signal: signal(),
      costEvidence: null,
      eligibility: eligibility(),
      evaluatedAt: NOW,
    });
    expect(missing.eligible).toBe(false);
    expect(missing.researchLabel).toBe('NO_TRADE');

    const stale = evaluateStrategyNetEdgeResearch({
      signal: signal(),
      costEvidence: cost({ observedAtMs: NOW - 60_001 }),
      eligibility: eligibility(),
      evaluatedAt: NOW,
    });
    expect(stale.eligible).toBe(false);
    expect(stale.reasons.join(' ')).toContain('freshness/TTL');

    const expired = evaluateStrategyNetEdgeResearch({
      signal: signal(),
      costEvidence: cost({ expiresAtMs: NOW - 1 }),
      eligibility: eligibility(),
      evaluatedAt: NOW,
    });
    expect(expired.eligible).toBe(false);
    expect(expired.schemaVersion).toBe('INVALID');
    expect(expired.reasons.join(' ')).toContain('freshness/TTL');

    const tampered = cost();
    tampered.directionalQuotes.SHORT.funding = { usd: 0.4, bps: 4 };
    const unbound = evaluateStrategyNetEdgeResearch({
      signal: signal(),
      costEvidence: tampered,
      eligibility: eligibility(),
      evaluatedAt: NOW,
    });
    expect(unbound.eligible).toBe(false);
    expect(unbound.schemaVersion).toBe('INVALID');
    expect(unbound.reasons.join(' ')).toMatch(/rate×horizon|합계 불일치/);
  });
});