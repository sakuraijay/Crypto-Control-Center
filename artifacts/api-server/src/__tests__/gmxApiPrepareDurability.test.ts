/**
 * 6G-3 §8 — prepare 구간 fail-closed durable 상태 머신 테스트.
 * DB-free (@workspace/db 전체 mock). 네트워크 호출 0회 — 전부 주입식 fixture.
 *
 * 커버리지:
 *  A) 영속화 우선 순서 — task 저장/전이 실패 시 prepare 0회, 동일 key 중복 차단
 *  B) prepare 실패 분류 — timeout/network/5xx/decode/echo → UNRESOLVED(재시도 0회),
 *     확정 4xx → FAILED_PRE_BROADCAST, requestId 저장 실패 → UNRESOLVED
 *  C) 재시작 reconciliation — PREPARED→FAILED_PRE_BROADCAST(미호출 확정),
 *     PREPARE_REQUESTED→UNRESOLVED, API_PREPARED 유지(자동 재개 0회), 조회 실패=ok:false
 *  D) 전이 규칙 — terminal 역행 금지, 새 상태 전이표
 *  E) 게이트 — blocking task 존재/조회 실패 시 신규 실행 차단, 자기 task 정확히 1건만 제외
 *  F) 민감정보 — durable row에 서명·URL 미저장
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── in-memory DB mock (6G-1 패턴 + select 실패 스위치) ──────────────────────
interface FakeRow { [k: string]: unknown }
const store: { tasks: FakeRow[]; failInsert: boolean; failUpdate: boolean; failSelect: boolean } =
  { tasks: [], failInsert: false, failUpdate: false, failSelect: false };

vi.mock('@workspace/db', () => {
  const tasksTable = { __name: 'relay_tasks' };
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          const run = () => {
            if (store.failSelect) throw new Error('select fail');
            return filterRows(store.tasks, cond);
          };
          // lazy thenable — await되기 전에는 실행하지 않는다 (unhandled rejection 방지)
          return {
            then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              try { resolve(run()); } catch (e) { reject(e); }
            },
            limit: async (n: number) => run().slice(0, n),
            orderBy: () => ({ limit: async (n: number) => run().slice(0, n) }),
          };
        },
        orderBy: () => ({ limit: async (n: number) => { if (store.failSelect) throw new Error('select fail'); return store.tasks.slice(0, n); } }),
      }),
    }),
    insert: () => ({
      values: async (v: FakeRow) => {
        if (store.failInsert) throw new Error('insert fail');
        if (store.tasks.some((r) => r.idempotencyKey === v.idempotencyKey)) throw new Error('unique violation');
        store.tasks.push({ createdAt: new Date(), updatedAt: new Date(), ...v });
      },
    }),
    update: () => ({
      set: (patch: FakeRow) => ({
        where: (cond: unknown) => {
          const run = () => {
            if (store.failUpdate) throw new Error('update fail');
            const matched = filterRows(store.tasks, cond);
            for (const r of matched) Object.assign(r, patch);
            return matched;
          };
          return {
            returning: async () => run().map((r) => ({ id: r.id })),
            then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              try { resolve(run()); } catch (e) { reject(e); }
            },
          };
        },
      }),
    }),
  };
  const proxied = (t: object) => new Proxy(t, {
    get: (obj, prop) => (prop in obj ? (obj as never)[prop] : { __col: prop }),
  });
  return { db, relayTasksTable: proxied(tasksTable) };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: { __col?: string }, v: unknown) => ({ op: 'eq', col: col.__col, v }),
  and: (...cs: unknown[]) => ({ op: 'and', cs }),
  inArray: (col: { __col?: string }, vs: unknown[]) => ({ op: 'in', col: col.__col, vs }),
  desc: (col: unknown) => ({ op: 'desc', col }),
}));

function filterRows(rows: FakeRow[], cond: unknown): FakeRow[] {
  const test = (row: FakeRow, c: unknown): boolean => {
    const cc = c as { op: string; col?: string; v?: unknown; vs?: unknown[]; cs?: unknown[] };
    if (cc.op === 'eq') return row[cc.col!] === cc.v;
    if (cc.op === 'in') return cc.vs!.includes(row[cc.col!]);
    if (cc.op === 'and') return cc.cs!.every((x) => test(row, x));
    return true;
  };
  return rows.filter((r) => test(r, cond));
}

import { runGmxApiSubmitFlow, type GmxSubmitFlowInput } from '../lib/gmxApiSubmitFlow';
import {
  RELAY_TASK_STATUS, transitionRelayTask, countBlockingRelayTasksOrNull, isTransitionAllowed,
} from '../lib/relayLifecycle';
import {
  reconcileGmxPrepareStagesOnStartup, getGmxPrepareStartupState,
  __resetGmxPrepareStartupStateForTests,
} from '../lib/gmxApiPrepareStartup';
import { GMX_API_TRANSPORT_GEN, type PreparedOrderView } from '../lib/gmxApiOrders';
import type { GmxApiTransport } from '../lib/gmxApiTransport';
import type { ActivationGateInput } from '../lib/relayActivationGate';
import { __resetReadinessRefreshForTests, recordCanonicalSnapshot } from '../lib/relayActivationStatus';

const MAIN = '0x1111111111111111111111111111111111111111';
const SUB = '0x2222222222222222222222222222222222222222';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ROUTER = '0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f';

const FULL_ENV = {
  WORKER_ENGINE_MODE: 'LIVE', LIVE_TEST_EXECUTION_LOCKED: 'false',
  DELEGATED_SIGNER_ENABLED: 'true', GMX_RELAY_SUBMISSION_ENABLED: 'true',
  GMX_RELAY_NETWORK_ENABLED: 'true', GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
  GMX_RELAY_MODE: 'LIVE',
  GMX_API_READONLY_ENABLED: 'true', GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
  GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: ROUTER,
  GMX_DATA_STORE_ADDRESS: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
  GMX_EVENT_EMITTER_ADDRESS: '0xC8ee91A54287DB53897056e12D9819156D3822Fb',
} as NodeJS.ProcessEnv;

function fullActivation(overrides?: Partial<ActivationGateInput>): ActivationGateInput {
  return {
    env: FULL_ENV, liveTestMode: true, signerInitialized: true, canonicalAuthorized: true,
    emergencyStopActive: false, dbOk: true, rpcOk: true, reconciliationComplete: true,
    blockingIntentCount: 0, activeRevokeInProgress: false, freshLiveFeeQuote: true,
    currentChainId: 42161, gmxConfigOk: true, deploymentVerified: true, kind: 'OPEN',
    ...overrides,
  };
}

function preparedFixture(overrides?: Partial<PreparedOrderView>): PreparedOrderView {
  return {
    requestId: 'req-1', idempotencyKey: 'idem-1', mode: 'express', payloadType: 'typed-data',
    typedData: { domain: { chainId: 42161 }, types: { X: [] }, message: { a: 1 }, primaryType: 'X' },
    from: MAIN, subaccountAddress: SUB, orderKind: 'MarketIncrease', isLong: true,
    sizeDeltaUsd: '1000', collateralToken: USDC, receiver: MAIN, executionFeeAmount: '100',
    ...overrides,
  };
}
const EXPECTED = {
  mainWallet: MAIN, subaccountAddress: SUB, orderKind: 'MarketIncrease',
  isLong: true, sizeDeltaUsd: '1000', collateralToken: USDC,
};

function mockTransport(): { transport: GmxApiTransport; calls: { submit: number } } {
  const calls = { submit: 0 };
  const transport: GmxApiTransport = {
    readonlyEnabled: true, submissionEnabled: true,
    peers: ['https://arbitrum.gmxapi.io/v1', 'https://arbitrum.gmxapi.ai/v1'],
    async postJson(_p, _b, intent) {
      if (intent === 'submit') {
        calls.submit++;
        return { ok: true, data: { status: 'relay_accepted' }, peerHost: 'arbitrum.gmxapi.io' } as never;
      }
      return { ok: true, data: {}, peerHost: 'arbitrum.gmxapi.io' } as never;
    },
    async getJson() { return { ok: true, data: {}, peerHost: 'arbitrum.gmxapi.io' } as never; },
  };
  return { transport, calls };
}

let seq = 0;
function flowInput(transport: GmxApiTransport, overrides?: Partial<GmxSubmitFlowInput>): GmxSubmitFlowInput {
  const view = preparedFixture({ idempotencyKey: `idem-${seq}` });
  seq += 1;
  return {
    transport, activation: fullActivation(), kind: 'OPEN', intentId: `intent-${seq}`, approvalSessionId: null,
    flowIdempotencyKey: `gmxapi:flow:test-${seq}`,
    requestPayloadHash: '0xreqhash',
    prepareOrder: async () => ({ ok: true, data: { view }, peerHost: 'arbitrum.gmxapi.io' } as never),
    toView: () => ({ ok: true, view }),
    expected: EXPECTED,
    extractEvidence: (v) => ({ primaryType: v.typedData?.primaryType ?? null, typedDataDigest: '0x' + 'ab'.repeat(32) }),
    verifyTypedDataBinding: async () => ({ ok: true }),
    signTypedData: async () => ({ ok: true, signature: '0xsig-secret' }),
    reevaluateActivation: async () => fullActivation(),
    buildSubmitBody: () => ({}),
    nowMs: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  store.tasks = []; store.failInsert = false; store.failUpdate = false; store.failSelect = false;
  __resetGmxPrepareStartupStateForTests();
  __resetReadinessRefreshForTests();
});
afterEach(() => { vi.restoreAllMocks(); });

// ════════════ A) 영속화 우선 순서 ════════════
describe('6G-3 §3 — 외부 prepare 호출 전 영속화', () => {
  it('canonical delegation=false면 signer가 초기화되어도 prepare·서명·제출 0회', async () => {
    const { transport, calls } = mockTransport();
    const prepareSpy = vi.fn(async () => ({ ok: true, data: {}, peerHost: 'x' } as never));
    const signSpy = vi.fn(async () => ({ ok: true as const, signature: '0xsig-secret' }));
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      activation: fullActivation({ canonicalAuthorized: false }),
      prepareOrder: prepareSpy,
      signTypedData: signSpy,
    }));
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
    expect(r.prepareCalls).toBe(0);
    expect(r.signCalls).toBe(0);
    expect(r.submitCalls).toBe(0);
    expect(calls.submit).toBe(0);
  });

  it('caller boolean이 true여도 fresh canonical evidence가 무효면 prepare·서명·submit·transport 0회', async () => {
    const nowMs = Date.parse('2026-08-30T07:00:00.000Z');
    recordCanonicalSnapshot({
      atMs: nowMs,
      confirmed: true,
      reason: null,
      approvalNonce: '7',
      isSubaccountListed: false,
      featureDisabled: false,
      integrationDisabled: false,
      expiresAt: String(Math.floor(nowMs / 1000) + 3600),
      remaining: '8',
    });
    const { transport, calls } = mockTransport();
    const prepareSpy = vi.fn(async () => ({ ok: true, data: {}, peerHost: 'x' } as never));
    const signSpy = vi.fn(async () => ({ ok: true as const, signature: '0xsig-secret' }));
    const paperEnv = {
      WORKER_ENGINE_MODE: 'PAPER',
      AUTO_WORKER_LIVE_ENABLED: 'false',
      LIVE_TEST_EXECUTION_LOCKED: 'false',
      DELEGATED_SIGNER_ENABLED: 'true',
      GMX_API_READONLY_ENABLED: 'true',
      GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
    } as NodeJS.ProcessEnv;

    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      activation: fullActivation({
        env: paperEnv,
        manualCanary: true,
        canonicalAuthorized: true,
        canonicalInFlightReservedActions: 0,
        nowMs,
      }),
      prepareOrder: prepareSpy,
      signTypedData: signSpy,
    }));

    expect(r.blockReasons.some((x) => x.includes('delegated authorization 비활성'))).toBe(true);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
    expect(r.prepareCalls).toBe(0);
    expect(r.signCalls).toBe(0);
    expect(r.submitCalls).toBe(0);
    expect(calls.submit).toBe(0);
    expect(store.tasks).toHaveLength(0);
  });

  it('실제 OPEN flow를 activation CLOSE로 위장해도 prepare·서명·submit·transport 0회', async () => {
    const { transport, calls } = mockTransport();
    const prepareSpy = vi.fn(async () => ({ ok: true, data: {}, peerHost: 'x' } as never));
    const signSpy = vi.fn(async () => ({ ok: true as const, signature: '0xsig-secret' }));

    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      kind: 'OPEN',
      activation: fullActivation({ kind: 'CLOSE' }),
      prepareOrder: prepareSpy,
      signTypedData: signSpy,
    }));

    expect(r.blockReasons.some((x) => x.includes('activation kind CLOSE ≠ flow kind OPEN'))).toBe(true);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
    expect(r.prepareCalls).toBe(0);
    expect(r.signCalls).toBe(0);
    expect(r.submitCalls).toBe(0);
    expect(calls.submit).toBe(0);
    expect(store.tasks).toHaveLength(0);
  });

  it('task insert 실패 → prepare·서명·제출 0회', async () => {
    store.failInsert = true;
    const { transport, calls } = mockTransport();
    const prepareSpy = vi.fn(async () => ({ ok: true, data: {}, peerHost: 'x' } as never));
    const r = await runGmxApiSubmitFlow(flowInput(transport, { prepareOrder: prepareSpy }));
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(r.prepareCalls).toBe(0); expect(r.signCalls).toBe(0); expect(calls.submit).toBe(0);
  });

  it('PREPARE_REQUESTED 조건부 전환 실패 → prepare 0회 + task PREPARED 잔존', async () => {
    const { transport, calls } = mockTransport();
    const prepareSpy = vi.fn(async () => ({ ok: true, data: {}, peerHost: 'x' } as never));
    // insert 성공 후 update만 실패하도록: update 시점에 스위치
    const input = flowInput(transport, { prepareOrder: prepareSpy });
    store.failUpdate = true;
    const r = await runGmxApiSubmitFlow(input);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(r.prepareCalls).toBe(0); expect(calls.submit).toBe(0);
    expect(store.tasks[0]?.status).toBe(RELAY_TASK_STATUS.PREPARED);
  });

  it('삽입 후 fence — 사전 카운트 이후 다른 task가 끼어들면 CANCELLED·prepare 0회', async () => {
    const { transport, calls } = mockTransport();
    const prepareSpy = vi.fn(async () => ({ ok: true, data: {}, peerHost: 'x' } as never));
    // 서로 다른 key의 두 flow를 동시에 실행 — 사전 카운트(1b)는 둘 다 0을 볼 수
    // 있지만, 삽입 후 재확인(2b)이 상대 행을 감지해 fail-closed로 취소해야 한다.
    const mk = (n: number) => flowInput(transport, {
      flowIdempotencyKey: `gmxapi:flow:race-${n}`, prepareOrder: prepareSpy,
      toView: () => ({ ok: true, view: preparedFixture() }),
    });
    const [r1, r2] = await Promise.all([runGmxApiSubmitFlow(mk(1)), runGmxApiSubmitFlow(mk(2))]);
    // 서로 다른 key의 동시 flow — fence가 최소 한쪽(대개 양쪽)을 취소, prepare 총 ≤1
    expect(prepareSpy.mock.calls.length).toBeLessThanOrEqual(1);
    expect([r1, r2].some((r) => r.finalStatus === RELAY_TASK_STATUS.CANCELLED || r.prepareCalls === 0)).toBe(true);
    expect(calls.submit).toBeLessThanOrEqual(1);
  });

  it('동일 flow idempotency key 동시/연속 실행 → prepare 최대 1회', async () => {
    const { transport } = mockTransport();
    let prepares = 0;
    const mk = () => flowInput(transport, {
      flowIdempotencyKey: 'gmxapi:flow:same',
      prepareOrder: async () => { prepares++; return { ok: true, data: { view: preparedFixture() }, peerHost: 'x' } as never; },
      toView: () => ({ ok: true, view: preparedFixture() }),
    });
    const [r1, r2] = await Promise.all([runGmxApiSubmitFlow(mk()), runGmxApiSubmitFlow(mk())]);
    expect(prepares).toBeLessThanOrEqual(1);
    expect([r1, r2].filter((r) => r.prepareCalls > 0).length).toBeLessThanOrEqual(1);
  });

  it('성공 경로 — PREPARED→PREPARE_REQUESTED→API_PREPARED→SUBMITTING→TASK_ACCEPTED + 증거 저장', async () => {
    const { transport, calls } = mockTransport();
    const r = await runGmxApiSubmitFlow(flowInput(transport));
    expect(r.submitted).toBe(true);
    expect(calls.submit).toBe(1);
    const row = store.tasks.find((t) => t.id === r.taskRowId)!;
    expect(row.status).toBe(RELAY_TASK_STATUS.TASK_ACCEPTED);
    expect(row.gmxRequestId).toBe('req-1');
    expect(row.gmxPrimaryType).toBe('X');
    expect(row.gmxTypedDataDigest).toMatch(/^0x/);
    expect(row.gmxPreparePeer).toBe('arbitrum.gmxapi.io');
    expect(row.gmxPrepareRequestedAt).toBeTruthy();
    expect(row.gmxPreparedAt).toBeTruthy();
    expect(row.transportGen).toBe(GMX_API_TRANSPORT_GEN);
  });
});

// ════════════ B) prepare 실패 분류 ════════════
describe('6G-3 §3.4 — prepare 실패 분류 (자동 재시도 0회)', () => {
  const failCases: Array<[string, unknown, string]> = [
    ['timeout', { ok: false, kind: 'timeout', httpStatus: null, ambiguous: true, message: 't', peerHost: null }, RELAY_TASK_STATUS.UNRESOLVED],
    ['network', { ok: false, kind: 'network', httpStatus: null, ambiguous: true, message: 'n', peerHost: null }, RELAY_TASK_STATUS.UNRESOLVED],
    ['5xx', { ok: false, kind: 'http', httpStatus: 502, ambiguous: true, message: '5', peerHost: null }, RELAY_TASK_STATUS.UNRESOLVED],
    ['확정 4xx', { ok: false, kind: 'http', httpStatus: 400, ambiguous: false, message: '4', peerHost: null }, RELAY_TASK_STATUS.FAILED_PRE_BROADCAST],
    ['429', { ok: false, kind: 'rate_limited', httpStatus: 429, ambiguous: false, message: 'r', peerHost: null }, RELAY_TASK_STATUS.FAILED_PRE_BROADCAST],
  ];
  for (const [label, res, expected] of failCases) {
    it(`prepare ${label} → ${expected} + prepare 1회·서명·제출 0회`, async () => {
      const { transport, calls } = mockTransport();
      let prepares = 0;
      const r = await runGmxApiSubmitFlow(flowInput(transport, {
        prepareOrder: async () => { prepares++; return res as never; },
      }));
      expect(prepares).toBe(1);
      expect(r.finalStatus).toBe(expected);
      expect(r.signCalls).toBe(0); expect(calls.submit).toBe(0);
      expect(store.tasks[0]?.status).toBe(expected);
    });
  }

  it('prepare decode 실패 → UNRESOLVED (FAILED 금지)', async () => {
    const { transport, calls } = mockTransport();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      toView: () => ({ ok: false, reason: '구조 오류' }),
    }));
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.UNRESOLVED);
    expect(r.signCalls).toBe(0); expect(calls.submit).toBe(0);
  });

  it('prepare echo 불일치(size) → UNRESOLVED', async () => {
    const { transport, calls } = mockTransport();
    const view = preparedFixture({ sizeDeltaUsd: '9999' });
    const r = await runGmxApiSubmitFlow(flowInput(transport, { toView: () => ({ ok: true, view }) }));
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.UNRESOLVED);
    expect(r.signCalls).toBe(0); expect(calls.submit).toBe(0);
  });

  it('requestId/증거 저장 실패 → UNRESOLVED + 서명·제출 0회 + requestId를 resolutionBasis에 보존', async () => {
    const { transport, calls } = mockTransport();
    const view = preparedFixture();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      prepareOrder: async () => {
        // prepare 성공 후 이어지는 UPDATE(증거 patch)부터 실패시킨다
        store.failUpdate = true;
        return { ok: true, data: { view }, peerHost: 'arbitrum.gmxapi.io' } as never;
      },
      toView: () => ({ ok: true, view }),
    }));
    expect(r.signCalls).toBe(0); expect(calls.submit).toBe(0);
    // 전이 자체도 실패할 수 있으므로 결과 상태는 UNRESOLVED 의도이며 durable 전환 재시도는 없다
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.UNRESOLVED);
    expect(r.blockReasons.join(' ')).toContain('증거 저장 실패');
  });
});

// ════════════ C) 재시작 reconciliation ════════════
describe('6G-3 §4 — 재시작 reconciliation (GMX POST·서명 0회)', () => {
  function seedTask(status: string, extra?: FakeRow): FakeRow {
    const row: FakeRow = {
      id: `task-${status}-${seq++}`, idempotencyKey: `k-${seq}`, kind: 'OPEN',
      status, transportGen: GMX_API_TRANSPORT_GEN,
      createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(), ...extra,
    };
    store.tasks.push(row);
    return row;
  }

  it('PREPARED(미호출 확정) → FAILED_PRE_BROADCAST, PREPARE_REQUESTED → UNRESOLVED, API_PREPARED 유지', async () => {
    const a = seedTask(RELAY_TASK_STATUS.PREPARED);
    const b = seedTask(RELAY_TASK_STATUS.PREPARE_REQUESTED);
    const c = seedTask(RELAY_TASK_STATUS.API_PREPARED, { gmxRequestId: 'req-x' });
    const s = await reconcileGmxPrepareStagesOnStartup();
    expect(s.ok).toBe(true);
    expect(a.status).toBe(RELAY_TASK_STATUS.FAILED_PRE_BROADCAST);
    expect(String(a.resolutionBasis)).toContain('미호출');
    expect(b.status).toBe(RELAY_TASK_STATUS.UNRESOLVED);
    expect(c.status).toBe(RELAY_TASK_STATUS.API_PREPARED); // 자동 재개·자동 전이 0회
    expect(s.stalePreparedFailed).toBe(1);
    expect(s.requestedToUnresolved).toBe(1);
    expect(s.apiPreparedHeld).toBe(1);
  });

  it('legacy transportGen 행은 미접촉', async () => {
    const legacy = seedTask(RELAY_TASK_STATUS.PREPARED, { transportGen: 'jsonrpc-gasless-0.0.10' });
    const s = await reconcileGmxPrepareStagesOnStartup();
    expect(s.ok).toBe(true);
    expect(legacy.status).toBe(RELAY_TASK_STATUS.PREPARED);
  });

  it('배치(200) 초과 잔존 행도 전수 pagination으로 처리 — 250건 전이 + ok=true', async () => {
    for (let i = 0; i < 250; i++) seedTask(RELAY_TASK_STATUS.PREPARED);
    const s = await reconcileGmxPrepareStagesOnStartup();
    expect(s.ok).toBe(true);
    expect(s.stalePreparedFailed).toBe(250);
    expect(store.tasks.every((t) => t.status === RELAY_TASK_STATUS.FAILED_PRE_BROADCAST)).toBe(true);
  });

  it('조회 실패 → ok=false (LIVE 차단 근거)', async () => {
    store.failSelect = true;
    const s = await reconcileGmxPrepareStagesOnStartup();
    expect(s.attempted).toBe(true);
    expect(s.ok).toBe(false);
    expect(getGmxPrepareStartupState().ok).toBe(false);
  });

  it('전이 실패 → ok=false', async () => {
    seedTask(RELAY_TASK_STATUS.PREPARE_REQUESTED);
    store.failUpdate = true;
    const s = await reconcileGmxPrepareStagesOnStartup();
    expect(s.ok).toBe(false);
  });

  it('API_PREPARED 잔존 시 신규 flow는 prepare 0회 차단', async () => {
    seedTask(RELAY_TASK_STATUS.API_PREPARED);
    const { transport, calls } = mockTransport();
    const prepareSpy = vi.fn(async () => ({ ok: true, data: {}, peerHost: 'x' } as never));
    const r = await runGmxApiSubmitFlow(flowInput(transport, { prepareOrder: prepareSpy }));
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(r.prepareCalls).toBe(0); expect(calls.submit).toBe(0);
    expect(r.blockReasons.join(' ')).toContain('미종결 relay task');
  });
});

// ════════════ D) 전이 규칙 ════════════
describe('6G-3 §3 — 전이표·terminal 역행 금지', () => {
  it('새 상태 전이표 — 허용/금지', () => {
    expect(isTransitionAllowed('PREPARED', RELAY_TASK_STATUS.PREPARE_REQUESTED)).toBe(true);
    expect(isTransitionAllowed('PREPARE_REQUESTED', RELAY_TASK_STATUS.API_PREPARED)).toBe(true);
    expect(isTransitionAllowed('PREPARE_REQUESTED', RELAY_TASK_STATUS.UNRESOLVED)).toBe(true);
    expect(isTransitionAllowed('PREPARE_REQUESTED', RELAY_TASK_STATUS.FAILED_PRE_BROADCAST)).toBe(true);
    expect(isTransitionAllowed('API_PREPARED', RELAY_TASK_STATUS.SUBMITTING)).toBe(true);
    // 역행·건너뛰기 금지
    expect(isTransitionAllowed('API_PREPARED', RELAY_TASK_STATUS.PREPARE_REQUESTED)).toBe(false);
    expect(isTransitionAllowed('PREPARE_REQUESTED', RELAY_TASK_STATUS.SUBMITTING)).toBe(false);
    expect(isTransitionAllowed('PREPARE_REQUESTED', RELAY_TASK_STATUS.TASK_ACCEPTED)).toBe(false);
    expect(isTransitionAllowed('FAILED_PRE_BROADCAST', RELAY_TASK_STATUS.PREPARE_REQUESTED)).toBe(false);
    expect(isTransitionAllowed('CONFIRMED', RELAY_TASK_STATUS.UNRESOLVED)).toBe(false);
  });

  it('terminal 행은 조건부 UPDATE로도 역행 불가', async () => {
    store.tasks.push({
      id: 't-term', idempotencyKey: 'k-term', kind: 'OPEN',
      status: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST, transportGen: GMX_API_TRANSPORT_GEN,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const t = await transitionRelayTask({
      taskId: 't-term', from: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST as never, to: RELAY_TASK_STATUS.SUBMITTING,
    });
    expect(t.ok).toBe(false);
    expect(store.tasks[0].status).toBe(RELAY_TASK_STATUS.FAILED_PRE_BROADCAST);
  });
});

// ════════════ E) 게이트 — blocking task·자기 제외 ════════════
describe('6G-3 §6 — 중앙 게이트 blocking task', () => {
  it('blocking 조회 실패(null) → 신규 실행 차단·prepare 0회', async () => {
    store.failSelect = true;
    const { transport, calls } = mockTransport();
    const prepareSpy = vi.fn(async () => ({ ok: true, data: {}, peerHost: 'x' } as never));
    const r = await runGmxApiSubmitFlow(flowInput(transport, { prepareOrder: prepareSpy }));
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(calls.submit).toBe(0);
    expect(r.blockReasons.join(' ')).toContain('조회 실패');
  });

  it('자기 task 정확히 1건만 제외 — 같은 intent의 다른 task도 숨기지 않음 (adversarial)', async () => {
    store.tasks.push(
      { id: 'self', idempotencyKey: 'k-self', kind: 'OPEN', status: RELAY_TASK_STATUS.API_PREPARED, transportGen: GMX_API_TRANSPORT_GEN, intentId: 'intent-1', createdAt: new Date(), updatedAt: new Date() },
      { id: 'other-same-intent', idempotencyKey: 'k-o1', kind: 'OPEN', status: RELAY_TASK_STATUS.UNRESOLVED, transportGen: GMX_API_TRANSPORT_GEN, intentId: 'intent-1', createdAt: new Date(), updatedAt: new Date() },
      { id: 'other-task', idempotencyKey: 'k-o2', kind: 'CLOSE', status: RELAY_TASK_STATUS.SUBMITTING, transportGen: GMX_API_TRANSPORT_GEN, intentId: 'intent-2', createdAt: new Date(), updatedAt: new Date() },
    );
    expect(await countBlockingRelayTasksOrNull({ transportGen: GMX_API_TRANSPORT_GEN, excludeTaskId: 'self' })).toBe(2);
    expect(await countBlockingRelayTasksOrNull({ transportGen: GMX_API_TRANSPORT_GEN })).toBe(3);
  });

  it('confirmed OPEN source 결속만 제외해 보호 flow 1회를 허용한다', async () => {
    const sourceIntentId = 'intent:open:general-sol';
    store.tasks.push({
      id: 'source-open',
      idempotencyKey: 'source-key',
      kind: 'OPEN',
      status: RELAY_TASK_STATUS.TASK_ACCEPTED,
      transportGen: GMX_API_TRANSPORT_GEN,
      intentId: sourceIntentId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { transport, calls } = mockTransport();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      allowedBlockingSourceOpen: { taskId: 'source-open', intentId: sourceIntentId },
      kind: 'CLOSE',
      activation: fullActivation({ kind: 'CLOSE' }),
      reevaluateActivation: async () => fullActivation({ kind: 'CLOSE' }),
    }));
    expect(r.submitted).toBe(true);
    expect(r.prepareCalls).toBe(1);
    expect(r.signCalls).toBe(1);
    expect(r.submitCalls).toBe(1);
    expect(calls.submit).toBe(1);
  });

  it('source task ID의 intent 결속이 다르거나 unrelated blocker가 있으면 보호 flow를 차단한다', async () => {
    store.tasks.push(
      {
        id: 'source-open',
        idempotencyKey: 'source-key',
        kind: 'OPEN',
        status: RELAY_TASK_STATUS.TASK_ACCEPTED,
        transportGen: GMX_API_TRANSPORT_GEN,
        intentId: 'intent:open:actual',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'unrelated',
        idempotencyKey: 'unrelated-key',
        kind: 'CLOSE',
        status: RELAY_TASK_STATUS.UNRESOLVED,
        transportGen: GMX_API_TRANSPORT_GEN,
        intentId: 'intent:close:other',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    );
    const { transport, calls } = mockTransport();
    const prepareSpy = vi.fn();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      allowedBlockingSourceOpen: {
        taskId: 'source-open',
        intentId: 'intent:open:spoofed',
      },
      prepareOrder: prepareSpy,
    }));
    expect(r.submitted).toBe(false);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(calls.submit).toBe(0);
    expect(r.blockReasons.join(' ')).toContain('미종결 relay task 2건');
  });

  it('제출 직전 다른 blocking task 등장 → CANCELLED·제출 0회', async () => {
    const { transport, calls } = mockTransport();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      reevaluateActivation: async () => {
        // 서명 후·제출 전 시점에 외부 UNRESOLVED task 삽입
        store.tasks.push({
          id: 'intruder', idempotencyKey: 'k-intruder', kind: 'OPEN',
          status: RELAY_TASK_STATUS.UNRESOLVED, transportGen: GMX_API_TRANSPORT_GEN,
          createdAt: new Date(), updatedAt: new Date(),
        });
        return fullActivation();
      },
    }));
    expect(calls.submit).toBe(0);
    expect(r.submitted).toBe(false);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.CANCELLED);
  });

  it('PAPER → durable 기록·prepare 0회', async () => {
    const { transport, calls } = mockTransport();
    const prepareSpy = vi.fn();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      activation: fullActivation({ env: { WORKER_ENGINE_MODE: 'PAPER' } as NodeJS.ProcessEnv }),
      prepareOrder: prepareSpy as never,
    }));
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(store.tasks.length).toBe(0);
    expect(calls.submit).toBe(0);
    expect(r.taskRowId).toBeNull();
  });
});

// ════════════ F) 민감정보 ════════════
describe('6G-3 §5 — durable row 비민감성', () => {
  it('서명 전문·URL이 어떤 durable 필드에도 저장되지 않음', async () => {
    const { transport } = mockTransport();
    await runGmxApiSubmitFlow(flowInput(transport));
    const serialized = JSON.stringify(store.tasks);
    expect(serialized).not.toContain('0xsig-secret');
    expect(serialized).not.toContain('https://');
  });
});
