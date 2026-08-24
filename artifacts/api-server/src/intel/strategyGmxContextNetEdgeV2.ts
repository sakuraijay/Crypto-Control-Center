/**
 * Pure GMX context and cost-adjusted Net Edge advisory.
 *
 * This boundary consumes an already-completed readiness binding. It starts no
 * external read and cannot authorize execution or mutate PAPER/LIVE state.
 */
import { MANUAL_CANARY_CAPS } from '../lib/manualCanaryCaps';
import type { StrategyConfidenceRiskReductionAdvisory } from './strategyConfidenceRiskReductionV2';
import type { StrategyShadowRecord } from './strategyShadowAdapterV2';
import type { StrategySignal } from './strategySignalV2';
import type { StrategyStructuralSizingReadinessBinding } from './strategyStructuralSizingReadinessBindingV2';

export const STRATEGY_GMX_CONTEXT_NET_EDGE_VERSION =
  'strategy-gmx-context-net-edge/v1' as const;

export interface StrategyGmxContextNetEdgeInput {
  signal: StrategySignal;
  shadowRecord: StrategyShadowRecord;
  confidenceAdvisory: StrategyConfidenceRiskReductionAdvisory;
  readinessBinding: StrategyStructuralSizingReadinessBinding;
}

export interface StrategyGmxContextNetEdgeAdvisory {
  schemaVersion: typeof STRATEGY_GMX_CONTEXT_NET_EDGE_VERSION | 'INVALID';
  advisoryId: string;
  signalId: string | null;
  symbol: string;
  status: 'PASSED' | 'REJECTED' | 'NOT_EVALUATED';
  coordinatorGeneration: number | null;
  inputNotionalUsd: number;
  finalAdvisoryNotionalUsd: number;
  grossExpectedEdgeBps: number | null;
  grossExpectedEdgeUsd: number | null;
  roundTripCostBps: number | null;
  roundTripCostUsd: number | null;
  immutableCostCapUsd: number;
  costCapExcessUsd: number | null;
  costAdjustedNetEdgeBps: number | null;
  costAdjustedNetEdgeUsd: number | null;
  reasons: string[];
  authority: 'ADVISORY_ONLY';
  externalReadStarted: false;
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const symbol = (value: string): string => value.trim().toUpperCase();

function output(
  input: StrategyGmxContextNetEdgeInput,
  status: StrategyGmxContextNetEdgeAdvisory['status'],
  schemaVersion: StrategyGmxContextNetEdgeAdvisory['schemaVersion'],
  values: Partial<Pick<StrategyGmxContextNetEdgeAdvisory,
    'coordinatorGeneration' | 'inputNotionalUsd' | 'finalAdvisoryNotionalUsd'
    | 'grossExpectedEdgeBps' | 'grossExpectedEdgeUsd' | 'roundTripCostBps'
    | 'roundTripCostUsd' | 'costCapExcessUsd' | 'costAdjustedNetEdgeBps'
    | 'costAdjustedNetEdgeUsd'>>,
  reasons: string[],
): StrategyGmxContextNetEdgeAdvisory {
  return {
    schemaVersion,
    advisoryId: `${input.shadowRecord.shadowRecordId}:GMX_CONTEXT_NET_EDGE`,
    signalId: input.shadowRecord.signalId,
    symbol: symbol(input.shadowRecord.symbol),
    status,
    coordinatorGeneration: values.coordinatorGeneration ?? null,
    inputNotionalUsd: values.inputNotionalUsd ?? 0,
    finalAdvisoryNotionalUsd: values.finalAdvisoryNotionalUsd ?? 0,
    grossExpectedEdgeBps: values.grossExpectedEdgeBps ?? null,
    grossExpectedEdgeUsd: values.grossExpectedEdgeUsd ?? null,
    roundTripCostBps: values.roundTripCostBps ?? null,
    roundTripCostUsd: values.roundTripCostUsd ?? null,
    immutableCostCapUsd: MANUAL_CANARY_CAPS.maxRoundTripCostUsd,
    costCapExcessUsd: values.costCapExcessUsd ?? null,
    costAdjustedNetEdgeBps: values.costAdjustedNetEdgeBps ?? null,
    costAdjustedNetEdgeUsd: values.costAdjustedNetEdgeUsd ?? null,
    reasons,
    authority: 'ADVISORY_ONLY',
    externalReadStarted: false,
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

function boundariesValid(input: StrategyGmxContextNetEdgeInput): boolean {
  const shadow = input.shadowRecord;
  const confidence = input.confidenceAdvisory;
  const binding = input.readinessBinding;
  return input.signal.schemaVersion === 'strategy-signal/v2'
    && shadow.schemaVersion === 'strategy-shadow-adapter/v1'
    && shadow.mode === 'SHADOW_ONLY'
    && shadow.executionAuthorized === false
    && shadow.paperPositionMutationAllowed === false
    && shadow.riskAuthority === 'NOT_EVALUATED'
    && confidence.schemaVersion === 'strategy-confidence-risk-reduction/v1'
    && confidence.authority === 'ADVISORY_ONLY'
    && confidence.executionAuthorized === false
    && confidence.approvalCreationAllowed === false
    && confidence.paperPositionMutationAllowed === false
    && confidence.livePositionMutationAllowed === false
    && binding.schemaVersion === 'strategy-structural-sizing-readiness-binding/v1'
    && binding.authority === 'ADVISORY_ONLY'
    && binding.externalReadStarted === false
    && binding.executionAuthorized === false
    && binding.approvalCreationAllowed === false
    && binding.paperPositionMutationAllowed === false
    && binding.livePositionMutationAllowed === false;
}

/** Recalculate economics from gross Signal edge and one bound GMX context. */
export function evaluateStrategyGmxContextNetEdge(
  input: StrategyGmxContextNetEdgeInput,
): StrategyGmxContextNetEdgeAdvisory {
  if (!boundariesValid(input)) {
    return output(input, 'REJECTED', 'INVALID', {},
      ['Signal/SHADOW/confidence/readiness 권한 경계 INVALID — 전체 차단']);
  }
  const { signal, shadowRecord: shadow, confidenceAdvisory: confidence, readinessBinding: binding } = input;
  const expectedSymbol = symbol(shadow.symbol);
  if (!shadow.shadowRecordId.trim() || shadow.signalId === null || !shadow.signalId.trim()
    || signal.signalId !== shadow.signalId || confidence.signalId !== shadow.signalId
    || symbol(signal.symbol) !== expectedSymbol || symbol(confidence.symbol) !== expectedSymbol
    || (shadow.direction !== 'LONG' && shadow.direction !== 'SHORT')
    || signal.direction !== shadow.direction
    || confidence.advisoryId !== `${shadow.shadowRecordId}:CONFIDENCE_RISK_REDUCTION`) {
    return output(input, 'REJECTED', 'INVALID', {},
      ['Signal identity·symbol·direction 결속 INVALID — fail-closed']);
  }
  if ((confidence.status !== 'UNCHANGED' && confidence.status !== 'REDUCED')
    || !finite(confidence.finalAdvisoryNotionalUsd) || confidence.finalAdvisoryNotionalUsd <= 0
    || !finite(confidence.inputNotionalUsd)
    || confidence.finalAdvisoryNotionalUsd > confidence.inputNotionalUsd) {
    return output(input, 'REJECTED', 'INVALID', {},
      ['Confidence 축소 결과 없음 또는 위험 확대 감지 — fail-closed']);
  }
  const context = binding.marketContextBySymbol[expectedSymbol];
  if ((binding.status !== 'BOUND' && binding.status !== 'PARTIAL')
    || !Number.isInteger(binding.coordinatorGeneration) || (binding.coordinatorGeneration ?? 0) <= 0
    || context === null || context === undefined) {
    return output(input, 'NOT_EVALUATED', STRATEGY_GMX_CONTEXT_NET_EDGE_VERSION, {
      coordinatorGeneration: binding.coordinatorGeneration,
      inputNotionalUsd: confidence.finalAdvisoryNotionalUsd,
    }, ['동일 generation의 fresh GMX 비용·유동성 근거 없음 — 0으로 위장하지 않음']);
  }
  if (context.source !== 'VERIFIED_READ_ONLY' || context.fresh !== true
    || !context.evidenceId.trim() || symbol(context.symbol) !== expectedSymbol
    || !finite(context.roundTripFeesFraction) || context.roundTripFeesFraction < 0
    || !finite(context.adverseImpactBufferFraction) || context.adverseImpactBufferFraction < 0
    || !finite(context.fundingBorrowingBufferFraction) || context.fundingBorrowingBufferFraction < 0
    || !finite(context.liquidityCapUsd) || context.liquidityCapUsd <= 0
    || !finite(context.tierNotionalCapUsd) || context.tierNotionalCapUsd <= 0) {
    return output(input, 'REJECTED', 'INVALID', {},
      ['GMX context shape 또는 freshness INVALID — fail-closed']);
  }
  if (!finite(signal.grossExpectedEdgeBps) || signal.grossExpectedEdgeBps <= 0) {
    return output(input, 'NOT_EVALUATED', STRATEGY_GMX_CONTEXT_NET_EDGE_VERSION, {
      coordinatorGeneration: binding.coordinatorGeneration,
      inputNotionalUsd: confidence.finalAdvisoryNotionalUsd,
    }, ['gross expected edge 근거 없음 — Net Edge 미평가']);
  }

  const notional = confidence.finalAdvisoryNotionalUsd;
  const roundTripCostFraction = context.roundTripFeesFraction
    + context.adverseImpactBufferFraction + context.fundingBorrowingBufferFraction;
  const roundTripCostBps = roundTripCostFraction * 10_000;
  const roundTripCostUsd = notional * roundTripCostFraction;
  const grossExpectedEdgeUsd = notional * signal.grossExpectedEdgeBps / 10_000;
  const costAdjustedNetEdgeUsd = grossExpectedEdgeUsd - roundTripCostUsd;
  const costAdjustedNetEdgeBps = signal.grossExpectedEdgeBps - roundTripCostBps;
  const costCapExcessUsd = Math.max(0, roundTripCostUsd - MANUAL_CANARY_CAPS.maxRoundTripCostUsd);
  const values = {
    coordinatorGeneration: binding.coordinatorGeneration,
    inputNotionalUsd: notional,
    grossExpectedEdgeBps: signal.grossExpectedEdgeBps,
    grossExpectedEdgeUsd,
    roundTripCostBps,
    roundTripCostUsd,
    costCapExcessUsd,
    costAdjustedNetEdgeBps,
    costAdjustedNetEdgeUsd,
  };
  if (![roundTripCostBps, roundTripCostUsd, grossExpectedEdgeUsd,
    costAdjustedNetEdgeBps, costAdjustedNetEdgeUsd].every(finite)) {
    return output(input, 'REJECTED', 'INVALID', values,
      ['비용·Net Edge 산술 overflow — fail-closed']);
  }
  if (notional > context.liquidityCapUsd || notional > context.tierNotionalCapUsd) {
    return output(input, 'REJECTED', STRATEGY_GMX_CONTEXT_NET_EDGE_VERSION, values,
      ['GMX liquidity 또는 tier notional cap 초과 — advisory 0']);
  }
  if (roundTripCostUsd > MANUAL_CANARY_CAPS.maxRoundTripCostUsd) {
    return output(input, 'REJECTED', STRATEGY_GMX_CONTEXT_NET_EDGE_VERSION, values,
      [`고정 $${MANUAL_CANARY_CAPS.maxRoundTripCostUsd.toFixed(2)} 왕복비용 상한 초과 — 완화 없이 차단`]);
  }
  if (costAdjustedNetEdgeUsd <= 0 || costAdjustedNetEdgeBps <= 0) {
    return output(input, 'REJECTED', STRATEGY_GMX_CONTEXT_NET_EDGE_VERSION, values,
      ['비용 차감 Net Edge가 양수 아님 — 경제성 fail-closed']);
  }
  return output(input, 'PASSED', STRATEGY_GMX_CONTEXT_NET_EDGE_VERSION, {
    ...values, finalAdvisoryNotionalUsd: notional,
  }, [
    '동일 readiness generation의 fresh GMX context로 비용 차감 Net Edge 재계산',
    '고정 $0.40 비용 상한·유동성·tier cap 통과',
    '실행·승인·PAPER/LIVE mutation 권한 없음',
  ]);
}
