import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  rows: new Map<string, string>(),
}));

vi.mock('@workspace/db', () => {
  function selectChain() {
    let key: string | null = null;
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = (condition: { value?: string }) => {
      key = condition?.value ?? null;
      return chain;
    };
    chain.limit = () => chain;
    (chain as { then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown> }).then =
      (resolve, reject) => Promise.resolve(
        key !== null && memory.rows.has(key)
          ? [{ key, value: memory.rows.get(key) }]
          : [],
      ).then(resolve, reject);
    return chain;
  }

  function insertChain() {
    let row: { key?: string; value?: string } | null = null;
    const chain: Record<string, unknown> = {};
    chain.values = (value: { key?: string; value?: string }) => {
      row = value;
      return chain;
    };
    chain.onConflictDoUpdate = () => chain;
    (chain as { then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown> }).then =
      (resolve, reject) => {
        if (row?.key && typeof row.value === 'string') memory.rows.set(row.key, row.value);
        return Promise.resolve([]).then(resolve, reject);
      };
    return chain;
  }

  return {
    db: {
      select: vi.fn(() => selectChain()),
      insert: vi.fn(() => insertChain()),
    },
    workerStateTable: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_field: unknown, value: string) => ({ value })),
}));

import express from 'express';
import request from 'supertest';
import { router } from '../routes/alphaStartIntent';
import { ALPHA_START_INTENT_KEY } from '../workers/alphaStartIntent';
import { WORKER_POLICY_CONTEXT_KEY } from '../workers/workerPolicyContext';

const app = express();
app.use(express.json());
app.use('/api', router);

function setFixedBetaPolicy(): void {
  memory.rows.set(WORKER_POLICY_CONTEXT_KEY, JSON.stringify({
    schemaVersion: 1,
    policyContext: 'FIXED_BETA_400',
    approvedBy: 'OPERATOR_AUTH_V1',
    approvedAt: new Date(Date.now() - 60_000).toISOString(),
  }));
}

beforeEach(() => {
  memory.rows.clear();
  process.env.OPERATOR_MASTER_PIN = '654321';
});

describe('alpha start intent HTTP boundary', () => {
  it('keeps GET observational and unauthenticated without bootstrapping missing state', async () => {
    delete process.env.OPERATOR_MASTER_PIN;

    const res = await request(app).get('/api/data/alpha-start-intent');

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('CONTROL_PLANE_INTENT_ONLY');
    expect(res.body.executionAuthorized).toBe(false);
    expect(res.body.intent.status).toBe('MISSING');
    expect(memory.rows.has(ALPHA_START_INTENT_KEY)).toBe(false);
  });

  it('fails closed when operator auth is not configured or the PIN is wrong', async () => {
    setFixedBetaPolicy();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

    delete process.env.OPERATOR_MASTER_PIN;
    const unconfigured = await request(app)
      .put('/api/data/alpha-start-intent')
      .set('x-operator-pin', '654321')
      .send({ action: 'START', expiresAt });
    expect(unconfigured.status).toBe(503);
    expect(memory.rows.has(ALPHA_START_INTENT_KEY)).toBe(false);

    process.env.OPERATOR_MASTER_PIN = '654321';
    const wrongPin = await request(app)
      .put('/api/data/alpha-start-intent')
      .set('x-operator-pin', '000000')
      .send({ action: 'START', expiresAt });
    expect(wrongPin.status).toBe(401);
    expect(memory.rows.has(ALPHA_START_INTENT_KEY)).toBe(false);
  });

  it('rejects non-JSON mutation requests before changing intent', async () => {
    setFixedBetaPolicy();

    const res = await request(app)
      .put('/api/data/alpha-start-intent')
      .set('x-operator-pin', '654321')
      .set('content-type', 'text/plain')
      .send('{"action":"STOP"}');

    expect(res.status).toBe(415);
    expect(memory.rows.has(ALPHA_START_INTENT_KEY)).toBe(false);
  });

  it('blocks START unless FIXED_BETA_400 is already selected', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const missing = await request(app)
      .put('/api/data/alpha-start-intent')
      .set('x-operator-pin', '654321')
      .send({ action: 'START', expiresAt });
    expect(missing.status).toBe(409);
    expect(missing.body.executionAuthorized).toBe(false);
    expect(memory.rows.has(ALPHA_START_INTENT_KEY)).toBe(false);

    memory.rows.set(WORKER_POLICY_CONTEXT_KEY, JSON.stringify({
      schemaVersion: 1,
      policyContext: 'STANDARD_ACTIVE',
      approvedBy: 'OPERATOR_AUTH_V1',
      approvedAt: new Date().toISOString(),
    }));
    const standard = await request(app)
      .put('/api/data/alpha-start-intent')
      .set('x-operator-pin', '654321')
      .send({ action: 'START', expiresAt });
    expect(standard.status).toBe(409);
    expect(standard.body.executionAuthorized).toBe(false);
    expect(memory.rows.has(ALPHA_START_INTENT_KEY)).toBe(false);
  });

  it('persists and verifies START intent under FIXED_BETA_400 without authorizing execution', async () => {
    setFixedBetaPolicy();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const res = await request(app)
      .put('/api/data/alpha-start-intent')
      .set('x-operator-pin', '654321')
      .send({ action: 'START', expiresAt });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.scope).toBe('CONTROL_PLANE_INTENT_ONLY');
    expect(res.body.executionAuthorized).toBe(false);
    expect(res.body.intent.status).toBe('ACTIVE');
    expect(res.body.intent.active).toBe(true);
    expect(memory.rows.has(ALPHA_START_INTENT_KEY)).toBe(true);
  });

  it('allows authenticated STOP even when worker policy context is missing', async () => {
    const res = await request(app)
      .put('/api/data/alpha-start-intent')
      .set('x-operator-pin', '654321')
      .send({ action: 'STOP', reason: 'operator stop' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.executionAuthorized).toBe(false);
    expect(res.body.intent.status).toBe('STOPPED');
    expect(res.body.intent.active).toBe(false);
    expect(memory.rows.has(ALPHA_START_INTENT_KEY)).toBe(true);
  });
});
