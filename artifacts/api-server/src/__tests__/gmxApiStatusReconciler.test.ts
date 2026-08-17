/**
 * gmxApiStatusReconciler — 6G-2 §9/§14 테스트.
 *
 * 검증(지시서 §14 #19/#23~26 해당):
 *  - readonly 플래그 꺼짐 → 외부 호출 0회·전이 0회
 *  - blocking 상태(prepared/relay_accepted/relay_pending/relay_submitted/created) → 전이 없음
 *  - executed → 온체인 receipt success + 허용 emitter OrderExecuted 확인 후에만 CONFIRMED
 *  - executed 보고 + 온체인 이벤트 부재 → UNRESOLVED (보고만으로 CONFIRMED 금지)
 *  - relay_reverted → receipt reverted 확인 후 FAILED; receipt success 모순 → UNRESOLVED
 *  - cancelled → OrderCancelled 확인 후 CANCELLED
 *  - not-found(http_4xx)/decode/requestId 불일치/txHash 없는 종결 보고 → UNRESOLVED
 *  - network/timeout/5xx → 전이 없음 (skippedTransient, 시간 경과 FAILED 금지)
 *  - RPC(onchain) 미설정 → 종결 판정 보류
 *  - 다중 orderKey → UNRESOLVED
 *  - 자동 재제출 0회 (transport.postJson은 status 경로만 호출됨)
 *
 * 실제 외부 POST·온체인 I/O 없음 — 전부 mock/fixture.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── DB mock — select 결과 주입 ────────────────────────────────────────────────
const dbState = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  selectFail: false,
}));
vi.mock('@workspace/db', () => {
  const limit = vi.fn(async () => {
    if (dbState.selectFail) throw new Error('db down');
    return dbState.rows;
  });
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return {
    db: {
      select: vi.fn(() => ({ from })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    },
    relayTasksTable: {},
  };
});
vi.mock('drizzle-orm', () => ({
  and: vi.fn(), eq: vi.fn(), inArray: vi.fn(),
}));

// ── lifecycle/intent/이벤트 mock ─────────────────────────────────────────────
const transitionSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('../lib/relayLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/relayLifecycle')>();
  return { ...actual, transitionRelayTask: transitionSpy };
});
const resolveIntentSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../lib/executionIntents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/executionIntents')>();
  return { ...actual, resolveIntentTerminal: resolveIntentSpy };
});
const eventsState = vi.hoisted(() => ({
  classify: null as null | { kind: 'executed' | 'cancelled' | 'frozen' },
  extract: { ok: true, orderKey: '0x' + 'a'.repeat(64), emitterAddress: '0xE' } as
    { ok: true; orderKey: string; emitterAddress: string } | { ok: false; reason: 'not_found' | 'ambiguous' },
}));
vi.mock('../lib/gmxOrderEvents', () => ({
  classifyOrderResolutionLogs: vi.fn(() => eventsState.classify),
  extractOrderKeyFromReceiptLogs: vi.fn(() => eventsState.extract),
  resolveGmxEventEmitterAddress: vi.fn(() => ({ ok: true, address: '0xE' })),
}));
vi.mock('../lib/intentReconciler', () => ({
  createViemOnchainClient: vi.fn(() => { throw new Error('no rpc in tests'); }),
}));

import { reconcileGmxApiTasks, fetchGmxApiOrderStatus } from '../lib/gmxApiStatusReconciler';
import type { GmxApiTransport } from '../lib/gmxApiTransport';

const ORDER_KEY = '0x' + 'a'.repeat(64);
const TX = '0x' + 'b'.repeat(64);

function makeTransport(
  responder: (path: string, body: unknown) => unknown,
  opts?: { readonlyEnabled?: boolean; fail?: { kind: string } },
): GmxApiTransport & { calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    readonlyEnabled: opts?.readonlyEnabled ?? true,
    submissionEnabled: false,
    peers: ['https://peer-a'],
    calls,
    async postJson(path: string, body: unknown) {
      calls.push({ path, body });
      if (opts?.fail) return { ok: false, kind: opts.fail.kind, httpStatus: null, ambiguous: false, message: 'x', peerHost: 'peer-a' } as never;
      return { ok: true, data: responder(path, body), peerHost: 'peer-a' } as never;
    },
    async getJson() { throw new Error('unexpected GET'); },
  } as never;
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1', kind: 'OPEN', status: 'TASK_ACCEPTED', transportGen: 'GMX_API_V2',
    gmxRequestId: 'req-1', relayTaskId: null, intentId: 'intent:open:d1',
    gmxExecutionTxHash: null, gmxOrderKeys: null, txHash: null,
    ...overrides,
  };
}

const receiptSuccess = { status: 'success' as const, logs: [] };
const receiptReverted = { status: 'reverted' as const, logs: [] };

function makeOnchain(receipt: unknown) {
  return {
    getChainId: async () => 42161,
    getTransactionReceipt: vi.fn(async () => receipt),
    getOrderResolutionLogs: vi.fn(async () => []),
  } as never;
}

const deps = (transport: GmxApiTransport, onchain: unknown = null) =>
  ({ transport, onchain, nowMs: () => Date.now() }) as never;

beforeEach(() => {
  dbState.rows = [];
  dbState.selectFail = false;
  transitionSpy.mockClear();
  transitionSpy.mockResolvedValue({ ok: true } as never);
  resolveIntentSpy.mockClear();
  eventsState.classify = null;
  eventsState.extract = { ok: true, orderKey: ORDER_KEY, emitterAddress: '0xE' };
});

describe('reconcileGmxApiTasks — 게이트/스캔', () => {
  it('readonly 플래그 꺼짐 → 외부 호출 0회, 전이 0회', async () => {
    dbState.rows = [row()];
    const t = makeTransport(() => ({}), { readonlyEnabled: false });
    const s = await reconcileGmxApiTasks(deps(t));
    expect(s.scanned).toBe(0);
    expect(t.calls.length).toBe(0);
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('DB 조회 실패 → errors=1, 외부 호출 0회 (fail-closed)', async () => {
    dbState.selectFail = true;
    const t = makeTransport(() => ({}));
    const s = await reconcileGmxApiTasks(deps(t));
    expect(s.errors).toBe(1);
    expect(t.calls.length).toBe(0);
  });

  it('requestId 미확보 task → 외부 조회 없이 UNRESOLVED 전환', async () => {
    dbState.rows = [row({ gmxRequestId: null, relayTaskId: null })];
    const t = makeTransport(() => ({}));
    const s = await reconcileGmxApiTasks(deps(t));
    expect(t.calls.length).toBe(0);
    expect(s.unresolvedMarked).toBe(1);
    expect(transitionSpy.mock.calls[0][0]).toMatchObject({ to: 'UNRESOLVED' });
  });
});

describe('status 매핑 — blocking/일시 장애', () => {
  for (const st of ['prepared', 'relay_accepted', 'relay_pending', 'relay_submitted', 'created']) {
    it(`${st} → 전이 없음 (대기, 시간 경과 FAILED 금지)`, async () => {
      dbState.rows = [row()];
      const t = makeTransport(() => ({ status: st, requestId: 'req-1' }));
      const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
      expect(s.transitioned).toBe(0);
      expect(s.unresolvedMarked).toBe(0);
      expect(transitionSpy).not.toHaveBeenCalled();
    });
  }

  for (const kind of ['network', 'timeout', 'http_5xx']) {
    it(`transport ${kind} → skippedTransient (전이 없음, 다음 주기 재시도)`, async () => {
      dbState.rows = [row()];
      const t = makeTransport(() => ({}), { fail: { kind } });
      const s = await reconcileGmxApiTasks(deps(t));
      expect(s.skippedTransient).toBe(1);
      expect(transitionSpy).not.toHaveBeenCalled();
    });
  }

  for (const kind of ['http_4xx', 'decode']) {
    it(`transport ${kind}(not-found/구조 불일치) → UNRESOLVED`, async () => {
      dbState.rows = [row()];
      const t = makeTransport(() => ({}), { fail: { kind } });
      const s = await reconcileGmxApiTasks(deps(t));
      expect(s.unresolvedMarked).toBe(1);
      expect(transitionSpy.mock.calls[0][0]).toMatchObject({ to: 'UNRESOLVED' });
    });
  }

  it('relay_failed(pre-broadcast 근거 없음) → 전이 없음 — 자동 FAILED 금지', async () => {
    dbState.rows = [row()];
    const t = makeTransport(() => ({ status: 'relay_failed', requestId: 'req-1' }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
    expect(s.transitioned).toBe(0);
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('peer 응답 requestId 불일치 → UNRESOLVED (§10)', async () => {
    dbState.rows = [row()];
    const t = makeTransport(() => ({ status: 'executed', requestId: 'req-OTHER', executionTxHash: TX }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
    expect(s.unresolvedMarked).toBe(1);
  });

  it('알 수 없는 status 문자열 → 전이 없음 (자동 종결 금지)', async () => {
    dbState.rows = [row()];
    const t = makeTransport(() => ({ status: 'weird_new_status', requestId: 'req-1' }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(s.transitioned).toBe(0);
  });
});

describe('executed — 온체인 교차검증 후에만 CONFIRMED', () => {
  it('executed + receipt success + OrderExecuted → CONFIRMED + intent 해소', async () => {
    dbState.rows = [row()];
    eventsState.classify = { kind: 'executed' };
    const t = makeTransport(() => ({ status: 'executed', requestId: 'req-1', executionTxHash: TX, orderKeys: [ORDER_KEY] }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
    expect(s.transitioned).toBe(1);
    expect(transitionSpy.mock.calls[0][0]).toMatchObject({ to: 'CONFIRMED', patch: { txHash: TX, orderKey: ORDER_KEY } });
    expect(resolveIntentSpy).toHaveBeenCalledWith('intent:open:d1', 'CONFIRMED', expect.objectContaining({ resolutionTxHash: TX, orderKey: ORDER_KEY }));
  });

  it('executed 보고 + 온체인 OrderExecuted 부재 → UNRESOLVED (status만으로 CONFIRMED 금지)', async () => {
    dbState.rows = [row()];
    eventsState.classify = null;
    const t = makeTransport(() => ({ status: 'executed', requestId: 'req-1', executionTxHash: TX, orderKeys: [ORDER_KEY] }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
    expect(s.unresolvedMarked).toBe(1);
    expect(resolveIntentSpy).not.toHaveBeenCalled();
  });

  it('executed 보고인데 txHash 없음 → UNRESOLVED (증거 불충분)', async () => {
    dbState.rows = [row()];
    const t = makeTransport(() => ({ status: 'executed', requestId: 'req-1' }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
    expect(s.unresolvedMarked).toBe(1);
  });

  it('onchain 클라이언트 없음(RPC 미설정) → 판정 보류 (전이 없음)', async () => {
    dbState.rows = [row()];
    const t = makeTransport(() => ({ status: 'executed', requestId: 'req-1', executionTxHash: TX, orderKeys: [ORDER_KEY] }));
    const s = await reconcileGmxApiTasks(deps(t, null));
    expect(s.transitioned).toBe(0);
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it('receipt pending(null) → 대기 (전이 없음)', async () => {
    dbState.rows = [row()];
    const t = makeTransport(() => ({ status: 'executed', requestId: 'req-1', executionTxHash: TX, orderKeys: [ORDER_KEY] }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(null)));
    expect(s.transitioned).toBe(0);
  });

  it('executed 보고 + receipt reverted 모순 → UNRESOLVED', async () => {
    dbState.rows = [row()];
    const t = makeTransport(() => ({ status: 'executed', requestId: 'req-1', executionTxHash: TX, orderKeys: [ORDER_KEY] }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptReverted)));
    expect(s.unresolvedMarked).toBe(1);
  });

  it('다중 orderKey 보고 + receipt 추출 실패 → UNRESOLVED (자동 종결 금지)', async () => {
    dbState.rows = [row()];
    eventsState.extract = { ok: false, reason: 'ambiguous' };
    const t = makeTransport(() => ({
      status: 'executed', requestId: 'req-1', executionTxHash: TX,
      orderKeys: [ORDER_KEY, '0x' + 'c'.repeat(64)],
    }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
    expect(s.unresolvedMarked).toBe(1);
  });
});

describe('relay_reverted / cancelled', () => {
  it('relay_reverted + receipt reverted → FAILED + intent FAILED', async () => {
    dbState.rows = [row()];
    const t = makeTransport(() => ({ status: 'relay_reverted', requestId: 'req-1', executionTxHash: TX }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptReverted)));
    expect(s.transitioned).toBe(1);
    expect(transitionSpy.mock.calls[0][0]).toMatchObject({ to: 'FAILED' });
    expect(resolveIntentSpy).toHaveBeenCalledWith('intent:open:d1', 'FAILED', expect.anything());
  });

  it('relay_reverted 보고 + receipt success 모순 → UNRESOLVED', async () => {
    dbState.rows = [row()];
    const t = makeTransport(() => ({ status: 'relay_reverted', requestId: 'req-1', executionTxHash: TX }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
    expect(s.unresolvedMarked).toBe(1);
    expect(resolveIntentSpy).not.toHaveBeenCalled();
  });

  it('cancelled + 온체인 OrderCancelled → CANCELLED', async () => {
    dbState.rows = [row()];
    eventsState.classify = { kind: 'cancelled' };
    const t = makeTransport(() => ({ status: 'cancelled', requestId: 'req-1', executionTxHash: TX, orderKeys: [ORDER_KEY] }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
    expect(s.transitioned).toBe(1);
    expect(transitionSpy.mock.calls[0][0]).toMatchObject({ to: 'CANCELLED' });
    expect(resolveIntentSpy).toHaveBeenCalledWith('intent:open:d1', 'CANCELLED', expect.anything());
  });

  it('cancelled 보고 + 온체인 OrderCancelled 부재 → UNRESOLVED', async () => {
    dbState.rows = [row()];
    eventsState.classify = null;
    const t = makeTransport(() => ({ status: 'cancelled', requestId: 'req-1', executionTxHash: TX, orderKeys: [ORDER_KEY] }));
    const s = await reconcileGmxApiTasks(deps(t, makeOnchain(receiptSuccess)));
    expect(s.unresolvedMarked).toBe(1);
  });
});

describe('fetchGmxApiOrderStatus — 방어적 추출', () => {
  it('status 경로만 호출하고 재제출 0회', async () => {
    const t = makeTransport(() => ({ status: 'created', requestId: 'req-1' }));
    const r = await fetchGmxApiOrderStatus(t, 'req-1');
    expect(r.ok).toBe(true);
    expect(t.calls).toEqual([{ path: '/orders/txns/status', body: { requestId: 'req-1' } }]);
  });

  it('status 필드 없는 응답 → decode', async () => {
    const t = makeTransport(() => ({ something: 'else' }));
    const r = await fetchGmxApiOrderStatus(t, 'req-1');
    expect(r).toMatchObject({ ok: false, kind: 'decode' });
  });

  it('비정상 txHash/orderKey는 버려진다 (원문 저장 금지)', async () => {
    const t = makeTransport(() => ({
      status: 'executed', executionTxHash: 'not-a-hash', orderKeys: ['bad', ORDER_KEY],
    }));
    const r = await fetchGmxApiOrderStatus(t, 'req-1');
    expect(r.executionTxHash).toBeNull();
    expect(r.orderKeys).toEqual([ORDER_KEY]);
  });
});
