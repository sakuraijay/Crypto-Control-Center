import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Stop execution capability state', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('starts unavailable and unevaluated (fail-closed)', async () => {
    const state = await import('../lib/stopExecutionCapabilityState');

    expect(state.getStopExecutionCapability()).toEqual({
      available: false,
      reasons: [
        'stop 실행 능력 미평가 — refreshStopExecutionCapability 필요 (fail-closed)',
      ],
      evaluatedAt: null,
      evidenceBinding: null,
    });
    expect(state.isStopExecutionAvailable()).toBe(false);
  });

  it('stores a timestamped derived snapshot and applies only the test availability override', async () => {
    const state = await import('../lib/stopExecutionCapabilityState');
    const evaluatedAt = '2026-09-01T00:00:00.000Z';

    state.setStopExecutionCapability({
      available: false,
      reasons: ['derived blocker'],
    }, evaluatedAt);

    expect(state.getStopExecutionCapability()).toEqual({
      available: false,
      reasons: ['derived blocker'],
      evaluatedAt,
      evidenceBinding: null,
    });
    state.__setStopExecutionAvailabilityForTests(true);
    expect(state.isStopExecutionAvailable()).toBe(true);
    expect(state.getStopExecutionCapability().available).toBe(false);
    state.__setStopExecutionAvailabilityForTests(null);
    expect(state.isStopExecutionAvailable()).toBe(false);
  });

  it.each([
    ['missing evaluation time', null, 1_777_000_000_000],
    ['malformed evaluation time', 'malformed', 1_777_000_000_000],
    ['future evaluation time', new Date(1_777_000_000_001).toISOString(), 1_777_000_000_000],
    ['expired evaluation time', new Date(1_776_999_969_999).toISOString(), 1_777_000_000_000],
    ['invalid local clock', new Date(1_776_999_999_000).toISOString(), Number.NaN],
  ])('rejects an available cached capability with %s', async (_case, evaluatedAt, nowMs) => {
    const state = await import('../lib/stopExecutionCapabilityState');
    state.setStopExecutionCapability({ available: true, reasons: [] }, evaluatedAt);

    expect(state.isStopExecutionAvailable(nowMs)).toBe(false);
  });

  it('accepts a freshly evaluated capability at the exact age boundary', async () => {
    const state = await import('../lib/stopExecutionCapabilityState');
    const nowMs = 1_777_000_000_000;
    state.setStopExecutionCapability({ available: true, reasons: [] },
      new Date(nowMs - state.STOP_EXECUTION_CAPABILITY_MAX_AGE_MS).toISOString());

    expect(state.isStopExecutionAvailable(nowMs)).toBe(true);
  });

  it('requires the current canonical/action-budget evidence to match the Stop evaluation', async () => {
    const state = await import('../lib/stopExecutionCapabilityState');
    const nowMs = 1_777_000_000_000;
    const binding = {
      canonicalAtMs: nowMs - 1_000,
      approvalNonce: '7',
      expiresAt: String(Math.floor(nowMs / 1000) + 3_600),
      remaining: '8',
      inFlightReservedActions: 0,
    };
    state.setStopExecutionCapability(
      { available: true, reasons: [] },
      new Date(nowMs - 1_000).toISOString(),
      binding,
    );

    expect(state.isStopExecutionAvailableForEvidence(binding, nowMs)).toBe(true);
    const exposed = state.getStopExecutionCapability();
    exposed.evidenceBinding!.remaining = '0';
    expect(state.isStopExecutionAvailableForEvidence(binding, nowMs)).toBe(true);
    expect(state.isStopExecutionAvailableForEvidence({
      ...binding,
      inFlightReservedActions: 1,
    }, nowMs)).toBe(false);
  });
});
