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
  GMX_EVENT_EMITTER_ARBITRUM_OFFICIAL_DOC,
  KNOWN_NON_ARBITRUM_EVENT_EMITTERS,
  EVENT_LOG_2_TOPIC0,
  ORDER_EVENT_NAME_HASH,
  extractOrderKeyFromReceiptLogs,
  classifyOrderResolutionLogs,
  resolveGmxEventEmitterAddress,
  type RawLog,
} from '../lib/gmxOrderEvents';
import {
  reconcileBlockingIntentsOnchain,
  sanitizeRpcError,
  type OnchainClient,
  type ReceiptResult,
} from '../lib/intentReconciler';

// Arbitrum 공식 emitter(문서 기준)와 타 체인 emitter — 테스트용 명시 설정.
// 기본값이 제거됐으므로 reconcile 경로 테스트를 위해 env를 명시 설정한다.
const ARB_EMITTER   = GMX_EVENT_EMITTER_ARBITRUM_OFFICIAL_DOC;
const OTHER_EMITTER = KNOWN_NON_ARBITRUM_EVENT_EMITTERS[0].address;
process.env.GMX_EVENT_EMITTER_ADDRESS = ARB_EMITTER;

// 정확한 EventLog2 signature (공식 ABI 파생) — topic0 검증에 사용
const SIG      = EVENT_LOG_2_TOPIC0;
const FAKE_SIG = '0x' + 'ab'.repeat(32); // 위조 signature
const EMITTERS = [ARB_EMITTER]; // 기본 허용 emitter 집합
const KEY  = ('0x' + '11'.repeat(32)) as `0x${string}`;
const ACCT = ('0x' + '22'.repeat(32)) as `0x${string}`;

function createdLog(key: string = KEY, address: string = ARB_EMITTER, sig: string = SIG): RawLog {
  return { address, topics: [sig, ORDER_EVENT_NAME_HASH.OrderCreated, key, ACCT] };
}
function resolutionLog(name: 'OrderExecuted' | 'OrderCancelled' | 'OrderFrozen', key: string = KEY, address: string = ARB_EMITTER, sig: string = SIG): RawLog {
  return {
    address,
    topics: [sig, ORDER_EVENT_NAME_HASH[name], key, ACCT],
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
    const r = extractOrderKeyFromReceiptLogs([createdLog()], EMITTERS);
    expect(r).toEqual({ ok: true, orderKey: KEY, emitterAddress: ARB_EMITTER });
  });

  it('EventEmitter 외 주소·다른 이벤트는 무시 → not_found', () => {
    const foreign: RawLog = { address: '0x' + '99'.repeat(20), topics: [SIG, ORDER_EVENT_NAME_HASH.OrderCreated, KEY, ACCT] };
    expect(extractOrderKeyFromReceiptLogs([foreign], EMITTERS)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('서로 다른 key 2건 → ambiguous (판정 불가)', () => {
    const r = extractOrderKeyFromReceiptLogs([createdLog(), createdLog('0x' + '33'.repeat(32))], EMITTERS);
    expect(r).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('classify: executed > cancelled 우선순위, key 불일치는 무시', () => {
    const other = resolutionLog('OrderExecuted', '0x' + '44'.repeat(32));
    expect(classifyOrderResolutionLogs([other], KEY, EMITTERS)).toBeNull();
    const both = [resolutionLog('OrderCancelled'), resolutionLog('OrderExecuted')];
    expect(classifyOrderResolutionLogs(both, KEY, EMITTERS)?.kind).toBe('executed');
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

  it('Secret 비노출: RPC 예외 로그가 URL·GMX_RPC_URL 값을 담지 않음 (sanitizeRpcError)', () => {
    const fakeSecret = 'https://rpc.example/v2/SECRET_TOKEN_xyz789';
    const prev = process.env.GMX_RPC_URL;
    process.env.GMX_RPC_URL = fakeSecret;
    try {
      // viem HTTP 오류처럼 메시지에 요청 URL이 포함된 예외
      const e = new Error(`HTTP request failed. URL: ${fakeSecret} Details: timeout`);
      e.name = 'HttpRequestError';
      const out = sanitizeRpcError(e);
      expect(out).toContain('HttpRequestError');
      expect(out).not.toContain('SECRET_TOKEN_xyz789');
      expect(out).not.toContain('rpc.example');
      // URL 없는 일반 오류는 메시지 유지
      expect(sanitizeRpcError(new Error('plain failure'))).toContain('plain failure');
    } finally {
      if (prev === undefined) delete process.env.GMX_RPC_URL; else process.env.GMX_RPC_URL = prev;
    }
  });

  it('RPC 예외 발생 시 console.error 출력에 RPC URL이 유출되지 않음', async () => {
    const fakeSecret = 'https://rpc.example/v2/SECRET_TOKEN_qqq111';
    const prev = process.env.GMX_RPC_URL;
    process.env.GMX_RPC_URL = fakeSecret;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      state.blockingRows = [intent()];
      const client = mockClient({
        getTransactionReceipt: async () => {
          const e = new Error(`HTTP request failed. URL: ${fakeSecret}`);
          e.name = 'HttpRequestError';
          throw e;
        },
      });
      await reconcileBlockingIntentsOnchain(() => client);
      const logged = spy.mock.calls.map(args => args.map(String).join(' ')).join('\n');
      expect(logged).not.toContain('SECRET_TOKEN_qqq111');
      expect(logged).not.toContain('rpc.example');
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.GMX_RPC_URL; else process.env.GMX_RPC_URL = prev;
    }
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

// ── Part A 신규: EventEmitter 주소 설정·정확한 EventLog2 필터 ──────────────────

import { encodeEventTopics, keccak256, toHex } from 'viem';
import { EVENT_LOG_2_ABI, isValidEvmAddress } from '../lib/gmxOrderEvents';

describe('gmxOrderEvents — EventEmitter 주소 설정 (fail-closed, 기본값 없음)', () => {
  it('환경변수 미설정 → ok=false (하드코딩 기본값 사용 금지)', () => {
    const r = resolveGmxEventEmitterAddress({} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    const r2 = resolveGmxEventEmitterAddress({ GMX_EVENT_EMITTER_ADDRESS: '  ' } as NodeJS.ProcessEnv);
    expect(r2.ok).toBe(false);
  });

  it('GMX_EVENT_EMITTER_ADDRESS 설정 시 그 값 사용 (코드 수정 없이 주소 교체)', () => {
    const custom = '0x' + '77'.repeat(20);
    const r = resolveGmxEventEmitterAddress({ GMX_EVENT_EMITTER_ADDRESS: ` ${custom} ` } as NodeJS.ProcessEnv);
    expect(r).toEqual({ ok: true, address: custom, source: 'env' });
  });

  it('형식 오류(길이·hex 아님·URL 등) → ok=false, 기본값 폴백 금지', () => {
    for (const bad of ['0x123', 'not-an-address', '0x' + 'zz'.repeat(20), '0x' + '11'.repeat(21)]) {
      const r = resolveGmxEventEmitterAddress({ GMX_EVENT_EMITTER_ADDRESS: bad } as NodeJS.ProcessEnv);
      expect(r.ok).toBe(false);
    }
  });

  it('타 체인(Botanix/MegaETH/Avalanche) EventEmitter 주소 → ok=false (chain/address 교차 오설정 차단)', () => {
    for (const e of KNOWN_NON_ARBITRUM_EVENT_EMITTERS) {
      const r = resolveGmxEventEmitterAddress({ GMX_EVENT_EMITTER_ADDRESS: e.address } as NodeJS.ProcessEnv);
      expect(r.ok).toBe(false);
      const rLower = resolveGmxEventEmitterAddress({ GMX_EVENT_EMITTER_ADDRESS: e.address.toLowerCase() } as NodeJS.ProcessEnv);
      expect(rLower.ok).toBe(false);
    }
  });

  it('과거 잘못 사용된 0xAf2E…를 Arbitrum 값으로 절대 허용하지 않음', () => {
    const r = resolveGmxEventEmitterAddress({
      GMX_EVENT_EMITTER_ADDRESS: '0xAf2E131d483cedE068e21a9228aD91E623a989C2',
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
  });

  it('공식 문서 상수는 Arbitrum 공식 주소(0xC8ee91…)이며 타 체인 주소가 아님', () => {
    expect(ARB_EMITTER.toLowerCase())
      .toBe('0xC8ee91A54287DB53897056e12D9819156D3822Fb'.toLowerCase());
    expect(ARB_EMITTER.toLowerCase()).not.toBe(OTHER_EMITTER.toLowerCase());
    expect(isValidEvmAddress(ARB_EMITTER)).toBe(true);
    // 공식 주소를 env로 설정하면 정상 통과
    const r = resolveGmxEventEmitterAddress({ GMX_EVENT_EMITTER_ADDRESS: ARB_EMITTER } as NodeJS.ProcessEnv);
    expect(r).toEqual({ ok: true, address: ARB_EMITTER, source: 'env' });
  });

  it('타 체인 주소만으로 들어온 로그는 허용 집합에 없으면 무시 (현재 주소로 오인 금지)', () => {
    const legacyOnly = [createdLog(KEY, OTHER_EMITTER)];
    expect(extractOrderKeyFromReceiptLogs(legacyOnly, EMITTERS)).toEqual({ ok: false, reason: 'not_found' });
    expect(classifyOrderResolutionLogs([resolutionLog('OrderExecuted', KEY, OTHER_EMITTER)], KEY, EMITTERS)).toBeNull();
    // 허용 집합에 명시적으로 포함되면(과거 intent 영속값) 정상 처리
    const withLegacy = [...EMITTERS, OTHER_EMITTER];
    expect(extractOrderKeyFromReceiptLogs(legacyOnly, withLegacy))
      .toEqual({ ok: true, orderKey: KEY, emitterAddress: OTHER_EMITTER });
  });
});

describe('gmxOrderEvents — 정확한 EventLog2 signature (topic0)', () => {
  it('topic0이 공식 ABI 파생 signature와 다르면 위조 로그로 차단', () => {
    const forged = [createdLog(KEY, ARB_EMITTER, FAKE_SIG)];
    expect(extractOrderKeyFromReceiptLogs(forged, EMITTERS)).toEqual({ ok: false, reason: 'not_found' });
    const forgedRes = [resolutionLog('OrderExecuted', KEY, ARB_EMITTER, FAKE_SIG)];
    expect(classifyOrderResolutionLogs(forgedRes, KEY, EMITTERS)).toBeNull();
  });

  it('ABI 기반 topic 위치 검증: [sig, eventNameHash, orderKey, account]', () => {
    // viem encodeEventTopics로 공식 ABI에서 topics를 직접 인코딩해 위치를 검증
    const topics = encodeEventTopics({
      abi: [EVENT_LOG_2_ABI],
      eventName: 'EventLog2',
      args: { eventNameHash: 'OrderCreated', topic1: KEY, topic2: ACCT },
    });
    expect(topics[0]).toBe(EVENT_LOG_2_TOPIC0);                              // signature
    expect(topics[1]).toBe(keccak256(toHex('OrderCreated')));                // eventNameHash (indexed string → keccak)
    expect(topics[1]).toBe(ORDER_EVENT_NAME_HASH.OrderCreated);
    expect(String(topics[2]).toLowerCase()).toBe(KEY.toLowerCase());         // topic1 = order key
    expect(String(topics[3]).toLowerCase()).toBe(ACCT.toLowerCase());        // topic2 = account
    // 이 ABI 인코딩 로그가 실제로 파서를 통과하는지 확인
    const log: RawLog = { address: ARB_EMITTER, topics: topics as string[] };
    expect(extractOrderKeyFromReceiptLogs([log], EMITTERS))
      .toEqual({ ok: true, orderKey: KEY.toLowerCase(), emitterAddress: ARB_EMITTER });
  });
});

describe('intentReconciler — emitter 설정·주소 교체 대응', () => {
  it('GMX_EVENT_EMITTER_ADDRESS 형식 오류 → 전원 차단 유지, chainId 조회조차 안 함', async () => {
    const prev = process.env.GMX_EVENT_EMITTER_ADDRESS;
    process.env.GMX_EVENT_EMITTER_ADDRESS = 'invalid';
    try {
      state.blockingRows = [intent()];
      const client = mockClient();
      const r = await reconcileBlockingIntentsOnchain(() => client);
      expect(r.ok).toBe(false);
      expect(r.stillBlocking).toBe(1);
      expect(client.calls.chainId).toBe(0);
      expect(client.calls.receipt).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.GMX_EVENT_EMITTER_ADDRESS;
      else process.env.GMX_EVENT_EMITTER_ADDRESS = prev;
    }
  });

  it('OrderCreated 추출 시 실제 매칭 emitter 주소를 intent 근거로 영속화', async () => {
    state.blockingRows = [intent()];
    const client = mockClient({
      getTransactionReceipt: async () => successReceipt([createdLog()]),
    });
    await reconcileBlockingIntentsOnchain(() => client);
    expect(state.evidenceCalls[0].evidence).toMatchObject({
      orderKey: KEY,
      orderEmitterAddress: ARB_EMITTER,
    });
  });

  it('주소 교체 후에도 intent에 저장된 과거 emitter로 reconcile 가능', async () => {
    const prev = process.env.GMX_EVENT_EMITTER_ADDRESS;
    const newEmitter = '0x' + '55'.repeat(20);
    process.env.GMX_EVENT_EMITTER_ADDRESS = newEmitter; // 교체된 새 주소
    try {
      // 교체 이전에 생성된 intent — 과거 emitter가 영속되어 있음
      state.blockingRows = [intent({
        orderKey: KEY, orderCreatedBlock: '90',
        orderEmitterAddress: ARB_EMITTER,
      })];
      const client = mockClient({
        getOrderResolutionLogs: async (_k: string, _fb: string | null, emitters: string[]) => {
          // 조회 대상 emitter 집합 = 새 설정값 ∪ 저장된 과거 주소
          expect(emitters.map(e => e.toLowerCase())).toEqual(
            expect.arrayContaining([newEmitter.toLowerCase(), ARB_EMITTER.toLowerCase()]));
          // 과거 emitter가 방출한 실행 이벤트
          return [resolutionLog('OrderExecuted', KEY, ARB_EMITTER)];
        },
        getTransactionReceipt: async () => successReceipt([]),
      });
      const r = await reconcileBlockingIntentsOnchain(() => client);
      expect(r.resolutions[0].status).toBe('CONFIRMED');
    } finally {
      if (prev === undefined) delete process.env.GMX_EVENT_EMITTER_ADDRESS;
      else process.env.GMX_EVENT_EMITTER_ADDRESS = prev;
    }
  });

  it('복수의 서로 다른 orderKey OrderCreated 로그 → ambiguous → UNRESOLVED 유지', async () => {
    state.blockingRows = [intent()];
    const client = mockClient({
      getTransactionReceipt: async () => successReceipt([createdLog(), createdLog('0x' + '66'.repeat(32))]),
    });
    const r = await reconcileBlockingIntentsOnchain(() => client);
    expect(r.resolutions).toEqual([]);
    expect(r.stillBlocking).toBe(1);
    expect(state.evidenceCalls[0].evidence.resolutionReason).toContain('ambiguous');
  });
});
