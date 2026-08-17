/**
 * Durable execution intent — liveTestExecutor 통합 테스트 (지시서 필수 실패 구간).
 *
 * 검증:
 *  1. intent INSERT 실패 → writeContract 0회
 *  2. 같은 idempotency key 중복 → 두 번째 writeContract 0회
 *  3. writeContract timeout/unknown 오류 → UNRESOLVED (자동 FAILED 금지)
 *  4. 제출 성공 후 intent SUBMITTED 갱신 실패 → ok=false + 차단 (PREPARED 잔존 전제)
 *  5. 차단 intent 존재 → 중앙 게이트에서 차단, writeContract 0회
 *  6. CLOSE 경로 동일 적용
 *  7. PAPER(LOCKED) 회귀 — intent 미생성
 *  8. 재시작 reconciliation — intent 차단/조회 실패 시 reconciled=false
 *
 * 실제 온체인·DB I/O 없음 (mock 전용).
 */

import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';

// ── @workspace/db 모킹 (감사로그용 worker_state) ──────────────────────────────
const savedValues: { key: string; value: string }[] = [];
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue([]);
const mockValues = vi.fn().mockImplementation((v: { key: string; value: string }) => {
  savedValues.push(v);
  return { onConflictDoUpdate: mockOnConflictDoUpdate };
});
const mockWhere = vi.fn().mockResolvedValue([]);
const mockFrom  = vi.fn().mockReturnValue({ where: mockWhere });

vi.mock('@workspace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: mockFrom }),
    insert: vi.fn().mockReturnValue({ values: mockValues }),
  },
  workerStateTable: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
}));

vi.mock('drizzle-orm', () => ({
  eq:      vi.fn((_col, val) => `eq(${String(val)})`),
  inArray: vi.fn(),
}));

// ── writeContract 스파이 ──────────────────────────────────────────────────────
const writeContractSpy = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('../lib/delegatedSigner', () => {
  return {
    isDelegatedSignerEnabled: vi.fn(() => process.env.DELEGATED_SIGNER_ENABLED === 'true'),
    isSignerInitialized:      vi.fn().mockReturnValue(true),
    getSignerAddress:         vi.fn().mockReturnValue('0xSigner'),
    getSignerWalletClient:    vi.fn().mockReturnValue({
      get writeContract() { return writeContractSpy.fn; },
    }),
    getSignerEthBalance:      vi.fn().mockResolvedValue({ ethWei: 5_000_000_000_000_000n, ethFormatted: '0.005', readyForGas: true }),
  };
});

vi.mock('../lib/gmxSubaccount', () => ({
  checkDelegationStatus: vi.fn().mockResolvedValue({
    isAuthorized: true, remainingActions: 5,
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
    isExpired: false, queryOk: true,
    mainAddress: '0xMain', signerAddress: '0xSigner',
  }),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, encodeFunctionData: vi.fn().mockReturnValue('0xEncoded') };
});

vi.mock('../lib/gmxContracts', () => ({
  USDC_ADDRESS: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  ARB_ADDRESS: '0x912CE59144191C1204E64559FE8253a0e49E6548',
  ZERO_ADDRESS: '0x0', ZERO_BYTES32: '0x0',
  SUBACCOUNT_ROUTER_ABI: [],
  GMX_ORDER_TYPE: { MarketIncrease: 0, MarketDecrease: 2 },
  GMX_DECREASE_SWAP_TYPE: { NoSwap: 0, SwapPnlTokenToCollateralToken: 1 },
  getSubaccountRouterAddress: vi.fn().mockReturnValue('0xRouter'),
  getOrderVaultAddress: vi.fn().mockReturnValue('0xVault'),
  getExecutionFeeWei: vi.fn().mockReturnValue(1_000_000_000_000_000n),
  usdSizeToGmx: vi.fn().mockReturnValue(1n),
  usdToUsdcWei: vi.fn().mockReturnValue(1n),
  acceptablePriceLong: vi.fn().mockReturnValue(1n),
  acceptablePriceShort: vi.fn().mockReturnValue(1n),
  acceptablePriceCloseLong: vi.fn().mockReturnValue(1n),
  acceptablePriceCloseShort: vi.fn().mockReturnValue(1n),
}));

// ── executionIntents 모킹 (상태 주입) ─────────────────────────────────────────
const intentState = vi.hoisted(() => ({
  createResult:    'created' as 'created' | 'duplicate' | 'error',
  blocking:        false,
  reconcile:       { ok: true, blockingCount: 0 },
  markSubmittedOk: true,
}));
const intentMocks = vi.hoisted(() => ({
  createPreparedIntent:         vi.fn(),
  markIntentSubmitted:          vi.fn(),
  markIntentUnresolved:         vi.fn(async () => true),
  markIntentFailedPreBroadcast: vi.fn(async () => true),
  hasBlockingIntents:           vi.fn(),
  reconcileIntentsOnRestart:    vi.fn(),
}));
// 상태 주입형 기본 구현 (beforeEach의 mockClear 이후에도 유지되도록 implementation으로 지정)
intentMocks.createPreparedIntent.mockImplementation(async () => intentState.createResult);
intentMocks.markIntentSubmitted.mockImplementation(async () => intentState.markSubmittedOk);
intentMocks.hasBlockingIntents.mockImplementation(async () => intentState.blocking);
intentMocks.reconcileIntentsOnRestart.mockImplementation(async () => intentState.reconcile);
vi.mock('../lib/executionIntents', () => {
  return {
    buildIntentId: (decisionId: string, orderType: string) => `intent:${orderType}:${decisionId}`,
    createPreparedIntent:         intentMocks.createPreparedIntent,
    markIntentSubmitted:          intentMocks.markIntentSubmitted,
    markIntentUnresolved:         intentMocks.markIntentUnresolved,
    markIntentFailedPreBroadcast: intentMocks.markIntentFailedPreBroadcast,
    hasBlockingIntents:           intentMocks.hasBlockingIntents,
    reconcileIntentsOnRestart:    intentMocks.reconcileIntentsOnRestart,
  };
});
// ── 6G-2 — 공식 GMX API v2 flow 모킹 (제출 결과 주입) ─────────────────────────
const flowState = vi.hoisted(() => ({
  result: {
    submitted: true, prepareCalls: 1, signCalls: 1, submitCalls: 1,
    finalStatus: 'TASK_ACCEPTED', taskRowId: 'task-1', gmxRequestId: 'req-1',
    blockReasons: [] as string[], preBlocked: false,
  } as Record<string, unknown>,
}));
const gmxFlowMocks = vi.hoisted(() => ({
  executeViaGmxApi: vi.fn(),
}));
gmxFlowMocks.executeViaGmxApi.mockImplementation(async () => flowState.result);
vi.mock('../lib/gmxApiExecution', () => ({
  executeViaGmxApi: gmxFlowMocks.executeViaGmxApi,
  buildActivationInput: vi.fn((x: unknown) => x),
}));
// transport는 config-only stub (외부 호출 없음)
vi.mock('../lib/gmxApiTransport', () => ({
  createGmxApiTransport: vi.fn(() => ({ readonlyEnabled: false, submissionEnabled: false, peers: [] })),
}));

// 온체인 reconciler는 별도 테스트(intentReconciler.test.ts)에서 검증 —
// 여기서는 "해소 없음" no-op으로 고정 (차단 유지 시나리오 보존)
vi.mock('../lib/intentReconciler', () => ({
  reconcileBlockingIntentsOnchain: vi.fn(async () => ({
    ok: true, checked: 0, resolutions: [], stillBlocking: 0,
  })),
}));

// ── env ──────────────────────────────────────────────────────────────────────
const ENV_KEYS = [
  'WORKER_ENGINE_MODE', 'LIVE_TEST_EXECUTION_LOCKED', 'DELEGATED_SIGNER_ENABLED', 'GMX_RPC_URL',
  'GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS', 'GMX_EVENT_EMITTER_ADDRESS', 'GMX_DATA_STORE_ADDRESS',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function unlockEnv() {
  process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
  process.env.WORKER_ENGINE_MODE = 'LIVE';
  process.env.DELEGATED_SIGNER_ENABLED = 'true';
  process.env.GMX_RPC_URL = 'https://rpc';
  // 최신 relay 구성 완비 (미완비 시 중앙 게이트에서 차단됨) — 문서 기준 공식 주소
  process.env.GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS = '0x517602BaC704B72993997820981603f5E4901273';
  process.env.GMX_EVENT_EMITTER_ADDRESS = '0xC8ee91A54287DB53897056e12D9819156D3822Fb';
  process.env.GMX_DATA_STORE_ADDRESS = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';
}

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  savedValues.length = 0;
  intentState.createResult    = 'created';
  intentState.blocking        = false;
  intentState.reconcile       = { ok: true, blockingCount: 0 };
  intentState.markSubmittedOk = true;
  writeContractSpy.fn.mockClear();
  writeContractSpy.fn.mockResolvedValue('0xTxSubmitted');
  gmxFlowMocks.executeViaGmxApi.mockClear();
  flowState.result = {
    submitted: true, prepareCalls: 1, signCalls: 1, submitCalls: 1,
    finalStatus: 'TASK_ACCEPTED', taskRowId: 'task-1', gmxRequestId: 'req-1',
    blockReasons: [], preBlocked: false,
  };
  for (const m of Object.values(intentMocks)) m?.mockClear?.();
  // reconciled 상태를 정상으로 초기화 (모듈은 파일 전체에서 공유됨)
  const { reconcileOnRestart } = await import('../workers/liveTestExecutor');
  await reconcileOnRestart();
  savedValues.length = 0;
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function openParams() {
  return {
    decisionId: 'd1', cycleNumber: 1, symbol: 'ETH', marketAddress: '0xM',
    isLong: true, sizeUsd: 10, collateralUsd: 5, leverage: 2,
    currentPriceUsd: 3000, mainAddress: '0xMain', accumLossUsd: 0,
    dbOk: true, openPositionCount: 0, liveTestMode: true,
  };
}
function closeParams() {
  return {
    decisionId: 'c1', cycleNumber: 1, symbol: 'ETH', marketAddress: '0xM',
    isLong: true, sizeUsd: 10, currentPriceUsd: 3000, mainAddress: '0xMain',
    accumLossUsd: 0, dbOk: true, liveTestMode: true,
  };
}

describe('OPEN — durable intent 필수 구간', () => {
  it('정상 경로: PREPARED 커밋 → GMX API 제출 수락 (requestId 기록, intent는 PREPARED 유지)', async () => {
    unlockEnv();
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(openParams());
    expect(r.ok).toBe(true);
    expect(r.txHash).toBeNull();                       // txHash는 reconciler가 온체인 증거로 확보
    expect(r.orderKey).toBe('gmxreq:req-1');
    expect(intentMocks.createPreparedIntent).toHaveBeenCalledTimes(1);
    expect(intentMocks.createPreparedIntent.mock.calls[0][0]).toMatchObject({ id: 'intent:open:d1', orderType: 'open' });
    expect(gmxFlowMocks.executeViaGmxApi).toHaveBeenCalledTimes(1);
    // intent는 PREPARED 유지 — 해소는 gmxApiStatusReconciler가 relay task 증거로 수행
    expect(intentMocks.markIntentSubmitted).not.toHaveBeenCalled();
    // legacy writeContract 경로 도달 0회
    expect(writeContractSpy.fn).not.toHaveBeenCalled();
  });

  it('intent INSERT 실패 → writeContract 0회, ok=false (fail-closed)', async () => {
    unlockEnv();
    intentState.createResult = 'error';
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(openParams());
    expect(r.ok).toBe(false);
    expect(r.txHash).toBeNull();
    expect(r.error).toMatch(/intent 저장 실패/);
    expect(writeContractSpy.fn).not.toHaveBeenCalled();
  });

  it('같은 idempotency key 중복 → 두 번째 writeContract 0회', async () => {
    unlockEnv();
    intentState.createResult = 'duplicate';
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(openParams());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/중복 제출/);
    expect(writeContractSpy.fn).not.toHaveBeenCalled();
  });

  it('제출 결과 불명(UNRESOLVED) → 자동 FAILED 금지 + 신규 주문 차단', async () => {
    unlockEnv();
    flowState.result = {
      submitted: false, prepareCalls: 1, signCalls: 1, submitCalls: 1,
      finalStatus: 'UNRESOLVED', taskRowId: 'task-1', gmxRequestId: null,
      blockReasons: ['submit timeout — 수락 여부 불명'], preBlocked: false,
    };
    const { executeLiveTestOrder, isReconciled } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(openParams());
    expect(r.ok).toBe(false);
    expect(intentMocks.markIntentUnresolved).toHaveBeenCalledWith('intent:open:d1', expect.stringMatching(/timeout/));
    expect(intentMocks.markIntentFailedPreBroadcast).not.toHaveBeenCalled();
    expect(isReconciled()).toBe(false);
    // 감사로그에도 FAILED가 아닌 UNRESOLVED로 기록
    const auditWrites = savedValues.filter(v => v.key === 'orderAuditLog');
    const entries = JSON.parse(auditWrites[auditWrites.length - 1].value) as { status: string }[];
    expect(entries[entries.length - 1].status).toBe('UNRESOLVED');
  });

  it('제출 수락 후 감사로그 저장 실패 → ok=false + 신규 주문 차단 (fail-closed)', async () => {
    unlockEnv();
    // 수락 이후의 감사로그 append만 실패시킨다
    mockOnConflictDoUpdate.mockRejectedValueOnce(new Error('db write failed'));
    const { executeLiveTestOrder, isReconciled } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(openParams());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/감사로그 저장 실패/);
    expect(isReconciled()).toBe(false);
  });

  it('차단 intent 존재 → 중앙 게이트 차단, writeContract 0회', async () => {
    unlockEnv();
    intentState.blocking = true;
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(openParams());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/execution intent/);
    expect(writeContractSpy.fn).not.toHaveBeenCalled();
    expect(intentMocks.createPreparedIntent).not.toHaveBeenCalled();
  });

  it('최신 relay 구성 미완비(라우터/DataStore/emitter 누락) → 중앙 게이트 차단, writeContract 0회', async () => {
    unlockEnv();
    delete process.env.GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS; // 하나만 빠져도 차단
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(openParams());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/relay 구성/);
    expect(writeContractSpy.fn).not.toHaveBeenCalled();
    expect(intentMocks.createPreparedIntent).not.toHaveBeenCalled();
  });

  it('EventEmitter 미설정(기본값 없음) → 중앙 게이트 차단, writeContract 0회', async () => {
    unlockEnv();
    delete process.env.GMX_EVENT_EMITTER_ADDRESS;
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(openParams());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/EventEmitter/);
    expect(writeContractSpy.fn).not.toHaveBeenCalled();
  });
});

describe('CLOSE — 동일 durable intent 경로', () => {
  it('정상 경로: intent:close 키로 PREPARED 커밋 + GMX API 제출 수락', async () => {
    unlockEnv();
    const { closeLiveTestPosition, __setOpenPositionsFetchForTests } = await import('../workers/liveTestExecutor');
    __setOpenPositionsFetchForTests(async () => [{ marketAddress: '0xM', isLong: true, sizeUsd: 10 }]);
    try {
      const r = await closeLiveTestPosition(closeParams());
      expect(r.ok).toBe(true);
      expect(r.orderKey).toBe('gmxreq:req-1');
      expect(intentMocks.createPreparedIntent.mock.calls[0][0]).toMatchObject({ id: 'intent:close:c1', orderType: 'close' });
      expect(intentMocks.markIntentSubmitted).not.toHaveBeenCalled(); // PREPARED 유지
    } finally {
      __setOpenPositionsFetchForTests(null);
    }
  });

  it('intent INSERT 실패 → writeContract 0회', async () => {
    unlockEnv();
    intentState.createResult = 'error';
    const { closeLiveTestPosition } = await import('../workers/liveTestExecutor');
    const r = await closeLiveTestPosition(closeParams());
    expect(r.ok).toBe(false);
    expect(writeContractSpy.fn).not.toHaveBeenCalled();
  });

  it('제출 결과 불명(UNRESOLVED) → 자동 FAILED 금지', async () => {
    unlockEnv();
    flowState.result = {
      submitted: false, prepareCalls: 1, signCalls: 1, submitCalls: 1,
      finalStatus: 'UNRESOLVED', taskRowId: 'task-1', gmxRequestId: null,
      blockReasons: ['submit 응답 유실(ECONNRESET) — 수락 여부 불명'], preBlocked: false,
    };
    const { closeLiveTestPosition, __setOpenPositionsFetchForTests } = await import('../workers/liveTestExecutor');
    __setOpenPositionsFetchForTests(async () => [{ marketAddress: '0xM', isLong: true, sizeUsd: 10 }]);
    try {
      const r = await closeLiveTestPosition(closeParams());
      expect(r.ok).toBe(false);
      expect(intentMocks.markIntentUnresolved).toHaveBeenCalledWith('intent:close:c1', expect.stringMatching(/ECONNRESET/));
      expect(intentMocks.markIntentFailedPreBroadcast).not.toHaveBeenCalled();
    } finally {
      __setOpenPositionsFetchForTests(null);
    }
  });
});

describe('PAPER(LOCKED) 회귀 — intent 미생성', () => {
  it('기본 잠금 상태에서는 intent 생성·writeContract 모두 0회', async () => {
    // env 미설정 = LOCKED 기본값
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(openParams());
    expect(r.simulated).toBe(true);
    expect(intentMocks.createPreparedIntent).not.toHaveBeenCalled();
    expect(writeContractSpy.fn).not.toHaveBeenCalled();
  });
});

describe('재시작 reconciliation — intent 검사', () => {
  it('차단 intent 존재 → reconciled=false 유지', async () => {
    intentState.reconcile = { ok: true, blockingCount: 2 };
    intentState.blocking  = true; // 온체인 판정 후에도 잔존
    const { reconcileOnRestart, isReconciled } = await import('../workers/liveTestExecutor');
    await reconcileOnRestart();
    expect(isReconciled()).toBe(false);
    const reconWrites = savedValues.filter(v => v.key === 'liveTestReconciled');
    expect(reconWrites[reconWrites.length - 1].value).toBe('false');
  });

  it('intent 조회 실패 → reconciled=false (fail-closed)', async () => {
    intentState.reconcile = { ok: false, blockingCount: -1 };
    const { reconcileOnRestart, isReconciled } = await import('../workers/liveTestExecutor');
    await reconcileOnRestart();
    expect(isReconciled()).toBe(false);
  });

  it('차단 intent 없음 → reconciled=true', async () => {
    const { reconcileOnRestart, isReconciled } = await import('../workers/liveTestExecutor');
    await reconcileOnRestart();
    expect(isReconciled()).toBe(true);
  });
});
