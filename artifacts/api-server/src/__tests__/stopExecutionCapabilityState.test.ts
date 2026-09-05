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
    });
    state.__setStopExecutionAvailabilityForTests(true);
    expect(state.isStopExecutionAvailable()).toBe(true);
    expect(state.getStopExecutionCapability().available).toBe(false);
    state.__setStopExecutionAvailabilityForTests(null);
    expect(state.isStopExecutionAvailable()).toBe(false);
  });
});