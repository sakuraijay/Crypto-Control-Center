/** Pure PAPER/SHADOW-only net-edge research gate. No sizing or execution authority. */
import type { SignalEligibilityDecision } from './signalLifecycleV2';
import type { StrategyId, StrategySignal } from './strategySignalV2';
import { accrueHoldingCostsFromEntryRates } from '../lib/holdingCosts';
import { COST_SNAPSHOT_TTL_MS, type CostSnapshotSource } from '../lib/costSnapshot';

export const STRATEGY_NET_EDGE_RESEARCH_VERSION = 'strategy-net-edge-research/v1' as const;
export const STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION = 'strategy-net-edge-cost/v1' as const;

export interface StrategyNetEdgeCostComponent {
  usd: number;
  bps: number;
}

export interface StrategyNetEdgeDirectionalQuoteEvidence {
  direction: 'LONG' | 'SHORT';
  market: string;
  orderType: 'MarketIncrease';
  notionalUsd: number;
  holdingHorizonHours: number;
  source: CostSnapshotSource;
  blockNumber: number | null;
  observedAtMs: number;
  fetchedAtMs: number;
  expiresAtMs: number;
  fundingRatePerHourFraction: number;
  borrowingRatePerHourFraction: number;
  positionFee: StrategyNetEdgeCostComponent;
  exitFee: StrategyNetEdgeCostComponent;
  funding: StrategyNetEdgeCostComponent;
  borrowing: StrategyNetEdgeCostComponent;
  priceImpact: StrategyNetEdgeCostComponent;
  network: StrategyNetEdgeCostComponent;
  totalRoundTripCost: StrategyNetEdgeCostComponent;
}

export interface StrategyNetEdgeCostEvidence {
  schemaVersion: typeof STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION;
  market: string;
  notionalUsd: number;
  holdingHorizonHours: number;
  observedAtMs: number;
  bidirectionalValidated: true;
  holdingCostsDerivedFromRates: true;
  holdingCostProjectionMethod: 'ENTRY_RATE_CONSTANT';
  conservativeBasisDirection: 'LONG' | 'SHORT';
  directionalQuotes: {
    LONG: StrategyNetEdgeDirectionalQuoteEvidence;
    SHORT: StrategyNetEdgeDirectionalQuoteEvidence;
  };
}

export interface StrategyNetEdgeResearchPolicy {
  strategyId: StrategyId;
  researchPriority: 1 | 2 | 3;
  minimumConfidence: number;
  minimumHoldingHorizonHours: number;
  turnoverPenaltyBps: number;
  minimumNetEdgeBps: number;
  minimumNetEdgeToCostRatio: number;
  minimumExpectedNetRR: number;
}

export interface StrategyNetEdgeResearchResult {
  schemaVersion: typeof STRATEGY_NET_EDGE_RESEARCH_VERSION | 'INVALID';
  signalId: string | null;
  symbol: string;
  strategyId: StrategyId | null;
  signalConfidence: number | null;
  signalDataQuality: StrategySignal['dataQuality'] | null;
  sourceTimeframes: StrategySignal['sourceTimeframes'];
  riskBps: number | null;
  researchOnly: true;
  researchLabel: 'PAPER_SHADOW_RESEARCH' | 'NO_TRADE';
  eligible: boolean;
  policy: StrategyNetEdgeResearchPolicy | null;
  expectedGrossEdge: StrategyNetEdgeCostComponent | null;
  expectedRoundTripCost: StrategyNetEdgeCostComponent | null;
  turnoverPenalty: StrategyNetEdgeCostComponent | null;
  expectedNetEdge: StrategyNetEdgeCostComponent | null;
  breakEvenMoveBps: number | null;
  breakEvenMovePct: number | null;
  minimumRequiredPriceMoveBps: number | null;
  minimumRequiredPriceMovePct: number | null;
  grossEdgeToCostRatio: number | null;
  netEdgeToCostRatio: number | null;
  expectedNetRR: number | null;
  minimumExpectedNetRR: number | null;
  holdingHorizonHours: number | null;
  cooldownSatisfied: boolean;
  cooldownCodes: string[];
  costEvidence: StrategyNetEdgeCostEvidence | null;
  reasons: string[];
  warnings: string[];
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
  capitalSizingUsed: false;
  plannedSeedUsed: false;
  strategySignalEconomicsPreserved: true;
  turnoverAdjustedResearchEconomics: true;
  riskAuthority: 'NOT_EVALUATED';
}

const POLICY: Readonly<Record<StrategyId, StrategyNetEdgeResearchPolicy>> = Object.freeze({
  TREND_PULLBACK: Object.freeze({
    strategyId: 'TREND_PULLBACK',
    researchPriority: 1,
    minimumConfidence: 75,
    minimumHoldingHorizonHours: 8,
    turnoverPenaltyBps: 5,
    minimumNetEdgeBps: 25,
    minimumNetEdgeToCostRatio: 1.5,
    minimumExpectedNetRR: 1.5,
  }),
  VOLATILITY_BREAKOUT: Object.freeze({
    strategyId: 'VOLATILITY_BREAKOUT',
    researchPriority: 2,
    minimumConfidence: 80,
    minimumHoldingHorizonHours: 6,
    turnoverPenaltyBps: 8,
    minimumNetEdgeBps: 30,
    minimumNetEdgeToCostRatio: 1.75,
    minimumExpectedNetRR: 1.8,
  }),
  RANGE_MEAN_REVERSION: Object.freeze({
    strategyId: 'RANGE_MEAN_REVERSION',
    researchPriority: 3,
    minimumConfidence: 82,
    minimumHoldingHorizonHours: 4,
    turnoverPenaltyBps: 15,
    minimumNetEdgeBps: 40,
    minimumNetEdgeToCostRatio: 2,
    minimumExpectedNetRR: 2,
  }),
});

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round = (value: number): number => Number(value.toPrecision(12));
const component = (bps: number, notionalUsd: number): StrategyNetEdgeCostComponent => ({
  bps: round(bps),
  usd: round(bps / 10_000 * notionalUsd),
});

function safeResult(
  signal: StrategySignal | null,
  costEvidence: StrategyNetEdgeCostEvidence | null,
  eligibility: SignalEligibilityDecision | null,
  reasons: string[],
  invalid = false,
): StrategyNetEdgeResearchResult {
  return {
    schemaVersion: invalid ? 'INVALID' : STRATEGY_NET_EDGE_RESEARCH_VERSION,
    signalId: signal?.signalId ?? null,
    symbol: signal?.symbol.trim().toUpperCase() ?? '',
    strategyId: signal?.strategyId ?? null,
    signalConfidence: signal?.confidence ?? null,
    signalDataQuality: signal?.dataQuality ?? null,
    sourceTimeframes: signal ? [...signal.sourceTimeframes] : [],
    riskBps: signal?.stopDistancePct !== null && finite(signal?.stopDistancePct)
      ? round(signal.stopDistancePct * 100)
      : null,
    researchOnly: true,
    researchLabel: 'NO_TRADE',
    eligible: false,
    policy: signal ? POLICY[signal.strategyId] : null,
    expectedGrossEdge: null,
    expectedRoundTripCost: costEvidence?.directionalQuotes?.[costEvidence.conservativeBasisDirection]
      ?.totalRoundTripCost ?? null,
    turnoverPenalty: null,
    expectedNetEdge: null,
    breakEvenMoveBps: null,
    breakEvenMovePct: null,
    minimumRequiredPriceMoveBps: null,
    minimumRequiredPriceMovePct: null,
    grossEdgeToCostRatio: null,
    netEdgeToCostRatio: null,
    expectedNetRR: null,
    minimumExpectedNetRR: signal ? POLICY[signal.strategyId].minimumExpectedNetRR : null,
    holdingHorizonHours: costEvidence?.holdingHorizonHours ?? null,
    cooldownSatisfied: eligibility?.eligible === true,
    cooldownCodes: eligibility?.codes ?? [],
    costEvidence,
    reasons,
    warnings: [],
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
    capitalSizingUsed: false,
    plannedSeedUsed: false,
    strategySignalEconomicsPreserved: true,
    turnoverAdjustedResearchEconomics: true,
    riskAuthority: 'NOT_EVALUATED',
  };
}

function validateCostComponent(
  name: string,
  value: unknown,
  notionalUsd: number,
  allowNegative = false,
): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${name} INVALID`];
  const part = value as Partial<StrategyNetEdgeCostComponent>;
  if (!finite(part.usd) || !finite(part.bps) || (!allowNegative && part.usd < 0)) {
    return [`${name} INVALID`];
  }
  const expectedBps = part.usd / notionalUsd * 10_000;
  return Math.abs(expectedBps - part.bps) > 1e-6 ? [`${name} USD/bps 불일치`] : [];
}

function validateDirectionalQuote(
  direction: 'LONG' | 'SHORT',
  quote: unknown,
  evidence: Partial<StrategyNetEdgeCostEvidence>,
): string[] {
  if (typeof quote !== 'object' || quote === null || Array.isArray(quote)) {
    return [`${direction} quote 누락`];
  }
  const item = quote as Partial<StrategyNetEdgeDirectionalQuoteEvidence>;
  const issues: string[] = [];
  if (item.direction !== direction) issues.push(`${direction} direction 결속 INVALID`);
  if (typeof item.market !== 'string'
    || item.market.toLowerCase() !== evidence.market?.toLowerCase()) issues.push(`${direction} market 결속 INVALID`);
  if (item.orderType !== 'MarketIncrease') issues.push(`${direction} orderType INVALID`);
  if (!finite(item.notionalUsd) || item.notionalUsd !== evidence.notionalUsd) issues.push(`${direction} notional 결속 INVALID`);
  if (!finite(item.holdingHorizonHours)
    || item.holdingHorizonHours !== evidence.holdingHorizonHours) issues.push(`${direction} horizon 결속 INVALID`);
  if (typeof item.source !== 'string' || !item.source.trim()) issues.push(`${direction} source 누락`);
  if (!['GMX_API', 'RPC_DATASTORE', 'PAPER_GMX_ESTIMATE'].includes(item.source ?? '')) {
    issues.push(`${direction} source INVALID`);
  }
  if (item.blockNumber !== null && (!finite(item.blockNumber) || !Number.isInteger(item.blockNumber))) {
    issues.push(`${direction} blockNumber INVALID`);
  }
  if (!finite(item.observedAtMs) || !finite(item.fetchedAtMs) || !finite(item.expiresAtMs)
    || item.observedAtMs <= 0 || item.observedAtMs !== item.fetchedAtMs
    || item.expiresAtMs <= item.fetchedAtMs) issues.push(`${direction} timestamp 결속 INVALID`);
  if (!finite(item.fundingRatePerHourFraction) || item.fundingRatePerHourFraction < 0
    || !finite(item.borrowingRatePerHourFraction) || item.borrowingRatePerHourFraction < 0) {
    issues.push(`${direction} holding rate INVALID`);
  }
  if (finite(item.notionalUsd) && item.notionalUsd > 0) {
    const names = ['positionFee', 'exitFee', 'funding', 'borrowing', 'network',
      'totalRoundTripCost'] as const;
    for (const name of names) issues.push(...validateCostComponent(`${direction} ${name}`, item[name], item.notionalUsd));
    issues.push(...validateCostComponent(`${direction} priceImpact`, item.priceImpact, item.notionalUsd, true));
  }
  if (issues.length === 0) {
    const holding = accrueHoldingCostsFromEntryRates({
      notionalUsd: item.notionalUsd as number,
      openedAtMs: 0,
      closedAtMs: (item.holdingHorizonHours as number) * 3_600_000,
      fundingRatePerHourFraction: item.fundingRatePerHourFraction as number,
      borrowingRatePerHourFraction: item.borrowingRatePerHourFraction as number,
    });
    if (!holding.ok) issues.push(`${direction} holding cost 계산 INVALID`);
    else if (Math.abs(holding.fundingUsd - (item.funding as StrategyNetEdgeCostComponent).usd) > 1e-6
      || Math.abs(holding.borrowingUsd - (item.borrowing as StrategyNetEdgeCostComponent).usd) > 1e-6) {
      issues.push(`${direction} holding rate×horizon 비용 불일치`);
    }
    const parts: StrategyNetEdgeCostComponent[] = [
      item.positionFee,
      item.exitFee,
      item.funding,
      item.borrowing,
      item.priceImpact,
      item.network,
    ] as StrategyNetEdgeCostComponent[];
    const total = item.totalRoundTripCost as StrategyNetEdgeCostComponent;
    const sumUsd = parts.reduce((sum, part) => sum + part.usd, 0);
    const sumBps = parts.reduce((sum, part) => sum + part.bps, 0);
    if (Math.abs(sumUsd - total.usd) > 1e-6 || Math.abs(sumBps - total.bps) > 1e-6) {
      issues.push(`${direction} cost component 합계 불일치`);
    }
  }
  return issues;
}

export function validateStrategyNetEdgeCostEvidence(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['cost evidence 객체 필요'];
  const item = value as Partial<StrategyNetEdgeCostEvidence>;
  const issues: string[] = [];
  if (item.schemaVersion !== STRATEGY_NET_EDGE_COST_EVIDENCE_VERSION) issues.push('cost evidence version INVALID');
  if (typeof item.market !== 'string' || !item.market.trim()) issues.push('market 누락');
  if (!finite(item.notionalUsd) || item.notionalUsd <= 0) issues.push('notionalUsd INVALID');
  if (!finite(item.holdingHorizonHours) || item.holdingHorizonHours <= 0
    || item.holdingHorizonHours > 168) issues.push('holding horizon INVALID');
  if (!finite(item.observedAtMs) || item.observedAtMs <= 0) issues.push('observedAtMs INVALID');
  if (item.bidirectionalValidated !== true) issues.push('bidirectional validation 증명 누락');
  if (item.holdingCostsDerivedFromRates !== true) issues.push('holding rate derivation 증명 누락');
  if (item.holdingCostProjectionMethod !== 'ENTRY_RATE_CONSTANT') {
    issues.push('holding cost projection method INVALID');
  }
  if (item.conservativeBasisDirection !== 'LONG' && item.conservativeBasisDirection !== 'SHORT') {
    issues.push('conservative direction INVALID');
  }
  issues.push(...validateDirectionalQuote('LONG', item.directionalQuotes?.LONG, item));
  issues.push(...validateDirectionalQuote('SHORT', item.directionalQuotes?.SHORT, item));
  if (issues.length === 0 && item.directionalQuotes) {
    const oldest = Math.min(item.directionalQuotes.LONG.observedAtMs,
      item.directionalQuotes.SHORT.observedAtMs);
    if (item.observedAtMs !== oldest) issues.push('양방향 oldest observedAt 결속 INVALID');
    const longTotal = item.directionalQuotes.LONG.totalRoundTripCost.usd;
    const shortTotal = item.directionalQuotes.SHORT.totalRoundTripCost.usd;
    const expectedDirection = longTotal >= shortTotal ? 'LONG' : 'SHORT';
    if (item.conservativeBasisDirection !== expectedDirection) {
      issues.push('보수적 최대비용 direction 불일치');
    }
  }
  return issues;
}

function validateCostEvidenceFreshness(
  evidence: StrategyNetEdgeCostEvidence,
  evaluatedAt: number,
): string[] {
  const issues: string[] = [];
  if (!finite(evaluatedAt) || evaluatedAt <= 0) return ['Net-Edge evaluatedAt INVALID'];
  for (const direction of ['LONG', 'SHORT'] as const) {
    const quote = evidence.directionalQuotes?.[direction];
    if (!quote) {
      issues.push(`${direction} Net-Edge quote 누락`);
      continue;
    }
    const age = evaluatedAt - quote.observedAtMs;
    const ttl = quote.expiresAtMs - quote.fetchedAtMs;
    if (!finite(age) || age < 0 || age > COST_SNAPSHOT_TTL_MS
      || !finite(ttl) || ttl <= 0 || ttl > COST_SNAPSHOT_TTL_MS
      || evaluatedAt > quote.expiresAtMs) {
      issues.push(`${direction} Net-Edge freshness/TTL INVALID`);
    }
  }
  return issues;
}

export function validateStrategyNetEdgeResearchResult(
  value: unknown,
  expected: {
    signalId: string | null;
    symbol: string;
    strategyId: StrategyId | null;
    confidence: number | null;
    expectedNetEdgeBps: number | null;
    expectedNetRR: number | null;
    lifecycleEligible: boolean | null;
    action: string;
    evaluatedAt: number;
  },
): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['Net-Edge research result 객체 필요'];
  }
  const item = value as Partial<StrategyNetEdgeResearchResult>;
  const issues: string[] = [];
  if (item.schemaVersion !== STRATEGY_NET_EDGE_RESEARCH_VERSION) issues.push('Net-Edge result version INVALID');
  if (item.signalId !== expected.signalId) issues.push('Net-Edge signalId 결속 INVALID');
  if (item.symbol?.trim().toUpperCase() !== expected.symbol.trim().toUpperCase()) {
    issues.push('Net-Edge symbol 결속 INVALID');
  }
  if (item.strategyId !== expected.strategyId || item.signalConfidence !== expected.confidence) {
    issues.push('Net-Edge strategy/confidence 결속 INVALID');
  }
  if (item.signalDataQuality !== 'GOOD'
    || !item.sourceTimeframes?.includes('4h') || !item.sourceTimeframes.includes('1h')) {
    issues.push('Net-Edge signal quality/timeframe 결속 INVALID');
  }
  if (item.cooldownSatisfied !== (expected.lifecycleEligible === true)) {
    issues.push('Net-Edge lifecycle 결속 INVALID');
  }
  if (item.researchOnly !== true || item.executionAuthorized !== false
    || item.approvalCreationAllowed !== false || item.paperPositionMutationAllowed !== false
    || item.livePositionMutationAllowed !== false || item.capitalSizingUsed !== false
    || item.plannedSeedUsed !== false || item.strategySignalEconomicsPreserved !== true
    || item.turnoverAdjustedResearchEconomics !== true || item.riskAuthority !== 'NOT_EVALUATED') {
    issues.push('Net-Edge authority 경계 INVALID');
  }
  if (item.eligible === true) {
    if (item.researchLabel !== 'PAPER_SHADOW_RESEARCH'
      || (expected.action !== 'LONG' && expected.action !== 'SHORT')) {
      issues.push('Net-Edge eligible/action 결속 INVALID');
    }
  } else if (item.eligible === false) {
    if (item.researchLabel !== 'NO_TRADE' || expected.action !== 'NO_TRADE') {
      issues.push('Net-Edge NO_TRADE/action 결속 INVALID');
    }
  } else {
    issues.push('Net-Edge eligible INVALID');
  }
  if (item.costEvidence === null || item.costEvidence === undefined) {
    if (item.eligible === true) issues.push('eligible Net-Edge cost evidence 누락');
  } else {
    issues.push(...validateStrategyNetEdgeCostEvidence(item.costEvidence));
    issues.push(...validateCostEvidenceFreshness(item.costEvidence, expected.evaluatedAt));
    const quote = item.costEvidence.directionalQuotes?.[item.costEvidence.conservativeBasisDirection];
    if (quote && item.expectedRoundTripCost
      && (Math.abs(quote.totalRoundTripCost.usd - item.expectedRoundTripCost.usd) > 1e-6
        || Math.abs(quote.totalRoundTripCost.bps - item.expectedRoundTripCost.bps) > 1e-6)) {
      issues.push('Net-Edge conservative total 결속 INVALID');
    }
  }
  const gross = item.expectedGrossEdge;
  const cost = item.expectedRoundTripCost;
  const turnover = item.turnoverPenalty;
  const net = item.expectedNetEdge;
  if (item.eligible === true || gross !== null) {
    if (!gross || !cost || !turnover || !net
      || !finite(gross.bps) || !finite(cost.bps) || !finite(turnover.bps) || !finite(net.bps)
      || Math.abs((gross.bps - cost.bps - turnover.bps) - net.bps) > 1e-6) {
      issues.push('Net-Edge turnover-adjusted 계산 INVALID');
    }
  }
  const expectedPolicy = expected.strategyId === null ? null : POLICY[expected.strategyId];
  if (expectedPolicy === null || !item.policy
    || (Object.keys(expectedPolicy) as (keyof StrategyNetEdgeResearchPolicy)[])
      .some(key => item.policy?.[key] !== expectedPolicy[key])) {
    issues.push('Net-Edge fixed policy 결속 INVALID');
  }
  if (expectedPolicy && item.costEvidence && gross && cost && turnover && net && finite(item.riskBps)
    && item.riskBps > 0 && finite(item.signalConfidence)) {
    const notionalUsd = item.costEvidence.notionalUsd;
    for (const [name, metric] of [
      ['gross', gross], ['cost', cost], ['turnover', turnover], ['net', net],
    ] as const) {
      issues.push(...validateCostComponent(`Net-Edge ${name}`, metric, notionalUsd, name === 'net'));
    }
    const preTurnoverNetBps = gross.bps - cost.bps;
    const adjustedNetBps = preTurnoverNetBps - expectedPolicy.turnoverPenaltyBps;
    const breakEvenBps = cost.bps + expectedPolicy.turnoverPenaltyBps;
    const minimumNetBps = Math.max(expectedPolicy.minimumNetEdgeBps,
      cost.bps * expectedPolicy.minimumNetEdgeToCostRatio);
    const minimumMoveBps = breakEvenBps + minimumNetBps;
    const adjustedRR = adjustedNetBps / item.riskBps;
    if (Math.abs(preTurnoverNetBps - (expected.expectedNetEdgeBps ?? Number.NaN)) > 1e-6
      || Math.abs(preTurnoverNetBps / item.riskBps - (expected.expectedNetRR ?? Number.NaN)) > 1e-6) {
      issues.push('Net-Edge StrategySignal economics 결속 INVALID');
    }
    if (turnover.bps !== expectedPolicy.turnoverPenaltyBps
      || Math.abs(net.bps - adjustedNetBps) > 1e-6
      || Math.abs((item.breakEvenMoveBps ?? Number.NaN) - breakEvenBps) > 1e-6
      || Math.abs((item.breakEvenMovePct ?? Number.NaN) - breakEvenBps / 100) > 1e-6
      || Math.abs((item.minimumRequiredPriceMoveBps ?? Number.NaN) - minimumMoveBps) > 1e-6
      || Math.abs((item.minimumRequiredPriceMovePct ?? Number.NaN) - minimumMoveBps / 100) > 1e-6
      || Math.abs((item.grossEdgeToCostRatio ?? Number.NaN) - gross.bps / cost.bps) > 1e-6
      || Math.abs((item.netEdgeToCostRatio ?? Number.NaN) - adjustedNetBps / cost.bps) > 1e-6
      || Math.abs((item.expectedNetRR ?? Number.NaN) - adjustedRR) > 1e-6
      || item.minimumExpectedNetRR !== expectedPolicy.minimumExpectedNetRR
      || item.holdingHorizonHours !== item.costEvidence.holdingHorizonHours) {
      issues.push('Net-Edge derived research metrics INVALID');
    }
    const shouldBeEligible = item.signalDataQuality === 'GOOD'
      && item.sourceTimeframes?.includes('4h') === true
      && item.sourceTimeframes?.includes('1h') === true
      && item.signalConfidence >= expectedPolicy.minimumConfidence
      && item.costEvidence.holdingHorizonHours >= expectedPolicy.minimumHoldingHorizonHours
      && item.cooldownSatisfied === true
      && adjustedNetBps >= minimumNetBps
      && adjustedRR >= expectedPolicy.minimumExpectedNetRR
      && gross.bps >= minimumMoveBps;
    if (item.eligible !== shouldBeEligible) issues.push('Net-Edge eligibility 재계산 불일치');
  } else if (item.eligible === true) {
    issues.push('eligible Net-Edge 계산 입력 누락');
  }
  return issues;
}

export function evaluateStrategyNetEdgeResearch(input: {
  signal: StrategySignal | null;
  costEvidence: StrategyNetEdgeCostEvidence | null;
  eligibility: SignalEligibilityDecision | null;
  evaluatedAt: number;
}): StrategyNetEdgeResearchResult {
  const { signal, costEvidence, eligibility, evaluatedAt } = input;
  if (signal === null) return safeResult(null, costEvidence, eligibility, ['선택 Signal 없음 — NO_TRADE']);
  const costIssues = validateStrategyNetEdgeCostEvidence(costEvidence);
  if (costEvidence === null || costIssues.length > 0) {
    return safeResult(signal, costEvidence, eligibility,
      ['fresh 비용 구성 evidence 미충족 — NO_TRADE', ...costIssues], costIssues.length > 0);
  }
  const freshnessIssues = validateCostEvidenceFreshness(costEvidence, evaluatedAt);
  if (freshnessIssues.length > 0) {
    return safeResult(signal, costEvidence, eligibility,
      ['비용 evidence freshness/TTL 초과 또는 관측시각 INVALID — NO_TRADE',
        ...freshnessIssues], true);
  }
  const policy = POLICY[signal.strategyId];
  const reasons: string[] = [];
  if (signal.direction === 'NONE') reasons.push('방향성 Signal 아님');
  if (signal.dataQuality !== 'GOOD') reasons.push('Data Quality GOOD 아님');
  if (!signal.sourceTimeframes.includes('4h') || !signal.sourceTimeframes.includes('1h')) {
    reasons.push('상위 timeframe 4h/1h 근거 누락');
  }
  if (!finite(signal.confidence) || signal.confidence < policy.minimumConfidence) {
    reasons.push(`confidence ${policy.minimumConfidence} 미달`);
  }
  if (costEvidence.holdingHorizonHours < policy.minimumHoldingHorizonHours) {
    reasons.push(`holding horizon ${policy.minimumHoldingHorizonHours}h 미달`);
  }
  if (eligibility === null || eligibility.signalId !== signal.signalId || !eligibility.eligible) {
    reasons.push('Signal lifecycle/cooldown 미충족');
  }
  const grossBps = signal.grossExpectedEdgeBps;
  const riskBps = signal.stopDistancePct === null ? null : signal.stopDistancePct * 100;
  const conservativeQuote = costEvidence.directionalQuotes[costEvidence.conservativeBasisDirection];
  const costBps = conservativeQuote.totalRoundTripCost.bps;
  if (!finite(grossBps) || grossBps <= 0 || !finite(riskBps) || riskBps <= 0
    || !finite(costBps) || costBps <= 0) {
    return {
      ...safeResult(signal, costEvidence, eligibility,
        [...reasons, 'gross edge/risk/cost 수치 미충족 — NO_TRADE'], true),
      policy,
    };
  }
  if (signal.expectedCostsBps === null || !finite(signal.expectedCostsBps)
    || Math.abs(signal.expectedCostsBps - costBps) > 1e-6) {
    reasons.push('Signal cost와 fresh cost evidence 불일치');
  }
  const turnoverBps = policy.turnoverPenaltyBps;
  const netBps = grossBps - costBps - turnoverBps;
  const breakEvenBps = costBps + turnoverBps;
  const minimumNetBps = Math.max(policy.minimumNetEdgeBps,
    costBps * policy.minimumNetEdgeToCostRatio);
  const minimumMoveBps = breakEvenBps + minimumNetBps;
  const grossToCost = grossBps / costBps;
  const netToCost = netBps / costBps;
  const netRR = netBps / riskBps;
  if (netBps < minimumNetBps) reasons.push('기대 Net Edge가 비용 대비 충분하지 않음');
  if (netRR < policy.minimumExpectedNetRR) reasons.push('최소 기대 Net R:R 미달');
  if (grossBps < minimumMoveBps) reasons.push('최소 요구 가격변동률 미달');

  const eligible = reasons.length === 0;
  return {
    schemaVersion: STRATEGY_NET_EDGE_RESEARCH_VERSION,
    signalId: signal.signalId,
    symbol: signal.symbol.trim().toUpperCase(),
    strategyId: signal.strategyId,
    signalConfidence: signal.confidence,
    signalDataQuality: signal.dataQuality,
    sourceTimeframes: [...signal.sourceTimeframes],
    riskBps: round(riskBps),
    researchOnly: true,
    researchLabel: eligible ? 'PAPER_SHADOW_RESEARCH' : 'NO_TRADE',
    eligible,
    policy,
    expectedGrossEdge: component(grossBps, costEvidence.notionalUsd),
    expectedRoundTripCost: conservativeQuote.totalRoundTripCost,
    turnoverPenalty: component(turnoverBps, costEvidence.notionalUsd),
    expectedNetEdge: component(netBps, costEvidence.notionalUsd),
    breakEvenMoveBps: round(breakEvenBps),
    breakEvenMovePct: round(breakEvenBps / 100),
    minimumRequiredPriceMoveBps: round(minimumMoveBps),
    minimumRequiredPriceMovePct: round(minimumMoveBps / 100),
    grossEdgeToCostRatio: round(grossToCost),
    netEdgeToCostRatio: round(netToCost),
    expectedNetRR: round(netRR),
    minimumExpectedNetRR: policy.minimumExpectedNetRR,
    holdingHorizonHours: costEvidence.holdingHorizonHours,
    cooldownSatisfied: eligibility?.eligible === true,
    cooldownCodes: eligibility?.codes ?? [],
    costEvidence,
    reasons: eligible
      ? ['상위 timeframe·고신뢰·저회전 Net Edge 연구 기준 충족',
        'RiskEngine 최종 veto 및 실행 경계는 별도 유지']
      : reasons,
    warnings: [],
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
    capitalSizingUsed: false,
    plannedSeedUsed: false,
    strategySignalEconomicsPreserved: true,
    turnoverAdjustedResearchEconomics: true,
    riskAuthority: 'NOT_EVALUATED',
  };
}