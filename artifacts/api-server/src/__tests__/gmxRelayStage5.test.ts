/**
 * GMX delegated trading 5단계 테스트 — 활성화 전 통합 완성 (전면 비활성 유지).
 * DB-free (@workspace/db 전체 mock). 실제 RPC·Gelato·signer 저장소 호출 0회 —
 * 전부 주입식 mock/fixture. 개인키는 공개 테스트 fixture 키만 사용.
 *
 * 커버리지 (지시서 §10):
 *  - relaySignerBinding: disabled/미초기화/주소 불일치/main==signer/digest 변조 시
 *    키 접근 0회; fixture 키 happy path에서 서명·복원 일치
 *  - PAPER(게이트 미충족)에서 signer binding 콜백 자체가 0회 호출
 *  - relayDigestReadback: bool 해석·형식 오류·RPC 예외 fail-closed
 *  - runSubmitFlow + checkDigestUnused: 조회 실패→PREPARED 유지·transport 0회;
 *    used→UNRESOLVED·자동 재제출 0회; 재실행 시 idempotency 차단
 *  - relayReceiptCollector: revert만 TX_REVERTED, OrderExecuted만 CONFIRMED 근거,
 *    복수 orderKey 판정 금지, 비허용 emitter 무시, chainId 불일치·RPC 오류 fail-closed
 *  - relayActivationStatus: startup reconciliation 미수행/실패/stale → false,
 *    전부 성공 시 true; freshLiveQuote는 mock 불인정·결속 불일치 거부
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── in-memory store (stage4와 동일 패턴 + execution_intents) ─────────────────

interface FakeRow { [k: string]: unknown }
const store: {
  sessions: FakeRow[]; tasks: FakeRow[]; nonces: FakeRow[]; intents: FakeRow[];
  failInsert: boolean; failUpdate: boolean; failSelect: boolean;
} = { sessions: [], tasks: [], nonces: [], intents: [], failInsert: false, failUpdate: false, failSelect: false };

function rowsFor(t: { __name: string } | null): FakeRow[] {
  if (t?.__name === 'relay_tasks') return store.tasks;
  if (t?.__name === 'relay_nonces') return store.nonces;
  if (t?.__name === 'execution_intents') return store.intents;
  return store.sessions;
}

vi.mock('@workspace/db', () => {
  const sessionsTable = { __name: 'subaccount_approval_sessions' };
  const tasksTable = { __name: 'relay_tasks' };
  const noncesTable = { __name: 'relay_nonces' };
  const intentsTable = { __name: 'execution_intents' };
  const db = {
    select: (_cols?: unknown) => ({
      from: (t: { __name: string }) => {
        const all = () => {
          if (store.failSelect) throw new Error('select fail');
          return rowsFor(t);
        };
        const whereResult = (cond: unknown) => {
          const p = Promise.resolve().then(() => filterRows(all(), cond));
          return Object.assign(p, {
            limit: async (n: number) => filterRows(all(), cond).slice(0, n),
            orderBy: () => ({ limit: async (n: number) => filterRows(all(), cond).slice(0, n) }),
          });
        };
        return {
          where: whereResult,
          orderBy: () => ({ limit: async (n: number) => all().slice(0, n) }),
        };
      },
    }),
    insert: (t: { __name: string }) => ({
      values: async (v: FakeRow) => {
        if (store.failInsert) throw new Error('insert fail');
        const rows = rowsFor(t);
        if (t.__name === 'relay_tasks' && rows.some((r) => r.idempotencyKey === v.idempotencyKey)) {
          throw new Error('unique violation');
        }
        rows.push({ createdAt: new Date(), updatedAt: new Date(), ...v });
      },
    }),
    update: (t: { __name: string }) => ({
      set: (patch: FakeRow) => ({
        where: (cond: unknown) => {
          const run = () => {
            if (store.failUpdate) throw new Error('update fail');
            const matched = filterRows(rowsFor(t), cond);
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
  (db as { transaction?: unknown }).transaction = async (cb: (tx: typeof db) => Promise<void>) => cb(db);
  const proxied = (t: object) => new Proxy(t, {
    get: (obj, prop) => (prop in obj ? (obj as never)[prop] : { __col: prop }),
  });
  return {
    db,
    subaccountApprovalSessionsTable: proxied(sessionsTable),
    relayTasksTable: proxied(tasksTable),
    relayNoncesTable: proxied(noncesTable),
    executionIntentsTable: proxied(intentsTable),
    workerStateTable: proxied({ __name: 'worker_state' }),
  };
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

// ── 대상 모듈 (mock 이후 import) ─────────────────────────────────────────────

import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { createSignerBindingVerifier, type SignerBindingDeps } from '../lib/relaySignerBinding';
import { checkDigestUnused, DIGESTS_GETTER_SELECTOR, type DigestReadClient } from '../lib/relayDigestReadback';
import { collectOnchainEvidence } from '../lib/relayReceiptCollector';
import type { OnchainClient, ReceiptResult } from '../lib/intentReconciler';
import {
  runSubmitFlow, type SubmitFlowInput,
} from '../lib/relaySubmission';
import type { ActivationGateInput } from '../lib/relayActivationGate';
import { buildLiveFeeQuote, getMockFeeQuote, type RelayFeeQuote } from '../lib/relayFeeQuote';
import type { RelayTransport } from '../lib/relayTransport';
import {
  runStartupRelayReconciliation, computeReconciliationComplete, evaluateFreshLiveQuote,
  getStartupReconciliationState, isReconciliationRunning, __resetActivationStatusForTests,
  RECONCILIATION_FRESHNESS_MS, type StartupReconciliationDeps,
} from '../lib/relayActivationStatus';
import { isRelayNetworkStructurallyDisabled } from '../lib/relayActivationStatus';
import { signDigestWithDelegatedSigner } from '../lib/delegatedSigner';
import { RELAY_TASK_STATUS } from '../lib/relayLifecycle';
import { EVENT_LOG_2_TOPIC0, ORDER_EVENT_NAME_HASH } from '../lib/gmxOrderEvents';

// 공개 테스트 fixture 키 (hardhat 표준 계정 #1) — 실제 자금·권한 없음
const FIXTURE_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const fixtureAccount = privateKeyToAccount(FIXTURE_PRIV);
const OWNER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const DIGEST = (`0x${'ab'.repeat(32)}`) as Hex;
const EMITTER = '0xC8ee91A54287DB53897056e12D9819156D3822Fb';

beforeEach(() => {
  store.sessions = []; store.tasks = []; store.nonces = []; store.intents = [];
  store.failInsert = false; store.failUpdate = false; store.failSelect = false;
  __resetActivationStatusForTests();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// ── signer binding deps fixture (접근 카운터) ────────────────────────────────

function makeSignerDeps(overrides?: Partial<SignerBindingDeps>): {
  deps: SignerBindingDeps; keyAccess: { integrity: number; sign: number };
} {
  const keyAccess = { integrity: 0, sign: 0 };
  const deps: SignerBindingDeps = {
    isEnabled: () => true,
    isInitialized: () => true,
    getStoredAddress: () => fixtureAccount.address,
    verifyIntegrity: () => { keyAccess.integrity++; return true; },
    signDigest: async (d) => { keyAccess.sign++; return fixtureAccount.sign({ hash: d }); },
    ...overrides,
  };
  return { deps, keyAccess };
}

describe('relaySignerBinding — delegated signer DI 결속 (5단계 §3)', () => {
  it('disabled면 키 접근 0회로 실패한다', async () => {
    const { deps, keyAccess } = makeSignerDeps({ isEnabled: () => false });
    const verify = createSignerBindingVerifier({ deps, mainAccount: OWNER, expectedDigest: DIGEST, recomputeDigest: () => DIGEST });
    const r = await verify();
    expect(r.ok).toBe(false);
    expect(keyAccess.integrity + keyAccess.sign).toBe(0);
  });

  it('미초기화면 키 접근 0회로 실패한다', async () => {
    const { deps, keyAccess } = makeSignerDeps({ isInitialized: () => false });
    const r = await createSignerBindingVerifier({ deps, mainAccount: OWNER, expectedDigest: DIGEST, recomputeDigest: () => DIGEST })();
    expect(r.ok).toBe(false);
    expect(keyAccess.integrity + keyAccess.sign).toBe(0);
  });

  it('main account == signer면 키 접근 전에 차단한다', async () => {
    const { deps, keyAccess } = makeSignerDeps();
    const r = await createSignerBindingVerifier({
      deps, mainAccount: fixtureAccount.address, expectedDigest: DIGEST, recomputeDigest: () => DIGEST,
    })();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('동일');
    expect(keyAccess.integrity + keyAccess.sign).toBe(0);
  });

  it('digest 재계산 불일치(payload 변조)면 키 접근 전에 차단한다', async () => {
    const { deps, keyAccess } = makeSignerDeps();
    const r = await createSignerBindingVerifier({
      deps, mainAccount: OWNER, expectedDigest: DIGEST, recomputeDigest: () => (`0x${'cd'.repeat(32)}`) as Hex,
    })();
    expect(r.ok).toBe(false);
    expect(keyAccess.integrity + keyAccess.sign).toBe(0);
  });

  it('주소 재계산 불일치(무결성 실패)면 서명 0회로 차단한다', async () => {
    const { deps, keyAccess } = makeSignerDeps({ verifyIntegrity: () => { keyAccess.integrity++; return false; } });
    const r = await createSignerBindingVerifier({ deps, mainAccount: OWNER, expectedDigest: DIGEST, recomputeDigest: () => DIGEST })();
    expect(r.ok).toBe(false);
    expect(keyAccess.sign).toBe(0);
  });

  it('fixture 키 happy path: 서명·recoverAddress 재검증 통과, 서명 sink 전달', async () => {
    const { deps, keyAccess } = makeSignerDeps();
    let sig: string | null = null;
    const r = await createSignerBindingVerifier(
      { deps, mainAccount: OWNER, expectedDigest: DIGEST, recomputeDigest: () => DIGEST },
      (s) => { sig = s; },
    )();
    expect(r.ok).toBe(true);
    expect(keyAccess.integrity).toBe(1);
    expect(keyAccess.sign).toBe(1);
    expect(sig).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('다른 키로 서명되면(복원 주소 불일치) 차단한다', async () => {
    const otherKey = privateKeyToAccount(('0x' + '11'.repeat(32)) as Hex);
    const { deps } = makeSignerDeps({ signDigest: async (d) => otherKey.sign({ hash: d }) });
    const r = await createSignerBindingVerifier({ deps, mainAccount: OWNER, expectedDigest: DIGEST, recomputeDigest: () => DIGEST })();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('복원');
  });
});

// ── runSubmitFlow — 게이트 미충족 시 signer/저장소 접근 0회 ──────────────────

function fullActivation(overrides?: Partial<ActivationGateInput>): ActivationGateInput {
  return {
    env: {
      WORKER_ENGINE_MODE: 'LIVE', LIVE_TEST_EXECUTION_LOCKED: 'false',
      DELEGATED_SIGNER_ENABLED: 'true', GMX_RELAY_SUBMISSION_ENABLED: 'true',
      GMX_RELAY_NETWORK_ENABLED: 'true', GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
      GMX_RELAY_MODE: 'LIVE',
    } as NodeJS.ProcessEnv,
    liveTestMode: true, signerInitialized: true, canonicalAuthorized: true,
    emergencyStopActive: false, dbOk: true, rpcOk: true, reconciliationComplete: true,
    blockingIntentCount: 0, activeRevokeInProgress: false, freshLiveFeeQuote: true,
    currentChainId: 42161, gmxConfigOk: true, kind: 'OPEN',
    ...overrides,
  };
}

function liveQuote(nowMs: number): RelayFeeQuote {
  return buildLiveFeeQuote({ estimatedFeeWei: 10n ** 14n, gasLimit: 3_000_000n, gasPrice: 20_000_000n, quotedAtMs: nowMs });
}

function makeTransport(): { transport: RelayTransport; calls: { submit: number } } {
  const calls = { submit: 0 };
  const transport: RelayTransport = {
    async quoteRelayFee() { return { ok: true, estimatedFeeWei: 10n ** 14n, quotedAtMs: Date.now() }; },
    async submitRelayTask() { calls.submit++; return { ok: true, taskId: 'gelato-task-5' }; },
    async getRelayTaskStatus() { return { ok: true, taskState: 'CheckPending', transactionHash: null, blockNumber: null }; },
  };
  return { transport, calls };
}

function flowInput(transport: RelayTransport, overrides?: Partial<SubmitFlowInput>): SubmitFlowInput {
  const nowMs = Date.now();
  return {
    transport, activation: fullActivation(), chainId: 42161,
    relayRouter: '0x2222222222222222222222222222222222222222',
    packedData: '0xdeadbeef',
    payloadHash: `0x${'11'.repeat(32)}`, calldataHash: `0x${'22'.repeat(32)}`,
    idempotencyKey: `s5:${Math.random()}`, kind: 'OPEN',
    intentId: null, approvalSessionId: null,
    quote: liveQuote(nowMs), nowMs, orderNotionalUsd: null, ethPriceUsd: null,
    receiverVerified: true, userNonce: 1n,
    verifySignatureBinding: async () => ({ ok: true }),
    checkDigestUnused: async () => ({ ok: true, used: false }),
    ...overrides,
  };
}

describe('runSubmitFlow — PAPER/게이트 미충족 시 signer·readback·transport 0회', () => {
  it('PAPER 모드면 signer binding·digest readback·transport 전부 0회', async () => {
    const { transport, calls } = makeTransport();
    let bindingCalls = 0; let readbackCalls = 0;
    const r = await runSubmitFlow(flowInput(transport, {
      activation: fullActivation({ env: { WORKER_ENGINE_MODE: 'PAPER' } as NodeJS.ProcessEnv }),
      verifySignatureBinding: async () => { bindingCalls++; return { ok: true }; },
      checkDigestUnused: async () => { readbackCalls++; return { ok: true, used: false }; },
    }));
    expect(r.submitted).toBe(false);
    expect(bindingCalls).toBe(0);
    expect(readbackCalls).toBe(0);
    expect(calls.submit).toBe(0);
    expect(store.tasks.length).toBe(0); // durable task조차 생성 전 차단
  });

  it('mock quote면 제출 불가 — signer 접근 0회', async () => {
    const { transport, calls } = makeTransport();
    let bindingCalls = 0;
    const r = await runSubmitFlow(flowInput(transport, {
      quote: getMockFeeQuote({ gasLimit: 3_000_000n, gasPrice: 20_000_000n, nowMs: Date.now() }),
      verifySignatureBinding: async () => { bindingCalls++; return { ok: true }; },
    }));
    expect(r.submitted).toBe(false);
    expect(bindingCalls).toBe(0);
    expect(calls.submit).toBe(0);
  });
});

describe('runSubmitFlow — 제출 직전 digest readback (5단계 §2)', () => {
  it('readback 조회 실패 → PREPARED 유지, transport 0회 (fail-closed)', async () => {
    const { transport, calls } = makeTransport();
    const r = await runSubmitFlow(flowInput(transport, {
      checkDigestUnused: async () => ({ ok: false, reason: 'RPC 오류' }),
    }));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(0);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.PREPARED);
    expect(r.blockReasons.join(' ')).toContain('digest readback 실패');
  });

  it('digest 이미 사용 → UNRESOLVED 전환·조사, transport 0회·새 nonce 재제출 없음', async () => {
    const { transport, calls } = makeTransport();
    const key = 's5:digest-used';
    const r = await runSubmitFlow(flowInput(transport, {
      idempotencyKey: key,
      checkDigestUnused: async () => ({ ok: true, used: true }),
    }));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(0);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.UNRESOLVED);
    expect(store.tasks[0]?.errorClass).toBe('DIGEST_ALREADY_USED');
    // 재실행(재시작 후 자동 재제출 시뮬레이션): 동일 idempotencyKey → duplicate 차단
    const r2 = await runSubmitFlow(flowInput(transport, { idempotencyKey: key }));
    expect(r2.submitted).toBe(false);
    expect(calls.submit).toBe(0);
    expect(store.tasks.length).toBe(1); // 새 task·새 nonce 없음
  });
});

describe('relayDigestReadback — digests(bytes32) readback', () => {
  const ROUTER = '0x3333333333333333333333333333333333333333';
  const mkClient = (ret: string | Error): DigestReadClient => ({
    call: async () => { if (ret instanceof Error) throw ret; return ret; },
  });

  it('selector는 ABI에서 계산된다', () => {
    expect(DIGESTS_GETTER_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it('0 → 미사용, 1 → 사용됨', async () => {
    const zero = `0x${'0'.repeat(64)}`;
    const one = `0x${'0'.repeat(63)}1`;
    expect(await checkDigestUnused({ client: mkClient(zero), relayRouter: ROUTER, digest: DIGEST })).toEqual({ ok: true, used: false });
    expect(await checkDigestUnused({ client: mkClient(one), relayRouter: ROUTER, digest: DIGEST })).toEqual({ ok: true, used: true });
  });

  it('형식 오류·해석 불가·예외는 전부 fail-closed', async () => {
    const bad1 = await checkDigestUnused({ client: mkClient('0x'), relayRouter: ROUTER, digest: DIGEST });
    expect(bad1.ok).toBe(false);
    const bad2 = await checkDigestUnused({ client: mkClient(`0x${'0'.repeat(63)}2`), relayRouter: ROUTER, digest: DIGEST });
    expect(bad2.ok).toBe(false);
    const bad3 = await checkDigestUnused({ client: mkClient(new Error('https://secret-rpc.example/key123 timeout')), relayRouter: ROUTER, digest: DIGEST });
    expect(bad3.ok).toBe(false);
    if (!bad3.ok) expect(bad3.reason).not.toContain('secret-rpc'); // RPC URL sanitize
    const bad4 = await checkDigestUnused({ client: mkClient(`0x${'0'.repeat(64)}`), relayRouter: ROUTER, digest: '0x123' });
    expect(bad4.ok).toBe(false);
  });
});

// ── relayReceiptCollector ────────────────────────────────────────────────────

const TX = `0x${'aa'.repeat(32)}`;
const ORDER_KEY = `0x${'bb'.repeat(32)}`;

function orderLog(name: keyof typeof ORDER_EVENT_NAME_HASH, key = ORDER_KEY, emitter = EMITTER) {
  return {
    address: emitter,
    topics: [EVENT_LOG_2_TOPIC0, ORDER_EVENT_NAME_HASH[name], key],
    transactionHash: TX,
    blockNumber: 100n,
  };
}

function mkOnchainClient(overrides?: {
  chainId?: number;
  receipt?: ReceiptResult | null | Error;
  extraLogs?: ReturnType<typeof orderLog>[] | Error;
}): OnchainClient {
  return {
    async getChainId() { return overrides?.chainId ?? 42161; },
    async getTransactionReceipt() {
      const r = overrides?.receipt;
      if (r instanceof Error) throw r;
      return r === undefined ? { status: 'success', blockNumber: '100', logs: [] } : r;
    },
    async getOrderResolutionLogs() {
      const e = overrides?.extraLogs;
      if (e instanceof Error) throw e;
      return e ?? [];
    },
  };
}

describe('relayReceiptCollector — 온체인 증거 수집 (5단계 §5)', () => {
  it('receipt reverted(독립 수집)만 TX_REVERTED 증거가 된다', async () => {
    const r = await collectOnchainEvidence({
      client: mkOnchainClient({ receipt: { status: 'reverted', blockNumber: '99', logs: [] } }),
      txHash: TX, emitterAllowlist: [EMITTER],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.evidence.event).toBe('TX_REVERTED');
  });

  it('OrderExecuted → ORDER_EXECUTED (CONFIRMED 유일 근거)', async () => {
    const r = await collectOnchainEvidence({
      client: mkOnchainClient({ receipt: { status: 'success', blockNumber: '100', logs: [orderLog('OrderCreated'), orderLog('OrderExecuted')] } }),
      txHash: TX, emitterAllowlist: [EMITTER],
    });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.evidence.event).toBe('ORDER_EXECUTED'); expect(r.evidence.orderKey).toBe(ORDER_KEY.toLowerCase()); }
  });

  it('OrderCancelled → ORDER_CANCELLED, OrderFrozen → ORDER_FROZEN', async () => {
    const c = await collectOnchainEvidence({
      client: mkOnchainClient({ receipt: { status: 'success', blockNumber: '100', logs: [orderLog('OrderCreated'), orderLog('OrderCancelled')] } }),
      txHash: TX, emitterAllowlist: [EMITTER],
    });
    if (c.ok) expect(c.evidence.event).toBe('ORDER_CANCELLED'); else expect.fail('ok 기대');
    const f = await collectOnchainEvidence({
      client: mkOnchainClient({ receipt: { status: 'success', blockNumber: '100', logs: [orderLog('OrderCreated'), orderLog('OrderFrozen')] } }),
      txHash: TX, emitterAllowlist: [EMITTER],
    });
    if (f.ok) expect(f.evidence.event).toBe('ORDER_FROZEN'); else expect.fail('ok 기대');
  });

  it('OrderCreated만 있으면 ORDER_CREATED (종결 판정 아님)', async () => {
    const r = await collectOnchainEvidence({
      client: mkOnchainClient({ receipt: { status: 'success', blockNumber: '100', logs: [orderLog('OrderCreated')] } }),
      txHash: TX, emitterAllowlist: [EMITTER],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.evidence.event).toBe('ORDER_CREATED');
  });

  it('복수 orderKey 검출 시 판정 금지 (ok:false)', async () => {
    const key2 = `0x${'cc'.repeat(32)}`;
    const r = await collectOnchainEvidence({
      client: mkOnchainClient({ receipt: { status: 'success', blockNumber: '100', logs: [orderLog('OrderCreated'), orderLog('OrderCreated', key2)] } }),
      txHash: TX, emitterAllowlist: [EMITTER],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('복수 orderKey');
  });

  it('허용집합 밖 emitter의 로그는 무시된다', async () => {
    const r = await collectOnchainEvidence({
      client: mkOnchainClient({ receipt: { status: 'success', blockNumber: '100', logs: [orderLog('OrderCreated', ORDER_KEY, '0x9999999999999999999999999999999999999999')] } }),
      txHash: TX, emitterAllowlist: [EMITTER],
    });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.evidence.event).toBe(null); expect(r.evidence.orderKey).toBe(null); }
  });

  it('chainId 불일치·receipt 미확인·RPC 예외·빈 허용집합은 판정 없음 (throw 금지)', async () => {
    const wrongChain = await collectOnchainEvidence({ client: mkOnchainClient({ chainId: 1 }), txHash: TX, emitterAllowlist: [EMITTER] });
    expect(wrongChain.ok).toBe(false);
    const noReceipt = await collectOnchainEvidence({ client: mkOnchainClient({ receipt: null }), txHash: TX, emitterAllowlist: [EMITTER] });
    expect(noReceipt.ok).toBe(false);
    const rpcErr = await collectOnchainEvidence({
      client: mkOnchainClient({ receipt: new Error('https://rpc.example/apikey down') }), txHash: TX, emitterAllowlist: [EMITTER],
    });
    expect(rpcErr.ok).toBe(false);
    if (!rpcErr.ok) expect(rpcErr.reason).not.toContain('rpc.example');
    const noEmitters = await collectOnchainEvidence({ client: mkOnchainClient(), txHash: TX, emitterAllowlist: [] });
    expect(noEmitters.ok).toBe(false);
  });

  it('후속 로그 조회 실패 시 receipt 로그만으로 판정 유지 (Worker 불중단)', async () => {
    const r = await collectOnchainEvidence({
      client: mkOnchainClient({
        receipt: { status: 'success', blockNumber: '100', logs: [orderLog('OrderCreated')] },
        extraLogs: new Error('logs unavailable'),
      }),
      txHash: TX, emitterAllowlist: [EMITTER],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.evidence.event).toBe('ORDER_CREATED');
  });
});

// ── relayActivationStatus ────────────────────────────────────────────────────

function startupDeps(overrides?: Partial<StartupReconciliationDeps>): StartupReconciliationDeps {
  return {
    migrationsComplete: () => true,
    countBlockingIntents: async () => 0,
    countOpenRelayTasks: async () => 0,
    countUnboundNonces: async () => 0,
    hasActiveRevoke: async () => false,
    canonicalReadback: async () => ({ performed: true, ok: true }),
    nowMs: () => Date.now(),
    ...overrides,
  };
}

describe('relayActivationStatus — reconciliationComplete 파생 (5단계 §4·§8)', () => {
  const liveDeps = (nowMs = Date.now()) => ({
    countBlockingIntents: async () => 0,
    countOpenRelayTasks: async () => 0,
    hasActiveRevoke: async () => false as boolean | null,
    getStartupState: getStartupReconciliationState,
    isRunning: isReconciliationRunning,
    nowMs: () => nowMs,
  });

  it('startup reconciliation 미수행이면 false', async () => {
    const r = await computeReconciliationComplete(liveDeps());
    expect(r.complete).toBe(false);
    expect(r.reasons.join(' ')).toContain('미수행');
  });

  it('startup 전 단계 성공 + 현재 DB 무결이면 true', async () => {
    await runStartupRelayReconciliation(startupDeps());
    const r = await computeReconciliationComplete(liveDeps());
    expect(r.complete).toBe(true);
  });

  it('freshness 초과(stale)면 false', async () => {
    const past = Date.now() - RECONCILIATION_FRESHNESS_MS - 1000;
    await runStartupRelayReconciliation(startupDeps({ nowMs: () => past }));
    const r = await computeReconciliationComplete(liveDeps());
    expect(r.complete).toBe(false);
    expect(r.reasons.join(' ')).toContain('stale');
  });

  it('startup 단계 실패(조회 실패·잔존 항목·canonical 미수행)는 전부 false', async () => {
    for (const bad of [
      startupDeps({ countBlockingIntents: async () => null }),
      startupDeps({ countOpenRelayTasks: async () => 2 }),
      startupDeps({ countUnboundNonces: async () => 1 }),
      startupDeps({ hasActiveRevoke: async () => null }),
      startupDeps({ canonicalReadback: async () => ({ performed: false, ok: false, reason: '네트워크 비활성' }) }),
    ]) {
      __resetActivationStatusForTests();
      const s = await runStartupRelayReconciliation(bad);
      expect(s.complete).toBe(false);
      const r = await computeReconciliationComplete(liveDeps());
      expect(r.complete).toBe(false);
    }
  });

  it('현재 DB에 blocking intent/미종결 task/revoke가 생기면 다시 false', async () => {
    await runStartupRelayReconciliation(startupDeps());
    const base = liveDeps();
    expect((await computeReconciliationComplete({ ...base, countBlockingIntents: async () => 1 })).complete).toBe(false);
    expect((await computeReconciliationComplete({ ...base, countOpenRelayTasks: async () => null })).complete).toBe(false);
    expect((await computeReconciliationComplete({ ...base, hasActiveRevoke: async () => true })).complete).toBe(false);
  });

  it('deps가 throw해도 runStartupRelayReconciliation은 throw하지 않는다 (Worker 불중단)', async () => {
    const s = await runStartupRelayReconciliation(startupDeps({
      countBlockingIntents: async () => { throw new Error('boom'); },
    }));
    expect(s.complete).toBe(false);
  });
});

describe('구조적 네트워크 게이트 + signer 서명 게이트 (리뷰 반영)', () => {
  it('GMX_RELAY_NETWORK_ENABLED !== true면 구조적 비활성 — canonical RPC·signer 저장소 접근 금지 신호', () => {
    expect(isRelayNetworkStructurallyDisabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isRelayNetworkStructurallyDisabled({ GMX_RELAY_NETWORK_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isRelayNetworkStructurallyDisabled({ GMX_RELAY_NETWORK_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isRelayNetworkStructurallyDisabled({ GMX_RELAY_NETWORK_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('signDigestWithDelegatedSigner: disabled면 서명 거부 (키 접근 없음)', async () => {
    vi.stubEnv('DELEGATED_SIGNER_ENABLED', 'false');
    await expect(signDigestWithDelegatedSigner(DIGEST)).rejects.toThrow(/disabled/);
  });

  function stubSignerStorageEnv() {
    // 6단계 §4 저장소/서명 게이트 통과용 (테스트 fixture 전용)
    vi.stubEnv('DELEGATED_SIGNER_ENABLED', 'true');
    vi.stubEnv('GMX_RELAY_READONLY_NETWORK_ENABLED', 'true');
    vi.stubEnv('GMX_RELAY_NETWORK_ENABLED', 'true');
    vi.stubEnv('GMX_RELAY_SUBMISSION_ENABLED', 'true');
    vi.stubEnv('GMX_RELAY_MODE', 'LIVE');
    vi.stubEnv('WORKER_ENGINE_MODE', 'LIVE');
    vi.stubEnv('LIVE_TEST_EXECUTION_LOCKED', 'false');
  }

  it('signDigestWithDelegatedSigner: enabled여도 read-only만 켠 상태면 서명 거부 (6단계 게이트)', async () => {
    vi.stubEnv('DELEGATED_SIGNER_ENABLED', 'true');
    await expect(signDigestWithDelegatedSigner(DIGEST)).rejects.toThrow(/차단/);
  });

  it('signDigestWithDelegatedSigner: 게이트 통과해도 미초기화면 서명 거부', async () => {
    stubSignerStorageEnv();
    await expect(signDigestWithDelegatedSigner(DIGEST)).rejects.toThrow(/미초기화/);
  });

  it('signDigestWithDelegatedSigner: digest 형식 오류 거부', async () => {
    stubSignerStorageEnv();
    await expect(signDigestWithDelegatedSigner('0x123' as Hex)).rejects.toThrow();
  });
});

describe('relayActivationStatus — freshLiveFeeQuote 파생', () => {
  const PAYLOAD = `0x${'11'.repeat(32)}`;

  it('저장된 quote 없음 → false', () => {
    const r = evaluateFreshLiveQuote({
      quote: null, chainId: 42161, nowMs: Date.now(),
      orderNotionalUsd: null, ethPriceUsd: null,
      quoteBoundPayloadHash: null, targetPayloadHash: null,
    });
    expect(r.fresh).toBe(false);
  });

  it('mock quote는 항상 불인정', () => {
    const nowMs = Date.now();
    const r = evaluateFreshLiveQuote({
      quote: getMockFeeQuote({ gasLimit: 3_000_000n, gasPrice: 20_000_000n, nowMs }),
      chainId: 42161, nowMs, orderNotionalUsd: null, ethPriceUsd: null,
      quoteBoundPayloadHash: PAYLOAD, targetPayloadHash: PAYLOAD,
    });
    expect(r.fresh).toBe(false);
    expect(r.reasons.join(' ')).toContain('mock');
  });

  it('gelato quote + 유효 + payload 결속 일치 → true', () => {
    const nowMs = Date.now();
    const r = evaluateFreshLiveQuote({
      quote: liveQuote(nowMs), chainId: 42161, nowMs,
      orderNotionalUsd: null, ethPriceUsd: null,
      quoteBoundPayloadHash: PAYLOAD, targetPayloadHash: PAYLOAD,
    });
    expect(r.fresh).toBe(true);
  });

  it('quote-payload 결속 불일치·chainId 불일치·stale은 false', () => {
    const nowMs = Date.now();
    const mismatch = evaluateFreshLiveQuote({
      quote: liveQuote(nowMs), chainId: 42161, nowMs,
      orderNotionalUsd: null, ethPriceUsd: null,
      quoteBoundPayloadHash: PAYLOAD, targetPayloadHash: `0x${'22'.repeat(32)}`,
    });
    expect(mismatch.fresh).toBe(false);
    const wrongChain = evaluateFreshLiveQuote({
      quote: liveQuote(nowMs), chainId: 1, nowMs,
      orderNotionalUsd: null, ethPriceUsd: null,
      quoteBoundPayloadHash: PAYLOAD, targetPayloadHash: PAYLOAD,
    });
    expect(wrongChain.fresh).toBe(false);
    const stale = evaluateFreshLiveQuote({
      quote: liveQuote(nowMs - 60_000), chainId: 42161, nowMs,
      orderNotionalUsd: null, ethPriceUsd: null,
      quoteBoundPayloadHash: PAYLOAD, targetPayloadHash: PAYLOAD,
    });
    expect(stale.fresh).toBe(false);
  });
});
