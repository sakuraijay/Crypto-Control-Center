import { describe, expect, it } from 'vitest';
import { buildStrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import {
  advanceVirtualPaper400StrategyContinuity,
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
});
