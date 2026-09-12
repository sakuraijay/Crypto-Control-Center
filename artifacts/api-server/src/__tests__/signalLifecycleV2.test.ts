import { describe, expect, it } from 'vitest';
import {
  createSignalLifecycleRecord,
  DEFAULT_SIGNAL_LIFECYCLE_CONFIG,
  evaluateSignalEligibility,
  transitionSignalLifecycle,
  type SignalHistoryEvent,
} from '../intel/signalLifecycleV2';
import { STRATEGY_SIGNAL_SCHEMA_VERSION, type StrategySignal } from '../intel/strategySignalV2';

const CLOSE = 10_000_000;
const CANDLE = 15 * 60 * 1_000;
const signal = (overrides: Partial<StrategySignal> = {}): StrategySignal => ({
  schemaVersion: STRATEGY_SIGNAL_SCHEMA_VERSION,
  signalId: `BTC:TREND_PULLBACK:LONG:15m:${CLOSE}`,
  strategyId: 'TREND_PULLBACK', symbol: 'BTC', regime: 'TREND_UP', direction: 'LONG',
  confidence: 85, entryZoneLow: 99, entryZoneHigh: 101, proposedEntryPrice: 100,
  structuralStop: 98, stopDistancePct: 2, invalidationPrice: 98,
  targets: [{ price: 104, expectedR: 2, allocationPct: 100 }],
  grossExpectedEdgeBps: 400, expectedCostsBps: 20, netExpectedEdgeBps: 380, expectedNetRR: 1.9,
  higherTimeframeTrend: 'TREND_UP', marketStructure: 'BULLISH', confirmationPattern: 'REJECTION',
  sourceTimeframes: ['4h', '1h', '15m'], sourceCandleCloseTime: CLOSE,
  dataQuality: 'GOOD', volumeConfirmation: null, reasons: [], warnings: [], ...overrides,
});
const event = (kind: SignalHistoryEvent['kind'], close: number, overrides: Partial<SignalHistoryEvent> = {}): SignalHistoryEvent => ({
  eventId: `${kind}:${close}:${overrides.strategyId ?? 'TREND_PULLBACK'}:${overrides.direction ?? 'LONG'}`,
  kind, symbol: 'BTC', strategyId: 'TREND_PULLBACK', direction: 'LONG', sourceCandleCloseTime: close,
  ...overrides,
});

describe('Signal lifecycle and cooldown v2', () => {
  it('StrategySignal에서 GENERATED record를 만든다', () => {
    const record = createSignalLifecycleRecord(signal(), CLOSE + 1);
    expect(record?.status).toBe('GENERATED');
    expect(record?.symbol).toBe('BTC');
  });

  it('NONE 방향 또는 미래 생성시각은 lifecycle record로 만들지 않는다', () => {
    expect(createSignalLifecycleRecord(signal({ direction: 'NONE' }), CLOSE + 1)).toBeNull();
    expect(createSignalLifecycleRecord(signal(), CLOSE - 1)).toBeNull();
  });

  it('GENERATED에서 APPROVED/REDUCED/REJECTED 전이를 허용한다', () => {
    const base = createSignalLifecycleRecord(signal(), CLOSE + 1)!;
    expect(transitionSignalLifecycle(base, 'APPROVED', CLOSE + 2)?.status).toBe('APPROVED');
    expect(transitionSignalLifecycle(base, 'REDUCED', CLOSE + 2)?.status).toBe('REDUCED');
    expect(transitionSignalLifecycle(base, 'REJECTED', CLOSE + 2)?.status).toBe('REJECTED');
  });

  it('terminal 상태 역행과 과거 시각 전이를 차단한다', () => {
    const base = createSignalLifecycleRecord(signal(), CLOSE + 1)!;
    const executed = transitionSignalLifecycle(transitionSignalLifecycle(base, 'APPROVED', CLOSE + 2)!, 'EXECUTED', CLOSE + 3)!;
    expect(transitionSignalLifecycle(executed, 'APPROVED', CLOSE + 4)).toBeNull();
    expect(transitionSignalLifecycle(base, 'APPROVED', CLOSE)).toBeNull();
  });

  it('동일 Signal ID가 한 번이라도 기록되면 재처리하지 않는다', () => {
    const record = createSignalLifecycleRecord(signal(), CLOSE + 1)!;
    const result = evaluateSignalEligibility(signal(), [record], []);
    expect(result.eligible).toBe(false);
    expect(result.codes).toContain('DUPLICATE_SIGNAL');
  });

  it('Stop Loss 후 동일 방향은 완료 15m봉 3개 동안 차단한다', () => {
    const stoppedAt = CLOSE - 2 * CANDLE;
    const blocked = evaluateSignalEligibility(signal(), [], [event('STOP_LOSS', stoppedAt)]);
    expect(blocked.codes).toContain('STOP_LOSS_COOLDOWN');
    expect(blocked.blockedUntilCandleCloseTime).toBe(stoppedAt + 3 * CANDLE);
    const after = evaluateSignalEligibility(signal({ sourceCandleCloseTime: stoppedAt + 3 * CANDLE,
      signalId: `BTC:TREND_PULLBACK:LONG:15m:${stoppedAt + 3 * CANDLE}` }), [], [event('STOP_LOSS', stoppedAt)]);
    expect(after.codes).not.toContain('STOP_LOSS_COOLDOWN');
  });

  it('Stop Loss의 반대 방향은 동일방향 cooldown에 걸리지 않는다', () => {
    const result = evaluateSignalEligibility(signal({ direction: 'SHORT',
      signalId: `BTC:TREND_PULLBACK:SHORT:15m:${CLOSE}` }), [], [event('STOP_LOSS', CLOSE - CANDLE)]);
    expect(result.codes).not.toContain('STOP_LOSS_COOLDOWN');
  });

  it('Failed Breakout 이후 동일 전략·방향 재진입을 차단한다', () => {
    const result = evaluateSignalEligibility(signal({ strategyId: 'VOLATILITY_BREAKOUT',
      regime: 'BREAKOUT_READY', signalId: `BTC:VOLATILITY_BREAKOUT:LONG:15m:${CLOSE}` }), [], [
      event('FAILED_BREAKOUT', CLOSE - CANDLE, { strategyId: 'VOLATILITY_BREAKOUT' }),
    ]);
    expect(result.codes).toContain('FAILED_BREAKOUT_COOLDOWN');
  });

  it('동일 전략 연속 손실 임계값에서 전략별 cooldown을 적용한다', () => {
    const result = evaluateSignalEligibility(signal(), [], [
      event('TRADE_LOSS', CLOSE - CANDLE),
      event('TRADE_LOSS', CLOSE - 2 * CANDLE, { eventId: 'older-loss' }),
    ]);
    expect(result.strategyConsecutiveLosses).toBe(2);
    expect(result.codes).toContain('STRATEGY_LOSS_COOLDOWN');
  });

  it('최근 승리는 연속 손실 streak을 끊는다', () => {
    const result = evaluateSignalEligibility(signal(), [], [
      event('TRADE_WIN', CLOSE - CANDLE),
      event('TRADE_LOSS', CLOSE - 2 * CANDLE),
      event('TRADE_LOSS', CLOSE - 3 * CANDLE, { eventId: 'older-loss' }),
    ]);
    expect(result.strategyConsecutiveLosses).toBe(0);
    expect(result.codes).not.toContain('STRATEGY_LOSS_COOLDOWN');
  });

  it('종목 전체 연속 손실은 전략이 달라도 symbol cooldown을 적용한다', () => {
    const result = evaluateSignalEligibility(signal(), [], [
      event('TRADE_LOSS', CLOSE - CANDLE),
      event('TRADE_LOSS', CLOSE - 2 * CANDLE, { eventId: 'range-loss', strategyId: 'RANGE_MEAN_REVERSION' }),
      event('TRADE_LOSS', CLOSE - 3 * CANDLE, { eventId: 'breakout-loss', strategyId: 'VOLATILITY_BREAKOUT' }),
    ]);
    expect(result.symbolConsecutiveLosses).toBe(3);
    expect(result.codes).toContain('SYMBOL_LOSS_COOLDOWN');
  });

  it('Regime 전환 직후 최소 확인봉을 기다린다', () => {
    const result = evaluateSignalEligibility(signal(), [], [event('REGIME_CHANGE', CLOSE, {
      direction: null, strategyId: null, regimeFrom: 'RANGE', regimeTo: 'TREND_UP',
    })]);
    expect(result.codes).toContain('REGIME_CHANGE_COOLDOWN');
  });

  it('반대 방향 exit 직후 LONG↔SHORT 반복 전환을 차단한다', () => {
    const result = evaluateSignalEligibility(signal(), [], [event('DIRECTION_EXIT', CLOSE - CANDLE, {
      direction: 'SHORT', strategyId: null,
    })]);
    expect(result.codes).toContain('DIRECTION_FLIP_COOLDOWN');
  });

  it('중복 history event는 제거하고 내용 충돌은 fail-closed한다', () => {
    const base = event('TRADE_WIN', CLOSE - CANDLE);
    const duplicate = evaluateSignalEligibility(signal(), [], [base, { ...base }]);
    expect(duplicate.eligible).toBe(true);
    expect(duplicate.warnings.join(' ')).toContain('중복 History event');
    const conflict = evaluateSignalEligibility(signal(), [], [base, { ...base, symbol: 'ETH' }]);
    expect(conflict.codes).toContain('INPUT_INVALID');
  });

  it('미래 history event와 strict config 오류는 fail-closed한다', () => {
    const future = evaluateSignalEligibility(signal(), [], [event('TRADE_WIN', CLOSE + CANDLE)]);
    expect(future.codes).toContain('INPUT_INVALID');
    const config = evaluateSignalEligibility(signal(), [], [], { ...DEFAULT_SIGNAL_LIFECYCLE_CONFIG, extra: true });
    expect(config.configVersion).toBe('INVALID');
    expect(config.warnings.join(' ')).toContain('알 수 없는');
  });

  it('차단 사유가 없으면 ELIGIBLE을 반환한다', () => {
    const result = evaluateSignalEligibility(signal(), [], []);
    expect(result.eligible).toBe(true);
    expect(result.codes).toEqual(['ELIGIBLE']);
  });
});
