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
 *  ✅ writeContract 직전 중앙 실행 게이트 (checkCentralExecutionGate, fail-closed)
 *  ✅ 재시작 후 SUBMITTED 주문은 UNRESOLVED 보존 — 상태불명 시 신규 주문 차단
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
  checkCentralExecutionGate,
  isLiveTestExecutionLocked,
  type GateInput,
} from '../lib/liveTestGate';
import {
  isDelegatedSignerEnabled,
  isSignerInitialized,
} from '../lib/delegatedSigner';
import {
  buildIntentId,
  createPreparedIntent,
  markIntentSubmitted,
  markIntentUnresolved,
  markIntentFailedPreBroadcast,
  hasBlockingIntents,
  reconcileIntentsOnRestart,
} from '../lib/executionIntents';
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
  status:       'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'SIMULATED' | 'CANCELLED' | 'UNRESOLVED';
  error:        string | null;
  simulated:    boolean;
  gateChecks:   Record<string, boolean>;
  submittedAt:  string;
  confirmedAt:  string | null;
}

// ── 감사로그 읽기/쓰기 ─────────────────────────────────────────────────────────

/** 감사로그 로드 결과 — DB/파싱 실패를 '빈 로그'로 오인하지 않도록 명시 구분 */
type AuditLogLoad =
  | { ok: true; entries: AuditLogEntry[] }
  | { ok: false };

async function loadAuditLogStrict(): Promise<AuditLogLoad> {
  try {
    const rows = await db.select().from(workerStateTable).where(eq(workerStateTable.key, AUDIT_LOG_KEY));
    if (!rows.length) return { ok: true, entries: [] };
    return { ok: true, entries: JSON.parse(rows[0].value) as AuditLogEntry[] };
  } catch {
    return { ok: false };
  }
}

/** @returns 저장 성공 여부. 실패는 삼키지 않고 호출자에게 알린다. */
async function appendAuditLog(entry: AuditLogEntry): Promise<boolean> {
  try {
    const loaded = await loadAuditLogStrict();
    // 로드 실패 시 기존 로그를 덮어쓰면 감사기록이 유실되므로 저장하지 않는다.
    if (!loaded.ok) {
      console.error('[LiveTestExecutor] 감사로그 로드 실패 — 항목 저장 불가 (기존 기록 보호)');
      return false;
    }
    // 최대 500개 보존 (FIFO)
    const updated = [...loaded.entries, entry].slice(-500);
    const now = new Date();
    await db.insert(workerStateTable)
      .values({ key: AUDIT_LOG_KEY, value: JSON.stringify(updated), updatedAt: now })
      .onConflictDoUpdate({ target: workerStateTable.key, set: { value: JSON.stringify(updated), updatedAt: now } });
    return true;
  } catch (e) {
    console.error('[LiveTestExecutor] 감사로그 저장 실패:', e);
    return false;
  }
}

export async function getAuditLog(limit = 100): Promise<AuditLogEntry[]> {
  const loaded = await loadAuditLogStrict();
  if (!loaded.ok) return [];
  return loaded.entries.slice(-limit);
}

// ── 재시작 Reconciliation ─────────────────────────────────────────────────────

/**
 * 서버 재시작 후 pending 주문 중복 방지 (fail-closed).
 *
 * 규칙:
 *  - SUBMITTED 주문은 온체인 확인 없이 임의로 FAILED로 바꾸지 않는다.
 *    (실제로 체결됐을 수 있는 주문을 "실패"로 잘못 기록하면 감사기록이 오염됨)
 *  - 대신 UNRESOLVED로 마킹: txHash 등 감사기록은 그대로 보존, 온체인 확인 필요 표시.
 *  - UNRESOLVED(상태불명) 주문이 하나라도 있으면 _reconciled=false 유지
 *    → 중앙 게이트가 신규 LIVE TEST 주문을 차단한다.
 *  - 상태불명 주문이 전혀 없을 때만 _reconciled=true.
 *  - 시간 경과만으로 FAILED 전환 금지. 해소는 온체인 확인(추후 구현) 또는
 *    운영자의 명시적 판정으로만 가능.
 *  - PAPER 모드 운영에는 영향 없음 (게이트는 LIVE TEST 실행 경로에만 적용).
 */
export async function reconcileOnRestart(): Promise<void> {
  try {
    const loaded = await loadAuditLogStrict();
    if (!loaded.ok) {
      // 감사로그를 읽을 수 없으면 상태불명 주문 존재 여부를 알 수 없음 → fail-closed
      _reconciled = false;
      console.error('[LiveTestExecutor] Reconciliation: 감사로그 로드 실패 — 신규 LIVE TEST 주문 차단 (fail-closed)');
      return;
    }
    const log = loaded.entries;
    const submitted  = log.filter(e => e.status === 'SUBMITTED');
    const unresolved = log.filter(e => e.status === 'UNRESOLVED');

    if (submitted.length > 0) {
      console.warn(
        `[LiveTestExecutor] 재시작 reconciliation: ${submitted.length}개 SUBMITTED 주문 발견 — ` +
        `UNRESOLVED로 마킹 (txHash 보존, 온체인 확인 필요)`,
      );
      const updated = log.map(e =>
        e.status === 'SUBMITTED'
          ? { ...e, status: 'UNRESOLVED' as const, error: '서버 재시작 시 상태 불명 — 온체인 확인 전까지 UNRESOLVED 유지' }
          : e
      );
      const now = new Date();
      await db.insert(workerStateTable)
        .values({ key: AUDIT_LOG_KEY, value: JSON.stringify(updated), updatedAt: now })
        .onConflictDoUpdate({ target: workerStateTable.key, set: { value: JSON.stringify(updated), updatedAt: now } });
    }

    const unresolvedTotal = submitted.length + unresolved.length;
    if (unresolvedTotal > 0) {
      // 상태불명 주문 존재 → fail-closed: 신규 LIVE TEST 주문 차단 유지
      _reconciled = false;
      const now = new Date();
      await db.insert(workerStateTable)
        .values({ key: RECONCILED_KEY, value: 'false', updatedAt: now })
        .onConflictDoUpdate({ target: workerStateTable.key, set: { value: 'false', updatedAt: now } });
      console.warn(`[LiveTestExecutor] 상태불명(UNRESOLVED) 주문 ${unresolvedTotal}개 — 신규 LIVE TEST 주문 차단 (fail-closed)`);
      return;
    }

    // durable execution intents 검사 — PREPARED/SUBMITTED → UNRESOLVED 전환 (txHash 보존)
    const intentResult = await reconcileIntentsOnRestart();
    if (!intentResult.ok || intentResult.blockingCount > 0) {
      _reconciled = false;
      const nowI = new Date();
      await db.insert(workerStateTable)
        .values({ key: RECONCILED_KEY, value: 'false', updatedAt: nowI })
        .onConflictDoUpdate({ target: workerStateTable.key, set: { value: 'false', updatedAt: nowI } });
      console.warn(
        `[LiveTestExecutor] 미해소 execution intent ${intentResult.ok ? intentResult.blockingCount + '개' : '조회 실패'} — ` +
        `신규 LIVE TEST 주문 차단 (fail-closed)`,
      );
      return;
    }

    _reconciled = true;
    const now = new Date();
    await db.insert(workerStateTable)
      .values({ key: RECONCILED_KEY, value: 'true', updatedAt: now })
      .onConflictDoUpdate({ target: workerStateTable.key, set: { value: 'true', updatedAt: now } });
    console.info('[LiveTestExecutor] Reconciliation 완료 — 상태불명 주문 없음');
  } catch (e) {
    console.error('[LiveTestExecutor] Reconciliation 실패:', e);
    _reconciled = false;
  }
}

export function isReconciled(): boolean { return _reconciled; }

/** 감사로그에 UNRESOLVED(상태불명) 주문이 있는지 조회. 로드 실패 시 true (fail-closed). */
export async function hasUnresolvedOrders(): Promise<boolean> {
  const loaded = await loadAuditLogStrict();
  if (!loaded.ok) return true;
  return loaded.entries.some(e => e.status === 'UNRESOLVED' || e.status === 'SUBMITTED');
}

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
  /** 운영자 설정 liveTestMode 플래그 (중앙 게이트 검증용, fail-closed) */
  liveTestMode: boolean;
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

  const rpcUrl = process.env.GMX_RPC_URL ?? '';

  // ── 중앙 실행 게이트 (writeContract에 도달하기 전 최종 fail-closed 검증) ──
  const central = checkCentralExecutionGate({
    workerEngineMode:       process.env.WORKER_ENGINE_MODE,
    liveTestMode:           params.liveTestMode,
    delegatedSignerEnabled: isDelegatedSignerEnabled(),
    emergencyStop:          _emergencyStop,
    signerInitialized:      isSignerInitialized(),
    dbOk:                   params.dbOk,
    rpcOk:                  Boolean(rpcUrl),
    reconciled:             _reconciled,
    noBlockingIntents:      !(await hasBlockingIntents()),
  });
  if (!central.allowed) {
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash: null, orderKey: null, status: 'FAILED', error: central.reason,
      simulated: false, gateChecks: central.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: central.reason ?? 'Central gate failed', executedAt };
  }

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

  // ── 1) calldata 빌드 (broadcast 이전 — 실패 시 intent 없이 FAILED 기록) ──
  let sendTokensDataBuilt: `0x${string}`;
  let createOrderDataBuilt: `0x${string}`;
  let routerAddrBuilt: `0x${string}`;
  let execFeeBuilt: bigint;
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

    sendTokensDataBuilt  = sendTokensData;
    createOrderDataBuilt = createOrderData;
    routerAddrBuilt      = routerAddr;
    execFeeBuilt         = execFee;
  } catch (err: unknown) {
    // calldata 빌드 실패 — broadcast 이전 확실 구간 (intent 미생성, 온체인 미도달)
    const msg = (err as Error).message ?? 'Unknown build error';
    console.error('[LiveTestExecutor] calldata 빌드 실패 (broadcast 이전):', msg);
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash: null, orderKey: null, status: 'FAILED', error: msg,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, gateResult, executedAt };
  }

  // ── 2) durable execution intent — writeContract 도달 전 PREPARED 커밋 필수 ──
  const intentId = buildIntentId(params.decisionId, 'open');
  const intentCreated = await createPreparedIntent({
    id: intentId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
    symbol: params.symbol, orderType: 'open', isLong: params.isLong,
    sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
  });
  if (intentCreated !== 'created') {
    const msg = intentCreated === 'duplicate'
      ? '[LIVE TEST] 동일 intent 중복 제출 시도 (idempotency key 충돌) — 주문 차단'
      : '[LIVE TEST] execution intent 저장 실패 — 온체인 제출 차단 (fail-closed)';
    console.error(`[LiveTestExecutor] ${msg} (intentId=${intentId})`);
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash: null, orderKey: null, status: 'FAILED', error: msg,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, gateResult, executedAt };
  }

  // ── 3) 서명 클라이언트 생성 (로컬 — broadcast 이전 확실 구간) ──
  let walletClient: ReturnType<typeof getSignerWalletClient>;
  try {
    walletClient = getSignerWalletClient(rpcUrl);
  } catch (err: unknown) {
    const msg = (err as Error).message ?? 'Wallet client init failed';
    await markIntentFailedPreBroadcast(intentId, msg);
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash: null, orderKey: null, status: 'FAILED', error: msg,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, gateResult, executedAt };
  }

  // ── 4) 온체인 제출 — 오류 시 broadcast 여부 불명 → UNRESOLVED (자동 FAILED 금지) ──
  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address:      routerAddrBuilt,
      abi:          SUBACCOUNT_ROUTER_ABI,
      functionName: 'multicall',
      args:         [[sendTokensDataBuilt, createOrderDataBuilt]],
      value:        execFeeBuilt,
    });
  } catch (err: unknown) {
    const msg = (err as Error).message ?? 'Unknown execution error';
    console.error('[LiveTestExecutor] 주문 제출 오류 — broadcast 여부 불명, UNRESOLVED 처리:', msg);
    // 시간 경과·타임아웃·네트워크 오류를 FAILED로 단정하지 않는다.
    // UNRESOLVED 전환 실패 시에도 PREPARED 행이 남아 차단은 유지된다.
    await markIntentUnresolved(intentId, msg);
    _reconciled = false; // 상태불명 intent 존재 → 신규 주문 즉시 차단
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash: null, orderKey: null, status: 'UNRESOLVED', error: msg,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, gateResult, executedAt };
  }

  console.info(`[LiveTestExecutor] ✅ 주문 제출 — symbol=${params.symbol} isLong=${params.isLong} size=$${params.sizeUsd} txHash=${txHash}`);

  // ── 5) intent SUBMITTED 전환 + 감사로그 (실패 시 fail-closed, PREPARED 보존) ──
  const intentSubmitted = await markIntentSubmitted(intentId, txHash);
  const entry: AuditLogEntry = {
    id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
    symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
    sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
    txHash, orderKey: null, status: 'SUBMITTED', error: null,
    simulated: false, gateChecks: gateResult.checks,
    submittedAt: executedAt, confirmedAt: null,
  };
  const audited = await appendAuditLog(entry);
  if (!intentSubmitted || !audited) {
    // 제출된 tx의 영속 기록(intent SUBMITTED 또는 감사로그)이 불완전하면
    // 재시작 reconciliation이 PREPARED intent를 UNRESOLVED로 발견하고 차단한다.
    _reconciled = false;
    console.error(`[LiveTestExecutor] ⚠️ 제출 후 영속화 실패 (txHash=${txHash}, intent=${intentSubmitted}, audit=${audited}) — 신규 주문 차단 (fail-closed)`);
    return { ok: false, txHash, orderKey: null, simulated: false, error: '[LIVE TEST] 주문은 제출되었으나 영속 기록 저장 실패 — 신규 주문 차단', gateResult, executedAt };
  }

  return { ok: true, txHash, orderKey: null, simulated: false, gateResult, executedAt };
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
  /** 운영자 설정 liveTestMode 플래그 (중앙 게이트 검증용, fail-closed) */
  liveTestMode:    boolean;
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

  const rpcUrl = process.env.GMX_RPC_URL ?? '';

  // ── 중앙 실행 게이트 (writeContract에 도달하기 전 최종 fail-closed 검증) ──
  const central = checkCentralExecutionGate({
    workerEngineMode:       process.env.WORKER_ENGINE_MODE,
    liveTestMode:           params.liveTestMode,
    delegatedSignerEnabled: isDelegatedSignerEnabled(),
    emergencyStop:          _emergencyStop,
    signerInitialized:      isSignerInitialized(),
    dbOk:                   params.dbOk,
    rpcOk:                  Boolean(rpcUrl),
    reconciled:             _reconciled,
    noBlockingIntents:      !(await hasBlockingIntents()),
  });
  if (!central.allowed) {
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketDecrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: 0,
      txHash: null, orderKey: null, status: 'FAILED', error: central.reason,
      simulated: false, gateChecks: central.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: central.reason ?? 'Central gate failed', executedAt };
  }

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

  // ── 1) calldata 빌드 (broadcast 이전 — 실패 시 intent 없이 FAILED 기록) ──
  let createOrderDataBuilt: `0x${string}`;
  let routerAddrBuilt: `0x${string}`;
  let execFeeBuilt: bigint;
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

    createOrderDataBuilt = createOrderData;
    routerAddrBuilt      = routerAddr;
    execFeeBuilt         = execFee;
  } catch (err: unknown) {
    // calldata 빌드 실패 — broadcast 이전 확실 구간 (intent 미생성, 온체인 미도달)
    const msg = (err as Error).message ?? 'Unknown build error';
    console.error('[LiveTestExecutor] 청산 calldata 빌드 실패 (broadcast 이전):', msg);
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketDecrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: 0,
      txHash: null, orderKey: null, status: 'FAILED', error: msg,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, executedAt };
  }

  // ── 2) durable execution intent — writeContract 도달 전 PREPARED 커밋 필수 ──
  const intentId = buildIntentId(params.decisionId, 'close');
  const intentCreated = await createPreparedIntent({
    id: intentId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
    symbol: params.symbol, orderType: 'close', isLong: params.isLong,
    sizeUsd: params.sizeUsd, collateralUsd: 0,
  });
  if (intentCreated !== 'created') {
    const msg = intentCreated === 'duplicate'
      ? '[LIVE TEST] 동일 intent 중복 제출 시도 (idempotency key 충돌) — 청산 차단'
      : '[LIVE TEST] execution intent 저장 실패 — 온체인 제출 차단 (fail-closed)';
    console.error(`[LiveTestExecutor] ${msg} (intentId=${intentId})`);
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketDecrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: 0,
      txHash: null, orderKey: null, status: 'FAILED', error: msg,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, gateResult, executedAt };
  }

  // ── 3) 서명 클라이언트 생성 (로컬 — broadcast 이전 확실 구간) ──
  let walletClient: ReturnType<typeof getSignerWalletClient>;
  try {
    walletClient = getSignerWalletClient(rpcUrl);
  } catch (err: unknown) {
    const msg = (err as Error).message ?? 'Wallet client init failed';
    await markIntentFailedPreBroadcast(intentId, msg);
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketDecrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: 0,
      txHash: null, orderKey: null, status: 'FAILED', error: msg,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, gateResult, executedAt };
  }

  // ── 4) 온체인 제출 — 오류 시 broadcast 여부 불명 → UNRESOLVED (자동 FAILED 금지) ──
  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: routerAddrBuilt,
      abi: SUBACCOUNT_ROUTER_ABI,
      functionName: 'multicall',
      args: [[createOrderDataBuilt]],
      value: execFeeBuilt,
    });
  } catch (err: unknown) {
    const msg = (err as Error).message ?? 'Unknown error';
    console.error('[LiveTestExecutor] 청산 제출 오류 — broadcast 여부 불명, UNRESOLVED 처리:', msg);
    await markIntentUnresolved(intentId, msg);
    _reconciled = false; // 상태불명 intent 존재 → 신규 주문 즉시 차단
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketDecrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: 0,
      txHash: null, orderKey: null, status: 'UNRESOLVED', error: msg,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, executedAt };
  }

  console.info(`[LiveTestExecutor] ✅ 청산 제출 — symbol=${params.symbol} txHash=${txHash}`);

  // ── 5) intent SUBMITTED 전환 + 감사로그 (실패 시 fail-closed, PREPARED 보존) ──
  const intentSubmitted = await markIntentSubmitted(intentId, txHash);
  const audited = await appendAuditLog({
    id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
    symbol: params.symbol, orderType: 'MarketDecrease', isLong: params.isLong,
    sizeUsd: params.sizeUsd, collateralUsd: 0,
    txHash, orderKey: null, status: 'SUBMITTED', error: null,
    simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
  });
  if (!intentSubmitted || !audited) {
    _reconciled = false;
    console.error(`[LiveTestExecutor] ⚠️ 청산 제출 후 영속화 실패 (txHash=${txHash}, intent=${intentSubmitted}, audit=${audited}) — 신규 주문 차단 (fail-closed)`);
    return { ok: false, txHash, orderKey: null, simulated: false, error: '[LIVE TEST] 청산은 제출되었으나 영속 기록 저장 실패 — 신규 주문 차단', gateResult, executedAt };
  }
  return { ok: true, txHash, orderKey: null, simulated: false, gateResult, executedAt };
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
