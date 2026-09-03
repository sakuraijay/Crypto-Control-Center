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
  __getGmxApiReadinessCoordinatorGenerationForTests,
  __getGmxApiReadinessCoordinatorStateForTests,
  __resetGmxApiReadinessCoordinatorForTests,
  __setGmxApiReadinessCoordinatorDepsForTests,
  runGmxApiReadinessRefresh,
  type CoordinatorDeps,
} from '../lib/gmxApiReadinessCoordinator';
import {
  __resetPaperRuntimeReadinessForTests,
  getPaperRuntimeReadinessSnapshot,
  runPaperRuntimeReadinessCycle,
  startPaperRuntimeReadinessScheduler,
  stopPaperRuntimeReadinessScheduler,
} from '../lib/paperRuntimeReadiness';
import { getStopExecutionCapability } from '../lib/stopExecutionCapabilityState';
import {
  __resetPaperStopReadinessEvidenceForTests,
  getPaperStopReadinessEvidence,
} from '../lib/paperStopReadinessEvidence';
import type { ManualCanaryReadonlyEvidence } from '../lib/manualCanaryReadonlyEvidence';
import { buildPaperRelayEvidence } from '../lib/paperRelayEvidence';
import {
  __setManualCanaryReadonlyReadersForTests,
  refreshManualCanaryReadonlyEvidence,
} from '../lib/manualCanaryReadonlyEvidence';

const PIN = 'test-pin-123456';
const MUTATED_ENV_KEYS = [
  'OPERATOR_MASTER_PIN',
  'DELEGATED_SIGNER_ENABLED',
  'WORKER_ENGINE_MODE',
  'GMX_API_READONLY_ENABLED',
  'GMX_API_ORDER_SUBMISSION_ENABLED',
  'GMX_RELAY_READONLY_NETWORK_ENABLED',
  'LIVE_TEST_EXECUTION_LOCKED',
] as const;
const savedEnv = new Map(
  MUTATED_ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

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
  __resetPaperStopReadinessEvidenceForTests();
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
  __resetPaperStopReadinessEvidenceForTests();
  __setManualCanaryReadonlyReadersForTests(null);
});
afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
      readinessEvidence: {
        scope: 'PAPER_READ_ONLY_STOP_READINESS',
        boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
        readinessComplete: false,
        executionAuthorized: false,
        generation: null,
        evaluatedAtMs: null,
        expiresAtMs: null,
        fresh: false,
      },
    });
    expect(Array.isArray(s.stopCapability.readinessEvidence.conditions)).toBe(true);
    expect(Array.isArray(s.stopCapability.readinessEvidence.missingConditionIds)).toBe(true);
    expect(typeof s.stopCapability.paperMode).toBe('boolean');
    expect(Array.isArray(s.stopCapability.reasons)).toBe(true);
    expect(s.paperRuntimeReadiness).toMatchObject({
      boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    });
    expect(typeof s.paperRuntimeReadiness.paperMode).toBe('boolean');
    expect(s.paperRuntimeReadiness).toHaveProperty('decimals.BTC.state');
    expect(s.paperRuntimeReadiness).toHaveProperty('costs.BTC.capUsd', null);
    expect(s.paperRuntimeReadiness.costs.BTC).toMatchObject({
      evidenceRole: 'OBSERVATIONAL_READ_ONLY',
      observationalFresh: false,
      effectiveRoundTripCostUsd: null,
      totalCostRatePct: null,
      capExcessUsd: null,
      capExcessRatePct: null,
      requiredCostReductionUsd: null,
      requiredCostReductionPct: null,
      breakEvenGrossMoveUsd: null,
      breakEvenGrossMovePct: null,
      source: null,
      executionSnapshot: {
        fresh: false,
        eligible: false,
        authorized: false,
        maxAgeMs: 30_000,
        failureId: 'COST_BTC_EXECUTION_SNAPSHOT_INELIGIBLE',
      },
    });
    expect(s.paperRuntimeReadiness.costs.BTC.blockReason).toContain('COST_BTC_NOT_EVALUATED');
    expect(s.paperRuntimeReadiness.boundedCanaryEconomics).toEqual({
      BTC: expect.objectContaining({
        status: 'UNAVAILABLE',
        boundary: 'READ_ONLY_OBSERVED_GRID_NOT_EXECUTION_AUTHORIZATION',
        failureId: 'BOUNDED_CANARY_BTC_NOT_EVALUATED',
        observedAffordableRanges: [],
      }),
      ETH: expect.objectContaining({
        status: 'UNAVAILABLE',
        boundary: 'READ_ONLY_OBSERVED_GRID_NOT_EXECUTION_AUTHORIZATION',
        failureId: 'BOUNDED_CANARY_ETH_NOT_EVALUATED',
        observedAffordableRanges: [],
      }),
    });
    expect(s.paperRuntimeReadiness).toHaveProperty('blockerIds');
    expect(s.paperRelayEvidence).toMatchObject({
      scope: 'PAPER_READ_ONLY_RELAY_EVIDENCE',
      boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
      executionAuthorized: false,
      fresh: true,
    });
    expect(s.paperEpochPreflight).toMatchObject({
      scope: 'PAPER_EPOCH_READINESS_PREFLIGHT',
      boundary: 'READ_ONLY_CALCULATION_NOT_STATE_CHANGE',
      executionAuthorized: false,
      stateChangePerformed: false,
      planned: {
        seedCapitalUsd: 10_000,
        activeCapitalStagesUsd: [1_000, 2_500, 5_000, 10_000],
        separation: 'PLANNED_SEED_IS_NOT_ACTIVE_OR_RESERVE_CAPITAL',
      },
      proposedNewEpoch: {
        activeTradingCapitalUsd: 1_000,
        equityHwmUsd: 1_000,
        dailyRiskBaselineUsd: 1_000,
        weeklyRiskBaselineUsd: 1_000,
        applied: false,
        persistenceId: null,
      },
      preservedExecutionGates: {
        readyForControlledCanary: false,
        unchanged: true,
      },
    });
    expect(s.paperRelayEvidence.executionOnly).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'canonicalAuthorization',
        status: 'not_evaluated',
        failureId: 'CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER',
      }),
      expect.objectContaining({
        id: 'actionBudget',
        status: 'not_evaluated',
        failureId: 'ACTION_BUDGET_NOT_EVALUATED_IN_PAPER',
      }),
      expect.objectContaining({
        id: 'prepareReconciliation',
        status: 'not_evaluated',
      }),
      expect.objectContaining({
        id: 'protectionReconciliation',
        status: 'not_evaluated',
      }),
      expect.objectContaining({
        id: 'settlementReconciliation',
        status: 'not_evaluated',
      }),
    ]));
    expect(s.canonical).toEqual({
      authorized: false,
      approvalRemainingOk: false,
      reason: 'CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER',
      expiresAt: null,
      remaining: null,
    });
    expect(s.approvalSessionReady).toBeNull();
    expect(s.actionBudget).toMatchObject({
      sufficient: false,
      remainingActions: null,
      inFlightReservedActions: null,
      budgetShortfall: null,
      reasons: ['ACTION_BUDGET_NOT_EVALUATED_IN_PAPER'],
    });
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
    expect(res.body.status.paperEpochPreflight.stateChangePerformed).toBe(false);
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
    const paperRelayView = JSON.stringify({
      canonical: res.body.status.canonical,
      actionBudget: res.body.status.actionBudget,
      paperRelayEvidence: res.body.status.paperRelayEvidence,
    });
    expect(paperRelayView).not.toMatch(/signedPayload|rpcUrl|payload|0x[a-f0-9]{40,}/i);
  });
});

describe('PAPER Relay evidence safety contract', () => {
  it('execution-only 요구는 NOT EVALUATED, 실제 저장 결함만 fail-closed failure ID로 분리한다', () => {
    const evidence = buildPaperRelayEvidence({
      nowMs: 1_777_000_000_000,
      dbOk: false,
      blockingIntentCount: null,
      openRelayTaskCount: 1,
      unresolvedTaskCount: 2,
      activeRevokeInProgress: null,
      prepareStageCounts: { API_PREPARED: 1 },
      blockingProtectionCount: null,
      uncoveredStopCount: null,
      legacyZeroFeeCount: null,
      unsettledLiveTradeCount: null,
      protectionReconciliation: {
        lastRunAtMs: 1_776_999_995_000,
        complete: false,
        blockNewOpens: true,
        ambiguousCount: 1,
      },
    });

    expect(evidence.executionAuthorized).toBe(false);
    expect(evidence.executionOnly.every((entry) =>
      entry.status === 'not_evaluated' && entry.fresh === false)).toBe(true);
    expect(evidence.failureIds).toEqual(expect.arrayContaining([
      'PAPER_RELAY_STATUS_DB_READ_FAILED',
      'BLOCKING_INTENT_READ_FAILED',
      'OPEN_RELAY_TASK_PRESENT',
      'UNRESOLVED_RELAY_TASK_PRESENT',
      'ACTIVE_REVOKE_READ_FAILED',
      'NON_TERMINAL_PREPARE_TASK_PRESENT',
      'PROTECTION_ORDER_READ_FAILED',
      'STOP_COVERAGE_READ_FAILED',
      'SETTLEMENT_STATUS_READ_FAILED',
      'STORED_PROTECTION_EVIDENCE_AMBIGUOUS',
    ]));
    expect(evidence.safe).toBe(false);
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
    expect(res.body.refresh.paperStopReadinessEvidence).toMatchObject({
      generation: 1,
      readinessComplete: false,
      fresh: true,
      executionAuthorized: false,
    });
    expect(res.body.refresh.paperStopReadinessEvidence.reasons).toEqual([
      'GMX API read-only mode is disabled for the current PAPER generation.',
    ]);
    expect(res.body.refresh.paperStopReadinessEvidence.conditions
      .find((condition: { id: string }) => condition.id === 'paperMode'))
      .toMatchObject({ status: 'verified', fresh: true });
    expect(res.body.refresh.paperStopReadinessEvidence.conditions
      .find((condition: { id: string }) => condition.id === 'readonlyEnabled'))
      .toMatchObject({
        status: 'failed',
        failureId: 'GMX_API_READONLY_REQUIRED',
      });
  });

  it.each(['canary', 'paper'] as const)(
    'publishes a sanitized current-generation snapshot when the %s stage throws',
    async (stage) => {
      if (stage === 'canary') {
        refreshCanarySpy.mockRejectedValueOnce(new Error('secret upstream detail'));
      } else {
        runPaperCycleSpy.mockRejectedValueOnce(new Error('secret paper detail'));
      }
      installCoordinatorDeps();

      await expect(runGmxApiReadinessRefresh({ singlePeerOnly: true }))
        .rejects.toThrow(`secret ${stage === 'canary' ? 'upstream' : 'paper'} detail`);

      const result = getPaperStopReadinessEvidence(Date.now(), coordinatorEnv);
      expect(result).toMatchObject({
        generation: 1,
        readinessComplete: false,
        fresh: true,
        executionAuthorized: false,
      });
      expect(result.reasons).toEqual([
        `Current PAPER readiness ${stage} stage failed (fail-closed).`,
      ]);
      expect(JSON.stringify(result)).not.toContain('secret');
      const failedIds = stage === 'canary'
        ? ['btcDecimals8', 'ethDecimals18', 'btcCostEvidence', 'ethCostEvidence']
        : ['deploymentVerified'];
      for (const id of failedIds) {
        expect(result.conditions.find((condition) => condition.id === id))
          .toMatchObject({
            status: 'failed',
            failureId: `PAPER_READINESS_${stage.toUpperCase()}_FAILED`,
            detail: 'The current read-only readiness stage failed.',
          });
      }
      expect(getStopExecutionCapability().available).toBe(false);
    },
  );

  it('publishes explicit cancellation without making external calls', async () => {
    const { t, calls } = makeSpyTransport(true);
    coordinatorTransport = t;
    installCoordinatorDeps();
    const result = await runGmxApiReadinessRefresh({
      singlePeerOnly: true,
      shouldContinue: () => false,
    });

    expect(calls).toEqual([]);
    expect(refreshCanarySpy).not.toHaveBeenCalled();
    expect(runPaperCycleSpy).not.toHaveBeenCalled();
    expect(result.paperStopReadinessEvidence).toMatchObject({
      generation: 1,
      readinessComplete: false,
      fresh: true,
      executionAuthorized: false,
      reasons: [
        'Current PAPER readiness generation was cancelled (fail-closed).',
      ],
    });
    expect(result.paperStopReadinessEvidence.conditions
      .find((condition) => condition.id === 'paperMode')?.status).toBe('verified');
    expect(result.paperStopReadinessEvidence.conditions
      .find((condition) => condition.id === 'healthyPeer')?.status)
      .toBe('not_evaluated');
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
    expect(refreshStopSpy).not.toHaveBeenCalled();
    expect(dbWriteCalls).toEqual([]);
    expect(res.body.refresh.paperStopReadinessEvidence).toMatchObject({
      scope: 'PAPER_READ_ONLY_STOP_READINESS',
      executionAuthorized: false,
      generation: res.body.refresh.generation,
    });
    // 응답에 최신 스냅샷 동봉
    expect(res.body.status.readyForControlledCanary).toBe(false);
    expect(res.body.status.stopCapability.available)
      .toBe(getStopExecutionCapability().available);
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
    expect(refreshStopSpy).not.toHaveBeenCalled();
    expect(maxActiveReads).toBe(1);
    expect(readerCalls).toEqual([
      'decimals:BTC',
      'cost:BTC',
      'cost:BTC',
      'decimals:ETH',
      'cost:ETH',
      'cost:ETH',
    ]);
    expect(calls).toEqual([{ method: 'GET', path: '/markets/tickers' }]);
    expect(dbWriteCalls).toEqual([]);
  });

  it('coordinator refresh 실패 뒤 shared in-flight를 해제하고 다음 refresh를 새 generation으로 재실행한다', async () => {
    const { t, calls } = makeSpyTransport(true);
    coordinatorTransport = t;
    const stopBefore = getStopExecutionCapability();
    refreshCanarySpy
      .mockRejectedValueOnce(new Error('injected readonly failure'))
      .mockResolvedValueOnce(emptyCanaryEvidence());
    installCoordinatorDeps();

    await expect(runGmxApiReadinessRefresh({
      singlePeerOnly: true,
    })).rejects.toThrow('injected readonly failure');

    const failedEvidence = getPaperStopReadinessEvidence(Date.now(), coordinatorEnv);
    expect(failedEvidence).toMatchObject({
      generation: 1,
      readinessComplete: false,
      fresh: true,
      executionAuthorized: false,
    });
    expect(failedEvidence.conditions
      .filter((condition) => condition.category === 'execution_required')
      .every((condition) =>
        condition.status === 'not_evaluated'
        && /NOT_EVALUATED_IN_PAPER/.test(condition.failureId ?? ''))).toBe(true);
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
    expect(retried.paperStopReadinessEvidence).toMatchObject({
      generation: 2,
      readinessComplete: false,
      fresh: true,
      executionAuthorized: false,
    });
    for (const id of ['paperMode', 'readonlyEnabled', 'healthyPeer', 'canonicalCostCap']) {
      expect(retried.paperStopReadinessEvidence.conditions
        .find((condition) => condition.id === id)?.status).toBe('verified');
    }
    expect(retried.paperStopReadinessEvidence.conditions
      .filter((condition) => condition.category === 'execution_required')
      .every((condition) => condition.status === 'not_evaluated')).toBe(true);
    expect(refreshCanarySpy).toHaveBeenCalledTimes(2);
    expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
    expect(refreshStopSpy).not.toHaveBeenCalled();
    expect(getStopExecutionCapability()).toEqual(stopBefore);
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

  it('scheduler refresh rejection을 fail-closed로 게시하고 다음 timer generation에서 회복한다', async () => {
    vi.useFakeTimers();
    const { t, calls: transportCalls } = makeSpyTransport(true);
    const getJson = vi.spyOn(t, 'getJson')
      .mockImplementationOnce(async (path: string) => {
        transportCalls.push({ method: 'GET', path });
        throw new Error('injected scheduler peer failure');
      })
      .mockImplementation(async (path: string) => {
        transportCalls.push({ method: 'GET', path });
        return {
          ok: true,
          data: {},
          peerHost: 'peer-a',
        };
      });
    coordinatorTransport = {
      ...t,
      peers: ['https://peer-a'],
      getJson,
    } as GmxApiTransport;
    installCoordinatorDeps();
    const stopBefore = getStopExecutionCapability();
    const executionCostBefore = getExecutionEligibleCostEvidence(Date.now());

    try {
      startPaperRuntimeReadinessScheduler();
      await vi.waitFor(() => {
        expect(__getGmxApiReadinessCoordinatorStateForTests().active).toBe(false);
        expect(getJson).toHaveBeenCalledTimes(1);
      });

      const failed = getPaperStopReadinessEvidence(Date.now(), coordinatorEnv);
      expect(failed).toMatchObject({
        generation: 1,
        readinessComplete: false,
        executionAuthorized: false,
      });
      expect(failed.conditions.find((condition) => condition.id === 'healthyPeer'))
        .toMatchObject({
          status: 'failed',
          failureId: 'PAPER_READINESS_PEER_FAILED',
        });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => {
        expect(getJson).toHaveBeenCalledTimes(2);
        expect(__getGmxApiReadinessCoordinatorStateForTests().active).toBe(false);
      });

      const recovered = getPaperStopReadinessEvidence(Date.now(), coordinatorEnv);
      expect(recovered).toMatchObject({
        generation: 2,
        fresh: true,
        executionAuthorized: false,
      });
      expect(recovered.conditions.find((condition) => condition.id === 'healthyPeer')
        ?.status).toBe('verified');
      expect(recovered.conditions
        .filter((condition) => condition.category === 'execution_required')
        .every((condition) => condition.status === 'not_evaluated')).toBe(true);
      expect(refreshStopSpy).not.toHaveBeenCalled();
      expect(getStopExecutionCapability()).toEqual(stopBefore);
      expect(getExecutionEligibleCostEvidence(Date.now())).toEqual(executionCostBefore);
      expect(transportCalls).toEqual([
        { method: 'GET', path: '/markets/tickers' },
        { method: 'GET', path: '/markets/tickers' },
      ]);
      expect(dbWriteCalls).toEqual([]);
    } finally {
      stopPaperRuntimeReadinessScheduler();
      vi.useRealTimers();
    }
  });

  it('거부된 PAPER shared flight 뒤 scheduler generation이 canary/PAPER/stop을 각각 한 번 실행한다', async () => {
    const { t, calls } = makeSpyTransport(true);
    coordinatorTransport = t;
    installCoordinatorDeps();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const failedSharedFlight = runPaperRuntimeReadinessCycle({
        deps: {
          env: coordinatorEnv,
          nowMs: () => {
            throw new Error('injected shared PAPER failure');
          },
        },
      });
      startPaperRuntimeReadinessScheduler();

      await expect(failedSharedFlight).rejects.toThrow(
        'injected shared PAPER failure',
      );
      await vi.waitFor(() => {
        expect(refreshCanarySpy).toHaveBeenCalledTimes(1);
        expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
        expect(refreshStopSpy).not.toHaveBeenCalled();
        expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
          active: false,
          joinCount: 0,
        });
        expect(getPaperRuntimeReadinessSnapshot(
          Date.now(),
          coordinatorEnv,
        ).scheduler.inFlight).toBe(false);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(calls).toEqual([
        { method: 'GET', path: '/markets/tickers' },
        { method: 'GET', path: '/markets/tickers' },
      ]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      stopPaperRuntimeReadinessScheduler();
    }
  });

  it('stale completion은 newer shared flight와 join count를 해제하지 않는다', async () => {
    let releaseFirst: (() => void) | null = null;
    let releaseSecond: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let canaryCall = 0;
    refreshCanarySpy.mockImplementation(async () => {
      canaryCall += 1;
      await (canaryCall === 1 ? firstGate : secondGate);
      return emptyCanaryEvidence();
    });
    installCoordinatorDeps();

    const staleFlight = runGmxApiReadinessRefresh({ singlePeerOnly: true });
    await vi.waitFor(() => expect(refreshCanarySpy).toHaveBeenCalledTimes(1));

    __resetGmxApiReadinessCoordinatorForTests({ preserveGeneration: true });
    installCoordinatorDeps();
    const newerFlight = runGmxApiReadinessRefresh({ singlePeerOnly: true });
    await vi.waitFor(() => expect(refreshCanarySpy).toHaveBeenCalledTimes(2));
    expect(__getGmxApiReadinessCoordinatorGenerationForTests()).toBe(2);
    const newerJoin = runGmxApiReadinessRefresh({ singlePeerOnly: true });
    expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
      active: true,
      joinCount: 1,
    });

    releaseFirst!();
    await staleFlight;
    const whileNewerGenerationIsActive =
      getPaperStopReadinessEvidence(Date.now(), coordinatorEnv);
    expect(whileNewerGenerationIsActive).toMatchObject({
      generation: 2,
      evaluatedAtMs: null,
      readinessComplete: false,
      executionAuthorized: false,
    });
    expect(whileNewerGenerationIsActive.conditions
      .filter((condition) => condition.category === 'execution_required')
      .every((condition) => condition.status === 'not_evaluated')).toBe(true);
    expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
      active: true,
      joinCount: 1,
    });
    expect(getPaperRuntimeReadinessSnapshot(
      Date.now(),
      coordinatorEnv,
    ).scheduler.inFlight).toBe(true);

    releaseSecond!();
    await Promise.all([newerFlight, newerJoin]);
    expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
      active: false,
      joinCount: 0,
    });
    expect(getPaperRuntimeReadinessSnapshot(
      Date.now(),
      coordinatorEnv,
    ).scheduler.inFlight).toBe(false);
    expect(runPaperCycleSpy).toHaveBeenCalledTimes(2);
    expect(refreshStopSpy).not.toHaveBeenCalled();
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
      runPaperCycleSpy.mockImplementation(async () => {
        resolveFirstCycle!();
        return getPaperRuntimeReadinessSnapshot(Date.now(), coordinatorEnv);
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
      expect(refreshStopSpy).not.toHaveBeenCalled();

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
      expect(refreshStopSpy).not.toHaveBeenCalled();
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

  it('scheduler peer read 중 stop → canary/PAPER/Stop 후속 external read 0회', async () => {
    const { t, calls } = makeSpyTransport(true);
    coordinatorTransport = t;
    let releasePeer: (() => void) | null = null;
    const peerGate = new Promise<void>((resolve) => {
      releasePeer = resolve;
    });
    const originalGetJson = t.getJson.bind(t);
    const peerRead = vi.spyOn(t, 'getJson').mockImplementation(async (path) => {
      await peerGate;
      return originalGetJson(path);
    });
    installCoordinatorDeps();

    try {
      startPaperRuntimeReadinessScheduler();
      await vi.waitFor(() => expect(peerRead).toHaveBeenCalledTimes(1));

      stopPaperRuntimeReadinessScheduler();
      releasePeer!();
      await vi.waitFor(() => expect(
        __getGmxApiReadinessCoordinatorStateForTests(),
      ).toEqual({
        active: false,
        joinCount: 0,
      }));

      expect(calls).toEqual([{ method: 'GET', path: '/markets/tickers' }]);
      expect(refreshCanarySpy).not.toHaveBeenCalled();
      expect(runPaperCycleSpy).not.toHaveBeenCalled();
      expect(refreshStopSpy).not.toHaveBeenCalled();
      expect(dbWriteCalls).toEqual([]);
    } finally {
      const release = releasePeer as unknown as (() => void) | null;
      release?.();
      stopPaperRuntimeReadinessScheduler();
      peerRead.mockRestore();
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
    expect(refreshStopSpy).not.toHaveBeenCalled();
    expect(maxActiveReads).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) =>
      call.method === 'GET' && call.path === '/markets/tickers')).toBe(true);
    expect(dbWriteCalls).toEqual([]);
  });

  it('scheduler coordinator와 direct PAPER cycle이 canonical collector 한 flight를 공유한다', async () => {
    const { t, calls } = makeSpyTransport(true);
    coordinatorTransport = t;
    let releaseCollector: (() => void) | null = null;
    const collectorGate = new Promise<void>((resolve) => {
      releaseCollector = resolve;
    });
    let activeCollectorReads = 0;
    let maxActiveCollectorReads = 0;
    const evidenceReads: string[] = [];
    __setManualCanaryReadonlyReadersForTests({
      resolveDecimals: async (symbol) => {
        activeCollectorReads += 1;
        maxActiveCollectorReads = Math.max(
          maxActiveCollectorReads,
          activeCollectorReads,
        );
        evidenceReads.push(`decimals:${symbol}`);
        if (symbol === 'BTC') await collectorGate;
        activeCollectorReads -= 1;
        return { ok: true, detail: `${symbol} decimals` };
      },
      fetchCost: async ({ symbol }) => {
        activeCollectorReads += 1;
        maxActiveCollectorReads = Math.max(
          maxActiveCollectorReads,
          activeCollectorReads,
        );
        evidenceReads.push(`cost:${symbol}`);
        activeCollectorReads -= 1;
        return { ok: false, reason: `${symbol} cost unavailable` };
      },
    });
    refreshCanarySpy.mockImplementation(
      refreshManualCanaryReadonlyEvidence,
    );
    installCoordinatorDeps();

    try {
      startPaperRuntimeReadinessScheduler();
      await vi.waitFor(() => expect(evidenceReads).toEqual(['decimals:BTC']));

      const directCycle = runPaperRuntimeReadinessCycle({
        deps: {
          env: coordinatorEnv,
          refreshCanary: refreshManualCanaryReadonlyEvidence,
          createReadonlyClient: () => ({
            ok: false,
            reason: 'injected no-network deployment client',
          }),
        },
        forceDeployment: true,
      });
      await Promise.resolve();

      expect(evidenceReads).toEqual(['decimals:BTC']);
      expect(maxActiveCollectorReads).toBe(1);
      releaseCollector!();
      await directCycle;
      await vi.waitFor(() => expect(
        __getGmxApiReadinessCoordinatorStateForTests(),
      ).toEqual({ active: false, joinCount: 0 }));

      expect(evidenceReads).toEqual([
        'decimals:BTC',
        'cost:BTC',
        'cost:BTC',
        'decimals:ETH',
        'cost:ETH',
        'cost:ETH',
      ]);
      expect(maxActiveCollectorReads).toBe(1);
      expect(refreshCanarySpy).toHaveBeenCalledTimes(1);
      expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([
        { method: 'GET', path: '/markets/tickers' },
        { method: 'GET', path: '/markets/tickers' },
      ]);
      expect(calls.some((call) =>
        call.method === 'POST'
        || /rpc|prepare|sign|submit|relay|order/i.test(call.path))).toBe(false);
      expect(dbWriteCalls).toEqual([]);
    } finally {
      const release = releaseCollector as unknown as (() => void) | null;
      release?.();
      stopPaperRuntimeReadinessScheduler();
    }
  });

  it('production scheduler-first 경로는 첫 peer read 전에 generation을 게시하고 HTTP가 같은 flight에 합류한다', async () => {
    __resetGmxApiReadinessCoordinatorForTests();
    __setGmxApiReadinessCoordinatorDepsForTests(null);
    process.env.GMX_API_READONLY_ENABLED = 'true';
    process.env.GMX_RELAY_READONLY_NETWORK_ENABLED = 'false';

    let releaseFirstPeer: () => void = () => {};
    const firstPeerGate = new Promise<void>((resolve) => {
      releaseFirstPeer = resolve;
    });
    const observedAtPeerStart: Array<{
      active: boolean;
      generation: number | null;
      inFlight: boolean;
    }> = [];
    const fetchSpy = vi.fn<typeof fetch>(async () => {
      observedAtPeerStart.push({
        ...__getGmxApiReadinessCoordinatorStateForTests(),
        generation: __getGmxApiReadinessCoordinatorGenerationForTests(),
        inFlight: getPaperRuntimeReadinessSnapshot(
          Date.now(),
          process.env,
        ).scheduler.inFlight,
      });
      if (observedAtPeerStart.length === 1) await firstPeerGate;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const evidenceReads: string[] = [];
    __setManualCanaryReadonlyReadersForTests({
      resolveDecimals: async (symbol) => {
        evidenceReads.push(`decimals:${symbol}`);
        return { ok: true, detail: `${symbol} decimals` };
      },
      fetchCost: async ({ symbol }) => {
        evidenceReads.push(`cost:${symbol}`);
        return { ok: false, reason: `${symbol} cost unavailable` };
      },
    });

    try {
      startPaperRuntimeReadinessScheduler();
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      expect(observedAtPeerStart[0]).toMatchObject({
        active: true,
        generation: 1,
        inFlight: true,
      });

      const httpPromise = request(app)
        .post('/api/executor/gmx-api/readiness/refresh')
        .set('x-operator-pin', PIN)
        .set('content-type', 'application/json').send({})
        .then((response) => response);
      await vi.waitFor(() => expect(
        __getGmxApiReadinessCoordinatorStateForTests(),
      ).toEqual({ active: true, joinCount: 1 }));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(evidenceReads).toEqual([]);

      releaseFirstPeer();
      const response = await httpPromise;

      expect(response.status).toBe(200);
      expect(response.body.refresh.generation).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(evidenceReads).toEqual([
        'decimals:BTC',
        'cost:BTC',
        'cost:BTC',
        'decimals:ETH',
        'cost:ETH',
        'cost:ETH',
      ]);
      expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
        active: false,
        joinCount: 0,
      });
    } finally {
      releaseFirstPeer();
      stopPaperRuntimeReadinessScheduler();
      vi.unstubAllGlobals();
      delete process.env.GMX_RELAY_READONLY_NETWORK_ENABLED;
    }
  });

  it('production HTTP-first 경로에 scheduler가 같은 published generation으로 합류한다', async () => {
    __resetGmxApiReadinessCoordinatorForTests();
    __setGmxApiReadinessCoordinatorDepsForTests(null);
    process.env.GMX_API_READONLY_ENABLED = 'true';
    process.env.GMX_RELAY_READONLY_NETWORK_ENABLED = 'false';

    let releaseFirstPeer: () => void = () => {};
    const firstPeerGate = new Promise<void>((resolve) => {
      releaseFirstPeer = resolve;
    });
    const peerStarts: Array<{
      active: boolean;
      generation: number | null;
    }> = [];
    const fetchSpy = vi.fn<typeof fetch>(async () => {
      peerStarts.push({
        active: __getGmxApiReadinessCoordinatorStateForTests().active,
        generation: __getGmxApiReadinessCoordinatorGenerationForTests(),
      });
      if (peerStarts.length === 1) await firstPeerGate;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const evidenceReads: string[] = [];
    __setManualCanaryReadonlyReadersForTests({
      resolveDecimals: async (symbol) => {
        evidenceReads.push(`decimals:${symbol}`);
        return { ok: true, detail: `${symbol} decimals` };
      },
      fetchCost: async ({ symbol }) => {
        evidenceReads.push(`cost:${symbol}`);
        return { ok: false, reason: `${symbol} cost unavailable` };
      },
    });

    try {
      const httpPromise = request(app)
        .post('/api/executor/gmx-api/readiness/refresh')
        .set('x-operator-pin', PIN)
        .set('content-type', 'application/json').send({})
        .then((response) => response);
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      expect(peerStarts[0]).toEqual({ active: true, generation: 1 });

      startPaperRuntimeReadinessScheduler();
      await vi.waitFor(() => expect(
        __getGmxApiReadinessCoordinatorStateForTests(),
      ).toEqual({ active: true, joinCount: 1 }));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(evidenceReads).toEqual([]);

      releaseFirstPeer();
      const response = await httpPromise;

      expect(response.status).toBe(200);
      expect(response.body.refresh.generation).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(evidenceReads).toEqual([
        'decimals:BTC',
        'cost:BTC',
        'cost:BTC',
        'decimals:ETH',
        'cost:ETH',
        'cost:ETH',
      ]);
      expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
        active: false,
        joinCount: 0,
      });
    } finally {
      releaseFirstPeer();
      stopPaperRuntimeReadinessScheduler();
      vi.unstubAllGlobals();
      delete process.env.GMX_RELAY_READONLY_NETWORK_ENABLED;
    }
  });

  it('transport rejection cleans the shared flight without unhandled rejection and next generation runs once', async () => {
    const transportFailure = new Error('injected transport timeout');
    const getJson = vi.fn()
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValue({
        ok: true,
        data: {},
        peerHost: 'peer-a',
      });
    coordinatorTransport = {
      ...makeSpyTransport(true).t,
      peers: ['https://peer-a'],
      getJson,
    } as GmxApiTransport;
    installCoordinatorDeps();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const first = runGmxApiReadinessRefresh({ singlePeerOnly: true });
      const joined = runGmxApiReadinessRefresh({ singlePeerOnly: true });
      await expect(Promise.all([first, joined])).rejects.toBe(transportFailure);
      expect(getJson).toHaveBeenCalledTimes(1);
      expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
        active: false,
        joinCount: 0,
      });

      const recovered = await Promise.all([
        runGmxApiReadinessRefresh({ singlePeerOnly: true }),
        runGmxApiReadinessRefresh({ singlePeerOnly: true }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(recovered.map((result) => result.generation)).toEqual([2, 2]);
      expect(getJson).toHaveBeenCalledTimes(2);
      expect(refreshCanarySpy).toHaveBeenCalledTimes(1);
      expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
      expect(refreshStopSpy).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('fail-closed timeout result settles shared state and the next generation executes once', async () => {
    const getJson = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        kind: 'timeout',
        httpStatus: null,
        ambiguous: true,
        message: 'GMX API response timeout',
        peerHost: 'peer-a',
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {},
        peerHost: 'peer-a',
      });
    coordinatorTransport = {
      ...makeSpyTransport(true).t,
      peers: ['https://peer-a'],
      getJson,
    } as GmxApiTransport;
    installCoordinatorDeps();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const timedOut = await Promise.all([
        runGmxApiReadinessRefresh({ singlePeerOnly: true }),
        runGmxApiReadinessRefresh({ singlePeerOnly: true }),
      ]);

      expect(timedOut.map((result) => result.generation)).toEqual([1, 1]);
      expect(timedOut[0].peerHealth).toEqual([{
        peerHost: 'peer-a',
        ok: false,
        kind: 'timeout',
      }]);
      expect(getJson).toHaveBeenCalledTimes(1);
      expect(refreshCanarySpy).toHaveBeenCalledTimes(1);
      expect(runPaperCycleSpy).toHaveBeenCalledTimes(1);
      expect(refreshStopSpy).not.toHaveBeenCalled();
      expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
        active: false,
        joinCount: 0,
      });

      const recovered = await Promise.all([
        runGmxApiReadinessRefresh({ singlePeerOnly: true }),
        runGmxApiReadinessRefresh({ singlePeerOnly: true }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(recovered.map((result) => result.generation)).toEqual([2, 2]);
      expect(getJson).toHaveBeenCalledTimes(2);
      expect(refreshCanarySpy).toHaveBeenCalledTimes(2);
      expect(runPaperCycleSpy).toHaveBeenCalledTimes(2);
      expect(refreshStopSpy).not.toHaveBeenCalled();
      expect(__getGmxApiReadinessCoordinatorStateForTests()).toEqual({
        active: false,
        joinCount: 0,
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('PAPER에서 peer health → canary → PAPER evidence 순서를 직렬화하고 cached Stop을 반환한다', async () => {
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
    expect(order).toEqual(['peer', 'canary', 'paper']);
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
    expect(refreshStopSpy).toHaveBeenCalledTimes(1);
    expect(res.body.status.submissionEnabled).toBe(false);
    expect(res.body.status.signerEnabled).toBe(false);
    expect(res.body.status.readyForControlledCanary).toBe(false);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(dbWriteCalls).toEqual([]);
    expect(getExecutionEligibleCostEvidence(Date.now())).toEqual(before);
  });
});
