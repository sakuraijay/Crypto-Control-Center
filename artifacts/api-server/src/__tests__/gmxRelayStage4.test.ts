/**
 * GMX delegated trading 4단계 테스트 — 실제 Gelato adapter (비활성 상태).
 * DB-free (@workspace/db 전체 mock). 실제 RPC·Gelato·네트워크 호출 0회 —
 * transport는 전부 호출 카운터가 달린 mock.
 *
 * 커버리지 (지시서 §10):
 *  - relayNonce: 단조 증가·동시 충돌 재시도·재시작 시 max 기반·조회 실패 fail-closed
 *  - relayActivationGate: 조건 각각 누락 시 networkEligible=false
 *  - relaySubmission: 게이트 미충족/quote 불량/durable 실패/SUBMITTING 실패 시
 *    transport 0회; 성공 경로 정확히 1회; taskId 저장 실패→UNRESOLVED;
 *    ambiguous 실패→UNRESOLVED+재시도 0회; 거부→FAILED_PRE_BROADCAST
 *  - decideApprovalAttachment: 첫/후속 action 규칙 (빈 signature 공식 허용)
 *  - relayTaskReconciler: Gelato 성공≠CONFIRMED, revert=FAILED, 온체인 증거 우선
 *  - relayRevokeAdapter: task accepted만으로 REVOKED 금지
 *  - relayLifecycle: FAILED terminal·역행 금지
 *  - ownerApprovalSession.markConsumedIfNonceAdvanced
 *  - transport: API key 미설정 시 네트워크 요청 없이 config 실패
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── in-memory 3-table store ──────────────────────────────────────────────────

interface FakeRow { [k: string]: unknown }
const store: {
  sessions: FakeRow[]; tasks: FakeRow[]; nonces: FakeRow[];
  failInsert: boolean; failUpdate: boolean; failSelect: boolean;
  failUpdateTimes: number; // 처음 N회 update만 실패 (일시 장애 시뮬레이션)
  nonceInsertFailures: number; // 처음 N회 insert 강제 충돌 (동시 allocation 시뮬레이션)
} = { sessions: [], tasks: [], nonces: [], failInsert: false, failUpdate: false, failSelect: false, failUpdateTimes: 0, nonceInsertFailures: 0 };

function rowsFor(t: { __name: string } | null): FakeRow[] {
  if (t?.__name === 'relay_tasks') return store.tasks;
  if (t?.__name === 'relay_nonces') return store.nonces;
  return store.sessions;
}

vi.mock('@workspace/db', () => {
  const sessionsTable = { __name: 'subaccount_approval_sessions' };
  const tasksTable = { __name: 'relay_tasks' };
  const noncesTable = { __name: 'relay_nonces' };
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
        if (t.__name === 'relay_nonces') {
          if (store.nonceInsertFailures > 0) {
            store.nonceInsertFailures--;
            // 다른 프로세스가 같은 nonce를 선점했다고 가정 — 행도 추가된다
            rows.push({ createdAt: new Date(), ...v, id: `foreign-${Math.random()}` });
            throw new Error('unique violation (main_account, nonce)');
          }
          if (rows.some((r) => r.mainAccount === v.mainAccount && r.nonce === v.nonce)) {
            throw new Error('unique violation (main_account, nonce)');
          }
        }
        rows.push({ createdAt: new Date(), updatedAt: new Date(), ...v });
      },
    }),
    update: (t: { __name: string }) => ({
      set: (patch: FakeRow) => ({
        where: (cond: unknown) => {
          const run = () => {
            if (store.failUpdateTimes > 0) { store.failUpdateTimes--; throw new Error('update fail (transient)'); }
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

import { allocateUserNonce, bindNonceToTask } from '../lib/relayNonce';
import { evaluateActivationGate, type ActivationGateInput } from '../lib/relayActivationGate';
import {
  decideApprovalAttachment, runSubmitFlow, MIN_APPROVAL_EXPIRY_MARGIN_SECONDS,
  type SubmitFlowInput,
} from '../lib/relaySubmission';
import { reconcileVerdict } from '../lib/relayTaskReconciler';
import { decideRevokeCompletion } from '../lib/relayRevokeAdapter';
import {
  RELAY_TASK_STATUS, TERMINAL_STATUSES, isTransitionAllowed, createRelayTask, safeTransition,
  listUnresolvedTasks,
} from '../lib/relayLifecycle';
import { buildLiveFeeQuote, WETH_ARBITRUM, type RelayFeeQuote } from '../lib/relayFeeQuote';
import {
  createGelatoHttpTransport, GELATO_HOST_ALLOWLIST, GELATO_API_KEY_SECRET_NAME,
  type RelayTransport, type SubmitResult, type TaskStatusResult,
} from '../lib/relayTransport';
import { markConsumedIfNonceAdvanced, SESSION_STATUS, APPROVAL_PURPOSE } from '../lib/ownerApprovalSession';

const OWNER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';

beforeEach(() => {
  store.sessions = []; store.tasks = []; store.nonces = [];
  store.failInsert = false; store.failUpdate = false; store.failSelect = false;
  store.failUpdateTimes = 0; store.nonceInsertFailures = 0;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// ── mock transport (호출 카운터) ─────────────────────────────────────────────

function makeMockTransport(overrides?: {
  submit?: SubmitResult;
  status?: TaskStatusResult;
}): { transport: RelayTransport; calls: { quote: number; submit: number; status: number } } {
  const calls = { quote: 0, submit: 0, status: 0 };
  const transport: RelayTransport = {
    async quoteRelayFee() { calls.quote++; return { ok: true, estimatedFeeWei: 10n ** 14n, quotedAtMs: Date.now() }; },
    async submitRelayTask() {
      calls.submit++;
      return overrides?.submit ?? { ok: true, taskId: 'gelato-task-1' };
    },
    async getRelayTaskStatus() {
      calls.status++;
      return overrides?.status ?? { ok: true, taskState: 'CheckPending', transactionHash: null, blockNumber: null };
    },
  };
  return { transport, calls };
}

// ── 활성화 게이트 전부 통과하는 기준 입력 ────────────────────────────────────

function fullEnv(): NodeJS.ProcessEnv {
  return {
    WORKER_ENGINE_MODE: 'LIVE',
    LIVE_TEST_EXECUTION_LOCKED: 'false',
    DELEGATED_SIGNER_ENABLED: 'true',
    GMX_RELAY_SUBMISSION_ENABLED: 'true',
    GMX_RELAY_NETWORK_ENABLED: 'true',
    GMX_RELAY_MODE: 'LIVE',
  } as NodeJS.ProcessEnv;
}

function fullActivation(overrides?: Partial<ActivationGateInput>): ActivationGateInput {
  return {
    env: fullEnv(),
    liveTestMode: true,
    signerInitialized: true,
    canonicalAuthorized: true,
    emergencyStopActive: false,
    dbOk: true,
    rpcOk: true,
    reconciliationComplete: true,
    blockingIntentCount: 0,
    activeRevokeInProgress: false,
    freshLiveFeeQuote: true,
    currentChainId: 42161,
    gmxConfigOk: true,
    kind: 'OPEN',
    ...overrides,
  };
}

function liveQuote(nowMs: number): RelayFeeQuote {
  return buildLiveFeeQuote({ estimatedFeeWei: 10n ** 14n, gasLimit: 3_000_000n, gasPrice: 20_000_000n, quotedAtMs: nowMs });
}

function baseFlowInput(transport: RelayTransport, overrides?: Partial<SubmitFlowInput>): SubmitFlowInput {
  const nowMs = Date.now();
  return {
    transport,
    activation: fullActivation(),
    chainId: 42161,
    relayRouter: '0x2222222222222222222222222222222222222222',
    packedData: '0xdeadbeef',
    payloadHash: `0x${'11'.repeat(32)}`,
    calldataHash: `0x${'22'.repeat(32)}`,
    idempotencyKey: `submit:OPEN:${Math.random()}`,
    kind: 'OPEN',
    intentId: null,
    approvalSessionId: null,
    quote: liveQuote(nowMs),
    nowMs,
    orderNotionalUsd: null,
    ethPriceUsd: null,
    receiverVerified: true,
    userNonce: 7n,
    verifySignatureBinding: async () => ({ ok: true }),
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
describe('relayNonce — durable userNonce allocation', () => {
  it('단조 증가: 0, 1, 2 순서로 할당된다', async () => {
    for (const expected of [0n, 1n, 2n]) {
      const r = await allocateUserNonce({ mainAccount: OWNER, purpose: 'OPEN' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.nonce).toBe(expected);
    }
  });

  it('동시 충돌 시 재시도해서 다음 nonce를 얻는다', async () => {
    store.nonceInsertFailures = 2; // 두 번 선점당함
    const r = await allocateUserNonce({ mainAccount: OWNER, purpose: 'OPEN' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nonce).toBe(2n); // 0,1은 선점됨
  });

  it('충돌이 재시도 한도를 넘으면 fail-closed', async () => {
    store.nonceInsertFailures = 99;
    const r = await allocateUserNonce({ mainAccount: OWNER, purpose: 'OPEN' });
    expect(r.ok).toBe(false);
  });

  it('재시작 시뮬레이션: 기존 행 기반 max+1 (재사용 없음)', async () => {
    store.nonces.push({ id: 'old', mainAccount: OWNER.toLowerCase(), nonce: '41', purpose: 'OPEN' });
    const r = await allocateUserNonce({ mainAccount: OWNER, purpose: 'CLOSE' });
    expect(r.ok && r.nonce === 42n).toBe(true);
  });

  it('조회 실패 시 fail-closed', async () => {
    store.failSelect = true;
    const r = await allocateUserNonce({ mainAccount: OWNER, purpose: 'OPEN' });
    expect(r.ok).toBe(false);
  });

  it('계정별 독립 시퀀스', async () => {
    await allocateUserNonce({ mainAccount: OWNER, purpose: 'OPEN' });
    const other = await allocateUserNonce({ mainAccount: '0xBbBb000000000000000000000000000000000000', purpose: 'OPEN' });
    expect(other.ok && other.nonce === 0n).toBe(true);
  });

  it('bindNonceToTask는 allocation 행에 taskId를 기록한다', async () => {
    const r = await allocateUserNonce({ mainAccount: OWNER, purpose: 'OPEN' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(await bindNonceToTask(r.allocationId, 'task-1')).toBe(true);
      expect(store.nonces.find((n) => n.id === r.allocationId)?.taskId).toBe('task-1');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('relayActivationGate — 조건 하나라도 빠지면 비활성', () => {
  it('전부 충족 시에만 networkEligible=true', () => {
    expect(evaluateActivationGate(fullActivation()).networkEligible).toBe(true);
  });

  const envCases: Array<[string, string]> = [
    ['WORKER_ENGINE_MODE', 'PAPER'],
    ['LIVE_TEST_EXECUTION_LOCKED', 'true'],
    ['DELEGATED_SIGNER_ENABLED', 'false'],
    ['GMX_RELAY_SUBMISSION_ENABLED', 'false'],
    ['GMX_RELAY_NETWORK_ENABLED', 'false'],
    ['GMX_RELAY_MODE', 'DRY_RUN'],
  ];
  for (const [key, badValue] of envCases) {
    it(`env ${key} 미충족 → 차단`, () => {
      const env = fullEnv();
      env[key] = badValue;
      const g = evaluateActivationGate(fullActivation({ env }));
      expect(g.networkEligible).toBe(false);
      expect(g.missing.some((m) => m.includes(key))).toBe(true);
    });
    it(`env ${key} 미설정 → 차단`, () => {
      const env = fullEnv();
      delete env[key];
      expect(evaluateActivationGate(fullActivation({ env })).networkEligible).toBe(false);
    });
  }

  const flagCases: Array<[string, Partial<ActivationGateInput>]> = [
    ['liveTestMode=false', { liveTestMode: false }],
    ['signer 미초기화', { signerInitialized: false }],
    ['canonical 미승인', { canonicalAuthorized: false }],
    ['Emergency Stop', { emergencyStopActive: true }],
    ['DB 비정상', { dbOk: false }],
    ['RPC 비정상', { rpcOk: false }],
    ['reconciliation 미완료', { reconciliationComplete: false }],
    ['blocking intent 존재', { blockingIntentCount: 1 }],
    ['revoke 진행 중(주문)', { activeRevokeInProgress: true }],
    ['live quote 없음', { freshLiveFeeQuote: false }],
    ['chainId 불일치', { currentChainId: 1 }],
    ['chainId 미확인', { currentChainId: null }],
    ['GMX config 미해결', { gmxConfigOk: false }],
  ];
  for (const [label, patch] of flagCases) {
    it(`${label} → 차단`, () => {
      expect(evaluateActivationGate(fullActivation(patch)).networkEligible).toBe(false);
    });
  }

  it('REVOKE 자체는 revoke 진행 중에도 차단되지 않는다 (그 외 조건 충족 시)', () => {
    const g = evaluateActivationGate(fullActivation({ activeRevokeInProgress: true, kind: 'REVOKE' }));
    expect(g.networkEligible).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('decideApprovalAttachment — 첫/후속 action 규칙 (§6)', () => {
  const base = {
    isSubaccountListed: true, canonicalNonce: 3n, remainingActions: 5n,
    expiresAt: 10_000n, nowSec: 1_000n, readySession: null,
  };

  it('승인 반영됨 → 후속 action은 빈 signature 허용', () => {
    const d = decideApprovalAttachment({ ...base });
    expect(d).toEqual({ ok: true, mode: 'SUBSEQUENT_EMPTY_SIGNATURE' });
  });

  it('action count 0 → 차단', () => {
    expect(decideApprovalAttachment({ ...base, remainingActions: 0n }).ok).toBe(false);
  });

  it('expiry 임박 → 차단', () => {
    const d = decideApprovalAttachment({
      ...base, expiresAt: base.nowSec + MIN_APPROVAL_EXPIRY_MARGIN_SECONDS - 1n,
    });
    expect(d.ok).toBe(false);
  });

  it('미반영 + READY 세션 nonce 일치 → 첫 action 승인 첨부', () => {
    const d = decideApprovalAttachment({
      ...base, isSubaccountListed: false,
      readySession: { approvalNonce: 3n, sessionId: 's1' },
    });
    expect(d).toEqual({ ok: true, mode: 'FIRST_ACTION_WITH_APPROVAL', sessionId: 's1' });
  });

  it('미반영 + 세션 없음 → 차단', () => {
    expect(decideApprovalAttachment({ ...base, isSubaccountListed: false }).ok).toBe(false);
  });

  it('미반영 + nonce 불일치 → 차단', () => {
    const d = decideApprovalAttachment({
      ...base, isSubaccountListed: false,
      readySession: { approvalNonce: 2n, sessionId: 's1' },
    });
    expect(d.ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('runSubmitFlow — 원자적 제출 흐름 (§5)', () => {
  it('활성화 게이트 미충족(기본 env) → transport 0회', async () => {
    const { transport, calls } = makeMockTransport();
    const r = await runSubmitFlow(baseFlowInput(transport, {
      activation: fullActivation({ env: {} as NodeJS.ProcessEnv }),
    }));
    expect(r.submitted).toBe(false);
    expect(r.transportCalls).toBe(0);
    expect(calls.submit).toBe(0);
  });

  it('활성화 플래그 각각 누락 → transport 0회', async () => {
    for (const patch of [
      { liveTestMode: false }, { signerInitialized: false }, { canonicalAuthorized: false },
      { emergencyStopActive: true }, { dbOk: false }, { rpcOk: false },
      { reconciliationComplete: false }, { blockingIntentCount: 2 },
      { activeRevokeInProgress: true }, { freshLiveFeeQuote: false },
      { currentChainId: 421614 }, { gmxConfigOk: false },
    ] as Partial<ActivationGateInput>[]) {
      const { transport, calls } = makeMockTransport();
      const r = await runSubmitFlow(baseFlowInput(transport, { activation: fullActivation(patch) }));
      expect(r.submitted).toBe(false);
      expect(calls.submit).toBe(0);
    }
  });

  it('quote 없음 → transport 0회 (fallback 숫자 금지)', async () => {
    const { transport, calls } = makeMockTransport();
    const r = await runSubmitFlow(baseFlowInput(transport, { quote: null }));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(0);
  });

  it('stale quote → transport 0회', async () => {
    const { transport, calls } = makeMockTransport();
    const nowMs = Date.now();
    const q = { ...liveQuote(nowMs - 60_000) };
    const r = await runSubmitFlow(baseFlowInput(transport, { quote: q, nowMs }));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(0);
  });

  it('mock quote → transport 0회 (live quote 필수)', async () => {
    const { transport, calls } = makeMockTransport();
    const nowMs = Date.now();
    const q: RelayFeeQuote = { ...liveQuote(nowMs), source: 'mock' };
    const r = await runSubmitFlow(baseFlowInput(transport, { quote: q, nowMs }));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(0);
  });

  it('과다 fee(절대 상한 초과) → transport 0회', async () => {
    const { transport, calls } = makeMockTransport();
    const nowMs = Date.now();
    const q = buildLiveFeeQuote({ estimatedFeeWei: 10n ** 18n, gasLimit: 1n, gasPrice: 1n, quotedAtMs: nowMs });
    const r = await runSubmitFlow(baseFlowInput(transport, { quote: q, nowMs }));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(0);
  });

  it('잘못된 feeToken → transport 0회', async () => {
    const { transport, calls } = makeMockTransport();
    const nowMs = Date.now();
    const q = { ...liveQuote(nowMs), feeToken: '0x0000000000000000000000000000000000000001' as typeof WETH_ARBITRUM };
    const r = await runSubmitFlow(baseFlowInput(transport, { quote: q, nowMs }));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(0);
  });

  it('receiver 미검증 → transport 0회', async () => {
    const { transport, calls } = makeMockTransport();
    const r = await runSubmitFlow(baseFlowInput(transport, { receiverVerified: false }));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(0);
  });

  it('durable task 저장 실패 → transport 0회', async () => {
    store.failInsert = true;
    const { transport, calls } = makeMockTransport();
    const r = await runSubmitFlow(baseFlowInput(transport));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(0);
    expect(r.blockReasons.join()).toContain('durable task 저장 실패');
  });

  it('서명-payload 결속 검증 실패 → transport 0회 + FAILED_PRE_BROADCAST', async () => {
    const { transport, calls } = makeMockTransport();
    const r = await runSubmitFlow(baseFlowInput(transport, {
      verifySignatureBinding: async () => ({ ok: false, reason: 'digest 불일치' }),
    }));
    expect(calls.submit).toBe(0);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.FAILED_PRE_BROADCAST);
  });

  it('SUBMITTING 전환 실패 → transport 0회', async () => {
    const { transport, calls } = makeMockTransport();
    // 전환만 실패시키기: verifySignatureBinding 시점에 update를 실패로 전환
    const r = await runSubmitFlow(baseFlowInput(transport, {
      verifySignatureBinding: async () => { store.failUpdate = true; return { ok: true }; },
    }));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(0);
    store.failUpdate = false;
  });

  it('성공 경로: transport 정확히 1회 + TASK_ACCEPTED + taskId 저장', async () => {
    const { transport, calls } = makeMockTransport();
    const r = await runSubmitFlow(baseFlowInput(transport));
    expect(r.submitted).toBe(true);
    expect(calls.submit).toBe(1);
    expect(r.transportCalls).toBe(1);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.TASK_ACCEPTED);
    expect(r.gelatoTaskId).toBe('gelato-task-1');
    const row = store.tasks.find((t) => t.id === r.taskRowId);
    expect(row?.relayTaskId).toBe('gelato-task-1');
    expect(row?.status).toBe(RELAY_TASK_STATUS.TASK_ACCEPTED);
  });

  it('TASK_ACCEPTED ≠ CONFIRMED — 성공 제출 후에도 terminal 아님', async () => {
    const { transport } = makeMockTransport();
    const r = await runSubmitFlow(baseFlowInput(transport));
    expect(TERMINAL_STATUSES).not.toContain(r.finalStatus);
  });

  it('taskId 저장 실패(일시) → durable UNRESOLVED로 수렴 + transport 재호출 0회', async () => {
    const { transport, calls } = makeMockTransport();
    // TASK_ACCEPTED 전환 1회만 실패, 이후 복구 — UNRESOLVED 재시도가 성공해야 함
    const failing: RelayTransport = {
      ...transport,
      async submitRelayTask(p) {
        const res = await transport.submitRelayTask(p);
        store.failUpdateTimes = 1;
        return res;
      },
    };
    const r = await runSubmitFlow(baseFlowInput(failing));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(1); // 재시도 없음
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.UNRESOLVED);
    expect(r.blockReasons.join()).toContain('taskId 저장 실패');
    const row = store.tasks.find((t) => t.id === r.taskRowId);
    expect(row?.status).toBe(RELAY_TASK_STATUS.UNRESOLVED);
    expect(row?.relayTaskId).toBe('gelato-task-1'); // 복구 시 taskId도 보존
  });

  it('taskId 저장 영구 실패 → DB는 SUBMITTING 잔존, 조사 대상(listUnresolvedTasks 포함)', async () => {
    const { transport, calls } = makeMockTransport();
    const failing: RelayTransport = {
      ...transport,
      async submitRelayTask(p) {
        const res = await transport.submitRelayTask(p);
        store.failUpdate = true;
        return res;
      },
    };
    const r = await runSubmitFlow(baseFlowInput(failing));
    store.failUpdate = false;
    expect(calls.submit).toBe(1);
    expect(r.blockReasons.join()).toContain('SUBMITTING 잔존');
    const row = store.tasks.find((t) => t.id === r.taskRowId);
    expect(row?.status).toBe(RELAY_TASK_STATUS.SUBMITTING);
    const investigation = await listUnresolvedTasks();
    expect(investigation.some((t) => t.id === r.taskRowId)).toBe(true);
  });

  it('submit timeout(ambiguous) → UNRESOLVED + 재시도 0회', async () => {
    const { transport, calls } = makeMockTransport({
      submit: { ok: false, kind: 'timeout', message: 'timeout', ambiguous: true },
    });
    const r = await runSubmitFlow(baseFlowInput(transport));
    expect(r.submitted).toBe(false);
    expect(calls.submit).toBe(1);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.UNRESOLVED);
  });

  it('submit 4xx 거부(비-ambiguous) → FAILED_PRE_BROADCAST', async () => {
    const { transport, calls } = makeMockTransport({
      submit: { ok: false, kind: 'http', message: 'HTTP 400', ambiguous: false },
    });
    const r = await runSubmitFlow(baseFlowInput(transport));
    expect(calls.submit).toBe(1);
    expect(r.finalStatus).toBe(RELAY_TASK_STATUS.FAILED_PRE_BROADCAST);
  });

  it('같은 idempotencyKey 재실행 → duplicate로 transport 0회', async () => {
    const key = 'submit:OPEN:dup';
    const { transport: t1 } = makeMockTransport();
    await runSubmitFlow(baseFlowInput(t1, { idempotencyKey: key }));
    const { transport: t2, calls: c2 } = makeMockTransport();
    const r2 = await runSubmitFlow(baseFlowInput(t2, { idempotencyKey: key }));
    expect(r2.submitted).toBe(false);
    expect(c2.submit).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('relayTaskReconciler — task/온체인 결합 판정 (§7)', () => {
  const noOnchain = { event: null, txHash: null, orderKey: null, blockNumber: null } as const;

  it('Gelato ExecSuccess만으로 CONFIRMED 금지 — TX_SUBMITTED까지', () => {
    const v = reconcileVerdict({
      gelato: { taskState: 'ExecSuccess', transactionHash: '0xtx' }, onchain: noOnchain,
    });
    expect(v.to).toBe(RELAY_TASK_STATUS.TX_SUBMITTED);
  });

  it('온체인 OrderExecuted → CONFIRMED', () => {
    const v = reconcileVerdict({
      gelato: { taskState: 'ExecSuccess', transactionHash: '0xtx' },
      onchain: { event: 'ORDER_EXECUTED', txHash: '0xtx', orderKey: '0xkey', blockNumber: 100 },
    });
    expect(v.to).toBe(RELAY_TASK_STATUS.CONFIRMED);
    expect(v.patch.orderKey).toBe('0xkey');
  });

  it('온체인 OrderCancelled → CANCELLED', () => {
    const v = reconcileVerdict({
      gelato: { taskState: 'ExecSuccess', transactionHash: '0xtx' },
      onchain: { event: 'ORDER_CANCELLED', txHash: '0xtx', orderKey: null, blockNumber: 100 },
    });
    expect(v.to).toBe(RELAY_TASK_STATUS.CANCELLED);
  });

  it('온체인 OrderFrozen → UNRESOLVED', () => {
    const v = reconcileVerdict({
      gelato: { taskState: 'ExecSuccess', transactionHash: '0xtx' },
      onchain: { event: 'ORDER_FROZEN', txHash: '0xtx', orderKey: null, blockNumber: 100 },
    });
    expect(v.to).toBe(RELAY_TASK_STATUS.UNRESOLVED);
  });

  it('Gelato ExecReverted만으로 FAILED 금지 — 온체인 receipt 필요 (UNRESOLVED)', () => {
    for (const txHash of ['0xtx', null]) {
      const v = reconcileVerdict({
        gelato: { taskState: 'ExecReverted', transactionHash: txHash }, onchain: noOnchain,
      });
      expect(v.to).toBe(RELAY_TASK_STATUS.UNRESOLVED);
    }
  });

  it('독립 수집 온체인 receipt revert(TX_REVERTED) → FAILED', () => {
    const v = reconcileVerdict({
      gelato: { taskState: 'ExecReverted', transactionHash: '0xtx' },
      onchain: { event: 'TX_REVERTED', txHash: '0xtx', orderKey: null, blockNumber: 100 },
    });
    expect(v.to).toBe(RELAY_TASK_STATUS.FAILED);
  });

  it('pending 상태들 → 전이 없음', () => {
    for (const s of ['CheckPending', 'ExecPending']) {
      expect(reconcileVerdict({ gelato: { taskState: s, transactionHash: null }, onchain: noOnchain }).to).toBeNull();
    }
  });

  it('timeout/불명 → UNRESOLVED (자동 FAILED 금지)', () => {
    const v = reconcileVerdict({ gelato: { taskState: null, transactionHash: null }, onchain: noOnchain });
    expect(v.to).toBe(RELAY_TASK_STATUS.UNRESOLVED);
    expect(v.to).not.toBe(RELAY_TASK_STATUS.FAILED);
  });

  it('Gelato Cancelled → UNRESOLVED (broadcast 여부 재확인 필요)', () => {
    const v = reconcileVerdict({ gelato: { taskState: 'Cancelled', transactionHash: null }, onchain: noOnchain });
    expect(v.to).toBe(RELAY_TASK_STATUS.UNRESOLVED);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('relayRevokeAdapter — REVOKED는 canonical 증거로만 (§8)', () => {
  it('task accepted + canonical 미반영 → REVOKED 금지 (PENDING)', () => {
    const v = decideRevokeCompletion({ taskAccepted: true, canonicalRemoved: false });
    expect(v.verdict).toBe('PENDING');
  });
  it('canonical 제거 확인 → REVOKED', () => {
    expect(decideRevokeCompletion({ taskAccepted: true, canonicalRemoved: true }).verdict).toBe('REVOKED');
  });
  it('canonical 불명 → UNRESOLVED (자동 종결 금지)', () => {
    expect(decideRevokeCompletion({ taskAccepted: true, canonicalRemoved: null }).verdict).toBe('UNRESOLVED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('relayLifecycle — FAILED terminal (4단계 확장)', () => {
  it('FAILED는 terminal이며 역행 금지', () => {
    expect(TERMINAL_STATUSES).toContain(RELAY_TASK_STATUS.FAILED);
    for (const to of Object.values(RELAY_TASK_STATUS)) {
      expect(isTransitionAllowed(RELAY_TASK_STATUS.FAILED, to)).toBe(false);
    }
  });

  it('SUBMITTING → FAILED 직접 전이 금지 (broadcast 전 실패는 FAILED_PRE_BROADCAST)', () => {
    expect(isTransitionAllowed(RELAY_TASK_STATUS.SUBMITTING, RELAY_TASK_STATUS.FAILED)).toBe(false);
  });

  it('TX_SUBMITTED → FAILED 허용 (revert 증거)', () => {
    expect(isTransitionAllowed(RELAY_TASK_STATUS.TX_SUBMITTED, RELAY_TASK_STATUS.FAILED)).toBe(true);
  });

  it('terminal 이후 safeTransition은 거부된다', async () => {
    const created = await createRelayTask({ idempotencyKey: 'k1', kind: 'OPEN', payloadHash: '0x1' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = store.tasks.find((t) => t.id === created.taskId)!;
    row.status = RELAY_TASK_STATUS.FAILED;
    const r = await safeTransition({ taskId: created.taskId, to: RELAY_TASK_STATUS.CONFIRMED });
    expect(r.ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('markConsumedIfNonceAdvanced — canonical nonce 증거 기반 CONSUMED', () => {
  function readySession(nonce: string): FakeRow {
    return {
      id: `s-${nonce}`, purpose: APPROVAL_PURPOSE, status: SESSION_STATUS.OWNER_SIGNATURE_READY,
      approvalNonce: nonce, mainAccount: OWNER.toLowerCase(),
    };
  }

  it('canonical nonce가 세션 nonce보다 크면 CONSUMED', async () => {
    store.sessions.push(readySession('3'));
    const r = await markConsumedIfNonceAdvanced({ canonicalNonce: 4n });
    expect(r.consumed).toBe(true);
    expect(store.sessions[0].status).toBe(SESSION_STATUS.CONSUMED);
  });

  it('같거나 작으면 유지 — relay accepted만으로 CONSUMED 금지', async () => {
    store.sessions.push(readySession('3'));
    const r = await markConsumedIfNonceAdvanced({ canonicalNonce: 3n });
    expect(r.consumed).toBe(false);
    expect(store.sessions[0].status).toBe(SESSION_STATUS.OWNER_SIGNATURE_READY);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('relayTransport — 네트워크 안전 규칙 (실호출 0회)', () => {
  it('host allowlist는 api.gelato.digital만', () => {
    expect(GELATO_HOST_ALLOWLIST).toEqual(['api.gelato.digital']);
  });

  it('GMX_RELAY_NETWORK_ENABLED 미설정 → 세 메서드 모두 네트워크 요청 0회 (중앙 게이트)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // API key가 있어도 네트워크 게이트가 먼저 차단해야 한다
    const transport = createGelatoHttpTransport({ [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real' } as unknown as NodeJS.ProcessEnv);
    const q = await transport.quoteRelayFee({ chainId: 42161, paymentToken: '0x1', gasLimit: 1n });
    const s = await transport.submitRelayTask({ chainId: 42161, target: '0x1', packedData: '0x' });
    const t = await transport.getRelayTaskStatus({ taskId: 'x' });
    for (const r of [q, s, t]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('config');
    }
    if (!s.ok) expect(s.ambiguous).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('네트워크 게이트 통과해도 API key 미설정 시 submit은 요청 없이 config 실패 (비-ambiguous)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const transport = createGelatoHttpTransport({ GMX_RELAY_NETWORK_ENABLED: 'true' } as NodeJS.ProcessEnv);
    const r = await transport.submitRelayTask({ chainId: 42161, target: '0x1', packedData: '0x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('config');
      expect(r.ambiguous).toBe(false);
      expect(r.message).toContain(GELATO_API_KEY_SECRET_NAME);
      // 메시지에 key 값 노출 없음 (미설정이므로 이름만)
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('오류 메시지에 긴 토큰형 문자열이 노출되지 않는다 (sanitize)', async () => {
    // 실제 키 패턴(sk_live_ 등)은 GitHub push protection이 차단하므로 사용 금지 —
    // sanitize 규칙(20자 이상 토큰형 문자열)만 검증하면 된다
    const secretish = 'FAKETOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`boom ${secretish}`));
    const transport = createGelatoHttpTransport({
      GMX_RELAY_NETWORK_ENABLED: 'true', [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
    } as unknown as NodeJS.ProcessEnv);
    const r = await transport.submitRelayTask({ chainId: 42161, target: '0x1', packedData: '0x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toContain(secretish);
      expect(r.message).not.toContain('test-key-not-real');
    }
    fetchSpy.mockRestore();
  });
});
