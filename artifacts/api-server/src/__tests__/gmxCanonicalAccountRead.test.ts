import { describe, expect, it } from 'vitest';
import {
  classifyPositionCountConsistency,
  readWithTimeout,
  resolvePositionsAccount,
} from '../routes/gmx';

const CONFIGURED = `0x${'46'.repeat(20)}`;
const OTHER = `0x${'ab'.repeat(20)}`;

describe('GMX canonical read-only account resolution', () => {
  it('uses the configured owner account without requiring a browser wallet query', () => {
    expect(resolvePositionsAccount(undefined, CONFIGURED)).toEqual({
      ok: true,
      account: CONFIGURED,
      source: 'configured',
    });
  });

  it('accepts an explicit query only when it matches the configured owner', () => {
    expect(resolvePositionsAccount(CONFIGURED.toUpperCase(), CONFIGURED)).toEqual({
      ok: true,
      account: CONFIGURED,
      source: 'configured',
    });
    expect(resolvePositionsAccount(OTHER, CONFIGURED)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('allows a valid explicit query in development when no owner is configured', () => {
    expect(resolvePositionsAccount(OTHER, undefined)).toEqual({
      ok: true,
      account: OTHER,
      source: 'query',
    });
  });

  it('fails closed for invalid or absent account configuration', () => {
    expect(resolvePositionsAccount('not-an-address', undefined)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(resolvePositionsAccount(undefined, undefined)).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(resolvePositionsAccount(undefined, 'invalid-config')).toMatchObject({
      ok: false,
      status: 503,
    });
  });
});

describe('GMX RPC/API position-count cross-check', () => {
  it('distinguishes matched, mismatched, and unavailable reads', () => {
    expect(classifyPositionCountConsistency(0, 0)).toBe('matched');
    expect(classifyPositionCountConsistency(1, 2)).toBe('mismatch');
    expect(classifyPositionCountConsistency(1, null)).toBe('unavailable');
    expect(classifyPositionCountConsistency(null, 1)).toBe('rpc-unavailable');
    expect(classifyPositionCountConsistency(null, null)).toBe('unavailable');
  });

  it('bounds an unresponsive read without turning it into successful data', async () => {
    const never = new Promise<string>(() => {});
    await expect(readWithTimeout(never, 5)).resolves.toBeNull();
    await expect(readWithTimeout(Promise.resolve('ok'), 100)).resolves.toBe('ok');
  });
});
