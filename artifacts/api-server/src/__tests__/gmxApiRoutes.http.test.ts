/**
 * 6G-2 §13/§14 — GMX API v2 운영자 상태 route 테스트.
 *
 * 검증:
 *  - GET /api/executor/gmx-api/status: PIN 인증 필수(401), 성공 시 서버 파생
 *    상태 항목 반환(legacyDisabled=true, submissionEnabled=false,
 *    readyForControlledCanary=false), Gelato 문구 0건, PIN/Secret 미노출
 *  - POST /api/executor/gmx-api/readiness/refresh: 조회만 — prepare/submit
 *    POST 0회, signer 접근 0회; readonly 꺼짐 = 외부 호출 0회
 *
 * 실제 외부 네트워크·DB 0회 (mock/주입 전용).
 */
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';

// DB 미접속 격리 mock — readiness.http.test.ts와 동일 패턴
vi.mock('@workspace/db', () => {
  function chain(getResult: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from','where','limit','offset','orderBy','set','values',
                     'onConflictDoNothing','onConflictDoUpdate','returning']) {
      c[m] = () => c;
    }
    (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
      (resolve) => Promise.resolve(getResult()).then(resolve);
    return c;
  }
  return {
    db: {
      select: () => chain(() => []),
      insert: () => chain(() => []),
      update: () => chain(() => []),
      delete: () => chain(() => []),
    },
    tradesTable: {}, strategyConfigTable: {}, aiDecisionsTable: {},
    liveApprovalsTable: {}, workerStateTable: {}, relayTasksTable: {},
    subaccountApprovalSessionsTable: {}, executionIntentsTable: {},
    runMigrations: vi.fn(async () => {}),
  };
});

import app from '../app';
import { __setGmxApiRouteTransportForTests } from '../routes/gmxapi';
import type { GmxApiTransport } from '../lib/gmxApiTransport';

const PIN = 'test-pin-123456';
const savedPin = process.env.OPERATOR_MASTER_PIN;
const savedSigner = process.env.DELEGATED_SIGNER_ENABLED;

function makeSpyTransport(readonlyEnabled: boolean) {
  const calls: Array<{ method: string; path: string }> = [];
  const t = {
    readonlyEnabled,
    submissionEnabled: false,
    peers: ['https://peer-a', 'https://peer-b'],
    async postJson(path: string) {
      calls.push({ method: 'POST', path });
      return { ok: true, data: { status: 'created' }, peerHost: 'peer-a' };
    },
    async getJson(path: string) {
      calls.push({ method: 'GET', path });
      return { ok: true, data: {}, peerHost: 'peer-a' };
    },
  } as unknown as GmxApiTransport;
  return { t, calls };
}

beforeEach(() => {
  process.env.OPERATOR_MASTER_PIN = PIN;
  delete process.env.DELEGATED_SIGNER_ENABLED;
  delete process.env.GMX_API_READONLY_ENABLED;
  delete process.env.GMX_API_ORDER_SUBMISSION_ENABLED;
  // 로컬 shared env(LIVE_TEST_EXECUTION_LOCKED=false 등)에 좌우되지 않도록 제거 — 미설정=잠금(fail-closed) 기본값을 검증
  delete process.env.LIVE_TEST_EXECUTION_LOCKED;
});
afterEach(() => {
  __setGmxApiRouteTransportForTests(null);
});
afterAll(() => {
  if (savedPin === undefined) delete process.env.OPERATOR_MASTER_PIN;
  else process.env.OPERATOR_MASTER_PIN = savedPin;
  if (savedSigner === undefined) delete process.env.DELEGATED_SIGNER_ENABLED;
  else process.env.DELEGATED_SIGNER_ENABLED = savedSigner;
});

describe('GET /api/executor/gmx-api/status', () => {
  it('PIN 없음 → 401 (운영자 인증 필수)', async () => {
    const res = await request(app).get('/api/executor/gmx-api/status');
    expect(res.status).toBe(401);
  });

  it('인증 성공 → 서버 파생 상태 반환 (fail-closed 기본값)', async () => {
    const res = await request(app)
      .get('/api/executor/gmx-api/status')
      .set('x-operator-pin', PIN);
    expect(res.status).toBe(200);
    const s = res.body.status;
    expect(s.transportGen).toBe('GMX_API_V2');
    expect(s.legacyDisabled).toBe(true);
    expect(s.readonlyEnabled).toBe(false);
    expect(s.submissionEnabled).toBe(false);
    expect(s.signerEnabled).toBe(false);
    expect(s.liveTestExecutionLocked).toBe(true);
    expect(s.readyForControlledCanary).toBe(false);
    expect(Array.isArray(s.peers)).toBe(true);
    expect(s.canonical).toHaveProperty('authorized');
    expect(s).toHaveProperty('blockingIntentCount');
    expect(s).toHaveProperty('approvalSessionReady');
    expect(s).toHaveProperty('manifestVersion');
  });

  it('Gelato Enterprise/Gas Tank/API key 문구 0건 + PIN/Secret 미노출', async () => {
    const res = await request(app)
      .get('/api/executor/gmx-api/status')
      .set('x-operator-pin', PIN);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/Gelato Enterprise|Gas Tank|GELATO_API_KEY/i);
    expect(body).not.toContain(PIN);
    expect(body).not.toMatch(/private[_ ]?key/i);
  });
});

describe('POST /api/executor/gmx-api/readiness/refresh', () => {
  it('route source에 durable task reconciliation 호출이 없다', () => {
    const source = readFileSync(new URL('../routes/gmxapi.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/reconcileGmxApiTasks|makeProductionDeps/);
  });

  it('PIN 없음 → 401; 잘못된 Content-Type → 415', async () => {
    const noPin = await request(app)
      .post('/api/executor/gmx-api/readiness/refresh')
      .set('content-type', 'application/json').send({});
    expect(noPin.status).toBe(401);
    const badCt = await request(app)
      .post('/api/executor/gmx-api/readiness/refresh')
      .set('x-operator-pin', PIN)
      .set('content-type', 'text/plain').send('x');
    expect(badCt.status).toBe(415);
  });

  it('readonly 꺼짐 → 외부 호출 0회 (fail-closed)', async () => {
    const { t, calls } = makeSpyTransport(false);
    __setGmxApiRouteTransportForTests(t);
    const res = await request(app)
      .post('/api/executor/gmx-api/readiness/refresh')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json').send({});
    expect(res.status).toBe(200);
    expect(res.body.refresh.readonlyEnabled).toBe(false);
    expect(res.body.refresh.peerHealth).toBeNull();
    expect(res.body.refresh.reconciliation).toMatchObject({ ran: false, readOnly: true });
    expect(calls.length).toBe(0);
  });

  it('readonly 켜짐 → 공개 GET/status 조회만 — prepare/submit POST 0회', async () => {
    const { t, calls } = makeSpyTransport(true);
    __setGmxApiRouteTransportForTests(t);
    const res = await request(app)
      .post('/api/executor/gmx-api/readiness/refresh')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // 허용된 호출: GET /markets/tickers 및 read-only evidence 조회만
    for (const c of calls) {
      expect(c.path).toBe('/markets/tickers');
    }
    expect(calls.some(c => c.path.includes('prepare') || c.path.includes('submit'))).toBe(false);
    // 응답에 최신 스냅샷 동봉
    expect(res.body.status.readyForControlledCanary).toBe(false);
  });
});
