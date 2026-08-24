import { describe, expect, it } from 'vitest';
import { parseStrategyShadowView } from '../ai/strategyShadowView';

const validEnvelope = {
  schemaVersion: 'strategy-shadow-worker-envelope/v1',
  mode: 'SHADOW_ONLY', status: 'EVALUATED', cycleNumber: 5,
  expectedSymbols: ['BTC'], evaluatedSymbols: ['BTC'], missingSymbols: [],
  records: [{
    symbol: 'BTC', regime: 'BREAKOUT_READY', action: 'NO_TRADE',
    comparison: 'AGREE_NO_TRADE', strategyId: null, signalId: null,
    confidence: null, selectedScore: null, expectedNetEdgeBps: null,
    expectedNetRR: null, lifecycleEligible: null,
    reasons: ['Strategy Arbiter NO TRADE'], warnings: [],
  }],
  reasons: ['모든 기대 종목의 Shadow explainability 확보'], warnings: [],
  executionAuthorized: false, approvalCreationAllowed: false,
  paperPositionMutationAllowed: false, livePositionMutationAllowed: false,
  riskAuthority: 'NOT_EVALUATED',
};

describe('parseStrategyShadowView', () => {
  it('accepts a safe persisted SHADOW envelope', () => {
    const view = parseStrategyShadowView(validEnvelope);
    expect(view?.status).toBe('EVALUATED');
    expect(view?.records).toHaveLength(1);
    expect(view?.records[0]).toMatchObject({ symbol: 'BTC', action: 'NO_TRADE' });
  });

  it('returns null when execution authority is enabled', () => {
    expect(parseStrategyShadowView({ ...validEnvelope, executionAuthorized: true })).toBeNull();
  });

  it('returns null for malformed records instead of inventing display evidence', () => {
    expect(parseStrategyShadowView({
      ...validEnvelope,
      records: [{ ...validEnvelope.records[0], expectedNetRR: 'unknown' }],
    })).toBeNull();
  });

  it('returns null when no envelope was persisted', () => {
    expect(parseStrategyShadowView(undefined)).toBeNull();
  });
});
