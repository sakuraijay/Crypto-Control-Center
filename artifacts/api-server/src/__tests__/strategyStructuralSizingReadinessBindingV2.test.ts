import { describe, expect, it } from 'vitest';
import {
  bindStrategyStructuralSizingReadinessGeneration,
  STRATEGY_STRUCTURAL_SIZING_READINESS_BINDING_VERSION,
  type StrategyStructuralSizingGeneratedContext,
  type StrategyStructuralSizingReadinessBindingInput,
} from '../intel/strategyStructuralSizingReadinessBindingV2';

const NOW = 2_000_000;
const context = (
  symbol: string,
  overrides: Partial<StrategyStructuralSizingGeneratedContext> = {},
): StrategyStructuralSizingGeneratedContext => ({
  source: 'VERIFIED_READ_ONLY', evidenceId: `generation-7-${symbol}`, symbol,
  observedAt: NOW - 1_000, fresh: true, coordinatorGeneration: 7,
  roundTripFeesFraction: 0.002, adverseImpactBufferFraction: 0.001,
  fundingBorrowingBufferFraction: 0.001, liquidityCapUsd: 1_000,
  tierNotionalCapUsd: 500, ...overrides,
});
const input = (): StrategyStructuralSizingReadinessBindingInput => ({
  coordinator: {
    source: 'GMX_API_READINESS_COORDINATOR', generation: 7,
    completedAt: NOW, externalReadComplete: true,
  },
  expectedSymbols: ['BTC', 'ETH'],
  contexts: [context('BTC'), context('ETH')],
});

describe('Structural sizing readiness generation binding', () => {
  it('동일 coordinator generation의 fresh 근거만 Worker context로 결속한다', () => {
    expect(bindStrategyStructuralSizingReadinessGeneration(input())).toMatchObject({
      schemaVersion: STRATEGY_STRUCTURAL_SIZING_READINESS_BINDING_VERSION,
      status: 'BOUND', coordinatorGeneration: 7,
      summary: { expected: 2, bound: 2, missingOrStale: 0 },
      authority: 'ADVISORY_ONLY', externalReadStarted: false,
      executionAuthorized: false, approvalCreationAllowed: false,
      paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
      marketContextBySymbol: {
        BTC: { source: 'VERIFIED_READ_ONLY', symbol: 'BTC' },
        ETH: { source: 'VERIFIED_READ_ONLY', symbol: 'ETH' },
      },
    });
  });

  it('mixed generation은 일부 context도 채택하지 않고 BLOCKED한다', () => {
    const value = input();
    value.contexts = [context('BTC'), context('ETH', { coordinatorGeneration: 6 })];
    expect(bindStrategyStructuralSizingReadinessGeneration(value)).toMatchObject({
      schemaVersion: 'INVALID', status: 'BLOCKED', coordinatorGeneration: null,
      marketContextBySymbol: {}, summary: { bound: 0 },
    });
  });

  it('30초 초과 또는 coordinator 완료 이후 근거는 null로 fail-closed한다', () => {
    const value = input();
    value.contexts = [
      context('BTC', { observedAt: NOW - 30_001 }),
      context('ETH', { observedAt: NOW + 1 }),
    ];
    expect(bindStrategyStructuralSizingReadinessGeneration(value)).toMatchObject({
      status: 'NOT_EVALUATED', summary: { expected: 2, bound: 0, missingOrStale: 2 },
      marketContextBySymbol: { BTC: null, ETH: null },
    });
  });

  it('일부 expected symbol이 없으면 PARTIAL이며 누락 종목을 생성하지 않는다', () => {
    const value = input();
    value.contexts = [context('BTC')];
    expect(bindStrategyStructuralSizingReadinessGeneration(value)).toMatchObject({
      status: 'PARTIAL', summary: { expected: 2, bound: 1, missingOrStale: 1 },
      marketContextBySymbol: { BTC: expect.any(Object), ETH: null },
    });
  });

  it('중복 symbol·evidence ID 또는 unexpected symbol은 전체 BLOCKED한다', () => {
    const duplicate = input();
    duplicate.contexts = [context('BTC'), context('btc')];
    expect(bindStrategyStructuralSizingReadinessGeneration(duplicate).status).toBe('BLOCKED');

    const evidence = input();
    evidence.contexts = [context('BTC'), context('ETH', { evidenceId: 'generation-7-BTC' })];
    expect(bindStrategyStructuralSizingReadinessGeneration(evidence).status).toBe('BLOCKED');

    const extra = input();
    extra.contexts = [...extra.contexts, context('SOL')];
    expect(bindStrategyStructuralSizingReadinessGeneration(extra).status).toBe('BLOCKED');
  });

  it('입력 불변이며 잘못된 coordinator/expected 계약을 차단한다', () => {
    const value = input();
    const before = JSON.stringify(value);
    expect(bindStrategyStructuralSizingReadinessGeneration(value))
      .toEqual(bindStrategyStructuralSizingReadinessGeneration(value));
    expect(JSON.stringify(value)).toBe(before);

    const invalid = input();
    invalid.coordinator = { ...invalid.coordinator, generation: 0 };
    expect(bindStrategyStructuralSizingReadinessGeneration(invalid).status).toBe('BLOCKED');
  });
});
