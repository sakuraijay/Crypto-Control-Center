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
      transaction: vi.fn(async callback => callback({
        select: () => selectChain(), insert: () => insertChain(), execute: async () => ({ rows: [] }),
      })),
      select: vi.fn(() => selectChain()),
      insert: vi.fn(() => insertChain()),
    },
    workerStateTable: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
    tradesTable: { strategy: 'strategy' },
  };
});

vi.mock('drizzle-orm', () => ({
  sql: vi.fn(() => ({})),
  eq: vi.fn((_field: unknown, value: string) => ({ value })),
}));

import express from 'express';
import request from 'supertest';
import { router } from '../routes/alphaStartIntent';
import { ALPHA_START_INTENT_KEY } from '../workers/alphaStartIntent';
import { WORKER_POLICY_CONTEXT_KEY } from '../workers/workerPolicyContext';
import { VIRTUAL_PAPER_400_SESSION_STATE_KEY, buildActiveVirtualPaper400SessionState } from '../workers/virtualPaper400SessionState';
import { virtualPaper400Activity } from '../workers/virtualPaper400Activity';
import { initialVirtualPaper400RiskState, virtualPaper400RiskKey } from '../workers/virtualPaper400Accounting';

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

describe('virtual trading mode HTTP boundary', () => {
  it('requires auth and a valid mode, and does not START or reset when saving and reading back a selection', async () => {
    const state = buildActiveVirtualPaper400SessionState('mode-http');
    const raw=JSON.stringify(state); memory.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY,raw);
    const url='/api/data/virtual-paper-400-trading-mode';
    expect((await request(app).put(url).send({mode:'SWING',expectedUpdatedAt:null})).status).toBe(401);
    expect((await request(app).put(url).set('x-operator-pin','654321').send({mode:'SWING',expectedUpdatedAt:null,stopRoePct:20})).status).toBe(400);
    const saved=await request(app).put(url).set('x-operator-pin','654321').send({mode:'SWING',expectedUpdatedAt:null});
    expect(saved.status).toBe(200); expect(saved.body.appliesTo).toBe('NEXT_ENTRY');
    const got=await request(app).get('/api/data/virtual-paper-400-session');
    expect(got.body.tradingModeSelection.mode).toBe('SWING');
    expect(got.body.tradingModeOptions.SWING.maxHoldHours).toBe(72);
    expect(memory.rows.get(VIRTUAL_PAPER_400_SESSION_STATE_KEY)).toBe(raw);
    expect(memory.rows.size).toBe(2);
    const stale=await request(app).put(url).set('x-operator-pin','654321').send({mode:'INTRADAY',expectedUpdatedAt:null});
    expect(stale.status).toBe(409);
    const changed=await request(app).put(url).set('x-operator-pin','654321').send({mode:'INTRADAY',expectedUpdatedAt:saved.body.selection.updatedAt});
    expect(changed.status).toBe(200); expect(changed.body.selection.mode).toBe('INTRADAY');
    expect(Date.parse(changed.body.selection.updatedAt)).toBeGreaterThan(Date.parse(saved.body.selection.updatedAt));
  });
  it('does not mint a virtual session or repair corrupt settings through the preference endpoint', async () => {
    const url='/api/data/virtual-paper-400-trading-mode';
    expect((await request(app).put(url).set('x-operator-pin','654321').send({mode:'SWING',expectedUpdatedAt:null})).status).toBe(409);
    expect(memory.rows.size).toBe(0);
    const state=buildActiveVirtualPaper400SessionState('corrupt-mode');
    memory.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY,JSON.stringify(state));
    memory.rows.set('virtual_trading_mode_v1:corrupt-mode','{"mode":"UNKNOWN"}');
    expect((await request(app).get('/api/data/virtual-paper-400-session')).status).toBe(503);
    expect((await request(app).put(url).set('x-operator-pin','654321').send({mode:'SWING',expectedUpdatedAt:null})).status).toBe(503);
    expect(memory.rows.get('virtual_trading_mode_v1:corrupt-mode')).toBe('{"mode":"UNKNOWN"}');
  });
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

describe('virtual PAPER 400 session HTTP boundary', () => {
  it('requires authenticated explicit chronological boundaries for the read-only learning validation', async () => {
    const url='/api/data/virtual-paper-learning-validation';
    expect((await request(app).get(url)).status).toBe(401);
    const missing=await request(app).get(url).set('x-operator-pin','654321');
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('PAPER_LEARNING_BOUNDARIES_REQUIRED');

    const state=buildActiveVirtualPaper400SessionState('validation-http',new Date('2026-09-20T00:00:00Z'));
    memory.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY,JSON.stringify(state));
    memory.rows.set(virtualPaper400RiskKey(state.session),JSON.stringify(initialVirtualPaper400RiskState(state.session)));
    const explicit=await request(app).get(url)
      .query({validationStartAt:'2026-09-20T01:00:00.000Z',testStartAt:'2026-09-20T02:00:00.000Z'})
      .set('x-operator-pin','654321');
    expect(explicit.status).toBe(200);
    expect(explicit.body).toMatchObject({
      ok:true,status:'UNAVAILABLE',ready:false,
      unavailableReasons:['TEST_SEGMENT_EMPTY','TRAIN_SEGMENT_EMPTY','VALIDATION_SEGMENT_EMPTY'],
      partitions:{train:{labels:{grossPnlUsd:null,netPnlUsd:null,estimatedCostsUsd:null}}},
      costEvidence:{storedLabels:{status:'UNAVAILABLE',reason:'NO_RETAINED_SAMPLES_OR_INVALID_LABELS'}},
      trainingPerformed:false,tuningPerformed:false,automaticPromotionAllowed:false,
    });
    const malformed=await request(app).get(url)
      .query({validationStartAt:'not-a-date',testStartAt:'2026-09-20T02:00:00.000Z'})
      .set('x-operator-pin','654321');
    expect(malformed.status).toBe(200);
    expect(malformed.body).toMatchObject({
      status:'UNAVAILABLE',ready:false,unavailableReasons:['VALIDATION_START_INVALID'],
    });
  });

  it('exports learning provenance only after repeatable-read ledger validation and fails closed otherwise', async () => {
    const state = buildActiveVirtualPaper400SessionState('learning-http', new Date('2026-09-22T08:00:00Z'));
    memory.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, JSON.stringify(state));
    const riskKey = virtualPaper400RiskKey(state.session);
    memory.rows.set(riskKey, JSON.stringify(initialVirtualPaper400RiskState(state.session)));

    const ok = await request(app).get('/api/data/virtual-paper-learning-dataset')
      .set('x-operator-pin', '654321');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      reviewedOpenCandidateCount: 0,
      settlementRowCount: 0,
      sampleExcludedTotal: 0,
      exclusionRate: 0,
      eligiblePeriods: {
        featureAt: { first: null, last: null },
        openedAt: { first: null, last: null },
        labelAvailableAt: { first: null, last: null },
      },
      ledgerReconciliation: {
        status: 'PASS',
        validator: 'evaluateVirtualPaper400Account',
        scope: {
          sessionId: state.session.sessionId,
          strategyTag: state.session.strategyTag,
          tradeRowCount: 0,
          reviewedOpenCandidateCount: 0,
          settlementRowCount: 0,
        },
      },
    });

    memory.rows.set(riskKey, '{"invalid":true}');
    const failed = await request(app).get('/api/data/virtual-paper-learning-dataset')
      .set('x-operator-pin', '654321');
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ok:false,code:'PAPER_LEARNING_EVIDENCE_UNAVAILABLE'});
  });

  it('exposes only the matching session activity through observational GET without financial writes', async () => {
    const session = buildActiveVirtualPaper400SessionState('activity-http', new Date());
    memory.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, JSON.stringify(session));
    const run = virtualPaper400Activity.begin(session.session.sessionId, 12);
    virtualPaper400Activity.stage(run, 'ANALYZING_MARKETS', ['BTC','ETH','SOL']);
    const before = [...memory.rows];
    const res = await request(app).get('/api/data/virtual-paper-400-session');
    expect(res.status).toBe(200); expect(res.body.executionAuthorized).toBe(false);
    expect(res.body.activityFresh).toBe(true);
    expect(res.body.activity.phase).toBe('ANALYZING_MARKETS');
    expect(res.body.activity.symbols).toEqual(['BTC','ETH','SOL']);
    expect([...memory.rows]).toEqual(before);
    memory.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY,
      JSON.stringify(buildActiveVirtualPaper400SessionState('another-session', new Date())));
    const other = await request(app).get('/api/data/virtual-paper-400-session');
    expect(other.body.activity).toBeNull(); expect(other.body.activityFresh).toBe(false);
  });
  it('keeps GET observational and does not bootstrap a missing virtual session', async () => {
    const res = await request(app).get('/api/data/virtual-paper-400-session');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe('VIRTUAL_PAPER_400');
    expect(res.body.realFundsUsed).toBe(false);
    expect(res.body.executionAuthorized).toBe(false);
    expect(res.body.session.status).toBe('MISSING');
    expect(memory.rows.has(VIRTUAL_PAPER_400_SESSION_STATE_KEY)).toBe(false);
  });

  it('requires operator auth for START and leaves state untouched on failure', async () => {
    const res = await request(app)
      .put('/api/data/virtual-paper-400-session')
      .set('x-operator-pin', '000000')
      .send({ action: 'START' });

    expect(res.status).toBe(401);
    expect(memory.rows.has(VIRTUAL_PAPER_400_SESSION_STATE_KEY)).toBe(false);
  });

  it('starts a separate 400-USDC virtual session without FIXED_BETA policy and keeps START idempotent', async () => {
    const first = await request(app)
      .put('/api/data/virtual-paper-400-session')
      .set('x-operator-pin', '654321')
      .send({ action: 'START' });

    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.realFundsUsed).toBe(false);
    expect(first.body.executionAuthorized).toBe(false);
    expect(first.body.idempotent).toBe(false);
    expect(first.body.session.status).toBe('ACTIVE');
    expect(first.body.session.paperRoutingEligible).toBe(true);
    expect(first.body.session.state.session.initialEquityUsd).toBe(400);
    expect(first.body.session.state.session.mode).toBe('VIRTUAL_PAPER_400');
    expect(first.body.session.state.session.strategyTag).toContain('SERVER_WORKER_AI_VIRTUAL_400_V1:vp400-');
    const firstSessionId = first.body.session.state.session.sessionId;

    const second = await request(app)
      .put('/api/data/virtual-paper-400-session')
      .set('x-operator-pin', '654321')
      .send({ action: 'START' });

    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.session.state.session.sessionId).toBe(firstSessionId);
  });

  it('STOP preserves exact session identity and a later START resumes the same ledger', async () => {
    const started = await request(app)
      .put('/api/data/virtual-paper-400-session')
      .set('x-operator-pin', '654321')
      .send({ action: 'START' });
    const sessionId = started.body.session.state.session.sessionId;
    const strategyTag = started.body.session.state.session.strategyTag;

    const stopped = await request(app)
      .put('/api/data/virtual-paper-400-session')
      .set('x-operator-pin', '654321')
      .send({ action: 'STOP', reason: 'operator stop' });

    expect(stopped.status).toBe(200);
    expect(stopped.body.idempotent).toBe(false);
    expect(stopped.body.session.status).toBe('STOPPED');
    expect(stopped.body.session.active).toBe(false);
    expect(stopped.body.session.paperRoutingEligible).toBe(false);
    expect(stopped.body.session.state.session.sessionId).toBe(sessionId);
    expect(stopped.body.session.state.session.strategyTag).toBe(strategyTag);
    expect(stopped.body.session.state.stopReason).toBe('operator stop');

    const stoppedAgain = await request(app)
      .put('/api/data/virtual-paper-400-session')
      .set('x-operator-pin', '654321')
      .send({ action: 'STOP', reason: 'ignored retry' });
    expect(stoppedAgain.status).toBe(200);
    expect(stoppedAgain.body.idempotent).toBe(true);
    expect(stoppedAgain.body.session.state.session.sessionId).toBe(sessionId);

    const resumed = await request(app)
      .put('/api/data/virtual-paper-400-session')
      .set('x-operator-pin', '654321')
      .send({ action: 'START' });
    expect(resumed.status).toBe(200);
    expect(resumed.body.idempotent).toBe(false);
    expect(resumed.body.session.status).toBe('ACTIVE');
    expect(resumed.body.session.state.session.sessionId).toBe(sessionId);
    expect(resumed.body.session.state.session.strategyTag).toBe(strategyTag);
    expect(resumed.body.session.state.session.initialEquityUsd).toBe(400);
  });

  it('does not invent a session for STOP when state is missing', async () => {
    const res = await request(app)
      .put('/api/data/virtual-paper-400-session')
      .set('x-operator-pin', '654321')
      .send({ action: 'STOP' });

    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.session.status).toBe('MISSING');
    expect(memory.rows.has(VIRTUAL_PAPER_400_SESSION_STATE_KEY)).toBe(false);
  });

  it('fails closed and preserves malformed persisted state instead of resetting to 400', async () => {
    const malformed = '{"schemaVersion":1,"status":"ACTIVE"}';
    memory.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, malformed);

    const res = await request(app)
      .put('/api/data/virtual-paper-400-session')
      .set('x-operator-pin', '654321')
      .send({ action: 'START' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VIRTUAL_PAPER_400_SESSION_INVALID');
    expect(res.body.executionAuthorized).toBe(false);
    expect(memory.rows.get(VIRTUAL_PAPER_400_SESSION_STATE_KEY)).toBe(malformed);
  });
});
