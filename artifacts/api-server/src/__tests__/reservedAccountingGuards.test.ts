import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  trades: [] as Record<string, unknown>[],
  readFailed: false,
  writes: [] as { table: string; value: unknown }[],
}));

vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: unknown) => ({ column, value }),
  and: (...conditions: unknown[]) => ({ and: conditions }),
  or: (...conditions: unknown[]) => ({ or: conditions }),
  desc: (column: unknown) => column,
  inArray: () => ({}),
}));

vi.mock('@workspace/db', () => {
  const matches = (row: Record<string, unknown>, condition: any): boolean => {
    if (!condition) return true;
    if (condition.or) return condition.or.some((part: unknown) => matches(row, part));
    if (condition.and) return condition.and.every((part: unknown) => matches(row, part));
    return row[condition.column] === condition.value;
  };
  function chain(table?: { name: string }, write = false) {
    let predicate: unknown;
    const query: any = {
      from: (value: { name: string }) => { table = value; return query; },
      where: (value: unknown) => { predicate = value; return query; },
      limit: () => query, orderBy: () => query,
      values: (value: unknown) => { fixture.writes.push({ table: table!.name, value }); return query; },
      set: (value: unknown) => { fixture.writes.push({ table: table!.name, value }); return query; },
      onConflictDoNothing: () => query, onConflictDoUpdate: () => query,
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve().then(() => {
          if (!write && fixture.readFailed) throw new Error('named ledger read failed');
          return table?.name === 'trades' ? fixture.trades.filter(row => matches(row, predicate)) : [];
        }).then(resolve, reject),
    };
    return query;
  }
  return {
    db: {
      select: vi.fn(() => chain()),
      insert: vi.fn((table) => chain(table, true)),
      update: vi.fn((table) => chain(table, true)),
      delete: vi.fn(async () => undefined),
    },
    tradesTable: { name: 'trades', id: 'id', managedBy: 'managedBy', strategy: 'strategy' },
    workerStateTable: { name: 'workerState', key: 'key', value: 'value' },
    strategyConfigTable: { name: 'strategyConfig', id: 'id' },
  };
});

import router from '../routes/data';
import { db } from '@workspace/db';
import { FIXED_BETA_TRADE_STRATEGY } from '../workers/fixedBetaAccountingState';
import { containsReservedAccountingFields } from '../workers/workerPolicyContext';

// Execute actual Express route middleware in-process: no app/listener/network.
async function invoke(method: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const route = router.stack.find(layer => layer.route?.path === path
    && (layer.route as unknown as { methods: Record<string, boolean> }).methods[method])!.route!;
  const response = {
    statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  for (const layer of route.stack) {
    let nextCalled = false;
    await layer.handle({ body, method: method.toUpperCase(), headers: { 'content-type': 'application/json', ...headers } } as never, response as never, (() => { nextCalled = true; }) as never);
    if (response.body !== undefined || !nextCalled) break;
  }
  return response;
}

beforeEach(() => {
  fixture.trades = [];
  fixture.readFailed = false;
  fixture.writes = [];
  vi.clearAllMocks();
});

describe('legacy strategy compatibility and reserved accounting boundary', () => {
  it('excludes virtual trades from the legacy Standard read surface', async () => {
    fixture.trades = [{ id: 'standard', strategy: 'SERVER_WORKER_AI' },
      { id: 'virtual', strategy: 'SERVER_WORKER_AI_VIRTUAL_400_V1:session' }];
    const response = await invoke('get', '/data/trades');
    expect(response.body).toEqual([{ id: 'standard', strategy: 'SERVER_WORKER_AI' }]);
  });
  it.each(['/data/trades', '/data/trades/batch'])('rejects a forged virtual namespace via %s', async path => {
    const row = { id: 'forged', strategy: 'SERVER_WORKER_AI_VIRTUAL_400_V1:session' };
    const response = await invoke('post', path, path.endsWith('batch') ? [row] : row);
    expect(response.statusCode).toBe(403); expect(fixture.writes).toEqual([]);
  });
  it('preserves shipped header-less legacy autosave without interpreting capital/mode as policy', async () => {
    const body = { indicators: [{ id: 'ema', params: { fast: 9 } }], limits: { tradingCapital: 1000, liveTestMode: false } };
    expect(containsReservedAccountingFields(body)).toBe(false);
    const result = await invoke('put', '/data/strategy', body);
    expect(result.statusCode).toBe(200);
    expect(fixture.writes.find(write => write.table === 'strategyConfig')?.value).toMatchObject(body);
    expect(fixture.writes.some(write => (write.value as any)?.key === 'worker_policy_context_v1')).toBe(false);
  });

  it.each([
    { policyContext: 'FIXED_BETA_400' },
    { limits: { referenceCapitalUsd: 400 } },
    { limits: { nested: { betaExecutionAuthorized: true } } },
    { indicators: [{ params: { nested: [{ reference_context: 'anything' }] } }] },
    { indicators: [{ params: { 'beta-execution-authorized': false } }] },
    { arbitrary: { value: FIXED_BETA_TRADE_STRATEGY } },
    { arbitrary: [{ key: 'fixed_beta_accounting_state_v1' }] },
    { limits: { ledgerBinding: { sha256: 'fake' } } },
  ])('rejects reserved fields/identifiers recursively before any write: %j', async body => {
    const result = await invoke('put', '/data/strategy', body);
    expect(result.statusCode).toBe(403);
    expect(result.body.code).toBe('RESERVED_ACCOUNTING_SCOPE');
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('keeps the new selector authenticated', async () => {
    const result = await invoke('put', '/data/worker-policy-context', { policyContext: 'FIXED_BETA_400' });
    expect([401, 503]).toContain(result.statusCode);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it.each([null, 'CLIENT'])('refuses DELETE of a reserved alpha row with managedBy=%s', async managedBy => {
    fixture.trades = [{ id: 'reserved', strategy: FIXED_BETA_TRADE_STRATEGY, managedBy }];
    const result = await invoke('delete', '/data/trades');
    expect(result.statusCode).toBe(409);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('fails closed on a DELETE guard read error', async () => {
    fixture.readFailed = true;
    const result = await invoke('delete', '/data/trades');
    expect(result.statusCode).toBe(503);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('retains baseline deletion of nonreserved client rows', async () => {
    fixture.trades = [{ id: 'legacy', strategy: 'Manual', managedBy: 'CLIENT' }];
    const result = await invoke('delete', '/data/trades');
    expect(result.statusCode).toBe(200);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });
});

describe('selector middleware authentication behavior', () => {
  // Deliberately public test fixture, never a runtime/operator credential.
  const TEST_ONLY_PIN = 'fixture-only-pin-ccc';
  beforeEach(() => { vi.stubEnv('OPERATOR_MASTER_PIN', TEST_ONLY_PIN); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([undefined, 'wrong-fixture-pin'])('rejects missing/wrong PIN (%s) before selector writes', async pin => {
    const response = await invoke('put', '/data/worker-policy-context', { policyContext: 'FIXED_BETA_400' },
      pin === undefined ? {} : { 'x-operator-pin': pin });
    expect(response.statusCode).toBe(401);
    expect(db.insert).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  });

  it.each(['STANDARD_ACTIVE', 'FIXED_BETA_400'])('valid fixture PIN writes only the correct selector row for %s', async policyContext => {
    const response = await invoke('put', '/data/worker-policy-context', { policyContext },
      { 'x-operator-pin': TEST_ONLY_PIN });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, policyContext });
    expect(fixture.writes).toHaveLength(1);
    const write = fixture.writes[0];
    expect(write.table).toBe('workerState');
    expect(write.value).toMatchObject({ key: 'worker_policy_context_v1', updatedAt: expect.any(Date) });
    const envelope = JSON.parse((write.value as { value: string }).value);
    expect(envelope).toEqual({ schemaVersion: 1, policyContext, approvedBy: 'OPERATOR_AUTH_V1', approvedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(envelope.approvedAt))).toBe(true);
    expect(JSON.stringify(fixture.writes)).not.toContain(TEST_ONLY_PIN);
  });

  it('valid fixture PIN cannot write an invalid context', async () => {
    const response = await invoke('put', '/data/worker-policy-context', { policyContext: 'INVALID' },
      { 'x-operator-pin': TEST_ONLY_PIN });
    expect(response.statusCode).toBe(400);
    expect(fixture.writes).toEqual([]);
  });
});
