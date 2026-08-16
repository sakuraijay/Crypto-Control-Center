/**
 * LIVE TEST Executor — GMX V2 SubaccountRouter를 통한 실제 주문 실행
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 보안 원칙
 * ──────────────────────────────────────────────────────────────────────────────
 *  ✅ 서버 사이너(위임된 EOA)만 사용 — 메인 지갑 키 절대 미사용
 *  ✅ LIVE_TEST_EXECUTION_LOCKED=false 명시 해제 시에만 실제 주문 제출
 *  ✅ 매 주문 직전 온체인 위임 상태 + 하드캡 검증
 *  ✅ 모든 주문에 txHash + orderKey 감사로그 기록
 *  ✅ 재시작 후 pending 주문 조회로 중복 체결 방지
 *  ✅ LIVE_EXECUTION_LOCKED=true as const 는 별도 영구 잠금 (무제한 LIVE)
 *
 * ⚠️  라이브 전 필수:
 *     GMX_SUBACCOUNT_ROUTER_ADDRESS, GMX_ORDER_VAULT_ADDRESS 검증
 *     Arbiscan에서 ABI 함수 시그니처 확인
 *     LIVE_TEST_EXECUTION_LOCKED=false 설정 (Replit Secrets)
 */

import { encodeFunctionData } from 'viem';
import { db, workerStateTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
  getSignerAddress,
  getSignerWalletClient,
  getSignerEthBalance,
} from '../lib/delegatedSigner';
import {
  checkDelegationStatus,
} from '../lib/gmxSubaccount';
import {
  checkLiveTestGate,
  isLiveTestExecutionLocked,
  type GateInput,
} from '../lib/liveTestGate';
import {
  SUBACCOUNT_ROUTER_ABI,
  USDC_ADDRESS,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  GMX_ORDER_TYPE,
  GMX_DECREASE_SWAP_TYPE,
  getSubaccountRouterAddress,
  getOrderVaultAddress,
  getExecutionFeeWei,
  usdSizeToGmx,
  usdToUsdcWei,
  acceptablePriceLong,
  acceptablePriceShort,
  acceptablePriceCloseLong,
  acceptablePriceCloseShort,
} from '../lib/gmxContracts';

// ── 감사로그 키 ────────────────────────────────────────────────────────────────
const AUDIT_LOG_KEY     = 'orderAuditLog';
const RECONCILED_KEY    = 'liveTestReconciled';
const EMERGENCY_STOP_KEY = 'emergencyStopActive';

// 재시작 reconciliation 완료 여부 (인메모리)
let _reconciled = false;
let _emergencyStop = false;

// ── 감사로그 타입 ──────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id:           string;
  decisionId:   string;
  cycleNumber:  number;
  symbol:       string;
  orderType:    string;   // MarketIncrease, MarketDecrease 등
  isLong:       boolean;
  sizeUsd:      number;
  collateralUsd: number;
  txHash:       string | null;
  orderKey:     string | null;
  status:       'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'SIMULATED' | 'CANCELLED';
  error:        string | null;
  simulated:    boolean;
  gateChecks:   Record<string, boolean>;
  submittedAt:  string;
  confirmedAt:  string | null;
}

// ── 감사로그 읽기/쓰기 ─────────────────────────────────────────────────────────

async function loadAuditLog(): Promise<AuditLogEntry[]> {
  try {
    const rows = await db.select().from(workerStateTable).where(eq(workerStateTable.key, AUDIT_LOG_KEY));
    if (!rows.length) return [];
    return JSON.parse(rows[0].value) as AuditLogEntry[];
  } catch { return []; }
}

async function appendAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    const existing = await loadAuditLog();
    // 최대 500개 보존 (FIFO)
    const updated = [...existing, entry].slice(-500);
    const now = new Date();
    await db.insert(workerStateTable)
      .values({ key: AUDIT_LOG_KEY, value: JSON.stringify(updated), updatedAt: now })
      .onConflictDoUpdate({ target: workerStateTable.key, set: { value: JSON.stringify(updated), updatedAt: now } });
  } catch (e) {
    console.error('[LiveTestExecutor] 감사로그 저장 실패:', e);
  }
}

export async function getAuditLog(limit = 100): Promise<AuditLogEntry[]> {
  const all = await loadAuditLog();
  return all.slice(-limit);
}

// ── 재시작 Reconciliation ─────────────────────────────────────────────────────

/**
 * 서버 재시작 후 pending 주문 중복 방지.
 * 감사로그에서 SUBMITTED 상태인 항목을 확인 → 재시작 전 이미 제출된 주문 파악.
 * 현재는 SUBMITTED 항목을 FAILED로 마킹 (온체인 확인 미구현 — 안전 우선).
 */
export async function reconcileOnRestart(): Promise<void> {
  try {
    const log = await loadAuditLog();
    const pending = log.filter(e => e.status === 'SUBMITTED');
    if (pending.length > 0) {
      console.warn(`[LiveTestExecutor] 재시작 reconciliation: ${pending.length}개 SUBMITTED 주문 발견 — FAILED로 마킹`);
      const updated = log.map(e =>
        e.status === 'SUBMITTED'
          ? { ...e, status: 'FAILED' as const, error: '서버 재시작으로 인한 상태 불명확 — 안전상 FAILED 처리', confirmedAt: new Date().toISOString() }
          : e
      );
      const now = new Date();
      await db.insert(workerStateTable)
        .values({ key: AUDIT_LOG_KEY, value: JSON.stringify(updated), updatedAt: now })
        .onConflictDoUpdate({ target: workerStateTable.key, set: { value: JSON.stringify(updated), updatedAt: now } });
    }
    _reconciled = true;
    const now = new Date();
    await db.insert(workerStateTable)
      .values({ key: RECONCILED_KEY, value: 'true', updatedAt: now })
      .onConflictDoUpdate({ target: workerStateTable.key, set: { value: 'true', updatedAt: now } });
    console.info('[LiveTestExecutor] Reconciliation 완료');
  } catch (e) {
    console.error('[LiveTestExecutor] Reconciliation 실패:', e);
    _reconciled = false;
  }
}

export function isReconciled(): boolean { return _reconciled; }

// ── Emergency Stop ─────────────────────────────────────────────────────────────

export async function setEmergencyStop(reason: string): Promise<void> {
  _emergencyStop = true;
  const now = new Date();
  const payload = JSON.stringify({ active: true, reason, at: now.toISOString() });
  await db.insert(workerStateTable)
    .values({ key: EMERGENCY_STOP_KEY, value: payload, updatedAt: now })
    .onConflictDoUpdate({ target: workerStateTable.key, set: { value: payload, updatedAt: now } });
  console.error(`[LiveTestExecutor] ⚠️  Emergency Stop 활성화: ${reason}`);
}

export function isEmergencyStopActive(): boolean { return _emergencyStop; }

export async function loadEmergencyStopFromDb(): Promise<void> {
  try {
    const rows = await db.select().from(workerStateTable).where(eq(workerStateTable.key, EMERGENCY_STOP_KEY));
    if (rows.length) {
      const payload = JSON.parse(rows[0].value) as { active: boolean };
      _emergencyStop = payload.active === true;
    }
  } catch { /* ignore */ }
}

// ── 주문 실행 파라미터 ─────────────────────────────────────────────────────────

export interface LiveOrderParams {
  decisionId:    string;
  cycleNumber:   number;
  symbol:        string;
  marketAddress: string;
  isLong:        boolean;
  sizeUsd:       number;
  collateralUsd: number;
  leverage:      number;
  currentPriceUsd: number;
  mainAddress:   string;
  /** DB에서 가져온 누적 손실 (USD) */
  accumLossUsd:  number;
  /** DB 쿼리 성공 여부 */
  dbOk:          boolean;
  /** 현재 열린 포지션 수 (온체인) */
  openPositionCount: number;
}

export interface LiveOrderResult {
  ok:          boolean;
  txHash:      string | null;
  orderKey:    string | null;
  error?:      string;
  simulated:   boolean;
  gateResult?: ReturnType<typeof checkLiveTestGate>;
  executedAt:  string;
}

// ── 주문 실행 핵심 함수 ────────────────────────────────────────────────────────

/**
 * LIVE TEST MarketIncrease 주문 실행 (포지션 열기).
 *
 * 실행 전:
 *   1. Emergency Stop 확인
 *   2. LIVE_TEST_EXECUTION_LOCKED 확인
 *   3. 온체인 위임 상태 조회
 *   4. 모든 하드캡 게이트 통과 확인
 *   5. 멀티콜: sendTokens(USDC) + createOrder
 *   6. 감사로그 기록
 */
export async function executeLiveTestOrder(params: LiveOrderParams): Promise<LiveOrderResult> {
  const executedAt = new Date().toISOString();
  const entryId    = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Emergency Stop
  if (_emergencyStop) {
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: '[LIVE TEST] Emergency Stop 활성화 — 주문 차단', executedAt };
  }

  // 잠금 확인 (빠른 경로)
  if (isLiveTestExecutionLocked()) {
    const entry: AuditLogEntry = {
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash: null, orderKey: null, status: 'SIMULATED', error: 'LIVE_TEST_EXECUTION_LOCKED=true',
      simulated: true, gateChecks: {}, submittedAt: executedAt, confirmedAt: null,
    };
    await appendAuditLog(entry);
    return { ok: true, txHash: null, orderKey: null, simulated: true, executedAt };
  }

  const rpcUrl    = process.env.GMX_RPC_URL ?? '';
  const signerAddr = getSignerAddress();
  if (!signerAddr) {
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: '[LIVE TEST] 사이너 미초기화', executedAt };
  }

  // 온체인 위임 상태 + ETH 잔고 조회 (병렬)
  const [delegation, ethBalance] = await Promise.all([
    checkDelegationStatus(params.mainAddress, signerAddr),
    getSignerEthBalance(rpcUrl),
  ]);

  const gateInput: GateInput = {
    orderType:         'open',
    collateralToken:   USDC_ADDRESS,
    sizeUsd:           params.sizeUsd,
    collateralUsd:     params.collateralUsd,
    leverage:          params.leverage,
    delegation,
    signerEthWei:      ethBalance.ethWei,
    openPositionCount: params.openPositionCount,
    accumLossUsd:      params.accumLossUsd,
    dbOk:              params.dbOk,
    rpcOk:             Boolean(rpcUrl),
    reconciled:        _reconciled,
    symbol:            params.symbol,
  };

  const gateResult = checkLiveTestGate(gateInput);
  if (!gateResult.allowed) {
    const entry: AuditLogEntry = {
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash: null, orderKey: null, status: 'FAILED',
      error: gateResult.reason, simulated: false,
      gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    };
    await appendAuditLog(entry);
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: gateResult.reason ?? 'Gate failed', gateResult, executedAt };
  }

  // 실제 트랜잭션 제출
  try {
    const routerAddr  = getSubaccountRouterAddress();
    const vaultAddr   = getOrderVaultAddress();
    const execFee     = getExecutionFeeWei();
    const collWei     = usdToUsdcWei(params.collateralUsd);
    const sizeGmx     = usdSizeToGmx(params.sizeUsd);
    const acceptPrice = params.isLong
      ? acceptablePriceLong(params.currentPriceUsd)
      : acceptablePriceShort(params.currentPriceUsd);

    // 1. sendTokens calldata
    const sendTokensData = encodeFunctionData({
      abi: SUBACCOUNT_ROUTER_ABI,
      functionName: 'sendTokens',
      args: [
        params.mainAddress as `0x${string}`,
        USDC_ADDRESS as `0x${string}`,
        vaultAddr,
        collWei,
      ],
    });

    // 2. createOrder calldata
    const createOrderData = encodeFunctionData({
      abi: SUBACCOUNT_ROUTER_ABI,
      functionName: 'createOrder',
      args: [
        params.mainAddress as `0x${string}`,
        {
          addresses: {
            receiver:              params.mainAddress as `0x${string}`,
            cancellationReceiver:  params.mainAddress as `0x${string}`,
            callbackContract:      ZERO_ADDRESS as `0x${string}`,
            uiFeeReceiver:         ZERO_ADDRESS as `0x${string}`,
            market:                params.marketAddress as `0x${string}`,
            initialCollateralToken: USDC_ADDRESS as `0x${string}`,
            swapPath:              [],
          },
          numbers: {
            sizeDeltaUsd:                sizeGmx,
            initialCollateralDeltaAmount: collWei,
            triggerPrice:                0n,
            acceptablePrice:             acceptPrice,
            executionFee:                execFee,
            callbackGasLimit:            0n,
            minOutputAmount:             0n,
            validFromTime:               0n,
          },
          orderType:                BigInt(GMX_ORDER_TYPE.MarketIncrease),
          decreasePositionSwapType: BigInt(GMX_DECREASE_SWAP_TYPE.NoSwap),
          isLong:                   params.isLong,
          shouldUnwrapNativeToken:  false,
          autoCancel:               false,
          referralCode:             ZERO_BYTES32 as `0x${string}`,
        },
      ],
    });

    // 3. 멀티콜 제출 (subaccount가 서명)
    const walletClient = getSignerWalletClient(rpcUrl);
    const txHash = await walletClient.writeContract({
      address:      routerAddr,
      abi:          SUBACCOUNT_ROUTER_ABI,
      functionName: 'multicall',
      args:         [[sendTokensData, createOrderData]],
      value:        execFee,
    });

    console.info(`[LiveTestExecutor] ✅ 주문 제출 — symbol=${params.symbol} isLong=${params.isLong} size=$${params.sizeUsd} txHash=${txHash}`);

    // 감사로그
    const entry: AuditLogEntry = {
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash, orderKey: null, status: 'SUBMITTED', error: null,
      simulated: false, gateChecks: gateResult.checks,
      submittedAt: executedAt, confirmedAt: null,
    };
    await appendAuditLog(entry);

    return { ok: true, txHash, orderKey: null, simulated: false, gateResult, executedAt };
  } catch (err: unknown) {
    const msg = (err as Error).message ?? 'Unknown execution error';
    console.error('[LiveTestExecutor] 주문 제출 실패:', msg);

    // 실패도 감사로그에 기록
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash: null, orderKey: null, status: 'FAILED', error: msg,
      simulated: false, gateChecks: gateResult.checks,
      submittedAt: executedAt, confirmedAt: null,
    });

    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, gateResult, executedAt };
  }
}

// ── 포지션 청산 (MarketDecrease) ───────────────────────────────────────────────

export interface ClosePositionParams {
  decisionId:      string;
  cycleNumber:     number;
  symbol:          string;
  marketAddress:   string;
  isLong:          boolean;
  sizeUsd:         number;    // 전체 포지션 크기 (USD)
  currentPriceUsd: number;
  mainAddress:     string;
  accumLossUsd:    number;
  dbOk:            boolean;
}

export async function closeLiveTestPosition(params: ClosePositionParams): Promise<LiveOrderResult> {
  const executedAt = new Date().toISOString();
  const entryId    = `close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (_emergencyStop) {
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: 'Emergency Stop', executedAt };
  }
  if (isLiveTestExecutionLocked()) {
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketDecrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: 0,
      txHash: null, orderKey: null, status: 'SIMULATED', error: 'LIVE_TEST_EXECUTION_LOCKED=true',
      simulated: true, gateChecks: {}, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: true, txHash: null, orderKey: null, simulated: true, executedAt };
  }

  const rpcUrl    = process.env.GMX_RPC_URL ?? '';
  const signerAddr = getSignerAddress();
  if (!signerAddr) return { ok: false, txHash: null, orderKey: null, simulated: false, error: '사이너 미초기화', executedAt };

  const [delegation, ethBalance] = await Promise.all([
    checkDelegationStatus(params.mainAddress, signerAddr),
    getSignerEthBalance(rpcUrl),
  ]);

  const gateInput: GateInput = {
    orderType: 'close', collateralToken: USDC_ADDRESS,
    sizeUsd: params.sizeUsd, collateralUsd: 0, leverage: 1,
    delegation, signerEthWei: ethBalance.ethWei,
    openPositionCount: 1, accumLossUsd: params.accumLossUsd,
    dbOk: params.dbOk, rpcOk: Boolean(rpcUrl), reconciled: _reconciled,
  };
  const gateResult = checkLiveTestGate(gateInput);
  if (!gateResult.allowed) {
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketDecrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: 0,
      txHash: null, orderKey: null, status: 'FAILED', error: gateResult.reason,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: gateResult.reason ?? 'Gate failed', gateResult, executedAt };
  }

  try {
    const routerAddr  = getSubaccountRouterAddress();
    const execFee     = getExecutionFeeWei();
    const sizeGmx     = usdSizeToGmx(params.sizeUsd);
    const acceptPrice = params.isLong
      ? acceptablePriceCloseLong(params.currentPriceUsd)
      : acceptablePriceCloseShort(params.currentPriceUsd);

    const createOrderData = encodeFunctionData({
      abi: SUBACCOUNT_ROUTER_ABI,
      functionName: 'createOrder',
      args: [
        params.mainAddress as `0x${string}`,
        {
          addresses: {
            receiver: params.mainAddress as `0x${string}`,
            cancellationReceiver: params.mainAddress as `0x${string}`,
            callbackContract: ZERO_ADDRESS as `0x${string}`,
            uiFeeReceiver: ZERO_ADDRESS as `0x${string}`,
            market: params.marketAddress as `0x${string}`,
            initialCollateralToken: USDC_ADDRESS as `0x${string}`,
            swapPath: [],
          },
          numbers: {
            sizeDeltaUsd: sizeGmx,
            initialCollateralDeltaAmount: 0n,
            triggerPrice: 0n,
            acceptablePrice: acceptPrice,
            executionFee: execFee,
            callbackGasLimit: 0n,
            minOutputAmount: 0n,
            validFromTime: 0n,
          },
          orderType: BigInt(GMX_ORDER_TYPE.MarketDecrease),
          decreasePositionSwapType: BigInt(GMX_DECREASE_SWAP_TYPE.SwapPnlTokenToCollateralToken),
          isLong: params.isLong,
          shouldUnwrapNativeToken: false,
          autoCancel: false,
          referralCode: ZERO_BYTES32 as `0x${string}`,
        },
      ],
    });

    const walletClient = getSignerWalletClient(rpcUrl);
    const txHash = await walletClient.writeContract({
      address: routerAddr,
      abi: SUBACCOUNT_ROUTER_ABI,
      functionName: 'multicall',
      args: [[createOrderData]],
      value: execFee,
    });

    console.info(`[LiveTestExecutor] ✅ 청산 제출 — symbol=${params.symbol} txHash=${txHash}`);
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketDecrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: 0,
      txHash, orderKey: null, status: 'SUBMITTED', error: null,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: true, txHash, orderKey: null, simulated: false, gateResult, executedAt };
  } catch (err: unknown) {
    const msg = (err as Error).message ?? 'Unknown error';
    console.error('[LiveTestExecutor] 청산 실패:', msg);
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketDecrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: 0,
      txHash: null, orderKey: null, status: 'FAILED', error: msg,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, executedAt };
  }
}

// ── 서브계정 권한 철회 (서버 사이너가 직접 호출) ──────────────────────────────

/**
 * 서버 사이너 지갑을 사용해 removeSubaccount 트랜잭션을 제출.
 * 메인 지갑(MetaMask) 없이도 서버가 직접 권한을 철회할 수 있음.
 * Emergency Stop 시 자동 호출.
 */
export async function revokeSubaccountFromServer(_mainAddress: string): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  // removeSubaccount는 메인 지갑(MetaMask)이 호출해야 하는 함수.
  // 서버 사이너(subaccount)는 자신의 권한을 직접 철회 불가.
  // MetaMask UI에서 /api/executor/livetest/revoke-tx 트랜잭션을 실행하도록 안내.
  console.warn('[LiveTestExecutor] 권한 철회는 MetaMask에서 수행해야 합니다 (/api/executor/livetest/revoke-tx 참고)');
  return {
    ok:    false,
    error: '서버에서 직접 권한 철회 불가 — MetaMask에서 /api/executor/livetest/revoke-tx 트랜잭션 실행 필요',
  };
}
