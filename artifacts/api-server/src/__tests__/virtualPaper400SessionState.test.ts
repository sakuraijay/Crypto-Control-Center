import { describe, expect, it } from 'vitest';
import {
  buildActiveVirtualPaper400SessionState,
  buildStoppedVirtualPaper400SessionState,
  evaluateVirtualPaper400SessionState,
  serializeVirtualPaper400SessionState,
} from '../workers/virtualPaper400SessionState';

const START = new Date('2026-09-20T03:00:00.000Z');
const STOP = new Date('2026-09-20T04:00:00.000Z');

describe('virtual PAPER 400 durable session state', () => {
  it('creates an explicit active virtual-only 400 session eligible only for PAPER routing', () => {
    const state = buildActiveVirtualPaper400SessionState('alpha-session', START);
    expect(state.status).toBe('ACTIVE');
    expect(state.session.initialEquityUsd).toBe(400);
    expect(state.session.realFundsUsed).toBe(false);
    expect(state.session.strategyTag).toBe('SERVER_WORKER_AI_VIRTUAL_400_V1:alpha-session');

    expect(evaluateVirtualPaper400SessionState(serializeVirtualPaper400SessionState(state))).toEqual({
      status: 'ACTIVE',
      active: true,
      paperRoutingEligible: true,
      reason: 'VIRTUAL_SESSION_ACTIVE',
      state,
    });
  });

  it('does not bootstrap missing or malformed durable state', () => {
    expect(evaluateVirtualPaper400SessionState(null)).toEqual({
      status: 'MISSING',
      active: false,
      paperRoutingEligible: false,
      reason: 'VIRTUAL_SESSION_MISSING',
    });
    expect(evaluateVirtualPaper400SessionState('{bad-json')).toEqual({
      status: 'INVALID',
      active: false,
      paperRoutingEligible: false,
      reason: 'VIRTUAL_SESSION_INVALID',
    });
  });

  it('fails closed if stored capital or namespace no longer matches virtual 400', () => {
    const state = buildActiveVirtualPaper400SessionState('scope-session', START);
    for (const session of [
      { ...state.session, initialEquityUsd: 1000 },
      { ...state.session, strategyTag: 'SERVER_WORKER_AI' },
    ]) {
      expect(evaluateVirtualPaper400SessionState(JSON.stringify({ ...state, session }))).toEqual({
        status: 'INVALID',
        active: false,
        paperRoutingEligible: false,
        reason: 'VIRTUAL_SESSION_INVALID',
      });
    }
  });

  it('preserves the exact session identity on STOP and remains ineligible after restart/readback', () => {
    const active = buildActiveVirtualPaper400SessionState('restart-session', START);
    const stopped = buildStoppedVirtualPaper400SessionState(active, 'operator stop', STOP);
    expect(stopped.session).toEqual(active.session);
    expect(stopped.updatedAt).toBe(STOP.toISOString());
    expect(stopped.stoppedAt).toBe(STOP.toISOString());

    expect(evaluateVirtualPaper400SessionState(serializeVirtualPaper400SessionState(stopped))).toEqual({
      status: 'STOPPED',
      active: false,
      paperRoutingEligible: false,
      reason: 'VIRTUAL_SESSION_STOPPED',
      state: stopped,
    });
  });

  it('rejects unknown fields instead of silently weakening the durable schema', () => {
    const active = buildActiveVirtualPaper400SessionState('strict-session', START);
    expect(evaluateVirtualPaper400SessionState(JSON.stringify({
      ...active,
      executionAuthorized: true,
    }))).toEqual({
      status: 'INVALID',
      active: false,
      paperRoutingEligible: false,
      reason: 'VIRTUAL_SESSION_INVALID',
    });
  });

  it('will not manufacture STOP from an already stopped state', () => {
    const active = buildActiveVirtualPaper400SessionState('stop-once', START);
    const stopped = buildStoppedVirtualPaper400SessionState(active, undefined, STOP);
    expect(() => buildStoppedVirtualPaper400SessionState(
      stopped,
      undefined,
      new Date('2026-09-20T05:00:00.000Z'),
    )).toThrow('ACTIVE_VIRTUAL_SESSION_REQUIRED');
  });
});
