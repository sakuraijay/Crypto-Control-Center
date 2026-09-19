import { describe, expect, it } from 'vitest';
import {
  ALPHA_START_INTENT_SCHEMA_VERSION,
  buildActiveAlphaStartIntent,
  buildStoppedAlphaStartIntent,
  evaluateAlphaStartIntent,
  evaluateAlphaStartPolicy,
  serializeAlphaStartIntentV1,
} from '../workers/alphaStartIntent';

const NOW = new Date('2026-09-20T00:00:00.000Z');

function fixedBetaPolicyRaw(): string {
  return JSON.stringify({
    schemaVersion: 1,
    policyContext: 'FIXED_BETA_400',
    approvedBy: 'OPERATOR_AUTH_V1',
    approvedAt: '2026-09-19T23:59:00.000Z',
  });
}

describe('alpha start intent control plane', () => {
  it('treats missing state as inactive without authorizing execution', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const result = evaluateAlphaStartIntent(raw, NOW);
      expect(result.status).toBe('MISSING');
      expect(result.active).toBe(false);
      expect(result.executionAuthorized).toBe(false);
    }
  });

  it('fails closed for malformed or unsupported persisted state', () => {
    const malformed = evaluateAlphaStartIntent('{not-json', NOW);
    expect(malformed.status).toBe('INVALID');
    expect(malformed.active).toBe(false);
    expect(malformed.executionAuthorized).toBe(false);

    const wrongSchema = evaluateAlphaStartIntent(JSON.stringify({
      schemaVersion: 2,
      status: 'ACTIVE',
      issuedAt: NOW.toISOString(),
      expiresAt: '2026-09-20T01:00:00.000Z',
    }), NOW);
    expect(wrongSchema.status).toBe('INVALID');
    expect(wrongSchema.active).toBe(false);
  });

  it('records active intent but never treats it as execution authorization', () => {
    const state = buildActiveAlphaStartIntent('2026-09-20T09:00:00+08:00', NOW);
    expect(state).toEqual({
      schemaVersion: ALPHA_START_INTENT_SCHEMA_VERSION,
      status: 'ACTIVE',
      issuedAt: NOW.toISOString(),
      expiresAt: '2026-09-20T01:00:00.000Z',
    });

    const result = evaluateAlphaStartIntent(serializeAlphaStartIntentV1(state), NOW);
    expect(result.status).toBe('ACTIVE');
    expect(result.active).toBe(true);
    expect(result.executionAuthorized).toBe(false);
  });

  it('expires fail-closed at or after the explicit expiry', () => {
    const state = buildActiveAlphaStartIntent('2026-09-20T01:00:00.000Z', NOW);
    const raw = serializeAlphaStartIntentV1(state);

    const atExpiry = evaluateAlphaStartIntent(raw, new Date('2026-09-20T01:00:00.000Z'));
    expect(atExpiry.status).toBe('EXPIRED');
    expect(atExpiry.active).toBe(false);
    expect(atExpiry.executionAuthorized).toBe(false);

    const afterExpiry = evaluateAlphaStartIntent(raw, new Date('2026-09-20T01:00:01.000Z'));
    expect(afterExpiry.status).toBe('EXPIRED');
    expect(afterExpiry.active).toBe(false);
  });

  it('requires an explicit valid future expiry for START', () => {
    expect(() => buildActiveAlphaStartIntent('not-a-date', NOW)).toThrow('EXPIRES_AT_INVALID');
    expect(() => buildActiveAlphaStartIntent(NOW.toISOString(), NOW)).toThrow('EXPIRES_AT_NOT_FUTURE');
    expect(() => buildActiveAlphaStartIntent('2026-09-19T23:59:59.999Z', NOW)).toThrow('EXPIRES_AT_NOT_FUTURE');
  });

  it('records STOP independently and remains inactive', () => {
    const state = buildStoppedAlphaStartIntent(' operator stop ', NOW);
    expect(state).toEqual({
      schemaVersion: ALPHA_START_INTENT_SCHEMA_VERSION,
      status: 'STOPPED',
      issuedAt: NOW.toISOString(),
      expiresAt: null,
      stoppedAt: NOW.toISOString(),
      stopReason: 'operator stop',
    });

    const result = evaluateAlphaStartIntent(serializeAlphaStartIntentV1(state), NOW);
    expect(result.status).toBe('STOPPED');
    expect(result.active).toBe(false);
    expect(result.executionAuthorized).toBe(false);
  });

  it('rejects an oversized STOP reason rather than silently truncating it', () => {
    expect(() => buildStoppedAlphaStartIntent('x'.repeat(161), NOW)).toThrow('STOP_REASON_TOO_LONG');
  });

  it('allows START policy gating only for an already-valid FIXED_BETA_400 context', () => {
    expect(evaluateAlphaStartPolicy(fixedBetaPolicyRaw())).toEqual({ ok: true });

    expect(evaluateAlphaStartPolicy(null)).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REQUIRED',
    });

    expect(evaluateAlphaStartPolicy(JSON.stringify({
      schemaVersion: 1,
      policyContext: 'STANDARD_ACTIVE',
      approvedBy: 'OPERATOR_AUTH_V1',
      approvedAt: '2026-09-19T23:59:00.000Z',
    }))).toEqual({
      ok: false,
      reason: 'FIXED_BETA_REQUIRED',
    });

    expect(evaluateAlphaStartPolicy('{bad-json')).toEqual({
      ok: false,
      reason: 'WORKER_POLICY_CONTEXT_INVALID',
    });
  });
});
