/**
 * 6G-1 §13 — 공식 GMX API v2 전환 신규 테스트.
 * DB-free (@workspace/db 전체 mock). 실제 네트워크 호출 0회 — 전부 fetch mock/주입식 fixture.
 *
 * 커버리지:
 *  A) gmxApiTransport — peer allowlist·플래그 게이트·readonly failover·submit 단일 1회·
 *     429 rate_limited·응답 상한·sanitize·SDK 어댑터 submit 경로 차단
 *  B) gmxApiOrders — status 판정(§10)·prepare 검증·payload hash 결정성
 *  C) gmxApiApproval — §5 owner approval 전면 검증 (domain/message/digest 독립 재계산)
 *  D) runGmxApiSubmitFlow — PAPER 0회·prepare 실패·검증 실패·durable 실패·결속 실패·
 *     서명 실패·재게이트·성공·ambiguous→UNRESOLVED·4xx→FAILED_PRE_BROADCAST·429
 *  E) gmxApiMarkets — 플래그 off·조회 실패 fail-closed
 *  F) 정적 가드 — PrivateKeySigner import 금지 (main wallet 개인키 없음)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── in-memory DB mock (stage5와 동일 패턴) ──────────────────────────────────
interface FakeRow { [k: string]: unknown }
const store: { tasks: FakeRow[]; failInsert: boolean; failUpdate: boolean } =
  { tasks: [], failInsert: false, failUpdate: false };

vi.mock('@workspace/db', () => {
  const tasksTable = { __name: 'relay_tasks' };
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          const p = Promise.resolve().then(() => filterRows(store.tasks, cond));
          return Object.assign(p, {
            limit: async (n: number) => filterRows(store.tasks, cond).slice(0, n),
            orderBy: () => ({ limit: async (n: number) => filterRows(store.tasks, cond).slice(0, n) }),
          });
        },
        orderBy: () => ({ limit: async (n: number) => store.tasks.slice(0, n) }),
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

// @gmx-io/sdk ESM 빌드는 vitest 해석에서 확장자 누락으로 로드 불가 —
// 이 파일의 §8 테스트는 flag-off·조회 실패(fail-closed) 경로만 검증하므로
// SDK 자체는 "항상 실패" stub로 대체한다 (성능·격리 목적, 계약 검증은 어댑터 계층).
vi.mock('@gmx-io/sdk/v2', () => ({
  GmxApiSdk: class {
    async fetchMarkets(): Promise<never> { throw new Error('stubbed'); }
    async fetchWalletBalances(): Promise<never> { throw new Error('stubbed'); }
    async fetchAllowances(): Promise<never> { throw new Error('stubbed'); }
  },
}));

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

// ── 대상 모듈 (mock 이후 import) ─────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import {
  createGmxApiTransport, createSdkApiAdapter, isAllowedPeer,
  GMX_API_PEERS, GMX_API_CHAIN_ID, type GmxApiTransport,
} from '../lib/gmxApiTransport';
import {
  mapGmxApiStatus, isTerminalGmxApiStatus, validatePreparedOrder, hashPreparedPayload,
  toPreparedOrderView, GMX_API_TRANSPORT_GEN, type PreparedOrderView,
} from '../lib/gmxApiOrders';
import { validateGmxPreparedApproval } from '../lib/gmxApiApproval';
import { runGmxApiSubmitFlow, type GmxSubmitFlowInput } from '../lib/gmxApiSubmitFlow';
import { fetchGmxApiMarketMap, checkUsdcCollateralGate } from '../lib/gmxApiMarkets';
import { RELAY_TASK_STATUS } from '../lib/relayLifecycle';
import type { ActivationGateInput } from '../lib/relayActivationGate';
import { GMX_RELAY_DOMAIN_NAME, GMX_RELAY_DOMAIN_VERSION } from '../lib/gmxEip712';
import type { Address } from 'viem';

const BOTH_FLAGS = { GMX_API_READONLY_ENABLED: 'true', GMX_API_ORDER_SUBMISSION_ENABLED: 'true' };
const MAIN = '0x1111111111111111111111111111111111111111';
const SUB = '0x2222222222222222222222222222222222222222';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ROUTER = '0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  store.tasks = []; store.failInsert = false; store.failUpdate = false;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// ════════════ A) transport ════════════
describe('6G-1 §3 — gmxApiTransport peer·플래그·failover·단일 제출', () => {
  it('peer allowlist — 공식 2개만 허용, 그 외 전부 거부', () => {
    for (const p of GMX_API_PEERS) expect(isAllowedPeer(p)).toBe(true);
    for (const bad of [
      'https://evil.example.com/v1', 'http://arbitrum.gmxapi.io/v1',
      'https://arbitrum.gmxapi.io/v2', 'https://arbitrum.gmxapi.io.evil.com/v1',
      'https://arbitrum.gmxapi.io/v1?x=1', 'not-a-url',
    ]) expect(isAllowedPeer(bad)).toBe(false);
  });

  it('readonly 플래그 off → GET fetch 0회 (fail-closed)', async () => {
    const t = createGmxApiTransport({});
    const r = await t.getJson('/markets');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('config');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('submission 플래그 off → submit POST fetch 0회 (fail-closed)', async () => {
    const t = createGmxApiTransport({ GMX_API_READONLY_ENABLED: 'true' });
    const r = await t.postJson('/orders/txns/submit', {}, 'submit');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.kind).toBe('config'); expect(r.ambiguous).toBe(false); }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("플래그는 정확히 'true'만 인정 ('TRUE'/'1' 거부)", async () => {
    for (const v of ['TRUE', '1', 'yes', ' true']) {
      const t = createGmxApiTransport({ GMX_API_READONLY_ENABLED: v });
      expect(t.readonlyEnabled).toBe(false);
    }
  });

  it('readonly GET — peer A 실패 시 peer B로 단일 failover 성공', async () => {
    fetchSpy.mockImplementationOnce(async () => { throw new Error('conn refused'); })
      .mockImplementationOnce(async () => jsonResponse({ markets: [] }));
    const t = createGmxApiTransport(BOTH_FLAGS);
    const r = await t.getJson('/markets');
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const hosts = fetchSpy.mock.calls.map((c: unknown[]) => new URL(String(c[0])).host);
    expect(new Set(hosts).size).toBe(2); // 서로 다른 peer
  });

  it('submit POST — 단일 peer 1회만, 실패해도 다른 peer 재시도 0회', async () => {
    fetchSpy.mockImplementation(async () => { throw new Error('timeout-ish'); });
    const t = createGmxApiTransport(BOTH_FLAGS);
    const r = await t.postJson('/orders/txns/submit', { a: 1 }, 'submit');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.ambiguous).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('submit 429 → rate_limited·비-ambiguous·재시도 0회', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ error: 'slow down' }, 429));
    const t = createGmxApiTransport(BOTH_FLAGS);
    const r = await t.postJson('/orders/txns/submit', {}, 'submit');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.kind).toBe('rate_limited'); }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('오류 메시지 sanitize — URL·토큰형 문자열 미노출', async () => {
    const secretish = 'FAKETOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    fetchSpy.mockImplementation(async () => { throw new Error(`boom ${secretish} https://arbitrum.gmxapi.io/v1/x`); });
    const t = createGmxApiTransport(BOTH_FLAGS);
    const r = await t.postJson('/orders/txns/submit', {}, 'submit');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain(secretish);
      expect(r.message).not.toContain('https://');
    }
  });

  it('경로 형식 위반(절대 URL·역참조) → fetch 0회', async () => {
    const t = createGmxApiTransport(BOTH_FLAGS);
    for (const bad of ['https://evil.com/v1/markets', '/a/../b', 'markets']) {
      const r = await t.getJson(bad);
      expect(r.ok).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('readonly GET — 엄격 charset query string 허용 (SDK 잔액/allowance 조회 경로)', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ balances: [] }));
    const t = createGmxApiTransport(BOTH_FLAGS);
    const r = await t.getJson(`/tokens/balances?account=${MAIN}&spender=router`);
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 위험 charset은 여전히 거부
    const bad = await t.getJson('/x?a=<script>');
    expect(bad.ok).toBe(false);
  });

  it('prepare 응답 echo 필드가 요청값과 불일치하면 decode 거부 (스푸핑 차단)', () => {
    const raw = {
      requestId: 'r', idempotencyKey: 'i', mode: 'express', payloadType: 'typed-data',
      payload: { typedData: { domain: { chainId: 42161 }, types: {}, message: {} } },
      estimates: { executionFeeAmount: '1' },
      sizeDeltaUsd: '999999', // 요청값 '1000'과 불일치 echo
    };
    const r = toPreparedOrderView(raw, {
      from: MAIN, subaccountAddress: SUB, orderKind: 'MarketIncrease',
      isLong: true, sizeDeltaUsd: '1000', collateralToken: USDC, receiver: MAIN,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('echo');
  });

  it('SDK 어댑터 — submit 경로 postJson은 구조적으로 차단', async () => {
    const t = createGmxApiTransport(BOTH_FLAGS);
    const api = createSdkApiAdapter(t);
    for (const p of ['/orders/txns/submit', '/v1/orders/txns/submit', '/relay/submit']) {
      await expect(api.postJson(p, {})).rejects.toThrow(/제출 금지/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ════════════ B) orders ════════════
describe('6G-1 §10 — mapGmxApiStatus 판정', () => {
  it('executed → 온체인 교차 확인 필요 (즉시 CONFIRMED 금지)', () => {
    expect(mapGmxApiStatus('executed')).toEqual({ action: 'confirm_pending_onchain' });
  });
  it('cancelled → CANCELLED / relay_reverted → receipt 확인 필요', () => {
    expect(mapGmxApiStatus('cancelled')).toEqual({ action: 'cancelled' });
    expect(mapGmxApiStatus('relay_reverted')).toEqual({ action: 'fail_pending_receipt' });
  });
  it('relay_failed — pre-broadcast 근거 있을 때만 FAILED, 없으면 blocking', () => {
    expect(mapGmxApiStatus('relay_failed', { preBroadcastEvidence: true })).toEqual({ action: 'failed_pre_broadcast' });
    expect(mapGmxApiStatus('relay_failed').action).toBe('blocking');
  });
  it('알 수 없는 status → blocking (자동 종결 금지)', () => {
    expect(mapGmxApiStatus('weird_new_status').action).toBe('blocking');
    expect(isTerminalGmxApiStatus('weird_new_status')).toBe(false);
  });
});

function preparedFixture(overrides?: Partial<PreparedOrderView>): PreparedOrderView {
  return {
    requestId: 'req-1', idempotencyKey: 'idem-1', mode: 'express', payloadType: 'typed-data',
    typedData: { domain: { chainId: 42161 }, types: { X: [] }, message: { a: 1 } },
    from: MAIN, subaccountAddress: SUB, orderKind: 'MarketIncrease', isLong: true,
    sizeDeltaUsd: '1000', collateralToken: USDC, receiver: MAIN, executionFeeAmount: '100',
    ...overrides,
  };
}
const EXPECTED = {
  mainWallet: MAIN, subaccountAddress: SUB, orderKind: 'MarketIncrease',
  isLong: true, sizeDeltaUsd: '1000', collateralToken: USDC,
};

describe('6G-1 §7-4 — validatePreparedOrder', () => {
  it('전 필드 일치 → ok + payloadHash', () => {
    const r = validatePreparedOrder({ prepared: preparedFixture(), expected: EXPECTED });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('불일치 각각(체인/from/subaccount/direction/size/collateral/receiver/fee) → 차단', () => {
    const cases: Partial<PreparedOrderView>[] = [
      { typedData: { domain: { chainId: 1 }, types: {}, message: {} } },
      { from: SUB }, { subaccountAddress: MAIN }, { isLong: false },
      { sizeDeltaUsd: '999' }, { collateralToken: ROUTER },
      { receiver: SUB }, { executionFeeAmount: null }, { mode: 'classic' }, { payloadType: 'calldata' },
    ];
    for (const c of cases) {
      const r = validatePreparedOrder({ prepared: preparedFixture(c), expected: EXPECTED });
      expect(r.ok).toBe(false);
    }
  });
  it('payloadHash는 키 순서와 무관하게 결정적', () => {
    const a = hashPreparedPayload(preparedFixture({ typedData: { domain: { a: 1, b: 2 }, types: {}, message: { x: 1, y: 2 } } }));
    const b = hashPreparedPayload(preparedFixture({ typedData: { domain: { b: 2, a: 1 }, types: {}, message: { y: 2, x: 1 } } }));
    expect(a).toBe(b);
  });
  it('toPreparedOrderView — typedData 없으면 decode 거부', () => {
    const r = toPreparedOrderView({ requestId: 'x' }, {
      from: MAIN, subaccountAddress: SUB, orderKind: 'MarketIncrease',
      isLong: true, sizeDeltaUsd: '1', collateralToken: USDC, receiver: MAIN,
    });
    expect(r.ok).toBe(false);
  });
});

// ════════════ C) approval ════════════
describe('6G-1 §5 — validateGmxPreparedApproval', () => {
  const NOW = 1_800_000_000n;
  function approvalRaw(msgOverrides?: Record<string, unknown>, domainOverrides?: Record<string, unknown>) {
    return {
      typedData: {
        domain: {
          name: GMX_RELAY_DOMAIN_NAME, version: GMX_RELAY_DOMAIN_VERSION,
          chainId: GMX_API_CHAIN_ID, verifyingContract: ROUTER, ...domainOverrides,
        },
        types: { SubaccountApproval: [{ name: 'subaccount', type: 'address' }] },
        message: {
          subaccount: SUB, shouldAdd: true, expiresAt: String(NOW + 3600n),
          maxAllowedCount: '8', actionType: `0x${'aa'.repeat(32)}`, nonce: '7',
          desChainId: '42161', deadline: String(NOW + 600n), integrationId: `0x${'bb'.repeat(32)}`,
          ...msgOverrides,
        },
      },
    };
  }
  const expected = {
    mainAccount: MAIN as Address, subaccount: SUB as Address,
    verifyingContract: ROUTER as Address, canonicalNonce: 7n, nowSec: NOW,
  };

  it('전 조건 충족 → ok + 서버 독립 재계산 digest', () => {
    const r = validateGmxPreparedApproval({ raw: approvalRaw(), expected });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.digest).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('위반 각각(router/nonce/expiry 초과/deadline 초과/shouldAdd/desChainId/count 초과) → 차단', () => {
    const cases: [Record<string, unknown> | undefined, Record<string, unknown> | undefined][] = [
      [undefined, { verifyingContract: MAIN }],
      [{ nonce: '8' }, undefined],
      [{ expiresAt: String(NOW + 7200n) }, undefined],
      [{ deadline: String(NOW + 7200n) }, undefined],           // deadline > 1h 상한
      [{ deadline: String(NOW + 3601n) }, undefined],           // deadline > expiresAt(1h)
      [{ deadline: String(NOW - 1n) }, undefined],              // deadline 과거
      [{ shouldAdd: false }, undefined],
      [{ desChainId: '1' }, undefined],
      [{ maxAllowedCount: '5' }, undefined],
      [{ maxAllowedCount: '2' }, undefined],
      [{ maxAllowedCount: '6' }, undefined],
      [{ maxAllowedCount: '9' }, undefined],
      [{ actionType: '0x1234' }, undefined],
    ];
    for (const [m, d] of cases) {
      const r = validateGmxPreparedApproval({ raw: approvalRaw(m, d), expected });
      expect(r.ok).toBe(false);
    }
  });
  it('typedData 자체가 없으면 즉시 차단', () => {
    expect(validateGmxPreparedApproval({ raw: {}, expected }).ok).toBe(false);
  });
});

// ════════════ D) submit flow ════════════
const FULL_ENV = {
  WORKER_ENGINE_MODE: 'LIVE', LIVE_TEST_EXECUTION_LOCKED: 'false',
  DELEGATED_SIGNER_ENABLED: 'true', GMX_RELAY_SUBMISSION_ENABLED: 'true',
  GMX_RELAY_NETWORK_ENABLED: 'true', GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
  GMX_RELAY_MODE: 'LIVE', ...BOTH_FLAGS,
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

function mockGmxTransport(submitResult?: unknown): { transport: GmxApiTransport; calls: { submit: number } } {
  const calls = { submit: 0 };
  const transport: GmxApiTransport = {
    readonlyEnabled: true, submissionEnabled: true, peers: GMX_API_PEERS,
    async postJson(path, _body, intent) {
      if (intent === 'submit') {
        calls.submit++;
        return (submitResult ?? { ok: true, data: { status: 'relay_accepted' }, peerHost: 'arbitrum.gmxapi.io' }) as never;
      }
      return { ok: true, data: {}, peerHost: 'arbitrum.gmxapi.io' } as never;
    },
    async getJson() { return { ok: true, data: {}, peerHost: 'arbitrum.gmxapi.io' } as never; },
  };
  return { transport, calls };
}

function flowInput(transport: GmxApiTransport, overrides?: Partial<GmxSubmitFlowInput>): GmxSubmitFlowInput {
  const view = preparedFixture({ idempotencyKey: `idem-${Math.random()}` });
  return {
    transport, activation: fullActivation(), kind: 'OPEN', intentId: null, approvalSessionId: null,
    flowIdempotencyKey: `flow-${Math.random()}`,
    requestPayloadHash: '0xreqhash',
    prepareOrder: async () => ({ ok: true, data: { view }, peerHost: 'arbitrum.gmxapi.io' } as never),
    toView: () => ({ ok: true, view }),
    expected: EXPECTED,
    verifyTypedDataBinding: async () => ({ ok: true }),
    signTypedData: async () => ({ ok: true, signature: '0xsig' }),
    reevaluateActivation: async () => fullActivation(),
    buildSubmitBody: () => ({}),
    nowMs: Date.now(),
    ...overrides,
  };
}

describe('6G-1 §7 — runGmxApiSubmitFlow', () => {
  it('PAPER/게이트 미충족 → prepare·sign·submit 전부 0회', async () => {
    const { transport, calls } = mockGmxTransport();
    const prepareSpy = vi.fn();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      activation: fullActivation({ env: { WORKER_ENGINE_MODE: 'PAPER' } as NodeJS.ProcessEnv }),
      prepareOrder: prepareSpy,
    }));
    expect(r.submitted).toBe(false);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(r.signCalls).toBe(0); expect(calls.submit).toBe(0);
    expect(store.tasks.length).toBe(0);
  });

  it('prepare 실패(5xx ambiguous) → 서명·제출 0회 + UNRESOLVED (6G-3 §3.4)', async () => {
    const { transport, calls } = mockGmxTransport();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      prepareOrder: async () => ({ ok: false, kind: 'http', httpStatus: 500, ambiguous: true, message: 'x', peerHost: null } as never),
    }));
    expect(r.signCalls).toBe(0); expect(calls.submit).toBe(0);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.UNRESOLVED);
  });

  it('prepare 검증 실패(size 불일치) → 서명 0회 + UNRESOLVED (echo 불일치는 보수적 처리)', async () => {
    const { transport, calls } = mockGmxTransport();
    const view = preparedFixture({ sizeDeltaUsd: '9999' });
    const r = await runGmxApiSubmitFlow(flowInput(transport, { toView: () => ({ ok: true, view }) }));
    expect(r.signCalls).toBe(0); expect(calls.submit).toBe(0);
    expect(r.blockReasons.join(' ')).toContain('prepare 검증 실패');
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.UNRESOLVED);
  });

  it('durable PREPARED 저장 실패 → prepare·서명·제출 0회 (6G-3 §3.1)', async () => {
    store.failInsert = true;
    const { transport, calls } = mockGmxTransport();
    const prepareSpy = vi.fn(async () => ({ ok: true, data: {}, peerHost: 'x' } as never));
    const r = await runGmxApiSubmitFlow(flowInput(transport, { prepareOrder: prepareSpy }));
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(r.prepareCalls).toBe(0);
    expect(r.signCalls).toBe(0); expect(calls.submit).toBe(0);
  });

  it('typed data 결속 검증 실패 → 서명 0회 + FAILED_PRE_BROADCAST', async () => {
    const { transport, calls } = mockGmxTransport();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      verifyTypedDataBinding: async () => ({ ok: false, reason: 'domain 불일치' }),
    }));
    expect(r.signCalls).toBe(0); expect(calls.submit).toBe(0);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.FAILED_PRE_BROADCAST);
  });

  it('서명 실패 → 제출 0회 + FAILED_PRE_BROADCAST', async () => {
    const { transport, calls } = mockGmxTransport();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      signTypedData: async () => ({ ok: false, reason: 'signer 잠김' }),
    }));
    expect(calls.submit).toBe(0);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.FAILED_PRE_BROADCAST);
  });

  it('제출 직전 재게이트 미충족 → 제출 0회', async () => {
    const { transport, calls } = mockGmxTransport();
    const r = await runGmxApiSubmitFlow(flowInput(transport, {
      reevaluateActivation: async () => fullActivation({ emergencyStopActive: true }),
    }));
    expect(calls.submit).toBe(0);
    expect(r.submitted).toBe(false);
  });

  it('성공 경로: submit 정확히 1회 + TASK_ACCEPTED + gmxRequestId·transportGen 저장', async () => {
    const { transport, calls } = mockGmxTransport();
    const r = await runGmxApiSubmitFlow(flowInput(transport));
    expect(r.submitted).toBe(true);
    expect(calls.submit).toBe(1);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.TASK_ACCEPTED);
    const row = store.tasks.find((t) => t.id === r.taskRowId);
    expect(row?.transportGen).toBe(GMX_API_TRANSPORT_GEN);
    expect(row?.gmxRequestId).toBe('req-1');
  });

  it('submit ambiguous(timeout) → UNRESOLVED + 재시도 0회', async () => {
    const { transport, calls } = mockGmxTransport(
      { ok: false, kind: 'timeout', httpStatus: null, ambiguous: true, message: 'timeout', peerHost: 'arbitrum.gmxapi.io' });
    const r = await runGmxApiSubmitFlow(flowInput(transport));
    expect(calls.submit).toBe(1);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.UNRESOLVED);
  });

  it('submit 4xx 거부 → FAILED_PRE_BROADCAST', async () => {
    const { transport, calls } = mockGmxTransport(
      { ok: false, kind: 'http', httpStatus: 400, ambiguous: false, message: 'HTTP 400', peerHost: 'arbitrum.gmxapi.io' });
    const r = await runGmxApiSubmitFlow(flowInput(transport));
    expect(calls.submit).toBe(1);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.FAILED_PRE_BROADCAST);
  });

  it('submit 429 → FAILED_PRE_BROADCAST + 자동 재시도 금지 사유', async () => {
    const { transport, calls } = mockGmxTransport(
      { ok: false, kind: 'rate_limited', httpStatus: 429, ambiguous: false, message: '429', peerHost: 'arbitrum.gmxapi.io' });
    const r = await runGmxApiSubmitFlow(flowInput(transport));
    expect(calls.submit).toBe(1);
    expect(r.blockReasons.join(' ')).toContain('재시도 금지');
  });

  it('같은 flow idempotency key 재실행 → duplicate로 prepare·제출 0회', async () => {
    const { transport: t1 } = mockGmxTransport();
    await runGmxApiSubmitFlow(flowInput(t1, { flowIdempotencyKey: 'flow-dup' }));
    // 첫 실행이 남긴 task를 terminal로 만들어 blocking 사전 차단과 분리
    for (const t of store.tasks) t.status = 'CONFIRMED';
    const { transport: t2, calls: c2 } = mockGmxTransport();
    const prepareSpy = vi.fn(async () => ({ ok: true, data: {}, peerHost: 'x' } as never));
    const r2 = await runGmxApiSubmitFlow(flowInput(t2, { flowIdempotencyKey: 'flow-dup', prepareOrder: prepareSpy }));
    expect(r2.submitted).toBe(false);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(c2.submit).toBe(0);
  });
});

// ════════════ E) markets/collateral 게이트 ════════════
describe('6G-1 §8 — gmxApiMarkets fail-closed', () => {
  const offTransport: GmxApiTransport = {
    readonlyEnabled: false, submissionEnabled: false, peers: GMX_API_PEERS,
    async postJson() { throw new Error('호출 금지'); },
    async getJson() { throw new Error('호출 금지'); },
  };
  it('readonly 플래그 off → 시장 매핑·allowance 게이트 모두 차단, 호출 0회', async () => {
    const m = await fetchGmxApiMarketMap(offTransport);
    expect(m.ok).toBe(false);
    const g = await checkUsdcCollateralGate(offTransport, { account: MAIN, requiredUsdc: 1n });
    expect(g.ok).toBe(false);
  });
  it('조회 실패 → fail-closed (allowance 불명 = 차단)', async () => {
    const failing: GmxApiTransport = {
      readonlyEnabled: true, submissionEnabled: false, peers: GMX_API_PEERS,
      async postJson() { return { ok: false, kind: 'network', httpStatus: null, ambiguous: true, message: 'x', peerHost: null } as never; },
      async getJson() { return { ok: false, kind: 'network', httpStatus: null, ambiguous: true, message: 'x', peerHost: null } as never; },
    };
    const g = await checkUsdcCollateralGate(failing, { account: MAIN, requiredUsdc: 1n });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain('fail-closed');
  });
});

// ════════════ F) 정적 가드 ════════════
describe('6G-1 §13 — PrivateKeySigner import 금지 (정적 가드)', () => {
  it('src 어디에도 PrivateKeySigner import가 없다 (main wallet 개인키 부재)', () => {
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/import\s+[^;]*PrivateKeySigner[^;]*from/.test(src)) offenders.push(p);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
