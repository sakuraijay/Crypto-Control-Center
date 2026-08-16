/**
 * Publish 전 실행 안전성 보강 테스트
 *
 * 1. checkCentralExecutionGate — writeContract 직전 중앙 fail-closed 게이트
 * 2. reconcileOnRestart — SUBMITTED → UNRESOLVED (임의 FAILED 금지, txHash 보존)
 *
 * 실제 온체인·DB I/O 없음 (mock 전용).
 */

import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';

// ── @workspace/db 모킹 (감사로그 상태 주입 가능) ───────────────────────────────
let auditLogRows: { value: string }[] = [];
const savedValues: { key: string; value: string }[] = [];

let failAuditInsert = false;
let failAuditSelect = false;

const mockOnConflictDoUpdate = vi.fn().mockResolvedValue([]);
const mockValues = vi.fn().mockImplementation((v: { key: string; value: string }) => {
  if (failAuditInsert && v.key === 'orderAuditLog') throw new Error('DB write failed');
  savedValues.push(v);
  return { onConflictDoUpdate: mockOnConflictDoUpdate };
});
const mockWhere  = vi.fn().mockImplementation(() => {
  if (failAuditSelect) return Promise.reject(new Error('DB read failed'));
  return Promise.resolve(auditLogRows);
});
const mockFrom   = vi.fn().mockReturnValue({ where: mockWhere });

vi.mock('@workspace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: mockFrom }),
    insert: vi.fn().mockReturnValue({ values: mockValues }),
  },
  workerStateTable: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => `eq(${String(val)})`),
  inArray: vi.fn(),
}));

// ── executionIntents 모킹 (durable intent 상태 주입 가능) ─────────────────────
const intentState = vi.hoisted(() => ({
  createResult: 'created' as 'created' | 'duplicate' | 'error',
  blocking:     false,
  reconcile:    { ok: true, blockingCount: 0 },
  markSubmittedOk: true,
}));
const intentMocks = vi.hoisted(() => ({
  createPreparedIntent:        undefined as unknown as ReturnType<typeof vi.fn>,
  markIntentSubmitted:         undefined as unknown as ReturnType<typeof vi.fn>,
  markIntentUnresolved:        undefined as unknown as ReturnType<typeof vi.fn>,
  markIntentFailedPreBroadcast: undefined as unknown as ReturnType<typeof vi.fn>,
  hasBlockingIntents:          undefined as unknown as ReturnType<typeof vi.fn>,
  reconcileIntentsOnRestart:   undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('../lib/executionIntents', () => {
  intentMocks.createPreparedIntent         = vi.fn(async () => intentState.createResult);
  intentMocks.markIntentSubmitted          = vi.fn(async () => intentState.markSubmittedOk);
  intentMocks.markIntentUnresolved         = vi.fn(async () => true);
  intentMocks.markIntentFailedPreBroadcast = vi.fn(async () => true);
  intentMocks.hasBlockingIntents           = vi.fn(async () => intentState.blocking);
  intentMocks.reconcileIntentsOnRestart    = vi.fn(async () => intentState.reconcile);
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

vi.mock('../lib/delegatedSigner', () => ({
  isDelegatedSignerEnabled: vi.fn(() => process.env.DELEGATED_SIGNER_ENABLED === 'true'),
  isSignerInitialized:      vi.fn().mockReturnValue(true),
  getSignerAddress:         vi.fn().mockReturnValue('0xSigner'),
  getSignerWalletClient:    vi.fn().mockReturnValue({
    writeContract: vi.fn().mockResolvedValue('0xTxSubmitted'),
  }),
  getSignerEthBalance:      vi.fn().mockResolvedValue({ ethWei: 5_000_000_000_000_000n, ethFormatted: '0.005', readyForGas: true }),
}));

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
  getSubaccountRouterAddress: vi.fn(), getOrderVaultAddress: vi.fn(),
  getExecutionFeeWei: vi.fn(), usdSizeToGmx: vi.fn(), usdToUsdcWei: vi.fn(),
  acceptablePriceLong: vi.fn(), acceptablePriceShort: vi.fn(),
  acceptablePriceCloseLong: vi.fn(), acceptablePriceCloseShort: vi.fn(),
}));

// ── env 초기화 ────────────────────────────────────────────────────────────────
const ENV_KEYS = [
  'WORKER_ENGINE_MODE', 'LIVE_TEST_EXECUTION_LOCKED', 'DELEGATED_SIGNER_ENABLED', 'GMX_RPC_URL',
  'GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS', 'GMX_EVENT_EMITTER_ADDRESS', 'GMX_DATA_STORE_ADDRESS',
] as const;

// legacy 주문 경로 Production 차단 가드 (gmxDelegatedTrading.test.ts에서 이동 —
// liveTestExecutor는 lib/db를 끌어와 mock 하네스가 필요)
describe('legacy SubaccountRouter 주문 경로 — Production 차단', () => {
  it('테스트 환경에서는 통과, 비테스트 환경에서는 throw', async () => {
    const { assertLegacyOrderPathAllowed } = await import('../workers/liveTestExecutor');
    expect(() => assertLegacyOrderPathAllowed()).not.toThrow(); // vitest 환경

    const prevNodeEnv = process.env.NODE_ENV;
    const prevVitest  = process.env.VITEST;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.VITEST;
      expect(() => assertLegacyOrderPathAllowed()).toThrow(/DEPRECATED/);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
      if (prevVitest === undefined) delete process.env.VITEST; else process.env.VITEST = prevVitest;
    }
  });
});

/** 최신 relay 구성 완비 (게이트 통과 시나리오용) — 문서 기준 공식 Arbitrum 주소 */
function setRelayEnv() {
  process.env.GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS = '0x517602BaC704B72993997820981603f5E4901273';
  process.env.GMX_EVENT_EMITTER_ADDRESS = '0xC8ee91A54287DB53897056e12D9819156D3822Fb';
  process.env.GMX_DATA_STORE_ADDRESS = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';
}
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  auditLogRows = [];
  savedValues.length = 0;
  failAuditInsert = false;
  failAuditSelect = false;
  intentState.createResult    = 'created';
  intentState.blocking        = false;
  intentState.reconcile       = { ok: true, blockingCount: 0 };
  intentState.markSubmittedOk = true;
  for (const m of Object.values(intentMocks)) m?.mockClear?.();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── 중앙 게이트 입력 헬퍼 ─────────────────────────────────────────────────────
function allowInput() {
  return {
    workerEngineMode:       'LIVE',
    liveTestMode:           true,
    delegatedSignerEnabled: true,
    emergencyStop:          false,
    signerInitialized:      true,
    dbOk:                   true,
    rpcOk:                  true,
    reconciled:             true,
    noBlockingIntents:      true,
    eventEmitterConfigured: true,
    relayConfigured:        true,
  };
}

describe('checkCentralExecutionGate — fail-closed 조합', () => {
  it('모든 조건 충족 + LOCKED=false → 허용', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    const r = checkCentralExecutionGate(allowInput());
    expect(r.allowed).toBe(true);
  });

  it('환경 전부 미설정(기본값) → 차단', async () => {
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    const r = checkCentralExecutionGate({ ...allowInput(), workerEngineMode: undefined });
    expect(r.allowed).toBe(false);
  });

  it('WORKER_ENGINE_MODE=PAPER → 차단 (unlock돼 있어도)', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    const r = checkCentralExecutionGate({ ...allowInput(), workerEngineMode: 'PAPER' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/WORKER_ENGINE_MODE/);
  });

  it('liveTestMode=false → 차단', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    expect(checkCentralExecutionGate({ ...allowInput(), liveTestMode: false }).allowed).toBe(false);
  });

  it('LIVE_TEST_EXECUTION_LOCKED 미설정(기본 잠금) → 차단', async () => {
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    const r = checkCentralExecutionGate(allowInput());
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/LOCKED/);
  });

  it('DELEGATED_SIGNER_ENABLED 비활성 → 차단', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    const r = checkCentralExecutionGate({ ...allowInput(), delegatedSignerEnabled: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/DELEGATED_SIGNER_ENABLED/);
  });

  it('Emergency Stop 활성 → 차단', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    expect(checkCentralExecutionGate({ ...allowInput(), emergencyStop: true }).allowed).toBe(false);
  });

  it('signer 미초기화 → 차단', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    expect(checkCentralExecutionGate({ ...allowInput(), signerInitialized: false }).allowed).toBe(false);
  });

  it('dbOk=false / rpcOk=false / reconciled=false → 각각 차단', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    expect(checkCentralExecutionGate({ ...allowInput(), dbOk: false }).allowed).toBe(false);
    expect(checkCentralExecutionGate({ ...allowInput(), rpcOk: false }).allowed).toBe(false);
    expect(checkCentralExecutionGate({ ...allowInput(), reconciled: false }).allowed).toBe(false);
  });

  it('eventEmitterConfigured=false → 차단 (기본값 없음, 미설정 시 fail-closed)', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    const r = checkCentralExecutionGate({ ...allowInput(), eventEmitterConfigured: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/EventEmitter/);
  });

  it('relayConfigured=false → 차단 (legacy 라우터만 설정된 상태로는 LIVE 불가)', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    const { checkCentralExecutionGate } = await import('../lib/liveTestGate');
    const r = checkCentralExecutionGate({ ...allowInput(), relayConfigured: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/relay 구성/);
  });
});

describe('executeLiveTestOrder — 중앙 게이트 통합 (writeContract 도달 차단)', () => {
  function orderParams() {
    return {
      decisionId: 'd1', cycleNumber: 1, symbol: 'ETH', marketAddress: '0xM',
      isLong: true, sizeUsd: 10, collateralUsd: 5, leverage: 2,
      currentPriceUsd: 3000, mainAddress: '0xMain', accumLossUsd: 0,
      dbOk: true, openPositionCount: 0, liveTestMode: true,
    };
  }

  it('unlock돼 있어도 PAPER 모드면 실제 실행 차단 (simulated=false, ok=false)', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    process.env.WORKER_ENGINE_MODE = 'PAPER';
    process.env.DELEGATED_SIGNER_ENABLED = 'true';
    process.env.GMX_RPC_URL = 'https://rpc';
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(orderParams());
    expect(r.ok).toBe(false);
    expect(r.txHash).toBeNull();
    expect(r.error).toMatch(/CENTRAL GATE/);
  });

  it('unlock + LIVE여도 DELEGATED_SIGNER_ENABLED 미설정이면 차단', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    process.env.WORKER_ENGINE_MODE = 'LIVE';
    process.env.GMX_RPC_URL = 'https://rpc';
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder(orderParams());
    expect(r.ok).toBe(false);
    expect(r.txHash).toBeNull();
    expect(r.error).toMatch(/DELEGATED_SIGNER_ENABLED/);
  });

  it('unlock + LIVE + signer 활성이어도 liveTestMode=false면 차단', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    process.env.WORKER_ENGINE_MODE = 'LIVE';
    process.env.DELEGATED_SIGNER_ENABLED = 'true';
    process.env.GMX_RPC_URL = 'https://rpc';
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const r = await executeLiveTestOrder({ ...orderParams(), liveTestMode: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/liveTestMode/);
  });

  it('차단 사유가 감사로그(FAILED)로 기록된다', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    process.env.WORKER_ENGINE_MODE = 'PAPER';
    process.env.GMX_RPC_URL = 'https://rpc';
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    await executeLiveTestOrder(orderParams());
    const auditWrites = savedValues.filter(v => v.key === 'orderAuditLog');
    expect(auditWrites.length).toBeGreaterThan(0);
    const entries = JSON.parse(auditWrites[auditWrites.length - 1].value) as { status: string; error: string }[];
    const last = entries[entries.length - 1];
    expect(last.status).toBe('FAILED');
    expect(last.error).toMatch(/CENTRAL GATE/);
  });

  it('주문 제출 후 SUBMITTED 감사기록 저장 실패 → ok=false + 신규 주문 차단 (fail-closed)', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    process.env.WORKER_ENGINE_MODE = 'LIVE';
    process.env.DELEGATED_SIGNER_ENABLED = 'true';
    process.env.GMX_RPC_URL = 'https://rpc';
    setRelayEnv(); // 최신 relay 구성 없이는 중앙 게이트에서 차단되므로 완비 상태로 설정
    const { executeLiveTestOrder, reconcileOnRestart, isReconciled } =
      await import('../workers/liveTestExecutor');

    // 사전: 빈 감사로그로 reconciliation 완료 → 게이트 통과 가능 상태
    await reconcileOnRestart();
    expect(isReconciled()).toBe(true);

    failAuditInsert = true; // writeContract 성공 후 감사기록 저장만 실패
    const r = await executeLiveTestOrder(orderParams());

    expect(r.txHash).toBe('0xTxSubmitted');       // 제출 자체는 발생
    expect(r.ok).toBe(false);                      // 성공으로 보고하지 않음
    expect(r.error).toMatch(/영속 기록 저장 실패/);
    expect(isReconciled()).toBe(false);            // 이후 신규 주문 차단

    // 차단 검증: 다음 주문은 중앙 게이트(reconciled)에서 거부
    failAuditInsert = false;
    const r2 = await executeLiveTestOrder(orderParams());
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/reconciliation/);
  });

  it('closeLiveTestPosition도 동일 중앙 게이트로 차단된다', async () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
    process.env.WORKER_ENGINE_MODE = 'PAPER';
    process.env.GMX_RPC_URL = 'https://rpc';
    const { closeLiveTestPosition } = await import('../workers/liveTestExecutor');
    const r = await closeLiveTestPosition({
      decisionId: 'c1', cycleNumber: 1, symbol: 'ETH', marketAddress: '0xM',
      isLong: true, sizeUsd: 10, currentPriceUsd: 3000, mainAddress: '0xMain',
      accumLossUsd: 0, dbOk: true, liveTestMode: true,
    });
    expect(r.ok).toBe(false);
    expect(r.txHash).toBeNull();
    expect(r.error).toMatch(/CENTRAL GATE/);
  });
});

describe('reconcileOnRestart — fail-closed (UNRESOLVED)', () => {
  function submittedEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: 'a1', decisionId: 'd1', cycleNumber: 1, symbol: 'ETH',
      orderType: 'MarketIncrease', isLong: true, sizeUsd: 10, collateralUsd: 5,
      txHash: '0xTxHashPreserved', orderKey: null, status: 'SUBMITTED',
      error: null, simulated: false, gateChecks: {},
      submittedAt: '2026-08-15T00:00:00.000Z', confirmedAt: null,
      ...overrides,
    };
  }

  it('SUBMITTED 주문은 FAILED가 아닌 UNRESOLVED로 마킹되고 txHash가 보존된다', async () => {
    auditLogRows = [{ value: JSON.stringify([submittedEntry()]) }];
    const { reconcileOnRestart, isReconciled } = await import('../workers/liveTestExecutor');
    await reconcileOnRestart();

    const auditWrites = savedValues.filter(v => v.key === 'orderAuditLog');
    expect(auditWrites.length).toBe(1);
    const entries = JSON.parse(auditWrites[0].value) as { status: string; txHash: string | null }[];
    expect(entries[0].status).toBe('UNRESOLVED');
    expect(entries[0].txHash).toBe('0xTxHashPreserved');

    // 상태불명 주문 존재 → reconciled=false 유지 (신규 주문 차단)
    expect(isReconciled()).toBe(false);
    const reconWrites = savedValues.filter(v => v.key === 'liveTestReconciled');
    expect(reconWrites[reconWrites.length - 1].value).toBe('false');
  });

  it('기존 UNRESOLVED 주문이 남아 있으면 reconciled=false 유지', async () => {
    auditLogRows = [{ value: JSON.stringify([submittedEntry({ status: 'UNRESOLVED' })]) }];
    const { reconcileOnRestart, isReconciled, hasUnresolvedOrders } =
      await import('../workers/liveTestExecutor');
    await reconcileOnRestart();
    expect(isReconciled()).toBe(false);
    expect(await hasUnresolvedOrders()).toBe(true);
  });

  it('상태불명 주문이 없으면 reconciled=true', async () => {
    auditLogRows = [{ value: JSON.stringify([submittedEntry({ status: 'CONFIRMED' }), submittedEntry({ id: 'a2', status: 'FAILED' })]) }];
    const { reconcileOnRestart, isReconciled } = await import('../workers/liveTestExecutor');
    await reconcileOnRestart();
    expect(isReconciled()).toBe(true);
    const reconWrites = savedValues.filter(v => v.key === 'liveTestReconciled');
    expect(reconWrites[reconWrites.length - 1].value).toBe('true');
  });

  it('감사로그 로드 실패 시 reconciled=false 유지 (빈 로그로 오인 금지)', async () => {
    failAuditSelect = true;
    const { reconcileOnRestart, isReconciled, hasUnresolvedOrders } =
      await import('../workers/liveTestExecutor');
    await reconcileOnRestart();
    expect(isReconciled()).toBe(false);
    // 로드 실패 시 상태불명으로 간주 (fail-closed)
    expect(await hasUnresolvedOrders()).toBe(true);
  });

  it('감사로그에 SUBMITTED가 있어도 durable intent reconciliation은 먼저 수행된다', async () => {
    auditLogRows = [{ value: JSON.stringify([submittedEntry()]) }];
    const { reconcileOnRestart, isReconciled } = await import('../workers/liveTestExecutor');
    await reconcileOnRestart();
    // 조기 반환(SUBMITTED 존재)과 무관하게 PREPARED→UNRESOLVED 전환이 호출됨
    expect(intentMocks.reconcileIntentsOnRestart).toHaveBeenCalledTimes(1);
    expect(isReconciled()).toBe(false);
  });

  it('감사로그는 깨끗해도 durable intent가 차단 상태면 reconciled=false', async () => {
    intentState.reconcile = { ok: true, blockingCount: 1 };
    const { reconcileOnRestart, isReconciled } = await import('../workers/liveTestExecutor');
    await reconcileOnRestart();
    expect(isReconciled()).toBe(false);
  });

  it('PAPER 모드 감사로그(SIMULATED)는 영향받지 않는다', async () => {
    auditLogRows = [{ value: JSON.stringify([submittedEntry({ status: 'SIMULATED', simulated: true, txHash: null })]) }];
    const { reconcileOnRestart, isReconciled } = await import('../workers/liveTestExecutor');
    await reconcileOnRestart();
    expect(isReconciled()).toBe(true);
    // SIMULATED 항목은 재작성되지 않음 (audit log 쓰기는 SUBMITTED 존재 시에만)
    expect(savedValues.filter(v => v.key === 'orderAuditLog').length).toBe(0);
  });
});
