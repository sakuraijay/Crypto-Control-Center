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

import { db, workerStateTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
  getSignerAddress,
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
  reconcileBlockingIntentsOnchain,
  type IntentResolution,
} from '../lib/intentReconciler';
import { resolveGmxEventEmitterAddress } from '../lib/gmxOrderEvents';
import { enforceOrderSizing } from '../lib/orderSizingEnforcement';
import type { CostSnapshot } from '../lib/costSnapshot';
import { listUncovered, type StopCoverageMap, type StopCoverageRecord } from '../lib/stopLossPlan';
import { isGmxLiveRelayConfigured, resolveGmxLiveRelayConfig } from '../lib/gmxLiveConfig';
// ── 6G-2 §5 — 공식 GMX API v2 실행 경로 (legacy writeContract 경로 대체) ──────
import { createGmxApiTransport, type GmxApiTransport } from '../lib/gmxApiTransport';
import {
  executeViaGmxApi,
  buildActivationInput,
  type OpenPositionEvidence,
} from '../lib/gmxApiExecution';
import type { ActivationGateInput } from '../lib/relayActivationGate';
import {
  getCanonicalSnapshot,
  getDeploymentVerificationState,
  getFeeEstimateState,
} from '../lib/relayActivationStatus';
import { getActiveRevokeSession } from '../lib/revokeSession';
import { getGmxPrepareStartupState } from '../lib/gmxApiPrepareStartup';
import { countBlockingIntentsOrNull } from '../lib/executionIntents';
import { fetchServerOpenPositions } from '../routes/gmx';

/**
 * DEPRECATED — legacy SubaccountRouter 직접 주문 경로 (multicall/sendTokens/createOrder).
 * 최신 GMX delegated trading은 SubaccountGelatoRelayRouter(EIP-712 relay)를 사용하며
 * legacy 라우터는 주문 생성에 사용할 수 없다 (비-express removeSubaccount 전용).
 * 이 가드는 테스트 환경 밖에서 legacy 경로 broadcast를 원천 차단한다.
 * 중앙 게이트의 relayConfigured 체크와 별개로 이중 방어선 역할.
 */
export function assertLegacyOrderPathAllowed(): void {
  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined;
  if (!isTestEnv) {
    throw new Error('[DEPRECATED] legacy SubaccountRouter 주문 경로는 Production에서 차단됨 — 최신 SubaccountGelatoRelayRouter relay 경로 필요');
  }
}
import { USDC_ADDRESS } from '../lib/gmxContracts';

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

// ── Stop coverage 영속 저장 (6H-2 §8) ─────────────────────────────────────────
// OPEN과 stop 생성은 원자화 불가 — worker_state에 coverage 상태 머신을 영속해
// "OPEN 성공"만으로 안전 완료 처리하지 않는다. COVERED가 아닌 기록이 있으면
// 신규 OPEN은 차단된다 (복구/종료 우선).

const STOP_COVERAGE_KEY = 'stopCoverage';

export async function loadStopCoverage(): Promise<{ ok: true; map: StopCoverageMap } | { ok: false }> {
  try {
    const rows = await db.select().from(workerStateTable).where(eq(workerStateTable.key, STOP_COVERAGE_KEY));
    if (!rows.length) return { ok: true, map: {} };
    return { ok: true, map: JSON.parse(rows[0].value) as StopCoverageMap };
  } catch {
    return { ok: false };
  }
}

export async function saveStopCoverageRecord(rec: StopCoverageRecord): Promise<boolean> {
  try {
    const loaded = await loadStopCoverage();
    if (!loaded.ok) return false;
    const map = { ...loaded.map, [rec.positionRef]: rec };
    const value = JSON.stringify(map);
    await db.insert(workerStateTable)
      .values({ key: STOP_COVERAGE_KEY, value })
      .onConflictDoUpdate({ target: workerStateTable.key, set: { value } });
    return true;
  } catch {
    return false;
  }
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

// ── 감사로그 직렬화 뮤텍스 ─────────────────────────────────────────────────────
// 감사로그는 단일 JSON 행에 read-modify-write 되므로, 동시 갱신(append vs
// intent 판정 동기화)이 겹치면 lost-update로 terminal 감사 상태가 SUBMITTED로
// 되돌아갈 수 있다. 서버는 단일 Node 프로세스(Reserved VM 단일 프로세스 구조)
// 이므로 프로세스 내 뮤텍스로 모든 감사로그 read-modify-write를 직렬화한다.
let _auditLogChain: Promise<unknown> = Promise.resolve();

function withAuditLogLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _auditLogChain.then(fn, fn);
  _auditLogChain = next.catch(() => {});
  return next;
}

/**
 * 감사로그를 락 안에서 load → mutate → save. mutator가 null을 반환하면 저장 없음.
 * @returns 저장(또는 무변경) 성공 여부. 로드 실패 시 false (기존 기록 보호).
 */
async function mutateAuditLog(
  mutator: (entries: AuditLogEntry[]) => AuditLogEntry[] | null,
): Promise<boolean> {
  return withAuditLogLock(async () => {
    try {
      const loaded = await loadAuditLogStrict();
      if (!loaded.ok) {
        console.error('[LiveTestExecutor] 감사로그 로드 실패 — 갱신 불가 (기존 기록 보호)');
        return false;
      }
      const updated = mutator(loaded.entries);
      if (updated === null) return true; // 변경 없음
      const now = new Date();
      await db.insert(workerStateTable)
        .values({ key: AUDIT_LOG_KEY, value: JSON.stringify(updated), updatedAt: now })
        .onConflictDoUpdate({ target: workerStateTable.key, set: { value: JSON.stringify(updated), updatedAt: now } });
      return true;
    } catch (e) {
      console.error('[LiveTestExecutor] 감사로그 저장 실패:', e);
      return false;
    }
  });
}

/** @returns 저장 성공 여부. 실패는 삼키지 않고 호출자에게 알린다. */
async function appendAuditLog(entry: AuditLogEntry): Promise<boolean> {
  // 최대 500개 보존 (FIFO). 락 안에서 최신 로그를 다시 읽으므로
  // intent 판정 동기화가 바꾼 terminal 상태를 되돌리지 않는다.
  return mutateAuditLog(entries => [...entries, entry].slice(-500));
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
/**
 * intent 온체인 판정 결과를 감사로그에 동기화 — 같은 txHash를 가진
 * SUBMITTED/UNRESOLVED 항목을 CONFIRMED/FAILED/CANCELLED로 갱신한다.
 * (intent가 온체인 증거로 해소됐는데 감사로그가 영구 차단으로 남는 것 방지)
 */
async function applyIntentResolutionsToAuditLog(resolutions: IntentResolution[]): Promise<void> {
  if (resolutions.length === 0) return;
  const byTx = new Map(resolutions.filter(r => r.txHash).map(r => [r.txHash as string, r]));
  const ok = await mutateAuditLog(entries => {
    let changed = false;
    const updated = entries.map(e => {
      if (!e.txHash) return e;
      const r = byTx.get(e.txHash);
      if (!r) return e;
      if (e.status !== 'SUBMITTED' && e.status !== 'UNRESOLVED') return e; // terminal 역행 금지
      changed = true;
      return {
        ...e,
        status:      r.status,
        error:       r.status === 'CONFIRMED' ? null : r.reason,
        confirmedAt: r.status === 'CONFIRMED' ? new Date().toISOString() : e.confirmedAt,
      };
    });
    return changed ? updated : null;
  });
  if (ok) console.info(`[LiveTestExecutor] 감사로그 intent 온체인 판정 동기화 (${byTx.size}건 대상)`);
  else console.error('[LiveTestExecutor] 감사로그 동기화 실패 (차단 유지)');
}

export async function reconcileOnRestart(): Promise<void> {
  try {
    // durable execution intents를 감사로그보다 먼저 reconcile —
    // 감사로그에 상태불명 항목이 있어 조기 반환하더라도 PREPARED intent가
    // PREPARED로 남지 않고 반드시 UNRESOLVED로 전환되도록 보장한다.
    const intentResult = await reconcileIntentsOnRestart();

    // 차단 intent가 있으면 온체인 증거로 판정 시도 (RPC 오류 → 차단 유지, throw 안 함)
    if (intentResult.ok && intentResult.blockingCount > 0) {
      const summary = await reconcileBlockingIntentsOnchain();
      await applyIntentResolutionsToAuditLog(summary.resolutions);
    }
    // 판정 후 잔여 차단 intent 재조회 (조회 실패 → true, fail-closed)
    const intentsBlocked = !intentResult.ok || await hasBlockingIntents();

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
      await mutateAuditLog(entries => entries.map(e =>
        e.status === 'SUBMITTED'
          ? { ...e, status: 'UNRESOLVED' as const, error: '서버 재시작 시 상태 불명 — 온체인 확인 전까지 UNRESOLVED 유지' }
          : e
      ));
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

    // durable execution intents 차단 검사 (전환은 함수 서두에서 이미 수행됨)
    if (intentsBlocked) {
      _reconciled = false;
      const nowI = new Date();
      await db.insert(workerStateTable)
        .values({ key: RECONCILED_KEY, value: 'false', updatedAt: nowI })
        .onConflictDoUpdate({ target: workerStateTable.key, set: { value: 'false', updatedAt: nowI } });
      console.warn(
        '[LiveTestExecutor] 온체인 판정 후에도 미해소 execution intent 잔존 — 신규 LIVE TEST 주문 차단 (fail-closed)',
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

// ── 6G-2 §5·§6 — 공식 GMX API v2 실행 경로 배선 ───────────────────────────────

/** 테스트 주입용 transport override (production은 env 파생 transport 고정) */
let _gmxApiTransportOverride: GmxApiTransport | null = null;
export function __setGmxApiTransportForTests(t: GmxApiTransport | null): void {
  _gmxApiTransportOverride = t;
}
function getGmxApiTransport(): GmxApiTransport {
  return _gmxApiTransportOverride ?? createGmxApiTransport(process.env);
}

/** 테스트 주입용 CLOSE 포지션 증거 조회 override */
let _openPositionsFetchOverride: (() => Promise<OpenPositionEvidence[] | null>) | null = null;
export function __setOpenPositionsFetchForTests(
  f: (() => Promise<OpenPositionEvidence[] | null>) | null,
): void {
  _openPositionsFetchOverride = f;
}

/**
 * §6 — activation gate 입력을 실제 파생값으로 조립 (조회 실패 = 차단).
 * UI/localStorage 입력은 없다: canonical/deployment/fee/revoke/blocking 전부
 * 서버 저장 스냅샷·DB에서만 파생한다.
 */
async function buildExecutorActivationInput(args: {
  kind: 'OPEN' | 'CLOSE';
  liveTestMode: boolean;
  dbOk: boolean;
  rpcOk: boolean;
  /** 이 실행 흐름이 방금 생성한 자기 intent id — blocking count에서 제외 */
  selfIntentId?: string | null;
}): Promise<ActivationGateInput> {
  const snap = getCanonicalSnapshot();
  const canonicalAuthorized = !!snap && snap.confirmed && snap.isSubaccountListed === true;
  let approvalRemainingOk = false;
  if (snap?.remaining && snap?.expiresAt) {
    try {
      approvalRemainingOk =
        BigInt(snap.remaining) > 0n && Number(snap.expiresAt) * 1000 > Date.now();
    } catch { approvalRemainingOk = false; }
  }
  let blockingIntentCount: number | null = null;
  try { blockingIntentCount = await countBlockingIntentsOrNull(args.selfIntentId ?? null); } catch { blockingIntentCount = null; }
  let revoke = true; // 조회 실패 = revoke 진행 중으로 간주 (차단)
  try { revoke = (await getActiveRevokeSession()) !== null; } catch { revoke = true; }
  // fee freshness — 저장된 fee estimate 스냅샷만 (10분 이내, mock 불인정)
  const fe = getFeeEstimateState();
  const freshLiveFeeQuote =
    fe.attempted && fe.ok && fe.atMs !== null && Date.now() - fe.atMs < 10 * 60_000;

  return buildActivationInput({
    env: process.env,
    liveTestMode: args.liveTestMode,
    emergencyStopActive: _emergencyStop,
    // 6G-3 §4 — prepare 단계 startup reconciliation 실패 시 LIVE 경로 전체 차단
    reconciled: _reconciled && getGmxPrepareStartupState().attempted && getGmxPrepareStartupState().ok,
    canonicalAuthorized,
    approvalRemainingOk,
    blockingIntentCount,
    activeRevokeInProgress: revoke,
    freshLiveFeeQuote,
    gmxConfigOk: resolveGmxLiveRelayConfig().ok,
    deploymentVerified: getDeploymentVerificationState().ok,
    dbOk: args.dbOk,
    rpcOk: args.rpcOk,
    kind: args.kind,
  });
}

/**
 * §5 — OPEN/CLOSE 공통: durable intent 생성 이후의 GMX API v2 흐름 실행 +
 * intent/감사로그 영속. legacy writeContract 경로는 LEGACY_DISABLED로 폐기됨.
 */
async function runGmxApiOrderPath(args: {
  kind: 'OPEN' | 'CLOSE';
  intentId: string;
  entryId: string;
  executedAt: string;
  gateChecks: Record<string, boolean>;
  liveTestMode: boolean;
  dbOk: boolean;
  rpcOk: boolean;
  decisionId: string;
  cycleNumber: number;
  symbol: string;
  marketAddress: string;
  isLong: boolean;
  sizeUsd: number;
  collateralUsd: number;
  mainAddress: string;
  openPosition: OpenPositionEvidence | null;
}): Promise<LiveOrderResult> {
  const orderType = args.kind === 'OPEN' ? 'MarketIncrease' : 'MarketDecrease';
  const audit = (
    status: AuditLogEntry['status'],
    error: string | null,
    orderKey: string | null = null,
  ): Promise<boolean> =>
    appendAuditLog({
      id: args.entryId, decisionId: args.decisionId, cycleNumber: args.cycleNumber,
      symbol: args.symbol, orderType, isLong: args.isLong,
      sizeUsd: args.sizeUsd, collateralUsd: args.collateralUsd,
      txHash: null, orderKey, status, error,
      simulated: false, gateChecks: args.gateChecks,
      submittedAt: args.executedAt, confirmedAt: null,
    });

  const transport = getGmxApiTransport();
  const activation = await buildExecutorActivationInput({
    kind: args.kind, liveTestMode: args.liveTestMode, dbOk: args.dbOk, rpcOk: args.rpcOk,
    selfIntentId: args.intentId,
  });
  const canonicalNonce = (() => {
    const snap = getCanonicalSnapshot();
    if (!snap?.approvalNonce) return null;
    try { return BigInt(snap.approvalNonce); } catch { return null; }
  })();

  const res = await executeViaGmxApi({
    transport,
    req: {
      kind: args.kind, symbol: args.symbol, marketAddress: args.marketAddress,
      isLong: args.isLong, sizeUsd: args.sizeUsd,
      collateralUsd: args.kind === 'OPEN' ? args.collateralUsd : 0,
      mainWallet: args.mainAddress, subaccountAddress: getSignerAddress() ?? '',
    },
    intentId: args.intentId,
    activation,
    reevaluateActivation: () => buildExecutorActivationInput({
      kind: args.kind, liveTestMode: args.liveTestMode, dbOk: args.dbOk, rpcOk: args.rpcOk,
      selfIntentId: args.intentId,
    }),
    openPosition: args.openPosition,
    canonicalNonce,
  });

  const reason = res.blockReasons.join('; ') || null;

  if (res.finalStatus === 'TASK_ACCEPTED' && res.submitted) {
    // 제출 수락 — orderKey 자리에 GMX requestId 참조 저장 (txHash는 reconciler가 확보).
    // intent는 PREPARED로 유지: 온체인 확정 전 신규 주문 차단(fail-closed),
    // 해소는 gmxApiStatusReconciler가 relay task 증거로 수행한다.
    const audited = await audit('SUBMITTED', null, res.gmxRequestId ? `gmxreq:${res.gmxRequestId}` : null);
    if (!audited) {
      _reconciled = false;
      return { ok: false, txHash: null, orderKey: null, simulated: false, error: '[LIVE TEST] 제출 수락됐으나 감사로그 저장 실패 — 신규 주문 차단', executedAt: args.executedAt };
    }
    console.info(`[LiveTestExecutor] ✅ GMX API 제출 수락 — ${args.symbol} ${orderType} requestId=${res.gmxRequestId ?? '?'}`);
    return { ok: true, txHash: null, orderKey: res.gmxRequestId ? `gmxreq:${res.gmxRequestId}` : null, simulated: false, executedAt: args.executedAt };
  }

  if (res.finalStatus === 'UNRESOLVED') {
    await markIntentUnresolved(args.intentId, reason ?? 'GMX API 제출 결과 불명');
    _reconciled = false; // 상태불명 → 신규 주문 즉시 차단
    await audit('UNRESOLVED', reason);
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: reason ?? 'UNRESOLVED', executedAt: args.executedAt };
  }

  // 제출 미도달 확정 (게이트 차단·prepare/검증/서명 실패·4xx·429·사전 차단)
  await markIntentFailedPreBroadcast(args.intentId, reason ?? '제출 미도달');
  await audit('FAILED', reason);
  return { ok: false, txHash: null, orderKey: null, simulated: false, error: reason ?? 'GMX API 흐름 차단', executedAt: args.executedAt };
}

// ── 주기적 온체인 intent reconciliation ────────────────────────────────────────

let _intentReconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Worker 운영 중 주기적으로 차단 intent를 온체인 증거로 재판정한다.
 *
 * - 차단 intent가 0건이면 hasBlockingIntents의 DB 조회 1회 외에 아무 것도 하지
 *   않는다 (RPC 호출·상태 변경 없음 — PAPER 모드 무영향).
 * - 재시작 전용 전환(SUBMITTED→UNRESOLVED)은 수행하지 않는다 — 방금 제출된
 *   SUBMITTED intent를 오염시키지 않기 위함. 온체인 판정 규칙만 적용된다.
 * - 오류는 전부 흡수 (Worker 중단 금지). 차단 해소는 온체인 증거로만.
 */
export async function runPeriodicIntentReconciliation(): Promise<void> {
  try {
    if (!(await hasBlockingIntents())) return;
    const summary = await reconcileBlockingIntentsOnchain();
    await applyIntentResolutionsToAuditLog(summary.resolutions);
    if (summary.resolutions.length === 0) return;
    // 해소된 것이 있으면 차단 플래그 재평가 (감사로그+intent 모두 깨끗해야 해제)
    const auditLoaded = await loadAuditLogStrict();
    const auditBlocked = !auditLoaded.ok ||
      auditLoaded.entries.some(e => e.status === 'SUBMITTED' || e.status === 'UNRESOLVED');
    const stillBlocked = auditBlocked || await hasBlockingIntents();
    _reconciled = !stillBlocked;
    const now = new Date();
    await db.insert(workerStateTable)
      .values({ key: RECONCILED_KEY, value: String(_reconciled), updatedAt: now })
      .onConflictDoUpdate({ target: workerStateTable.key, set: { value: String(_reconciled), updatedAt: now } });
    console.info(`[LiveTestExecutor] 주기 reconciliation: ${summary.resolutions.length}건 해소, 차단=${stillBlocked}`);
  } catch (e) {
    console.error('[LiveTestExecutor] 주기 intent reconciliation 오류 (차단 유지, Worker 계속):', e);
  }
}

/** 주기 reconciliation 시작 (기본 5분). 중복 시작 방지. */
export function startPeriodicIntentReconciliation(intervalMs = 5 * 60_000): void {
  if (_intentReconcileTimer) return;
  _intentReconcileTimer = setInterval(() => { void runPeriodicIntentReconciliation(); }, intervalMs);
  console.info(`[LiveTestExecutor] 주기 intent reconciliation 시작 (${Math.round(intervalMs / 1000)}s 간격)`);
}

export function stopPeriodicIntentReconciliation(): void {
  if (_intentReconcileTimer) { clearInterval(_intentReconcileTimer); _intentReconcileTimer = null; }
}

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
  /**
   * 서버 최종 사이징 컨텍스트 (6H-2 §3) — 없으면 OPEN 거부 (fail-closed).
   * 실행 직전 enforceOrderSizing으로 재계산되며, 요청 sizeUsd/collateralUsd는
   * 서버 산정값을 초과할 수 없다 (초과 시 clamp + 감사로그).
   */
  sizingContext?: OrderSizingContext;
}

/** OPEN 사이징 강제 입력 — aiWorker가 조립, executor가 실행 직전 재계산 */
export interface OrderSizingContext {
  positionSizingCapitalUsd: number;
  stopDistanceFraction: number | null;
  costSnapshot: CostSnapshot | null;
  liquidityCapUsd: number | null;
  tierNotionalCapUsd: number;
  defensiveMode: boolean;
  canaryActive: boolean;
  operatorApprovedNotionalCapUsd?: number | null;
}

/** 마지막 사이징 강제 결과 — ExecutorStatus/UI 노출용 */
export interface SizingEnforcementSnapshot {
  at: string;
  decisionId: string;
  ok: boolean;
  reason: string | null;
  requestedSizeUsd: number;
  finalNotionalUsd: number | null;
  finalCollateralUsd: number | null;
  finalLeverage: number | null;
  allowedRiskUsd: number | null;
  clamped: boolean;
  clampDetails: string[];
  costSource: string | null;
  costFetchedAt: string | null;
  estimatedRoundTripCostUsd: number | null;
}

let _lastSizingEnforcement: SizingEnforcementSnapshot | null = null;
export function getLastSizingEnforcement(): SizingEnforcementSnapshot | null {
  return _lastSizingEnforcement;
}
/** 테스트 전용 초기화 */
export function __resetSizingEnforcementForTests(): void { _lastSizingEnforcement = null; }

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
    eventEmitterConfigured: resolveGmxEventEmitterAddress().ok,
    relayConfigured:        isGmxLiveRelayConfigured(),
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

  // ── 1.5) 서버 최종 사이징 강제 (6H-2 §3) — intent 생성 전, 실패 시 주문 0회 ──
  const sizingFail = async (reason: string): Promise<LiveOrderResult> => {
    _lastSizingEnforcement = {
      at: executedAt, decisionId: params.decisionId, ok: false, reason,
      requestedSizeUsd: params.sizeUsd, finalNotionalUsd: null, finalCollateralUsd: null,
      finalLeverage: null, allowedRiskUsd: null, clamped: false, clampDetails: [],
      costSource: params.sizingContext?.costSnapshot?.source ?? null,
      costFetchedAt: params.sizingContext?.costSnapshot?.fetchedAt ?? null,
      estimatedRoundTripCostUsd: null,
    };
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash: null, orderKey: null, status: 'FAILED', error: reason,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: reason, gateResult, executedAt };
  };

  // ── §8 — stop coverage 확인: COVERED 아닌 포지션이 있으면 신규 OPEN 금지 ──
  const coverage = await loadStopCoverage();
  if (!coverage.ok) {
    return sizingFail('[LIVE TEST] stop coverage 조회 실패 — 신규 OPEN 차단 (fail-closed)');
  }
  const uncovered = listUncovered(coverage.map);
  if (uncovered.length > 0) {
    return sizingFail(
      `[LIVE TEST] stop 미확보 포지션 ${uncovered.length}건 (${uncovered.map(u => `${u.positionRef}:${u.status}`).join(', ')}) — 복구/종료 전 신규 OPEN 금지`,
    );
  }

  if (!params.sizingContext) {
    return sizingFail('[LIVE TEST] 사이징 컨텍스트 없음 — 서버 최종 사이징 강제 불가, OPEN 0회 (fail-closed)');
  }
  const enf = enforceOrderSizing({
    requestedSizeUsd: params.sizeUsd,
    requestedCollateralUsd: params.collateralUsd,
    requestedLeverage: params.leverage,
    positionSizingCapitalUsd: params.sizingContext.positionSizingCapitalUsd,
    stopDistanceFraction: params.sizingContext.stopDistanceFraction,
    costSnapshot: params.sizingContext.costSnapshot,
    liquidityCapUsd: params.sizingContext.liquidityCapUsd,
    tierNotionalCapUsd: params.sizingContext.tierNotionalCapUsd,
    defensiveMode: params.sizingContext.defensiveMode,
    liveMode: true,
    canaryActive: params.sizingContext.canaryActive,
    operatorApprovedNotionalCapUsd: params.sizingContext.operatorApprovedNotionalCapUsd ?? null,
    expected: { market: params.marketAddress, isLong: params.isLong, orderType: 'MarketIncrease' },
    now: new Date(),
  });
  if (!enf.ok) {
    return sizingFail(`[LIVE TEST] 서버 사이징 거부 — ${enf.reason}`);
  }
  _lastSizingEnforcement = {
    at: executedAt, decisionId: params.decisionId, ok: true, reason: null,
    requestedSizeUsd: params.sizeUsd, finalNotionalUsd: enf.finalNotionalUsd,
    finalCollateralUsd: enf.finalCollateralUsd, finalLeverage: enf.finalLeverage,
    allowedRiskUsd: enf.allowedRiskUsd, clamped: enf.clamped, clampDetails: enf.clampDetails,
    costSource: params.sizingContext.costSnapshot?.source ?? null,
    costFetchedAt: params.sizingContext.costSnapshot?.fetchedAt ?? null,
    estimatedRoundTripCostUsd: enf.estimatedRoundTripCostUsd,
  };
  if (enf.clamped) {
    // clamp 사실은 감사로그에 별도 기록 (§3) — 주문은 서버 산정값으로 계속 진행
    const clampMsg = `[LIVE TEST] 요청값 clamp: ${enf.clampDetails.join('; ')} (요청 $${params.sizeUsd.toFixed(2)} → 최종 $${enf.finalNotionalUsd.toFixed(2)})`;
    console.warn(`[LiveTestExecutor] ${clampMsg}`);
    await appendAuditLog({
      id: `${entryId}-clamp`, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'SizingClamp', isLong: params.isLong,
      sizeUsd: enf.finalNotionalUsd, collateralUsd: enf.finalCollateralUsd,
      txHash: null, orderKey: null, status: 'SIMULATED', error: clampMsg,
      simulated: false, gateChecks: gateResult.checks, submittedAt: executedAt, confirmedAt: null,
    });
  }
  // 이후 모든 단계(intent·prepare 요청·expected echo 결속)는 서버 최종값 사용
  const finalSizeUsd = enf.finalNotionalUsd;
  const finalCollateralUsd = enf.finalCollateralUsd;

  // legacy calldata 빌드 제거됨 (6G-2 §5) — 주문 payload는 GMX API prepare가 생성한다.

  // ── 2) durable execution intent — writeContract 도달 전 PREPARED 커밋 필수 ──
  const intentId = buildIntentId(params.decisionId, 'open');
  const intentCreated = await createPreparedIntent({
    id: intentId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
    symbol: params.symbol, orderType: 'open', isLong: params.isLong,
    sizeUsd: finalSizeUsd, collateralUsd: finalCollateralUsd,
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

  // ── 3) 공식 GMX API v2 흐름 (§5) — prepare→검증→durable→서명→재게이트→submit 1회 ──
  // legacy SubaccountRouter writeContract 경로는 LEGACY_DISABLED로 폐기됨.
  const flowRes = await runGmxApiOrderPath({
    kind: 'OPEN', intentId, entryId, executedAt, gateChecks: gateResult.checks,
    liveTestMode: params.liveTestMode, dbOk: params.dbOk, rpcOk: Boolean(rpcUrl),
    decisionId: params.decisionId, cycleNumber: params.cycleNumber, symbol: params.symbol,
    marketAddress: params.marketAddress, isLong: params.isLong,
    sizeUsd: finalSizeUsd, collateralUsd: finalCollateralUsd,
    mainAddress: params.mainAddress, openPosition: null,
  });

  // ── §8 진입 후 계약 — OPEN 제출 성공 시 stop coverage PENDING 등록.
  // 등록 실패는 치명적: coverage 불명 상태로 두면 다음 사이클 uncovered 검사가
  // DB 조회 실패와 동일하게 신규 OPEN을 차단한다 (fail-closed 유지).
  if (flowRes.ok && !flowRes.simulated) {
    const saved = await saveStopCoverageRecord({
      positionRef: intentId, status: 'PENDING', stopOrderKey: null,
      triggerPriceUsd: null, updatedAt: new Date().toISOString(),
    });
    if (!saved) {
      console.error(`[LiveTestExecutor] stop coverage PENDING 등록 실패 (${intentId}) — 다음 OPEN은 coverage 조회 fail-closed로 차단됨`);
    }
  }
  return { ...flowRes, gateResult };
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
    eventEmitterConfigured: resolveGmxEventEmitterAddress().ok,
    relayConfigured:        isGmxLiveRelayConfigured(),
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

  // legacy calldata 빌드 제거됨 (6G-2 §5) — 청산 payload는 GMX API prepare가 생성한다.

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

  // ── 3) CLOSE 포지션 증거 (§5) — 조회 실패/부재 = submit 금지 (executeViaGmxApi가 차단) ──
  let openPosition: OpenPositionEvidence | null = null;
  try {
    const positions = _openPositionsFetchOverride
      ? await _openPositionsFetchOverride()
      : await fetchServerOpenPositions();
    if (positions) {
      openPosition = positions.find(
        (p) => p.marketAddress.toLowerCase() === params.marketAddress.toLowerCase()
          && p.isLong === params.isLong,
      ) ?? null;
    }
  } catch {
    openPosition = null; // 조회 실패 → 차단 (fail-closed)
  }

  // ── 4) 공식 GMX API v2 흐름 (§5) — legacy writeContract 경로는 LEGACY_DISABLED로 폐기됨 ──
  const flowRes = await runGmxApiOrderPath({
    kind: 'CLOSE', intentId, entryId, executedAt, gateChecks: gateResult.checks,
    liveTestMode: params.liveTestMode, dbOk: params.dbOk, rpcOk: Boolean(rpcUrl),
    decisionId: params.decisionId, cycleNumber: params.cycleNumber, symbol: params.symbol,
    marketAddress: params.marketAddress, isLong: params.isLong,
    sizeUsd: params.sizeUsd, collateralUsd: 0,
    mainAddress: params.mainAddress, openPosition,
  });
  return { ...flowRes, gateResult };
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
