import { describe, expect, it } from 'vitest';
import { buildStrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import {
  advanceVirtualPaper400StrategyContinuity,
  filterNewVirtualPaper400StrategyRecords,
  restoreVirtualPaper400StrategyContinuity,
  virtualPaper400StrategyContinuityKey,
} from '../workers/virtualPaper400StrategyContinuity';

const symbols = ['BTC', 'ETH', 'SOL'];
const now = 1_800_000_000_000;
const sessionId = 'vp400-continuity-test';

function notEvaluatedEnvelope(at = now) {
  return buildStrategyShadowWorkerEnvelope({ cycleNumber: 1, generatedAt: at,
    expectedSymbols: symbols, records: [],
    existingAi: { decisionId: `test:${at}`, action: 'NO_TRADE', confidence: 0,
      primarySymbol: null, createdAt: new Date(at).toISOString() },
    notEvaluatedReason: 'no completed candle' });
}

describe('Virtual400 session-scoped Strategy continuity codec', () => {
  it('establishes a durable baseline and restores it across process-local cycles', () => {
    const missing = restoreVirtualPaper400StrategyContinuity(null, sessionId, now, symbols);
    expect(missing.status).toBe('MISSING');
    const persisted = advanceVirtualPaper400StrategyContinuity(sessionId, missing, notEvaluatedEnvelope(), now);
    expect(persisted).not.toBeNull();
    const restored = restoreVirtualPaper400StrategyContinuity(
      JSON.stringify(persisted), sessionId, now + 60_000, symbols,
    );
    expect(restored.status).toBe('RESTORED');
    if (restored.status !== 'BLOCKED') {
      expect(restored.lifecycleSnapshot.records).toEqual([]);
      expect(restored.previousRegimes).toEqual({});
      const next = advanceVirtualPaper400StrategyContinuity(
        sessionId, restored, notEvaluatedEnvelope(now + 60_000), now + 60_000,
      );
      expect(next?.sessionId).toBe(sessionId);
      expect(next?.updatedAt).toBe(now + 60_000);
    }
  });

  it('binds the key and payload to one Virtual400 session', () => {
    expect(virtualPaper400StrategyContinuityKey(sessionId)).toContain(sessionId);
    const missing = restoreVirtualPaper400StrategyContinuity(null, sessionId, now, symbols);
    const persisted = advanceVirtualPaper400StrategyContinuity(sessionId, missing, notEvaluatedEnvelope(), now)!;
    const wrong = restoreVirtualPaper400StrategyContinuity(persisted, 'another-session', now, symbols);
    expect(wrong).toMatchObject({ status: 'BLOCKED', reason: 'STRATEGY_CONTINUITY_STATE_INVALID' });
  });

  it('rejects corrupt and future state without replacing it with an empty baseline', () => {
    expect(restoreVirtualPaper400StrategyContinuity('{broken', sessionId, now, symbols))
      .toMatchObject({ status: 'BLOCKED', reason: 'STRATEGY_CONTINUITY_JSON_INVALID' });
    const missing = restoreVirtualPaper400StrategyContinuity(null, sessionId, now, symbols);
    const persisted = advanceVirtualPaper400StrategyContinuity(sessionId, missing, notEvaluatedEnvelope(), now)!;
    expect(restoreVirtualPaper400StrategyContinuity(
      { ...persisted, updatedAt: now + 1 }, sessionId, now, symbols,
    )).toMatchObject({ status: 'BLOCKED', reason: 'STRATEGY_CONTINUITY_STATE_INVALID' });
  });

  it('drops a repeated completed-candle record before it can advance hysteresis or authorize entry', () => {
    const missing = restoreVirtualPaper400StrategyContinuity(null, sessionId, now, symbols);
    if (missing.status === 'BLOCKED') throw new Error('unexpected blocked baseline');
    missing.state.lastSourceCandleCloseTimeBySymbol.BTC = now - 15 * 60_000;
    const envelope = notEvaluatedEnvelope() as any;
    envelope.status = 'EVALUATED';
    envelope.records = [{ symbol: 'BTC', sourceCandleCloseTime: now - 15 * 60_000,
      action: 'LONG', comparison: 'ENSEMBLE_ONLY' }];
    const filtered = filterNewVirtualPaper400StrategyRecords(missing, envelope, now);
    expect(filtered?.envelope.status).toBe('NOT_EVALUATED');
    expect(filtered?.envelope.records).toEqual([]);
    expect(filtered?.cursors.BTC).toBe(now - 15 * 60_000);
  });

  it('discards contaminated v1 SHADOW evidence while preserving its completed-candle boundary', () => {
    const missing = restoreVirtualPaper400StrategyContinuity(null, sessionId, now, symbols);
    const persisted = advanceVirtualPaper400StrategyContinuity(
      sessionId, missing, notEvaluatedEnvelope(), now,
    )!;
    const restored = restoreVirtualPaper400StrategyContinuity(
      { ...persisted, schemaVersion: 'virtual-paper-400-strategy-continuity/v1' },
      sessionId, now + 60_000, symbols,
    );
    expect(restored.status).toBe('RESTORED');
    if (restored.status === 'BLOCKED') throw new Error('unexpected blocked migration');
    expect(restored.state.schemaVersion).toBe('virtual-paper-400-strategy-continuity/v2');
    expect(restored.previousRegimes).toEqual({});
    expect(restored.lifecycleSnapshot.records).toEqual([]);
    expect(restored.state.lastSourceCandleCloseTimeBySymbol).toEqual({
      BTC: now, ETH: now, SOL: now,
    });
  });
});
