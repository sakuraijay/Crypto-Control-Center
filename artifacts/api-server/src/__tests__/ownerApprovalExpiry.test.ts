import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  purpose: string;
  status: string;
  expiresAt: string;
  deadline: string;
  invalidReason?: string | null;
};

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  failSelect: false,
  failUpdate: false,
  forceConflict: false,
  beforeUpdate: null as null | (() => void),
}));

vi.mock('@workspace/db', () => {
  const columns = new Proxy({}, {
    get: (_target, prop) => ({ column: String(prop) }),
  });
  const matches = (
    row: Row,
    condition: { op: string; column?: string; value?: unknown; conditions?: unknown[] },
  ): boolean => {
    if (condition.op === 'eq') {
      return row[condition.column as keyof Row] === condition.value;
    }
    if (condition.op === 'and') {
      return (condition.conditions ?? []).every((item) =>
        matches(row, item as Parameters<typeof matches>[1]),
      );
    }
    return false;
  };
  return {
    subaccountApprovalSessionsTable: columns,
    db: {
      select: vi.fn(() => ({
        from: () => ({
          where: async (
            condition: Parameters<typeof matches>[1],
          ) => {
            if (state.failSelect) throw new Error('select failed');
            return state.rows
              .filter((row) => matches(row, condition))
              .map(({ id, expiresAt, deadline }) => ({
                id,
                expiresAt,
                deadline,
              }));
          },
        }),
      })),
      update: vi.fn(() => ({
        set: (patch: Partial<Row>) => ({
          where: (condition: Parameters<typeof matches>[1]) => ({
            returning: async () => {
              if (state.failUpdate) throw new Error('update failed');
              if (state.forceConflict) return [];
              state.beforeUpdate?.();
              const matched = state.rows.filter((row) =>
                matches(row, condition),
              );
              for (const row of matched) Object.assign(row, patch);
              return matched.map((row) => ({ id: row.id }));
            },
          }),
        }),
      })),
    },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (
    column: { column: string },
    value: unknown,
  ) => ({ op: 'eq', column: column.column, value }),
  and: (...conditions: unknown[]) => ({
    op: 'and',
    conditions,
  }),
}));

vi.mock('../lib/ownerApprovalSession', () => ({
  SESSION_STATUS: {
    OWNER_SIGNATURE_READY: 'OWNER_SIGNATURE_READY',
    INVALIDATED: 'INVALIDATED',
    CONSUMED: 'CONSUMED',
  },
}));

import {
  EXPIRED_OWNER_SIGNATURE_REASON,
  invalidateExpiredOwnerSignatureReadySessions,
  isExpiredOrMalformedOwnerApprovalTimestamp,
} from '../lib/ownerApprovalExpiry';

const NOW = 2_000n;

function row(overrides: Partial<Row>): Row {
  return {
    id: 'session',
    purpose: 'APPROVAL',
    status: 'OWNER_SIGNATURE_READY',
    expiresAt: '3000',
    deadline: '2500',
    invalidReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.failSelect = false;
  state.failUpdate = false;
  state.forceConflict = false;
  state.beforeUpdate = null;
});

describe('invalidateExpiredOwnerSignatureReadySessions', () => {
  it('exposes the same strict timestamp guard for submit-time revalidation', () => {
    expect(isExpiredOrMalformedOwnerApprovalTimestamp('2000', NOW)).toBe(true);
    expect(isExpiredOrMalformedOwnerApprovalTimestamp('1999', NOW)).toBe(true);
    expect(isExpiredOrMalformedOwnerApprovalTimestamp('2001', NOW)).toBe(false);
    expect(isExpiredOrMalformedOwnerApprovalTimestamp('0x7d1', NOW)).toBe(true);
    expect(isExpiredOrMalformedOwnerApprovalTimestamp('+2001', NOW)).toBe(true);
    expect(isExpiredOrMalformedOwnerApprovalTimestamp(' 2001', NOW)).toBe(true);
    expect(isExpiredOrMalformedOwnerApprovalTimestamp('02001', NOW)).toBe(true);
    expect(
      isExpiredOrMalformedOwnerApprovalTimestamp((1n << 256n).toString(), NOW),
    ).toBe(true);
  });

  it('keeps submit selection fail-closed before signature decryption', () => {
    const source = readFileSync(
      new URL('../lib/gmxApiExecution.ts', import.meta.url),
      'utf8',
    );
    const selectorAt = source.indexOf(
      'export async function getReadyApprovalForSubmit',
    );
    const expiryAt = source.indexOf(
      'isExpiredOrMalformedOwnerApprovalTimestamp(row.expiresAt',
      selectorAt,
    );
    const deadlineAt = source.indexOf(
      'isExpiredOrMalformedOwnerApprovalTimestamp(row.deadline',
      selectorAt,
    );
    const decryptAt = source.indexOf(
      'decryptSensitiveHex(row.encryptedSignature)',
      selectorAt,
    );

    expect(selectorAt).toBeGreaterThan(-1);
    expect(expiryAt).toBeGreaterThan(selectorAt);
    expect(deadlineAt).toBeGreaterThan(expiryAt);
    expect(decryptAt).toBeGreaterThan(deadlineAt);
  });

  it('invalidates only expired or malformed APPROVAL READY sessions', async () => {
    state.rows = [
      row({ id: 'expired-expires', expiresAt: '2000' }),
      row({ id: 'expired-deadline', deadline: '1999' }),
      row({ id: 'malformed', expiresAt: 'not-a-uint' }),
      row({ id: 'hex', expiresAt: '0x7d0' }),
      row({ id: 'signed', expiresAt: '+2000' }),
      row({ id: 'whitespace', expiresAt: ' 2000' }),
      row({ id: 'leading-zero', expiresAt: '02000' }),
      row({ id: 'uint256-overflow', expiresAt: (1n << 256n).toString() }),
      row({ id: 'malformed-deadline', deadline: 'not-a-uint' }),
      row({ id: 'fresh' }),
      row({ id: 'prepared', status: 'PREPARED', expiresAt: '1000' }),
      row({ id: 'invalidated', status: 'INVALIDATED', expiresAt: '1000' }),
      row({ id: 'consumed', status: 'CONSUMED', expiresAt: '1000' }),
      row({ id: 'revoke', purpose: 'REVOKE', expiresAt: '1000' }),
    ];

    const result =
      await invalidateExpiredOwnerSignatureReadySessions(NOW);

    expect(result).toEqual({
      ok: true,
      scanned: 10,
      invalidated: 9,
      conflicts: 0,
    });
    for (const id of [
      'expired-expires',
      'expired-deadline',
      'malformed',
      'hex',
      'signed',
      'whitespace',
      'leading-zero',
      'uint256-overflow',
      'malformed-deadline',
    ]) {
      expect(state.rows.find((item) => item.id === id)).toMatchObject({
        status: 'INVALIDATED',
        invalidReason: EXPIRED_OWNER_SIGNATURE_REASON,
      });
    }
    expect(state.rows.find((item) => item.id === 'fresh')?.status)
      .toBe('OWNER_SIGNATURE_READY');
    expect(state.rows.find((item) => item.id === 'prepared')?.status)
      .toBe('PREPARED');
    expect(state.rows.find((item) => item.id === 'consumed')?.status)
      .toBe('CONSUMED');
    expect(state.rows.find((item) => item.id === 'revoke')?.status)
      .toBe('OWNER_SIGNATURE_READY');
  });

  it('uses a conditional status fence so a concurrent transition is not overwritten', async () => {
    state.rows = [row({ id: 'race', expiresAt: '1000' })];
    state.forceConflict = true;

    const result =
      await invalidateExpiredOwnerSignatureReadySessions(NOW);

    expect(result).toEqual({
      ok: false,
      scanned: 1,
      invalidated: 0,
      conflicts: 1,
    });
    expect(state.rows[0].status).toBe('OWNER_SIGNATURE_READY');
    expect(state.rows[0].invalidReason).toBeNull();
  });

  it('does not invalidate a session whose inspected expiry changes before the update', async () => {
    state.rows = [row({ id: 'race', expiresAt: '1000' })];
    state.beforeUpdate = () => {
      state.rows[0].expiresAt = '3000';
      state.beforeUpdate = null;
    };

    const result =
      await invalidateExpiredOwnerSignatureReadySessions(NOW);

    expect(result).toEqual({
      ok: false,
      scanned: 1,
      invalidated: 0,
      conflicts: 1,
    });
    expect(state.rows[0]).toMatchObject({
      status: 'OWNER_SIGNATURE_READY',
      expiresAt: '3000',
      invalidReason: null,
    });
  });

  it('is idempotent after a successful invalidation', async () => {
    state.rows = [row({ id: 'expired', expiresAt: '1000' })];

    expect(await invalidateExpiredOwnerSignatureReadySessions(NOW))
      .toMatchObject({ ok: true, invalidated: 1 });
    expect(await invalidateExpiredOwnerSignatureReadySessions(NOW))
      .toEqual({ ok: true, scanned: 0, invalidated: 0, conflicts: 0 });
  });

  it('fails closed when the candidate read fails', async () => {
    state.failSelect = true;

    expect(await invalidateExpiredOwnerSignatureReadySessions(NOW))
      .toEqual({ ok: false, scanned: 0, invalidated: 0, conflicts: 0 });
  });

  it('fails closed when a conditional transition write fails', async () => {
    state.rows = [row({ id: 'expired', expiresAt: '1000' })];
    state.failUpdate = true;

    expect(await invalidateExpiredOwnerSignatureReadySessions(NOW))
      .toEqual({ ok: false, scanned: 1, invalidated: 0, conflicts: 0 });
    expect(state.rows[0].status).toBe('OWNER_SIGNATURE_READY');
  });

  it('keeps persistent cleanup out of startup and status paths', () => {
    const source = readFileSync(
      new URL('../startup.ts', import.meta.url),
      'utf8',
    );
    const signerReadiness = readFileSync(
      new URL('../routes/signer-readiness.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain(
      'invalidateExpiredOwnerSignatureReadySessions',
    );
    expect(signerReadiness).not.toContain(
      'invalidateExpiredOwnerSignatureReadySessions',
    );
    expect(signerReadiness).toContain(
      'staleOwnerSignatureReadySessionCount',
    );
  });
});