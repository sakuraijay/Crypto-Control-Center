import { describe, expect, it } from 'vitest';
import { isExecutorSafetySnapshot } from '@/hooks/useExecutorHealth';

describe('executor safety snapshot validation', () => {
  it('accepts the minimum authoritative PAPER status contract', () => {
    expect(isExecutorSafetySnapshot({
      ready: true,
      engineMode: 'PAPER',
      gmxConnected: true,
      rpcConfigured: true,
      networkChainId: 42161,
    })).toBe(true);
  });

  it('rejects malformed HTTP 200 bodies instead of retaining prior readiness', () => {
    expect(isExecutorSafetySnapshot(null)).toBe(false);
    expect(isExecutorSafetySnapshot({})).toBe(false);
    expect(isExecutorSafetySnapshot({
      ready: true,
      engineMode: 'PAPER',
      gmxConnected: true,
      rpcConfigured: true,
    })).toBe(false);
    expect(isExecutorSafetySnapshot({
      ready: 'true',
      engineMode: 'PAPER',
      gmxConnected: true,
      rpcConfigured: true,
      networkChainId: 42161,
    })).toBe(false);
  });
});