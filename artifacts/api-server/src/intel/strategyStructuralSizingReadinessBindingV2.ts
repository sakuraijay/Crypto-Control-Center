/**
 * Pure binding contract between the shared GMX readiness coordinator and the
 * Structural Stop sizing Worker bridge.
 *
 * This module performs no external read. It only accepts contexts produced by
 * one completed coordinator generation and strips any context that is stale.
 */
import type { StrategyStructuralSizingMarketContext } from './strategyStructuralSizingWorkerBridgeV2';

export const STRATEGY_STRUCTURAL_SIZING_READINESS_BINDING_VERSION =
  'strategy-structural-sizing-readiness-binding/v1' as const;
export const STRATEGY_STRUCTURAL_SIZING_CONTEXT_MAX_AGE_MS = 30_000;

export interface StrategyStructuralSizingCoordinatorEvidence {
  source: 'GMX_API_READINESS_COORDINATOR';
  generation: number;
  completedAt: number;
  externalReadComplete: true;
}

export interface StrategyStructuralSizingGeneratedContext
  extends StrategyStructuralSizingMarketContext {
  coordinatorGeneration: number;
}

export interface StrategyStructuralSizingReadinessBindingInput {
  coordinator: StrategyStructuralSizingCoordinatorEvidence;
  expectedSymbols: readonly string[];
  contexts: readonly StrategyStructuralSizingGeneratedContext[];
}

export interface StrategyStructuralSizingReadinessBinding {
  schemaVersion: typeof STRATEGY_STRUCTURAL_SIZING_READINESS_BINDING_VERSION | 'INVALID';
  status: 'NOT_EVALUATED' | 'PARTIAL' | 'BOUND' | 'BLOCKED';
  coordinatorGeneration: number | null;
  marketContextBySymbol: Readonly<Record<string, StrategyStructuralSizingMarketContext | null>>;
  summary: { expected: number; bound: number; missingOrStale: number };
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
const normalizeSymbol = (value: string): string => value.trim().toUpperCase();

function output(
  input: StrategyStructuralSizingReadinessBindingInput,
  status: StrategyStructuralSizingReadinessBinding['status'],
  schemaVersion: StrategyStructuralSizingReadinessBinding['schemaVersion'],
  marketContextBySymbol: Record<string, StrategyStructuralSizingMarketContext | null>,
  reasons: string[],
): StrategyStructuralSizingReadinessBinding {
  const values = Object.values(marketContextBySymbol);
  const bound = values.filter((value): value is StrategyStructuralSizingMarketContext => value !== null).length;
  return {
    schemaVersion,
    status,
    coordinatorGeneration: schemaVersion === 'INVALID' ? null : input.coordinator.generation,
    marketContextBySymbol,
    summary: {
      expected: input.expectedSymbols.length,
      bound,
      missingOrStale: values.length - bound,
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

function coordinatorValid(value: StrategyStructuralSizingCoordinatorEvidence): boolean {
  return value.source === 'GMX_API_READINESS_COORDINATOR'
    && Number.isInteger(value.generation) && value.generation > 0
    && finite(value.completedAt) && value.completedAt > 0
    && value.externalReadComplete === true;
}

function contextShapeValid(value: StrategyStructuralSizingGeneratedContext): boolean {
  return value.source === 'VERIFIED_READ_ONLY'
    && value.fresh === true
    && value.evidenceId.trim().length > 0
    && normalizeSymbol(value.symbol).length > 0
    && Number.isInteger(value.coordinatorGeneration) && value.coordinatorGeneration > 0
    && finite(value.observedAt) && value.observedAt > 0
    && finite(value.roundTripFeesFraction) && value.roundTripFeesFraction >= 0
    && finite(value.adverseImpactBufferFraction) && value.adverseImpactBufferFraction >= 0
    && finite(value.fundingBorrowingBufferFraction) && value.fundingBorrowingBufferFraction >= 0
    && finite(value.liquidityCapUsd) && value.liquidityCapUsd > 0
    && finite(value.tierNotionalCapUsd) && value.tierNotionalCapUsd > 0;
}

/**
 * Bind only same-generation, execution-fresh evidence. A mixed generation,
 * duplicate symbol/evidence ID, or unexpected symbol blocks the whole binding.
 * Missing or expired expected symbols stay explicit nulls.
 */
export function bindStrategyStructuralSizingReadinessGeneration(
  input: StrategyStructuralSizingReadinessBindingInput,
): StrategyStructuralSizingReadinessBinding {
  const expected = input.expectedSymbols.map(normalizeSymbol);
  if (!coordinatorValid(input.coordinator)
    || expected.some(value => value.length === 0)
    || new Set(expected).size !== expected.length) {
    return output(input, 'BLOCKED', 'INVALID', {},
      ['readiness coordinator 또는 expected symbol 계약 INVALID — 전체 결속 차단']);
  }

  const symbols = input.contexts.map(value => normalizeSymbol(value.symbol));
  const evidenceIds = input.contexts.map(value => value.evidenceId.trim());
  if (input.contexts.some(value => !contextShapeValid(value))
    || input.contexts.some(value => value.coordinatorGeneration !== input.coordinator.generation)
    || symbols.some(value => !expected.includes(value))
    || new Set(symbols).size !== symbols.length
    || new Set(evidenceIds).size !== evidenceIds.length) {
    return output(input, 'BLOCKED', 'INVALID', {},
      ['mixed generation·중복·미허용 readiness context 감지 — 부분 채택 금지']);
  }

  const marketContextBySymbol: Record<string, StrategyStructuralSizingMarketContext | null> = {};
  for (const expectedSymbol of expected) {
    const context = input.contexts.find(value => normalizeSymbol(value.symbol) === expectedSymbol);
    const ageMs = context ? input.coordinator.completedAt - context.observedAt : Number.POSITIVE_INFINITY;
    const executionFresh = context !== undefined
      && ageMs >= 0
      && ageMs <= STRATEGY_STRUCTURAL_SIZING_CONTEXT_MAX_AGE_MS;
    if (!context || !executionFresh) {
      marketContextBySymbol[expectedSymbol] = null;
      continue;
    }
    const { coordinatorGeneration: _generation, ...workerContext } = context;
    marketContextBySymbol[expectedSymbol] = workerContext;
  }

  const bound = Object.values(marketContextBySymbol).filter(value => value !== null).length;
  const status = bound === expected.length ? 'BOUND' : bound > 0 ? 'PARTIAL' : 'NOT_EVALUATED';
  return output(input, status, STRATEGY_STRUCTURAL_SIZING_READINESS_BINDING_VERSION,
    marketContextBySymbol, [
      `GMX readiness coordinator generation ${input.coordinator.generation}에 결속`,
      '30초 execution-fresh 범위 밖 근거는 null·NOT_EVALUATED',
      '외부 read 시작·실행·승인·PAPER/LIVE 권한 없음',
    ]);
}
