/**
 * liveTestExecutor.ts 단위 테스트
 *
 * LIVE_TEST_EXECUTION_LOCKED=true (기본값) 상태에서의 시뮬레이션 경로를 검증.
 * 실제 온체인 트랜잭션 없음.
 *
 * 모킹 대상:
 *   - @workspace/db (DB I/O 없음)
 *   - delegatedSigner (사이너 상태 주입)
 *   - gmxSubaccount (위임 상태 주입)
 */

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';

// ── @workspace/db 모킹 ────────────────────────────────────────────────────────
const mockWhere    = vi.fn().mockResolvedValue([]);
const mockFrom     = vi.fn().mockReturnValue({ where: mockWhere });
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue([]);
const mockValues   = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
const mockInsert   = vi.fn().mockReturnValue({ values: mockValues });
const mockSelect   = vi.fn().mockReturnValue({ from: mockFrom });

vi.mock('@workspace/db', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
  },
  workerStateTable: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => `eq(${String(val)})`),
}));

// ── delegatedSigner 모킹 ─────────────────────────────────────────────────────
const MOCK_SIGNER = '0xSignerAddr1234567890123456789012345678';

vi.mock('../lib/delegatedSigner', () => ({
  isDelegatedSignerEnabled: vi.fn(() => process.env.DELEGATED_SIGNER_ENABLED === 'true'),
  isSignerInitialized:   vi.fn().mockReturnValue(true),
  getSignerAddress:      vi.fn().mockReturnValue(MOCK_SIGNER),
  getSignerWalletClient: vi.fn().mockReturnValue({
    writeContract: vi.fn().mockResolvedValue('0xMockTxHash'),
  }),
  getSignerEthBalance: vi.fn().mockResolvedValue({
    ethWei:      BigInt('5000000000000000'),
    ethFormatted: '0.005',
    readyForGas:  true,
  }),
}));

// ── gmxSubaccount 모킹 ───────────────────────────────────────────────────────
vi.mock('../lib/gmxSubaccount', () => ({
  checkDelegationStatus: vi.fn().mockResolvedValue({
    isAuthorized:     true,
    remainingActions: 5,
    expiresAtUnix:    Math.floor(Date.now() / 1000) + 3600,
    isExpired:        false,
    queryOk:          true,
    mainAddress:      '0xMainAddr12345678901234567890123456789',
    signerAddress:    MOCK_SIGNER,
  }),
}));

// ── gmxContracts 모킹 ────────────────────────────────────────────────────────
vi.mock('../lib/gmxContracts', () => ({
  USDC_ADDRESS:              '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  ARB_ADDRESS:               '0x912CE59144191C1204E64559FE8253a0e49E6548',
  ZERO_ADDRESS:              '0x0000000000000000000000000000000000000000',
  ZERO_BYTES32:              '0x0000000000000000000000000000000000000000000000000000000000000000',
  SUBACCOUNT_ROUTER_ABI:     [],
  GMX_ORDER_TYPE:            { MarketIncrease: 0, MarketDecrease: 2 },
  GMX_DECREASE_SWAP_TYPE:    { NoSwap: 0 },
  getSubaccountRouterAddress: vi.fn().mockReturnValue('0xSubaccountRouter'),
  getOrderVaultAddress:       vi.fn().mockReturnValue('0xOrderVault'),
  getExecutionFeeWei:         vi.fn().mockReturnValue(BigInt('1000000000000000')),
  usdSizeToGmx:               vi.fn().mockReturnValue(BigInt('10000000000000000000000000000000')),
  usdToUsdcWei:               vi.fn().mockReturnValue(BigInt('5000000')),
  acceptablePriceLong:        vi.fn().mockReturnValue(BigInt('50000000000000000000000000000000')),
  acceptablePriceShort:       vi.fn().mockReturnValue(BigInt('45000000000000000000000000000000')),
  acceptablePriceCloseLong:   vi.fn().mockReturnValue(BigInt('45000000000000000000000000000000')),
  acceptablePriceCloseShort:  vi.fn().mockReturnValue(BigInt('50000000000000000000000000000000')),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, encodeFunctionData: vi.fn().mockReturnValue('0xEncoded') };
});

// ── 환경변수: LOCKED=true (기본값) ────────────────────────────────────────────
// 명시적으로 삭제하여 기본 잠금 상태 유지
beforeAll(() => { delete process.env.LIVE_TEST_EXECUTION_LOCKED; });
afterAll(()  => { delete process.env.LIVE_TEST_EXECUTION_LOCKED; });

const MOCK_MARKET = '0xMarket1234567890123456789012345678901';
const MOCK_MAIN   = '0xMainAddr12345678901234567890123456789';

function baseParams() {
  return {
    decisionId:        'test-decision-001',
    cycleNumber:       1,
    symbol:            'ETH',
    marketAddress:     MOCK_MARKET,
    isLong:            true as const,
    sizeUsd:           10,
    collateralUsd:     5,
    leverage:          2,
    currentPriceUsd:   3000,
    mainAddress:       MOCK_MAIN,
    accumLossUsd:      0,
    dbOk:              true,
    openPositionCount: 0,
    liveTestMode:      true,
  };
}

// ── 테스트 ──────────────────────────────────────────────────────────────────

describe('executeLiveTestOrder — LOCKED 상태 시뮬레이션', () => {
  it('기본 잠금 상태에서 simulated=true, ok=true, txHash=null', async () => {
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const result = await executeLiveTestOrder(baseParams());

    expect(result.simulated).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.txHash).toBeNull();
    expect(result.orderKey).toBeNull();
  });

  it('누적 손실 $3 초과 + LOCKED → simulated=true (잠금이 게이트보다 먼저 적용)', async () => {
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const result = await executeLiveTestOrder({ ...baseParams(), accumLossUsd: 3.5 });
    expect(result.simulated).toBe(true);
  });

  it('포지션 수 1 + LOCKED → simulated=true', async () => {
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const result = await executeLiveTestOrder({ ...baseParams(), openPositionCount: 1 });
    expect(result.simulated).toBe(true);
  });

  it('dbOk=false + LOCKED → simulated=true', async () => {
    const { executeLiveTestOrder } = await import('../workers/liveTestExecutor');
    const result = await executeLiveTestOrder({ ...baseParams(), dbOk: false });
    expect(result.simulated).toBe(true);
  });
});

describe('closeLiveTestPosition — LOCKED 상태 시뮬레이션', () => {
  it('LOCKED 상태에서 simulated=true, ok=true', async () => {
    const { closeLiveTestPosition } = await import('../workers/liveTestExecutor');
    const result = await closeLiveTestPosition({
      decisionId:      'close-001',
      cycleNumber:     1,
      symbol:          'ETH',
      marketAddress:   MOCK_MARKET,
      isLong:          true,
      sizeUsd:         10,
      currentPriceUsd: 3000,
      mainAddress:     MOCK_MAIN,
      accumLossUsd:    0,
      dbOk:            true,
      liveTestMode:    true,
    });

    expect(result.simulated).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.txHash).toBeNull();
  });
});

describe('setEmergencyStop', () => {
  it('emergencyStop 활성화 → 이후 주문이 error=Emergency Stop으로 차단된다', async () => {
    const { setEmergencyStop, executeLiveTestOrder, isEmergencyStopActive } =
      await import('../workers/liveTestExecutor');

    await setEmergencyStop('테스트 비상정지');
    expect(isEmergencyStopActive()).toBe(true);

    const result = await executeLiveTestOrder(baseParams());
    // Emergency Stop은 LOCKED 이전에 확인 → ok=false, simulated=false
    expect(result.ok).toBe(false);
    expect(result.simulated).toBe(false);
    expect(result.error).toMatch(/Emergency Stop|비상/i);
  });
});

describe('reconcileOnRestart', () => {
  it('재시작 reconciliation이 오류 없이 완료된다', async () => {
    const { reconcileOnRestart } = await import('../workers/liveTestExecutor');
    await expect(reconcileOnRestart()).resolves.not.toThrow();
  });
});

describe('getAuditLog', () => {
  it('감사로그 조회가 배열을 반환한다', async () => {
    const { getAuditLog } = await import('../workers/liveTestExecutor');
    const log = await getAuditLog();
    expect(Array.isArray(log)).toBe(true);
  });
});
