import { describe, expect, it } from 'vitest';
import { buildStrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import {
  advanceVirtualPaper400StrategyContinuity,
  filterNewVirtualPaper400StrategyRecords,
  restoreVirtualPaper400StrategyContinuity,
  summarizeVirtualPaper400StrategyContinuity,
  virtualPaper400StrategyContinuityKey,
} from '../workers/virtualPaper400StrategyContinuity';
import { virtualReplaySignal } from './helpers/virtualPaper400Replay';
import { buildCandleStrategyShadowEvidence } from '../intel/candleStrategyShadowEvidenceV2';

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

function evaluatedEnvelope(at = now) {
  const envelope = notEvaluatedEnvelope(at);
  const record = virtualReplaySignal(at);
  const candleSignal = record.candleSignalEvidence!.candleSignal;
  record.candleSignalEvidence = buildCandleStrategyShadowEvidence({
    candleSignal,
    v2Regime: {
      configVersion: 'regime-engine/v2', symbol: 'BTC', regime: 'TREND_UP', confidence: 80,
      sinceCandleCloseTime: record.sourceCandleCloseTime, heldCandles: 1,
      pendingRegime: null, pendingCount: 0, previousRegime: 'UNKNOWN', changed: true,
      candidateRegime: 'TREND_UP', candidateConfidence: 80,
      calculatedAt: record.sourceCandleCloseTime, reasons: ['test'], warnings: [], scores: {
        TREND_UP: 80, TREND_DOWN: 0, RANGE: 0, BREAKOUT_READY: 0,
        HIGH_VOLATILITY: 0, TRANSITION: 0,
      },
    },
    shadowRecord: { ...record, candleSignalEvidence: undefined },
  })!;
  envelope.status = 'PARTIAL';
  envelope.records = [record];
  envelope.evaluatedSymbols = ['BTC'];
  envelope.missingSymbols = ['ETH', 'SOL'];
  return envelope;
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

  it('preserves the last meaningful completed-candle reasons across duplicate worker ticks', () => {
    const missing = restoreVirtualPaper400StrategyContinuity(null, sessionId, now, symbols);
    const accepted = advanceVirtualPaper400StrategyContinuity(
      sessionId, missing, evaluatedEnvelope(), now,
    )!;
    expect(accepted.lastMeaningfulAnalysis).toMatchObject({
      evaluatedAt: now, status: 'PARTIAL',
      records: [{ symbol: 'BTC', reasons: ['SYNTHETIC REPLAY'] }],
    });
    const restored = restoreVirtualPaper400StrategyContinuity(
      accepted, sessionId, now + 60_000, symbols,
    );
    const duplicate = advanceVirtualPaper400StrategyContinuity(
      sessionId, restored, notEvaluatedEnvelope(now + 60_000), now + 60_000,
    )!;
    expect(duplicate.lastEnvelopeStatus).toBe('NOT_EVALUATED');
    expect(duplicate.lastMeaningfulAnalysis).toEqual(accepted.lastMeaningfulAnalysis);
    const summary = summarizeVirtualPaper400StrategyContinuity(
      restoreVirtualPaper400StrategyContinuity(duplicate, sessionId, now + 60_000, symbols),
    );
    expect(summary).toMatchObject({ lastEnvelopeStatus: 'NOT_EVALUATED',
      lastMeaningfulAnalysis: { status: 'PARTIAL', records: [{ symbol: 'BTC' }] } });
  });

  it('fails closed on malformed durable meaningful-analysis evidence', () => {
    const missing = restoreVirtualPaper400StrategyContinuity(null, sessionId, now, symbols);
    const persisted = advanceVirtualPaper400StrategyContinuity(
      sessionId, missing, evaluatedEnvelope(), now,
    )!;
    expect(restoreVirtualPaper400StrategyContinuity({ ...persisted,
      lastMeaningfulAnalysis: { ...persisted.lastMeaningfulAnalysis!,
        records: [{ ...persisted.lastMeaningfulAnalysis!.records[0], symbol: 'DOGE' }] } },
    sessionId, now + 60_000, symbols)).toMatchObject({
      status: 'BLOCKED', reason: 'STRATEGY_CONTINUITY_ANALYSIS_INVALID',
    });
  });

  it('adds the optional diagnostic field to an existing v2 state without resetting continuity', () => {
    const missing = restoreVirtualPaper400StrategyContinuity(null, sessionId, now, symbols);
    const persisted = advanceVirtualPaper400StrategyContinuity(
      sessionId, missing, notEvaluatedEnvelope(), now,
    )!;
    const deployedV2 = { ...persisted } as Partial<typeof persisted>;
    delete deployedV2.lastMeaningfulAnalysis;
    const restored = restoreVirtualPaper400StrategyContinuity(
      deployedV2, sessionId, now + 60_000, symbols,
    );
    expect(restored.status).toBe('RESTORED');
    if (restored.status === 'BLOCKED') throw new Error('unexpected blocked additive migration');
    expect(restored.state.lastMeaningfulAnalysis).toBeNull();
    expect(restored.state.strategyEnsembleShadow).toEqual(persisted.strategyEnsembleShadow);
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
