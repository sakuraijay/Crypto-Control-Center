/**
 * intentReconciler + gmxOrderEvents 테스트 — 온체인 증거 기반 intent 판정.
 *
 * 지시서 필수 시나리오:
 *  receipt pending 유지 / tx not found / reverted→FAILED / key 추출 실패 /
 *  created만→차단 유지 / executed→CONFIRMED / cancelled→CANCELLED / frozen→차단 /
 *  RPC timeout / 잘못된 chainId / 동시 reconciliation / terminal 역행 방지 /
 *  PREPARED 무txHash / OPEN·CLOSE 공통 / PAPER 회귀(무 RPC) / 재시작 fail-closed /
 *  Secret 비노출.
 *
 * 실제 RPC 호출 없음 — 전부 mock 클라이언트 + 고정 log fixture.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── executionIntents 모킹 (DB 계층은 executionIntents.test.ts에서 검증) ────────
const state = vi.hoisted(() => ({
  blockingRows:   [] as Array<Record<string, unknown>>,
  blockingIsNull: false,
  resolveResult:  true,
  resolveCalls:   [] as Array<{ id: string; toStatus: string; evidence: Record<string, unknown> }>,
  evidenceCalls:  [] as Array<{ id: string; evidence: Record<string, unknown> }>,
}));

vi.mock('../lib/executionIntents', () => ({
  listBlockingIntents: vi.fn(async () => (state.blockingIsNull ? null : state.blockingRows)),
  resolveIntentTerminal: vi.fn(async (id: string, toStatus: string, evidence: Record<string, unknown>) => {
    state.resolveCalls.push({ id, toStatus, evidence });
    return state.resolveResult;
  }),
  updateIntentEvidence: vi.fn(async (id: string, evidence: Record<string, unknown>) => {
    state.evidenceCalls.push({ id, evidence });
    return true;
  }),
}));

import {
  GMX_EVENT_EMITTER_ADDRESS,
  ORDER_EVENT_NAME_HASH,
  extractOrderKeyFromReceiptLogs,
  classifyOrderResolutionLogs,
  type RawLog,
} from '../lib/gmxOrderEvents';
import {
  reconcileBlockingIntentsOnchain,
  type OnchainClient,
  type ReceiptResult,
} from '../lib/intentReconciler';

const SIG  = '0x' + 'ab'.repeat(32); // EventLog2 signature hash 위치 (판정에 미사용)
const KEY  = '0x' + '11'.repeat(32);
const ACCT = '0x' + '22'.repeat(32);

function createdLog(key = KEY): RawLog {
  return { address: GMX_EVENT_EMITTER_ADDRESS, topics: [SIG, ORDER_EVENT_NAME_HASH.OrderCreated, key, ACCT] };
}
function resolutionLog(name: 'OrderExecuted' | 'OrderCancelled' | 'OrderFrozen', key = KEY): RawLog {
  return {
    address: GMX_EVENT_EMITTER_ADDRESS,
    topics: [SIG, ORDER_EVENT_NAME_HASH[name], key, ACCT],
    transactionHash: '0xResTx',
    blockNumber: '456',
  };
}

function intent(over: Record<string, unknown> = {}) {
  return {
    id: 'intent:open:d1', decisionId: 'd1', cycleNumber: 1, symbol: 'ETH',
    orderType: 'open', isLong: true, sizeUsd: 10, collateralUsd: 5,
    txHash: '0xTx1', status: 'UNRESOLVED', orderKey: null, orderCreatedBlock: null,
    ...over,
  };
}

function mockClient(over: Partial<OnchainClient> = {}): OnchainClient & { calls: Record<string, number> } {
  const calls = { chainId: 0, receipt: 0, logs: 0 };
  return {
    calls,
    getChainId: async () => { calls.chainId++; return 42161; },
    getTransactionReceipt: async () => { calls.receipt++; return null; },
    getOrderResolutionLogs: async () => { calls.logs++; return []; },
    ...over,
  };
}

const successReceipt = (logs: RawLog[]): ReceiptResult => ({ status: 'success', blockNumber: '100', logs });

beforeEach(() => {
  state.blockingRows   = [];
  state.blockingIsNull = false;
  state.resolveResult  = true;
  state.resolveCalls   = [];
  state.evidenceCalls  = [];
});

// ── gmxOrderEvents 순수 파싱 ──────────────────────────────────────────────────

describe('gmxOrderEvents — receipt 로그 파싱', () => {
  it('OrderCreated 로그에서 order key(topic1=topics[2]) 추출', () => {
    const r = extractOrderKeyFromReceiptLogs([createdLog()]);
    expect(r).toEqual({ ok: true, orderKey: KEY });
  });

  it('EventEmitter 외 주소·다른 이벤트는 무시 → not_found', () => {
    const foreign: RawLog = { address: '0x' + '99'.repeat(20), topics: [SIG, ORDER_EVENT_NAME_HASH.OrderCreated, KEY, ACCT] };
    expect(extractOrderKeyFromReceiptLogs([foreign])).toEqual({ ok: false, reason: 'not_found' });
  });

  it('서로 다른 key 2건 → ambiguous (판정 불가)', () => {
    const r = extractOrderKeyFromReceiptLogs([createdLog(), createdLog('0x' + '33'.repeat(32))]);
    expect(r).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('classify: executed > cancelled 우선순위, key 불일치는 무시', () => {
    const other = resolutionLog('OrderExecuted', '0x' + '44'.repeat(32));
    expect(classifyOrderResolutionLogs([other], KEY)).toBeNull();
    const both = [resolutionLog('OrderCancelled'), resolutionLog('OrderExecuted')];
    expect(classifyOrderResolutionLogs(both, KEY)?.kind).toBe('executed');
  });
});

// ── reconcileBlockingIntentsOnchain ───────────────────────────────────────────

describe('intentReconciler — 온체인 판정 (fail-closed)', () => {
  it('PAPER 회귀: 차단 intent 0건 → RPC 클라이언트 자체를 만들지 않음', async () => {
    const factory = vi.fn();
    const r = await reconcileBlockingIntentsOnchain(factory);
    expect(r).toEqual({ ok: true, checked: 0, resolutions: [], stillBlocking: 0 });
    expect(factory).not.toHaveBeenCalled();
  });

  it('재시작 fail-closed: intent 목록 조회 실패(null) → ok=false, RPC 없음', async () => {
    state.blockingIsNull = true;
    const factory = vi.fn();
    const r = await reconcileBlockingIntentsOnchain(factory);
    expect(r.ok).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it('잘못된 chainId(≠42161) → 전원 차단 유지, receipt 조회 없음', async () => {
    state.blockingRows = [intent()];
    const client = mockClient({ getChainId: async () => 1 });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.ok).toBe(false);
    expect(r.stillBlocking).toBe(1);
    expect(client.calls.receipt).toBe(0);
  });

  it('클라이언트 생성 실패(GMX_RPC_URL 미설정 등) → 차단 유지, throw 없음', async () => {
    state.blockingRows = [intent()];
    const r = await reconcileBlockingIntentsOnchain(() => { throw new Error('no rpc'); });
    expect(r.ok).toBe(false);
    expect(r.stillBlocking).toBe(1);
  });

  it('PREPARED + txHash 없음 → 영구 차단, receipt 조회조차 안 함 (자동 FAILED 금지)', async () => {
    state.blockingRows = [intent({ txHash: null, status: 'UNRESOLVED' })];
    const client = mockClient();
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions).toEqual([]);
    expect(r.stillBlocking).toBe(1);
    expect(client.calls.receipt).toBe(0);
    expect(state.resolveCalls).toEqual([]);
  });

  it('receipt 미존재/pending(null) → 상태 변경 없음 (시간 경과 FAILED 금지)', async () => {
    state.blockingRows = [intent({ status: 'SUBMITTED' })];
    const client = mockClient(); // receipt → null
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.ok).toBe(true);
    expect(r.stillBlocking).toBe(1);
    expect(state.resolveCalls).toEqual([]);
    expect(state.evidenceCalls).toEqual([]);
  });

  it('receipt reverted → FAILED terminal + block 증거 저장', async () => {
    state.blockingRows = [intent()];
    const client = mockClient({
      getTransactionReceipt: async () => ({ status: 'reverted', blockNumber: '99', logs: [] }),
    });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions).toHaveLength(1);
    expect(r.resolutions[0].status).toBe('FAILED');
    expect(state.resolveCalls[0]).toMatchObject({
      toStatus: 'FAILED',
      evidence: { receiptStatus: 'reverted', resolutionBlock: '99', resolutionTxHash: '0xTx1' },
    });
  });

  it('receipt success + key 추출 실패 → UNRESOLVED 유지 (근거만 기록, 해소 금지)', async () => {
    state.blockingRows = [intent()];
    const client = mockClient({ getTransactionReceipt: async () => successReceipt([]) });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions).toEqual([]);
    expect(r.stillBlocking).toBe(1);
    expect(state.evidenceCalls[0].evidence.resolutionReason).toContain('추출 실패');
    expect(client.calls.logs).toBe(0); // key 없이 이벤트 조회 불가
  });

  it('생성만 확인(실행 이벤트 없음) → key·생성 block 영속화 후 계속 차단', async () => {
    state.blockingRows = [intent()];
    const client = mockClient({ getTransactionReceipt: async () => successReceipt([createdLog()]) });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions).toEqual([]);
    expect(r.stillBlocking).toBe(1);
    expect(state.evidenceCalls[0].evidence).toMatchObject({
      orderKey: KEY, orderCreatedBlock: '100', receiptStatus: 'success',
    });
  });

  it('OrderExecuted 확인 → CONFIRMED terminal + 실행 tx/block 증거', async () => {
    state.blockingRows = [intent()];
    const client = mockClient({
      getTransactionReceipt: async () => successReceipt([createdLog()]),
      getOrderResolutionLogs: async () => [resolutionLog('OrderExecuted')],
    });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions[0]).toMatchObject({ status: 'CONFIRMED', txHash: '0xTx1' });
    expect(state.resolveCalls[0]).toMatchObject({
      toStatus: 'CONFIRMED',
      evidence: { orderKey: KEY, resolutionTxHash: '0xResTx', resolutionBlock: '456' },
    });
  });

  it('OrderCancelled 확인 → CANCELLED terminal (FAILED와 구분)', async () => {
    state.blockingRows = [intent()];
    const client = mockClient({
      getTransactionReceipt: async () => successReceipt([createdLog()]),
      getOrderResolutionLogs: async () => [resolutionLog('OrderCancelled')],
    });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions[0].status).toBe('CANCELLED');
    expect(state.resolveCalls[0].toStatus).toBe('CANCELLED');
  });

  it('OrderFrozen → 판정 불가, terminal 전환 없이 차단 유지', async () => {
    state.blockingRows = [intent()];
    const client = mockClient({
      getTransactionReceipt: async () => successReceipt([createdLog()]),
      getOrderResolutionLogs: async () => [resolutionLog('OrderFrozen')],
    });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions).toEqual([]);
    expect(r.stillBlocking).toBe(1);
    expect(state.resolveCalls).toEqual([]);
    expect(state.evidenceCalls.some(c => String(c.evidence.resolutionReason).includes('OrderFrozen'))).toBe(true);
  });

  it('RPC timeout(throw) → 해당 intent 차단 유지, 루프는 계속·throw 없음', async () => {
    state.blockingRows = [
      intent({ id: 'i1', txHash: '0xBad' }),
      intent({ id: 'i2', txHash: '0xGood' }),
    ];
    const client = mockClient({
      getTransactionReceipt: async (tx: string) => {
        if (tx === '0xBad') throw new Error('timeout');
        return successReceipt([createdLog()]);
      },
      getOrderResolutionLogs: async () => [resolutionLog('OrderExecuted')],
    });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.ok).toBe(true);
    expect(r.stillBlocking).toBe(1);
    expect(r.resolutions.map(x => x.intentId)).toEqual(['i2']);
  });

  it('동시 reconciliation: 조건부 UPDATE 0행(선점됨) → 해소 목록에 미포함, 중복 전환 없음', async () => {
    state.blockingRows = [intent()];
    state.resolveResult = false; // 타 프로세스가 이미 terminal 전환
    const client = mockClient({
      getTransactionReceipt: async () => successReceipt([createdLog()]),
      getOrderResolutionLogs: async () => [resolutionLog('OrderExecuted')],
    });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions).toEqual([]); // terminal 역행·중복 보고 없음
  });

  it('OPEN·CLOSE 공통: close intent도 동일 규칙으로 CONFIRMED', async () => {
    state.blockingRows = [intent({ id: 'intent:close:d1', orderType: 'close', txHash: '0xTxC' })];
    const client = mockClient({
      getTransactionReceipt: async () => successReceipt([createdLog()]),
      getOrderResolutionLogs: async () => [resolutionLog('OrderExecuted')],
    });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions[0]).toMatchObject({ intentId: 'intent:close:d1', status: 'CONFIRMED' });
  });

  it('기존 orderKey 보유 intent → receipt 로그 재파싱 없이 이벤트 조회로 직행', async () => {
    state.blockingRows = [intent({ orderKey: KEY, orderCreatedBlock: '90' })];
    const client = mockClient({
      getTransactionReceipt: async () => successReceipt([]), // created 로그 없어도 무관
      getOrderResolutionLogs: async (_k: string, fromBlock: string | null) => {
        expect(fromBlock).toBe('90');
        return [resolutionLog('OrderExecuted')];
      },
    });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions[0].status).toBe('CONFIRMED');
  });

  it('Secret 비노출: 판정 결과·사유에 RPC URL 값이 포함되지 않음', async () => {
    const fakeSecret = 'https://rpc.example/SECRET_TOKEN_abc123';
    const prev = process.env.GMX_RPC_URL;
    process.env.GMX_RPC_URL = fakeSecret;
    try {
      state.blockingRows = [intent()];
      const client = mockClient({
        getTransactionReceipt: async () => successReceipt([createdLog()]),
        getOrderResolutionLogs: async () => [resolutionLog('OrderExecuted')],
      });
      const r = await reconcileBlockingIntentsOnchain(() => client);
      const dump = JSON.stringify(r) + JSON.stringify(state.resolveCalls) + JSON.stringify(state.evidenceCalls);
      expect(dump).not.toContain('SECRET_TOKEN_abc123');
      expect(dump).not.toContain(fakeSecret);
    } finally {
      if (prev === undefined) delete process.env.GMX_RPC_URL; else process.env.GMX_RPC_URL = prev;
    }
  });
});
