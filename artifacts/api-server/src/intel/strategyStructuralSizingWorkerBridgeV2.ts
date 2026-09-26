/**
 * Read-only Worker aggregation boundary for Structural Stop sizing advisories.
 *
 * It starts no external read and performs no persistence or execution. Only an
 * explicitly fresh, verified market context may produce a non-zero advisory.
 */
import type { AppliedRiskProfileSnapshot } from '../lib/riskProfiles';
import type { StrategyRiskWorkerAdvisory } from './strategyRiskWorkerBridgeV2';
import type { StrategyShadowWorkerEnvelope } from './strategyShadowWorkerEnvelopeV2';
import {
  buildStrategyStructuralSizingAdvisory,
  type StrategyStructuralSizingAdvisory,
} from './strategyStructuralSizingV2';

export const STRATEGY_STRUCTURAL_SIZING_WORKER_VERSION =
  'strategy-structural-sizing-worker/v1' as const;

export interface StrategyStructuralSizingMarketContext {
  source: 'VERIFIED_READ_ONLY';
  evidenceId: string;
  symbol: string;
  observedAt: number;
  fresh: true;
  roundTripFeesFraction: number;
  adverseImpactBufferFraction: number;
  fundingBorrowingBufferFraction: number;
  liquidityCapUsd: number;
  tierNotionalCapUsd: number;
}

export interface StrategyStructuralSizingWorkerInput {
  shadowEnvelope: StrategyShadowWorkerEnvelope;
  riskAdvisory: StrategyRiskWorkerAdvisory;
  riskProfile: AppliedRiskProfileSnapshot;
  marketContextBySymbol: Readonly<Record<string, StrategyStructuralSizingMarketContext | null>>;
}

export interface StrategyStructuralSizingWorkerAdvisory {
  schemaVersion: typeof STRATEGY_STRUCTURAL_SIZING_WORKER_VERSION | 'INVALID';
  advisoryId: string;
  cycleNumber: number;
  status: 'NOT_EVALUATED' | 'PARTIAL' | 'EVALUATED' | 'BLOCKED';
  sizings: StrategyStructuralSizingAdvisory[];
  summary: { sized: number; rejected: number; notEvaluated: number };
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
  input: StrategyStructuralSizingWorkerInput,
  status: StrategyStructuralSizingWorkerAdvisory['status'],
  version: StrategyStructuralSizingWorkerAdvisory['schemaVersion'],
  sizings: StrategyStructuralSizingAdvisory[],
  notEvaluated: number,
  reasons: string[],
): StrategyStructuralSizingWorkerAdvisory {
  return {
    schemaVersion: version,
    advisoryId: `${input.shadowEnvelope.envelopeId}:STRUCTURAL_SIZING_ADVISORY`,
    cycleNumber: input.shadowEnvelope.cycleNumber,
    status,
    sizings,
    summary: {
      sized: sizings.filter(value => value.status === 'SIZED').length,
      rejected: sizings.filter(value => value.status === 'REJECTED').length - notEvaluated,
      notEvaluated,
    },
    reasons,
    authority: 'ADVISORY_ONLY',
    externalReadStarted: false,
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
  };
}

function boundariesValid(input: StrategyStructuralSizingWorkerInput): boolean {
  const shadow = input.shadowEnvelope;
  const risk = input.riskAdvisory;
  return shadow.schemaVersion === 'strategy-shadow-worker-envelope/v1'
    && shadow.mode === 'SHADOW_ONLY'
    && shadow.executionAuthorized === false
    && shadow.approvalCreationAllowed === false
    && shadow.paperPositionMutationAllowed === false
    && shadow.livePositionMutationAllowed === false
    && shadow.riskAuthority === 'NOT_EVALUATED'
    && risk.schemaVersion === 'strategy-risk-worker-bridge/v1'
    && risk.authority === 'ADVISORY_ONLY'
    && risk.executionAuthorized === false
    && risk.approvalCreationAllowed === false
    && risk.paperPositionMutationAllowed === false
    && risk.livePositionMutationAllowed === false
    && risk.cycleNumber === shadow.cycleNumber
    && risk.advisoryId === `${shadow.envelopeId}:RISK_ADVISORY`;
}

function contextValid(
  context: StrategyStructuralSizingMarketContext | null | undefined,
  expectedSymbol: string,
): context is StrategyStructuralSizingMarketContext {
  return context !== null && context !== undefined
    && context.source === 'VERIFIED_READ_ONLY'
    && context.fresh === true
    && context.evidenceId.trim().length > 0
    && symbol(context.symbol) === symbol(expectedSymbol)
    && finite(context.observedAt) && context.observedAt > 0
    && finite(context.roundTripFeesFraction) && context.roundTripFeesFraction >= 0
    && finite(context.adverseImpactBufferFraction) && context.adverseImpactBufferFraction >= 0
    && finite(context.fundingBorrowingBufferFraction) && context.fundingBorrowingBufferFraction >= 0
    && finite(context.liquidityCapUsd) && context.liquidityCapUsd > 0
    && finite(context.tierNotionalCapUsd) && context.tierNotionalCapUsd > 0;
}

/**
 * Joins already-computed SHADOW/Risk evidence with optional verified market
 * context. Missing context stays explicit and cannot silently become zero-cost.
 */
export function buildStrategyStructuralSizingWorkerAdvisory(
  input: StrategyStructuralSizingWorkerInput,
): StrategyStructuralSizingWorkerAdvisory {
  if (!boundariesValid(input)) {
    return output(input, 'BLOCKED', 'INVALID', [], 0,
      ['SHADOW/Risk Worker 권한 또는 cycle 결속 INVALID — 전체 sizing 차단']);
  }
  const records = input.shadowEnvelope.records;
  const decisions = input.riskAdvisory.decisions;
  if (records.length !== decisions.length
    || records.some((record, index) =>
      decisions[index]?.decisionId !== `${record.shadowRecordId}:RISK_ADAPTER`
      || decisions[index]?.signalId !== record.signalId
      || symbol(decisions[index]?.symbol ?? '') !== symbol(record.symbol))) {
    return output(input, 'BLOCKED', 'INVALID', [], 0,
      ['SHADOW record와 Risk decision 일대일 결속 실패 — 부분 채택 금지']);
  }
  if (records.length === 0) {
    return output(input, 'NOT_EVALUATED', STRATEGY_STRUCTURAL_SIZING_WORKER_VERSION,
      [], 0, ['Strategy SHADOW record 없음 — sizing 미평가']);
  }

  let notEvaluated = 0;
  const sizings = records.map((record, index) => {
    const riskDecision = decisions[index];
    const context = input.marketContextBySymbol[symbol(record.symbol)];
    const usableContext = contextValid(context, record.symbol);
    if (!usableContext && (riskDecision.action === 'ALLOW' || riskDecision.action === 'REDUCE')) {
      notEvaluated += 1;
    }
    return buildStrategyStructuralSizingAdvisory({
      shadowRecord: record,
      riskDecision,
      riskProfile: input.riskProfile,
      roundTripFeesFraction: usableContext ? context.roundTripFeesFraction : Number.NaN,
      adverseImpactBufferFraction: usableContext ? context.adverseImpactBufferFraction : Number.NaN,
      fundingBorrowingBufferFraction: usableContext ? context.fundingBorrowingBufferFraction : Number.NaN,
      liquidityCapUsd: usableContext ? context.liquidityCapUsd : null,
      tierNotionalCapUsd: usableContext ? context.tierNotionalCapUsd : Number.NaN,
    });
  });
  const sized = sizings.filter(value => value.status === 'SIZED').length;
  const status = notEvaluated === 0 ? 'EVALUATED'
    : sized > 0 ? 'PARTIAL' : 'NOT_EVALUATED';
  return output(input, status, STRATEGY_STRUCTURAL_SIZING_WORKER_VERSION,
    sizings, notEvaluated, [
      '기존 SHADOW/Risk 결과와 검증된 read-only market context만 결합',
      '외부 read 시작·실행·승인·PAPER/LIVE 권한 없음',
      ...(notEvaluated > 0 ? ['비용·유동성 근거 결측 종목은 0·NOT_EVALUATED'] : []),
    ]);
}
