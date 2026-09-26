import { describe, expect, it } from 'vitest';
import {
  createSignalLifecycleRecord,
  evaluateSignalEligibility,
  type SignalHistoryEvent,
} from '../intel/signalLifecycleV2';
import {
  buildSignalLifecycleSnapshot,
  restoreSignalLifecycleSnapshot,
  serializeSignalLifecycleSnapshot,
} from '../intel/signalLifecycleSnapshotV2';
import { STRATEGY_SIGNAL_SCHEMA_VERSION, type StrategySignal } from '../intel/strategySignalV2';

const CANDLE = 15 * 60 * 1_000;
const CLOSE = 20_000_000;
const CAPTURED = CLOSE + 60_000;
const signal = (overrides: Partial<StrategySignal> = {}): StrategySignal => ({
  schemaVersion: STRATEGY_SIGNAL_SCHEMA_VERSION,
  signalId: `BTC:TREND_PULLBACK:LONG:15m:${CLOSE}`,
  strategyId: 'TREND_PULLBACK', symbol: 'BTC', regime: 'TREND_UP', direction: 'LONG',
  confidence: 80, entryZoneLow: 99, entryZoneHigh: 101, proposedEntryPrice: 100,
  structuralStop: 98, stopDistancePct: 2, invalidationPrice: 98,
  targets: [{ price: 104, expectedR: 2, allocationPct: 100 }],
  grossExpectedEdgeBps: 400, expectedCostsBps: 20, netExpectedEdgeBps: 380,
  expectedNetRR: 1.9, higherTimeframeTrend: 'TREND_UP', marketStructure: 'BULLISH',
  confirmationPattern: 'REJECTION', sourceTimeframes: ['4h', '1h', '15m'],
  sourceCandleCloseTime: CLOSE, dataQuality: 'GOOD', volumeConfirmation: null,
  reasons: [], warnings: [], ...overrides,
});
const history = (kind: SignalHistoryEvent['kind'], close: number): SignalHistoryEvent => ({
  eventId: `${kind}:${close}`,
  kind,
  symbol: 'BTC',
  strategyId: kind === 'REGIME_CHANGE' ? null : 'TREND_PULLBACK',
  direction: kind === 'REGIME_CHANGE' ? null : 'LONG',
  sourceCandleCloseTime: close,
});

describe('Signal lifecycle restart snapshot v2', () => {
  it('canonical snapshot을 직렬화·복원해 동일 Signal ID 재처리를 계속 차단한다', () => {
    const record = createSignalLifecycleRecord(signal(), CAPTURED)!;
    const snapshot = buildSignalLifecycleSnapshot([record], [], CAPTURED);
    expect(snapshot).not.toBeNull();
    const serialized = serializeSignalLifecycleSnapshot(snapshot!);
    const restored = restoreSignalLifecycleSnapshot(serialized, CAPTURED + 1);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.reason);
    const decision = evaluateSignalEligibility(signal(), restored.snapshot.records,
      restored.snapshot.historyEvents);
    expect(decision.codes).toContain('DUPLICATE_SIGNAL');
  });

  it('Signal ID를 바꿔도 동일 종목·전략·방향·완료봉 재처리를 차단한다', () => {
    const record = createSignalLifecycleRecord(signal(), CAPTURED)!;
    const decision = evaluateSignalEligibility(signal({ signalId: 'attempted-id-bypass' }), [record], []);
    expect(decision.eligible).toBe(false);
    expect(decision.codes).toContain('DUPLICATE_SIGNAL');
    expect(decision.reasons.join(' ')).toContain('ID 변경 우회 금지');
  });

  it('재시작 후에도 Stop Loss와 Failed Breakout cooldown 종료봉을 보존한다', () => {
    const events = [
      history('STOP_LOSS', CLOSE - CANDLE),
      history('FAILED_BREAKOUT', CLOSE - 2 * CANDLE),
    ];
    const snapshot = buildSignalLifecycleSnapshot([], events, CAPTURED)!;
    const restored = restoreSignalLifecycleSnapshot(JSON.stringify(snapshot), CAPTURED + 5_000);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.reason);
    const decision = evaluateSignalEligibility(signal(), restored.snapshot.records,
      restored.snapshot.historyEvents);
    expect(decision.codes).toContain('STOP_LOSS_COOLDOWN');
    expect(decision.codes).toContain('FAILED_BREAKOUT_COOLDOWN');
    expect(decision.blockedUntilCandleCloseTime).toBe(CLOSE + 2 * CANDLE);
  });

  it('unknown field, future timestamp, version mismatch는 부분 복원 없이 fail-closed한다', () => {
    const valid = buildSignalLifecycleSnapshot([], [], CAPTURED)!;
    const cases = [
      { ...valid, extra: true },
      { ...valid, capturedAt: CAPTURED + 10_000 },
      { ...valid, schemaVersion: 'signal-lifecycle-snapshot/future' },
    ];
    for (const value of cases) {
      const restored = restoreSignalLifecycleSnapshot(value, CAPTURED + 1);
      expect(restored.ok).toBe(false);
      if (restored.ok) throw new Error('invalid snapshot restored');
      expect(restored.records).toEqual([]);
      expect(restored.historyEvents).toEqual([]);
    }
  });

  it('중복 Signal/candle 또는 History event는 ambiguous state로 거부한다', () => {
    const record = createSignalLifecycleRecord(signal(), CAPTURED)!;
    expect(buildSignalLifecycleSnapshot([record, { ...record }], [], CAPTURED)).toBeNull();
    const event = history('STOP_LOSS', CLOSE - CANDLE);
    expect(buildSignalLifecycleSnapshot([], [event, { ...event }], CAPTURED)).toBeNull();
  });

  it('손상 JSON과 미래 record는 빈 상태로도 복원하지 않는다', () => {
    expect(restoreSignalLifecycleSnapshot('{broken', CAPTURED).ok).toBe(false);
    const record = createSignalLifecycleRecord(signal(), CAPTURED)!;
    const raw = {
      schemaVersion: 'signal-lifecycle-snapshot/v1',
      configVersion: 'signal-lifecycle/v1',
      capturedAt: CAPTURED,
      records: [{ ...record, updatedAt: CAPTURED + 1 }],
      historyEvents: [],
    };
    expect(restoreSignalLifecycleSnapshot(raw, CAPTURED + 1).ok).toBe(false);
  });
});
