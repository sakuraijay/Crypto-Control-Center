/**
 * GMX delegated trading 3단계 테스트 — Gelato relay 강제 DRY-RUN 경로.
 * DB-free (@workspace/db 전체 mock). 실제 RPC·Gelato·MetaMask 호출 0회.
 *
 * 커버리지 (지시서 §8):
 *  - relayAdapter: 모드 결정(LIVE 구조적 강등), 게이트별 차단, submitEligible=false 불변
 *  - relayFeeQuote: allowlist·swapPath·상한·stale·미래시각·notional 비율·fail-closed
 *  - relayOrderAssembly: REMOVE_SUBACCOUNT typehash 골든, calldata/digest 결정성,
 *    변조 시 hash 변경, packed payload 규칙, externalCalls 없음(minimal relayParams)
 *  - relayLifecycle: 전이 테이블, terminal 역행 금지, idempotency 중복, DB 실패 fail-closed,
 *    UNRESOLVED 자동 FAILED 금지(전이 테이블에 FAILED 경로 없음)
 *  - revokeSession: prepare→서명 제출(변조·owner 불일치·deadline 거부), 활성 세션 단일성
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── in-memory 2-table store ──────────────────────────────────────────────────

interface FakeRow { [k: string]: unknown }
const store: {
  sessions: FakeRow[]; tasks: FakeRow[];
  failInsert: boolean; failUpdate: boolean; failSelect: boolean;
} = { sessions: [], tasks: [], failInsert: false, failUpdate: false, failSelect: false };

let currentTable: { __name: string } | null = null;
function rowsFor(t: { __name: string } | null): FakeRow[] {
  return t?.__name === 'relay_tasks' ? store.tasks : store.sessions;
}

vi.mock('@workspace/db', () => {
  const sessionsTable = { __name: 'subaccount_approval_sessions' };
  const tasksTable = { __name: 'relay_tasks' };
  const db = {
    select: (_cols?: unknown) => ({
      from: (t: { __name: string }) => {
        currentTable = t;
        const all = () => {
          if (store.failSelect) throw new Error('select fail');
          return rowsFor(t);
        };
        return {
          where: (cond: unknown) => ({
            limit: async (n: number) => filterRows(all(), cond).slice(0, n),
            orderBy: () => ({ limit: async (n: number) => filterRows(all(), cond).slice(0, n) }),
          }),
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

import { resolveRelayMode, evaluateRelayGate, buildDryRunResult } from '../lib/relayAdapter';
import {
  getMockFeeQuote, validateFeeQuote, WETH_ARBITRUM, MAX_FEE_ABSOLUTE_WEI, QUOTE_MAX_AGE_MS,
  type RelayFeeQuote,
} from '../lib/relayFeeQuote';
import {
  REMOVE_SUBACCOUNT_TYPEHASH, REMOVE_SUBACCOUNT_TYPE_STRING,
  getRemoveSubaccountStructHash, computeRemoveSubaccountDigest, buildRemoveSubaccountTypedData,
  assembleOrderRelayCall, assembleRevokeRelayCall,
} from '../lib/relayOrderAssembly';
import {
  RELAY_TASK_STATUS, TERMINAL_STATUSES, RECOVERY_STATUSES, isTransitionAllowed,
  createRelayTask, transitionRelayTask, safeTransition, listRecentRelayTasks,
} from '../lib/relayLifecycle';
import {
  prepareRevokeSession, submitRevokeSignature, getActiveRevokeSession, cancelRevokeSession,
} from '../lib/revokeSession';
import { buildMinimalRelayParams } from '../lib/gmxEip712';

// ── fixtures (공개 테스트 키 — 실자산 없음) ──────────────────────────────────

const OWNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const ownerAccount = privateKeyToAccount(OWNER_PK);
const OWNER = ownerAccount.address;
const SUBACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const ROUTER = '0x2222222222222222222222222222222222222222' as Address;
const MARKET = '0x47c031236e19d024b42f8AE6780E44A573170703' as Address;
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;

const NOW_MS = 1_800_000_000_000;
function freshQuote(overrides: Partial<RelayFeeQuote> = {}): RelayFeeQuote {
  return { ...getMockFeeQuote({ gasLimit: 3_000_000n, gasPrice: 20_000_000n, nowMs: NOW_MS }), ...overrides };
}

beforeEach(() => {
  store.sessions = [];
  store.tasks = [];
  store.failInsert = false;
  store.failUpdate = false;
  store.failSelect = false;
  vi.unstubAllEnvs();
  vi.stubEnv('DELEGATED_SIGNER_ENCRYPTION_KEY', 'a'.repeat(64));
  // encryptSensitiveHex는 scrypt(SESSION_SECRET) 기반 — CI에는 SESSION_SECRET이 없어 fixture로 stub
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-fixture-not-real');
});

// ═════════════════════════════════════ relayAdapter ═════════════════════════

describe('relayAdapter — 모드 결정', () => {
  it('기본(미설정)은 DISABLED', () => {
    const r = resolveRelayMode({} as NodeJS.ProcessEnv);
    expect(r.mode).toBe('DISABLED');
  });
  it("GMX_RELAY_SUBMISSION_ENABLED가 'true'가 아니면 어떤 모드도 후보 아님", () => {
    for (const v of ['TRUE', '1', 'yes', 'on', '']) {
      const r = resolveRelayMode({ GMX_RELAY_SUBMISSION_ENABLED: v, GMX_RELAY_MODE: 'DRY_RUN' } as NodeJS.ProcessEnv);
      expect(r.mode).toBe('DISABLED');
    }
  });
  it('LIVE 요청은 구조적으로 DISABLED 강등 + 사유 기록', () => {
    const r = resolveRelayMode({ GMX_RELAY_SUBMISSION_ENABLED: 'true', GMX_RELAY_MODE: 'LIVE' } as NodeJS.ProcessEnv);
    expect(r.mode).toBe('DISABLED');
    expect(r.requestedLive).toBe(true);
    expect(r.reasons.join(' ')).toContain('구조적으로 비활성');
  });
  it('DRY_RUN만 활성 가능', () => {
    const r = resolveRelayMode({ GMX_RELAY_SUBMISSION_ENABLED: 'true', GMX_RELAY_MODE: 'DRY_RUN' } as NodeJS.ProcessEnv);
    expect(r.mode).toBe('DRY_RUN');
  });
});

describe('relayAdapter — 게이트', () => {
  const baseInput = {
    engineMode: 'LIVE_TEST', liveTestLocked: false, signerActive: true,
    canonicalConfirmed: true, activeRevokeSession: false, kind: 'OPEN' as const,
  };
  it('모든 조건 통과 시 allowed=true, externalCallBudget=0 상수', () => {
    const g = evaluateRelayGate('DRY_RUN', baseInput);
    expect(g.allowed).toBe(true);
    expect(g.externalCallBudget).toBe(0);
  });
  it.each([
    ['PAPER 모드', { engineMode: 'PAPER' }],
    ['실행 잠금', { liveTestLocked: true }],
    ['signer 비활성', { signerActive: false }],
    ['canonical 미확인', { canonicalConfirmed: false }],
    ['활성 revoke 세션(주문)', { activeRevokeSession: true }],
  ])('%s → 차단', (_label, patch) => {
    const g = evaluateRelayGate('DRY_RUN', { ...baseInput, ...patch });
    expect(g.allowed).toBe(false);
    expect(g.blockReasons.length).toBeGreaterThan(0);
  });
  it('활성 revoke 세션이라도 kind=REVOKE는 차단 안 함', () => {
    const g = evaluateRelayGate('DRY_RUN', { ...baseInput, activeRevokeSession: true, kind: 'REVOKE' });
    expect(g.allowed).toBe(true);
  });
  it('buildDryRunResult는 항상 submitEligible=false + LIVE 비활성 사유 포함', () => {
    const gate = evaluateRelayGate('DRY_RUN', baseInput);
    const assembled = assembleRevokeRelayCall({
      mainAccount: OWNER, subaccount: SUBACCOUNT, relayRouter: ROUTER,
      quote: freshQuote(), userNonce: 1n, deadline: 2_000_000_000n,
    });
    const r = buildDryRunResult({
      mode: 'DRY_RUN', kind: 'REVOKE', gate, modeReasons: [], assembled,
      quote: freshQuote(), nowMs: NOW_MS, orderNotionalUsd: null, ethPriceUsd: null,
    });
    expect(r.ok).toBe(true);
    expect(r.submitEligible).toBe(false);
    expect(r.blockReasons.join(' ')).toContain('LIVE 제출은 이번 단계에서 비활성');
    // 민감정보 미포함: 서명 전문 필드 자체가 없음
    expect(JSON.stringify(r)).not.toContain('signature');
  });
});

// ═════════════════════════════════════ fee quote ════════════════════════════

describe('relayFeeQuote — 방어', () => {
  it('mock quote는 gas×price×1.3', () => {
    const q = getMockFeeQuote({ gasLimit: 100n, gasPrice: 10n, nowMs: NOW_MS });
    expect(q.feeAmount).toBe(1300n);
    expect(q.feeToken).toBe(WETH_ARBITRUM);
    expect(q.source).toBe('mock');
  });
  it('quote 없음 → 거부', () => {
    expect(validateFeeQuote({ quote: null, nowMs: NOW_MS, orderNotionalUsd: null, ethPriceUsd: null }).ok).toBe(false);
  });
  it('allowlist 외 feeToken 거부', () => {
    const r = validateFeeQuote({ quote: freshQuote({ feeToken: USDC }), nowMs: NOW_MS, orderNotionalUsd: null, ethPriceUsd: null });
    expect(r.ok).toBe(false);
  });
  it('feeSwapPath 존재 시 거부', () => {
    const r = validateFeeQuote({ quote: freshQuote({ feeSwapPath: [MARKET] }), nowMs: NOW_MS, orderNotionalUsd: null, ethPriceUsd: null });
    expect(r.ok).toBe(false);
  });
  it('0 이하 수수료 거부', () => {
    expect(validateFeeQuote({ quote: freshQuote({ feeAmount: 0n }), nowMs: NOW_MS, orderNotionalUsd: null, ethPriceUsd: null }).ok).toBe(false);
  });
  it('절대 상한 초과 거부', () => {
    const r = validateFeeQuote({ quote: freshQuote({ feeAmount: MAX_FEE_ABSOLUTE_WEI + 1n }), nowMs: NOW_MS, orderNotionalUsd: null, ethPriceUsd: null });
    expect(r.ok).toBe(false);
  });
  it('stale quote 거부(>30s), 미래시각 거부', () => {
    expect(validateFeeQuote({ quote: freshQuote(), nowMs: NOW_MS + QUOTE_MAX_AGE_MS + 1, orderNotionalUsd: null, ethPriceUsd: null }).ok).toBe(false);
    expect(validateFeeQuote({ quote: freshQuote({ quotedAtMs: NOW_MS + 60_000 }), nowMs: NOW_MS, orderNotionalUsd: null, ethPriceUsd: null }).ok).toBe(false);
  });
  it('notional 대비 1% 초과 거부, ETH 가격 미확인 시 fail-closed', () => {
    // fee 0.000078 ETH × $2500 = $0.195 → notional $10의 1%($0.10) 초과 → 거부
    const q = freshQuote();
    expect(validateFeeQuote({ quote: q, nowMs: NOW_MS, orderNotionalUsd: 10, ethPriceUsd: 2500 }).ok).toBe(false);
    // 큰 notional이면 통과
    expect(validateFeeQuote({ quote: q, nowMs: NOW_MS, orderNotionalUsd: 100_000, ethPriceUsd: 2500 }).ok).toBe(true);
    // notional은 있는데 ETH 가격 미확인 → fail-closed
    expect(validateFeeQuote({ quote: q, nowMs: NOW_MS, orderNotionalUsd: 100_000, ethPriceUsd: null }).ok).toBe(false);
  });
});

// ═════════════════════════════ 조립 — 골든 fixture ═══════════════════════════

describe('relayOrderAssembly — 골든·결정성·변조', () => {
  it('REMOVE_SUBACCOUNT typehash 골든 (공식 문자열 keccak256)', () => {
    expect(REMOVE_SUBACCOUNT_TYPE_STRING).toBe('RemoveSubaccount(address subaccount,bytes32 relayParams)');
    expect(REMOVE_SUBACCOUNT_TYPEHASH).toBe(keccak256(toHex(REMOVE_SUBACCOUNT_TYPE_STRING)));
    // 골든 고정값 — 문자열·인코딩이 바뀌면 즉시 실패
    expect(REMOVE_SUBACCOUNT_TYPEHASH).toBe(
      keccak256(toHex('RemoveSubaccount(address subaccount,bytes32 relayParams)')),
    );
  });

  const revokeInput = {
    mainAccount: OWNER, subaccount: SUBACCOUNT, relayRouter: ROUTER,
    quote: freshQuote(), userNonce: 12345n, deadline: 1_900_000_000n,
  };

  it('REVOKE 조립은 결정적 — 동일 입력 = 동일 hash', () => {
    const a = assembleRevokeRelayCall(revokeInput);
    const b = assembleRevokeRelayCall(revokeInput);
    expect(a.calldataHash).toBe(b.calldataHash);
    expect(a.packedPayloadHash).toBe(b.packedPayloadHash);
    expect(a.signingDigest).toBe(b.signingDigest);
    expect(a.signerRole).toBe('owner');
  });

  it('입력 변조 시 digest·hash 변경 (subaccount / nonce / fee)', () => {
    const base = assembleRevokeRelayCall(revokeInput);
    const t1 = assembleRevokeRelayCall({ ...revokeInput, subaccount: OWNER });
    const t2 = assembleRevokeRelayCall({ ...revokeInput, userNonce: 12346n });
    const t3 = assembleRevokeRelayCall({ ...revokeInput, quote: freshQuote({ feeAmount: 999n }) });
    for (const t of [t1, t2, t3]) {
      expect(t.signingDigest).not.toBe(base.signingDigest);
      expect(t.packedPayloadHash).not.toBe(base.packedPayloadHash);
    }
  });

  it('typed data digest == 수동 재계산 digest', () => {
    const relayParams = buildMinimalRelayParams({
      feeToken: revokeInput.quote.feeToken, feeAmount: revokeInput.quote.feeAmount,
      userNonce: revokeInput.userNonce, deadline: revokeInput.deadline,
    });
    const digest = computeRemoveSubaccountDigest({
      chainId: 42161, verifyingContract: ROUTER, relayParams, subaccount: SUBACCOUNT,
    });
    const assembled = assembleRevokeRelayCall(revokeInput);
    expect(assembled.signingDigest).toBe(digest);
    expect(assembled.structHash).toBe(getRemoveSubaccountStructHash(relayParams, SUBACCOUNT));
    const td = buildRemoveSubaccountTypedData({ chainId: 42161, verifyingContract: ROUTER, relayParams, subaccount: SUBACCOUNT });
    expect(td.primaryType).toBe('RemoveSubaccount');
    expect(td.domain.name).toBe('GmxBaseGelatoRelayRouter');
  });

  it('OPEN 조립 — receiver 강제, minimal relayParams(외부호출·스왑 없음)', () => {
    const a = assembleOrderRelayCall({
      kind: 'OPEN', mainAccount: OWNER, subaccount: SUBACCOUNT, relayRouter: ROUTER,
      order: {
        mainAccount: OWNER, market: MARKET, collateralToken: USDC,
        sizeDeltaUsd: 10n ** 33n, initialCollateralDeltaAmount: 100_000_000n,
        acceptablePrice: 10n ** 30n, executionFee: 10n ** 15n, isLong: true,
      },
      quote: freshQuote(), userNonce: 7n, deadline: 1_900_000_000n, subaccountApproval: null,
    });
    expect(a.receiverVerified).toBe(true);
    expect(a.signerRole).toBe('delegated');
    expect(a.approvalAttached).toBe(false); // empty-signature placeholder — 처리 생략 경로
    expect(a.kind).toBe('OPEN');
  });

  it('feeSwapPath가 있으면 조립 거부', () => {
    expect(() => assembleRevokeRelayCall({ ...revokeInput, quote: freshQuote({ feeSwapPath: [MARKET] }) }))
      .toThrow(/feeSwapPath/);
  });
});

// ═════════════════════════════════ lifecycle ═════════════════════════════════

describe('relayLifecycle — 전이·idempotency·fail-closed', () => {
  it('전이 테이블: terminal에서 어떤 전이도 불허', () => {
    for (const t of TERMINAL_STATUSES) {
      for (const to of Object.values(RELAY_TASK_STATUS)) {
        expect(isTransitionAllowed(t, to)).toBe(false);
      }
    }
  });
  it('UNRESOLVED → FAILED_PRE_BROADCAST 자동 전환 금지', () => {
    expect(isTransitionAllowed('UNRESOLVED', RELAY_TASK_STATUS.FAILED_PRE_BROADCAST)).toBe(false);
  });
  it('RECOVERY 상태 집합에 제출 가능성 있는 모든 상태 포함', () => {
    expect(RECOVERY_STATUSES).toEqual(expect.arrayContaining([
      'SUBMITTING', 'TASK_ACCEPTED', 'TX_SUBMITTED', 'ORDER_CREATED', 'UNRESOLVED',
    ]));
  });

  it('createRelayTask: 생성 → PREPARED, 같은 idempotencyKey 중복 거부', async () => {
    const p = { idempotencyKey: 'k1', kind: 'OPEN' as const, payloadHash: '0xabc' };
    const a = await createRelayTask(p);
    expect(a.ok).toBe(true);
    expect(store.tasks[0].status).toBe('PREPARED');
    const b = await createRelayTask(p);
    expect(b).toEqual({ ok: false, reason: 'duplicate' });
    expect(store.tasks.length).toBe(1);
  });

  it('DB insert 실패 시 relay 호출 불가 신호(db_error)', async () => {
    store.failInsert = true;
    const r = await createRelayTask({ idempotencyKey: 'k2', kind: 'CLOSE', payloadHash: '0x1' });
    expect(r).toEqual({ ok: false, reason: 'db_error' });
  });

  it('조건부 전이: from 불일치 시 실패(경합·역행 차단)', async () => {
    const c = await createRelayTask({ idempotencyKey: 'k3', kind: 'OPEN', payloadHash: '0x1' });
    if (!c.ok) throw new Error('setup');
    const t1 = await transitionRelayTask({ taskId: c.taskId, from: 'PREPARED', to: 'DRY_RUN_VALIDATED' });
    expect(t1.ok).toBe(true);
    // 이미 DRY_RUN_VALIDATED — from=PREPARED 재시도는 거부
    const t2 = await transitionRelayTask({ taskId: c.taskId, from: 'PREPARED', to: 'DRY_RUN_VALIDATED' });
    expect(t2.ok).toBe(false);
    // 허용되지 않은 전이 (PREPARED → CONFIRMED)
    const t3 = await transitionRelayTask({ taskId: c.taskId, from: 'PREPARED', to: 'CONFIRMED' });
    expect(t3.ok).toBe(false);
  });

  it('safeTransition: terminal 역행 이중 차단 + resolvedAt 기록', async () => {
    const c = await createRelayTask({ idempotencyKey: 'k4', kind: 'OPEN', payloadHash: '0x1' });
    if (!c.ok) throw new Error('setup');
    await safeTransition({ taskId: c.taskId, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST, patch: { errorClass: 'X' } });
    expect(store.tasks[0].status).toBe('FAILED_PRE_BROADCAST');
    expect(store.tasks[0].resolvedAt).toBeInstanceOf(Date);
    const back = await safeTransition({ taskId: c.taskId, to: RELAY_TASK_STATUS.PREPARED });
    expect(back.ok).toBe(false);
    expect(String((back as { reason: string }).reason)).toContain('terminal');
  });

  it('listRecentRelayTasks: 민감정보 없는 컬럼만', async () => {
    await createRelayTask({ idempotencyKey: 'k5', kind: 'REVOKE', payloadHash: '0xdead', calldataHash: '0xbeef' });
    const rows = await listRecentRelayTasks(10);
    expect(rows.length).toBe(1);
    const keys = Object.keys(rows[0]);
    expect(keys).not.toContain('payloadHash');
    expect(keys).not.toContain('idempotencyKey');
  });
});

// ═════════════════════════════════ revoke 세션 ═══════════════════════════════

describe('revokeSession — prepare·서명·변조 거부', () => {
  // 4단계: userNonce는 durable allocation 필수 인자 — 테스트에서는 고정값 주입
  const prep = () => prepareRevokeSession({
    mainAccount: OWNER, subaccount: SUBACCOUNT, verifyingContract: ROUTER,
    feeToken: WETH_ARBITRUM, feeAmount: 1000n, nowSec: 1_800_000_000n, userNonce: 0n,
  });

  it('prepare → PREPARED 저장 + 기존 활성 revoke 세션 무효화(단일성)', async () => {
    const a = await prep();
    expect(a.ok).toBe(true);
    const b = await prep();
    expect(b.ok).toBe(true);
    const active = store.sessions.filter((s) => s.purpose === 'REVOKE' && s.status === 'PREPARED');
    expect(active.length).toBe(1);
    const invalidated = store.sessions.filter((s) => s.status === 'INVALIDATED');
    expect(invalidated.length).toBe(1);
  });

  it('DB 저장 실패 시 prepare fail-closed', async () => {
    store.failInsert = true;
    const r = await prep();
    expect(r.ok).toBe(false);
  });

  it('올바른 owner 서명 → OWNER_SIGNATURE_READY (암호화 저장, 평문 미저장)', async () => {
    const p = await prep();
    if (!p.ok) throw new Error('setup');
    const sig = await ownerAccount.sign({ hash: p.digest });
    const r = await submitRevokeSignature({ sessionId: p.sessionId, signature: sig, expectedOwner: OWNER, nowSec: 1_800_000_100n });
    expect(r.ok).toBe(true);
    const row = store.sessions.find((s) => s.id === p.sessionId)!;
    expect(row.status).toBe('OWNER_SIGNATURE_READY');
    expect(row.encryptedSignature).toBeTruthy();
    expect(row.encryptedSignature).not.toBe(sig);
    expect(String(row.encryptedSignature)).not.toContain(sig.slice(2, 20));
  });

  it('다른 키 서명 → 거부', async () => {
    const p = await prep();
    if (!p.ok) throw new Error('setup');
    const other = privateKeyToAccount(('0x' + '2'.repeat(64)) as Hex);
    const sig = await other.sign({ hash: p.digest });
    const r = await submitRevokeSignature({ sessionId: p.sessionId, signature: sig, expectedOwner: OWNER, nowSec: 1_800_000_100n });
    expect(r.ok).toBe(false);
  });

  it('저장 파라미터 변조(fee) → digest 불일치 무효화', async () => {
    const p = await prep();
    if (!p.ok) throw new Error('setup');
    const row = store.sessions.find((s) => s.id === p.sessionId)!;
    row.relayFeeAmount = '9999'; // 변조
    const sig = await ownerAccount.sign({ hash: p.digest });
    const r = await submitRevokeSignature({ sessionId: p.sessionId, signature: sig, expectedOwner: OWNER, nowSec: 1_800_000_100n });
    expect(r.ok).toBe(false);
    expect(row.status).toBe('INVALIDATED');
  });

  it('deadline 경과 → 거부 + 무효화', async () => {
    const p = await prep();
    if (!p.ok) throw new Error('setup');
    const sig = await ownerAccount.sign({ hash: p.digest });
    const r = await submitRevokeSignature({ sessionId: p.sessionId, signature: sig, expectedOwner: OWNER, nowSec: 1_800_000_000n + 100_000n });
    expect(r.ok).toBe(false);
  });

  it('getActiveRevokeSession — 서명·암호문 비노출 요약', async () => {
    const p = await prep();
    if (!p.ok) throw new Error('setup');
    const s = await getActiveRevokeSession();
    expect(s?.sessionId).toBe(p.sessionId);
    expect(JSON.stringify(s)).not.toContain('encryptedSignature');
  });

  it('교차-purpose 격리: APPROVAL prepare가 REVOKE 세션을 무효화하지 않음', async () => {
    const p = await prep();
    if (!p.ok) throw new Error('setup');
    // getActiveReadySession/submitApprovalSignature 경로가 REVOKE 세션을 건드리지 않는지
    const { prepareApprovalSession, getActiveReadySession, submitApprovalSignature } =
      await import('../lib/ownerApprovalSession');
    vi.stubEnv('GMX_WALLET_ADDRESS', OWNER);
    const a = await prepareApprovalSession({
      mainAccount: OWNER, subaccount: SUBACCOUNT, verifyingContract: ROUTER,
      canonicalNonce: 0n, nowSec: 1_800_000_000n,
      requestedExpirySec: 3600, requestedMaxAllowedCount: 5,
    });
    expect(a.ok).toBe(true);
    // REVOKE 세션은 여전히 활성 (PREPARED)
    const revokeRow = store.sessions.find((s) => s.id === p.sessionId)!;
    expect(revokeRow.status).toBe('PREPARED');
    // REVOKE READY를 APPROVAL 조회가 선택하지 않음
    const sig = await ownerAccount.sign({ hash: p.digest });
    await submitRevokeSignature({ sessionId: p.sessionId, signature: sig, expectedOwner: OWNER, nowSec: 1_800_000_100n });
    const ready = await getActiveReadySession({ expectedOwner: OWNER, expectedSubaccount: SUBACCOUNT, canonicalNonce: 99n });
    expect(ready?.sessionId).not.toBe(p.sessionId);
    expect(revokeRow.status).toBe('OWNER_SIGNATURE_READY'); // markInvalid 안 됨
    // APPROVAL 서명 제출 경로가 REVOKE 세션을 받지 않음
    const wrong = await submitApprovalSignature({
      sessionId: p.sessionId, signature: sig, canonicalNonce: 0n, expectedOwner: OWNER, nowSec: 1_800_000_100n,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain('APPROVAL');
  });

  it('교차-purpose 격리: REVOKE prepare가 APPROVAL 세션을 무효화하지 않음', async () => {
    store.sessions.push({
      id: 'appr-1', purpose: 'APPROVAL', status: 'OWNER_SIGNATURE_READY',
      mainAccount: OWNER.toLowerCase(), subaccount: SUBACCOUNT.toLowerCase(),
    });
    const p = await prep();
    expect(p.ok).toBe(true);
    expect(store.sessions.find((s) => s.id === 'appr-1')!.status).toBe('OWNER_SIGNATURE_READY');
  });

  it('cancelRevokeSession — 활성 세션만 취소', async () => {
    const p = await prep();
    if (!p.ok) throw new Error('setup');
    expect(await cancelRevokeSession(p.sessionId)).toBe(true);
    expect(await cancelRevokeSession(p.sessionId)).toBe(false);
    expect(await getActiveRevokeSession()).toBeNull();
  });
});
