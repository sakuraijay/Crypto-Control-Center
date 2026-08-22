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

const dbWriteCalls = vi.hoisted(() => [] as string[]);

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
      insert: () => {
        dbWriteCalls.push('insert');
        return chain(() => []);
      },
      update: () => {
        dbWriteCalls.push('update');
        return chain(() => []);
      },
      delete: () => {
        dbWriteCalls.push('delete');
        return chain(() => []);
      },
    },
    tradesTable: {}, strategyConfigTable: {}, aiDecisionsTable: {},
    liveApprovalsTable: {}, workerStateTable: {}, relayTasksTable: {},
    subaccountApprovalSessionsTable: {}, executionIntentsTable: {},
    runMigrations: vi.fn(async () => {}),
  };
});

import app from '../app';
import { __setGmxApiRouteTransportForTests } from '../routes/gmxapi';
import { getExecutionEligibleCostEvidence } from '../lib/costSnapshot';
import type { GmxApiTransport } from '../lib/gmxApiTransport';
import {
  __getGmxApiReadinessCoordinatorStateForTests,
  __resetGmxApiReadinessCoordinatorForTests,
  __setGmxApiReadinessCoordinatorDepsForTests,
  runGmxApiReadinessRefresh,
  type CoordinatorDeps,
} from '../lib/gmxApiReadinessCoordinator';
import {
  __resetPaperRuntimeReadinessForTests,
  getPaperRuntimeReadinessSnapshot,
  startPaperRuntimeReadinessScheduler,
  stopPaperRuntimeReadinessScheduler,
} from '../lib/paperRuntimeReadiness';
import { getStopExecutionCapability } from '../workers/liveTestExecutor';
import type { ManualCanaryReadonlyEvidence } from '../lib/manualCanaryReadonlyEvidence';
import {
  __setManualCanaryReadonlyReadersForTests,
  refreshManualCanaryReadonlyEvidence,
} from '../lib/manualCanaryReadonlyEvidence';

const PIN = 'test-pin-123456';
const savedPin = process.env.OPERATOR_MASTER_PIN;
const savedSigner = process.env.DELEGATED_SIGNER_ENABLED;
const savedWorkerMode = process.env.WORKER_ENGINE_MODE;

const emptyCanaryEvidence = (): ManualCanaryReadonlyEvidence => ({
  decimals: {},
  costs: {},
});

let coordinatorEnv: NodeJS.ProcessEnv;
let coordinatorTransport: GmxApiTransport;
let refreshCanarySpy: ReturnType<typeof vi.fn<CoordinatorDeps['refreshCanary']>>;
let runPaperCycleSpy: ReturnType<typeof vi.fn<CoordinatorDeps['runPaperCycle']>>;
let refreshStopSpy: ReturnType<typeof vi.fn<CoordinatorDeps['refreshStopCapability']>>;

function installCoordinatorDeps(
  overrides: Partial<CoordinatorDeps> = {},
): void {
  __setGmxApiReadinessCoordinatorDepsForTests({
    env: coordinatorEnv,
    createTransport: () => coordinatorTransport,
    createPeerTransport: () => coordinatorTransport,
    refreshCanary: refreshCanarySpy,
    runPaperCycle: runPaperCycleSpy,
    getPaperSnapshot: (nowMs, env) =>
      getPaperRuntimeReadinessSnapshot(nowMs, env),
    refreshStopCapability: refreshStopSpy,
    getStopCapability: getStopExecutionCapability,
    ...overrides,
  });
}

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
  __resetPaperRuntimeReadinessForTests();
  __resetGmxApiReadinessCoordinatorForTests();
  dbWriteCalls.length = 0;
  process.env.OPERATOR_MASTER_PIN = PIN;
  process.env.WORKER_ENGINE_MODE = 'PAPER';
  delete process.env.DELEGATED_SIGNER_ENABLED;
  delete process.env.GMX_API_READONLY_ENABLED;
  delete process.env.GMX_API_ORDER_SUBMISSION_ENABLED;
  // 로컬 shared env(LIVE_TEST_EXECUTION_LOCKED=false 등)에 좌우되지 않도록 제거 — 미설정=잠금(fail-closed) 기본값을 검증
  delete process.env.LIVE_TEST_EXECUTION_LOCKED;
  coordinatorEnv = {
    ...process.env,
    WORKER_ENGINE_MODE: 'PAPER',
    GMX_API_READONLY_ENABLED: 'true',
  };
  coordinatorTransport = makeSpyTransport(true).t;
  refreshCanarySpy = vi.fn<CoordinatorDeps['refreshCanary']>(
    async () => emptyCanaryEvidence());
  runPaperCycleSpy = vi.fn<CoordinatorDeps['runPaperCycle']>(async () =>
    getPaperRuntimeReadinessSnapshot(Date.now(), coordinatorEnv));
  refreshStopSpy = vi.fn<CoordinatorDeps['refreshStopCapability']>(
    async () => getStopExecutionCapability());
  installCoordinatorDeps();
});
afterEach(() => {
  stopPaperRuntimeReadinessScheduler();
  __setGmxApiRouteTransportForTests(null);
  __resetGmxApiReadinessCoordinatorForTests();
  __resetPaperRuntimeReadinessForTests();
  __setManualCanaryReadonlyReadersForTests(null);
});
afterAll(() => {
  if (savedPin === undefined) delete process.env.OPERATOR_MASTER_PIN;
  else process.env.OPERATOR_MASTER_PIN = savedPin;
  if (savedSigner === undefined) delete process.env.DELEGATED_SIGNER_ENABLED;
  else process.env.DELEGATED_SIGNER_ENABLED = savedSigner;
  if (savedWorkerMode === undefined) delete process.env.WORKER_ENGINE_MODE;
  else process.env.WORKER_ENGINE_MODE = savedWorkerMode;
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
    expect(s).toHaveProperty('settlementReconcile');
    expect(s).toHaveProperty('legacyZeroFeeCount');
    expect(s).toHaveProperty('unsettledLiveTradeCount');
    expect(s.stopCapability).toMatchObject({
      scope: 'LIVE_STOP_EXECUTION',
      boundary: 'READ_ONLY_STATUS_NOT_EXECUTION_AUTHORIZATION',
    });
    expect(typeof s.stopCapability.paperMode).toBe('boolean');
    expect(Array.isArray(s.stopCapability.reasons)).toBe(true);
    expect(s.paperRuntimeReadiness).toMatchObject({
      boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    });
    expect(typeof s.paperRuntimeReadiness.paperMode).toBe('boolean');
    expect(s.paperRuntimeReadiness).toHaveProperty('decimals.BTC.state');
    expect(s.paperRuntimeReadiness).toHaveProperty('costs.BTC.capUsd', null);
    expect(s.paperRuntimeReadiness.costs.BTC).toMatchObject({
      effectiveRoundTripCostUsd: null,
      totalCostRatePct: null,
      capExcessUsd: null,
      requiredCostReductionUsd: null,
      requiredCostReductionPct: null,
      breakEvenGrossMoveUsd: null,
      breakEvenGrossMovePct: null,
      source: null,
    });
    expect(s.paperRuntimeReadiness.costs.BTC.blockReason).toContain('COST_BTC_NOT_EVALUATED');
    expect(s.paperRuntimeReadiness).toHaveProperty('blockerIds');
  });

  it('인증 GET은 외부 transport·DB write·execution-eligible evidence를 건드리지 않는다', async () => {
    const { t, calls } = makeSpyTransport(true);
    __setGmxApiRouteTransportForTests(t);
    const before = getExecutionEligibleCostEvidence(Date.now());

    const res = await request(app)
      .get('/api/executor/gmx-api/status')
      .set('x-operator-pin', PIN);

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect(dbWriteCalls).toEqual([]);
    expect(getExecutionEligibleCostEvidence(Date.now())).toEqual(before);
    expect(before).toEqual({ fresh: false, evidence: null });
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
    expect(refreshCanarySpy).not.toHaveBeenCalled();
    expect(runPaperCycleSpy).not.toHaveBeenCalled();
    expect(refreshStopSpy).not.toHaveBeenCalled();
    expect(dbWriteCalls).toEqual([]);
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
    expect(refreshCanarySpy).toHaveBeenCalledTimes(1);
    expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
    expect(refreshStopSpy).toHaveBeenCalledTimes(1);
    expect(dbWriteCalls).toEqual([]);
    // 응답에 최신 스냅샷 동봉
    expect(res.body.status.readyForControlledCanary).toBe(false);
  });

  it('동시 HTTP/HTTP refresh가 같은 generation을 공유하고 canary read를 한 번만 수행한다', async () => {
    const { t, calls } = makeSpyTransport(true);
    coordinatorTransport = t;
    __setGmxApiRouteTransportForTests(t);
    let releaseFirstRead: (() => void) | null = null;
    let activeReads = 0;
    let maxActiveReads = 0;
    const readerCalls: string[] = [];
    __setManualCanaryReadonlyReadersForTests({
      resolveDecimals: async (symbol) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        readerCalls.push(`decimals:${symbol}`);
        if (symbol === 'BTC') {
          await new Promise<void>((resolve) => { releaseFirstRead = resolve; });
        }
        activeReads -= 1;
        return { ok: true, detail: `${symbol} test decimals` };
      },
      fetchCost: async ({ symbol }) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        readerCalls.push(`cost:${symbol}`);
        await Promise.resolve();
        activeReads -= 1;
        return { ok: false, reason: `${symbol} test cost unavailable` };
      },
    });
    refreshCanarySpy.mockImplementation(refreshManualCanaryReadonlyEvidence);
    installCoordinatorDeps();

    const responsesPromise = Promise.all([
      request(app)
        .post('/api/executor/gmx-api/readiness/refresh')
        .set('x-operator-pin', PIN)
        .set('content-type', 'application/json').send({}),
      request(app)
        .post('/api/executor/gmx-api/readiness/refresh')
        .set('x-operator-pin', PIN)
        .set('content-type', 'application/json').send({}),
    ]);

    await vi.waitFor(() => {
      expect(refreshCanarySpy).toHaveBeenCalledTimes(1);
      expect(__getGmxApiReadinessCoordinatorStateForTests().joinCount).toBe(1);
    });
    releaseFirstRead!();
    const [first, second] = await responsesPromise;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.refresh.generation).toBe(second.body.refresh.generation);
    expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
    expect(refreshStopSpy).toHaveBeenCalledTimes(1);
    expect(maxActiveReads).toBe(1);
    expect(readerCalls).toEqual([
      'decimals:BTC',
      'cost:BTC',
      'decimals:ETH',
      'cost:ETH',
    ]);
    expect(calls).toEqual([{ method: 'GET', path: '/markets/tickers' }]);
    expect(dbWriteCalls).toEqual([]);
  });

  it('coordinator refresh 실패 뒤 shared in-flight를 해제하고 다음 refresh를 새 generation으로 재실행한다', async () => {
    const { t, calls } = makeSpyTransport(true);
    coordinatorTransport = t;
    refreshCanarySpy
      .mockRejectedValueOnce(new Error('injected readonly failure'))
      .mockResolvedValueOnce(emptyCanaryEvidence());
    installCoordinatorDeps();

    await expect(runGmxApiReadinessRefresh({
      singlePeerOnly: true,
    })).rejects.toThrow('injected readonly failure');

    expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
      active: false,
      joinCount: 0,
    });
    expect(getPaperRuntimeReadinessSnapshot(
      Date.now(),
      coordinatorEnv,
    ).scheduler.inFlight).toBe(false);

    const retried = await runGmxApiReadinessRefresh({
      singlePeerOnly: true,
    });

    expect(retried.generation).toBe(2);
    expect(refreshCanarySpy).toHaveBeenCalledTimes(2);
    expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
    expect(refreshStopSpy).toHaveBeenCalledTimes(1);
    expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
      active: false,
      joinCount: 0,
    });
    expect(calls).toEqual([
      { method: 'GET', path: '/markets/tickers' },
      { method: 'GET', path: '/markets/tickers' },
    ]);
    expect(calls.some((call) =>
      call.method === 'POST'
      || /rpc|prepare|sign|submit/i.test(call.path))).toBe(false);
    expect(dbWriteCalls).toEqual([]);
  });

  it('scheduler stop 뒤 예약된 stale timer가 PAPER cycle을 다시 시작하지 않는다', async () => {
    vi.useFakeTimers();
    try {
      const { t, calls } = makeSpyTransport(true);
      coordinatorTransport = t;
      let resolveFirstCycle: (() => void) | null = null;
      const firstCycle = new Promise<void>((resolve) => {
        resolveFirstCycle = resolve;
      });
      refreshStopSpy.mockImplementation(async () => {
        resolveFirstCycle!();
        return getStopExecutionCapability();
      });
      installCoordinatorDeps();

      startPaperRuntimeReadinessScheduler();
      await firstCycle;
      for (let i = 0; i < 10; i += 1) await Promise.resolve();

      const beforeStop = getPaperRuntimeReadinessSnapshot(
        Date.now(),
        coordinatorEnv,
      ).scheduler;
      expect(beforeStop.running).toBe(true);
      expect(beforeStop.inFlight).toBe(false);
      expect(beforeStop.nextRefreshAtMs).not.toBeNull();
      expect(refreshCanarySpy).toHaveBeenCalledTimes(1);
      expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
      expect(refreshStopSpy).toHaveBeenCalledTimes(1);

      stopPaperRuntimeReadinessScheduler();
      expect(getPaperRuntimeReadinessSnapshot(
        Date.now(),
        coordinatorEnv,
      ).scheduler).toMatchObject({
        running: false,
        inFlight: false,
        nextRefreshAtMs: null,
      });

      await vi.advanceTimersByTimeAsync(beforeStop.intervalMs * 3);

      expect(refreshCanarySpy).toHaveBeenCalledTimes(1);
      expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
      expect(refreshStopSpy).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([
        { method: 'GET', path: '/markets/tickers' },
        { method: 'GET', path: '/markets/tickers' },
      ]);
      expect(calls.some((call) =>
        call.method === 'POST'
        || /rpc|prepare|sign|submit/i.test(call.path))).toBe(false);
      expect(dbWriteCalls).toEqual([]);
    } finally {
      stopPaperRuntimeReadinessScheduler();
      vi.useRealTimers();
    }
  });

  it('scheduler refresh 중 HTTP refresh가 합류해 canary external read를 중복하지 않는다', async () => {
    const { t, calls } = makeSpyTransport(true);
    coordinatorTransport = t;
    __setGmxApiRouteTransportForTests(t);
    let releaseRead: (() => void) | null = null;
    let activeReads = 0;
    let maxActiveReads = 0;
    refreshCanarySpy.mockImplementation(async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise<void>((resolve) => { releaseRead = resolve; });
      activeReads -= 1;
      return emptyCanaryEvidence();
    });
    installCoordinatorDeps();

    startPaperRuntimeReadinessScheduler();
    await vi.waitFor(() => expect(refreshCanarySpy).toHaveBeenCalledTimes(1));
    expect(getPaperRuntimeReadinessSnapshot(
      Date.now(),
      coordinatorEnv,
    ).scheduler.inFlight).toBe(true);

    const httpPromise = request(app)
      .post('/api/executor/gmx-api/readiness/refresh')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json').send({})
      .then((response) => response);
    await vi.waitFor(() => {
      expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
        active: true,
        joinCount: 1,
      });
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) =>
      call.method === 'GET' && call.path === '/markets/tickers')).toBe(true);
    expect(refreshCanarySpy).toHaveBeenCalledTimes(1);

    releaseRead!();
    const response = await httpPromise;
    await vi.waitFor(() => expect(
      getPaperRuntimeReadinessSnapshot(
        Date.now(),
        coordinatorEnv,
      ).scheduler.inFlight,
    ).toBe(false));

    expect(response.status).toBe(200);
    expect(refreshCanarySpy).toHaveBeenCalledTimes(1);
    expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
    expect(refreshStopSpy).toHaveBeenCalledTimes(1);
    expect(maxActiveReads).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) =>
      call.method === 'GET' && call.path === '/markets/tickers')).toBe(true);
    expect(dbWriteCalls).toEqual([]);
  });

  it('peer health → canary → PAPER evidence → Stop capability 순서를 직렬화한다', async () => {
    const order: string[] = [];
    const { t } = makeSpyTransport(true);
    const orderedTransport = {
      ...t,
      async getJson(path: string) {
        order.push('peer');
        return { ok: true, data: {}, peerHost: 'peer-a' };
      },
    } as GmxApiTransport;
    coordinatorTransport = orderedTransport;
    __setGmxApiRouteTransportForTests(orderedTransport);
    installCoordinatorDeps({
      createTransport: () => orderedTransport,
      createPeerTransport: () => orderedTransport,
      refreshCanary: async () => {
        order.push('canary');
        return emptyCanaryEvidence();
      },
      runPaperCycle: async () => {
        order.push('paper');
        return getPaperRuntimeReadinessSnapshot(Date.now(), coordinatorEnv);
      },
      refreshStopCapability: async () => {
        order.push('stop');
        return getStopExecutionCapability();
      },
    });

    const res = await request(app)
      .post('/api/executor/gmx-api/readiness/refresh')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json').send({});

    expect(res.status).toBe(200);
    expect(order).toEqual(['peer', 'canary', 'paper', 'stop']);
    expect(dbWriteCalls).toEqual([]);
  });

  it('LIVE에서도 read-only 상태만 반환하고 submit/order capability를 얻지 않는다', async () => {
    process.env.WORKER_ENGINE_MODE = 'LIVE';
    coordinatorEnv = {
      ...coordinatorEnv,
      WORKER_ENGINE_MODE: 'LIVE',
    };
    const { t, calls } = makeSpyTransport(true);
    coordinatorTransport = t;
    __setGmxApiRouteTransportForTests(t);
    installCoordinatorDeps();
    const before = getExecutionEligibleCostEvidence(Date.now());

    const res = await request(app)
      .post('/api/executor/gmx-api/readiness/refresh')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json').send({});

    expect(res.status).toBe(200);
    expect(refreshCanarySpy).toHaveBeenCalledTimes(1);
    expect(runPaperCycleSpy).not.toHaveBeenCalled();
    expect(res.body.status.submissionEnabled).toBe(false);
    expect(res.body.status.signerEnabled).toBe(false);
    expect(res.body.status.readyForControlledCanary).toBe(false);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(dbWriteCalls).toEqual([]);
    expect(getExecutionEligibleCostEvidence(Date.now())).toEqual(before);
  });
});
