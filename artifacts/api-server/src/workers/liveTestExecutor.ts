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
import { validateExecutionEligibleSnapshot, type CostSnapshot } from '../lib/costSnapshot';
import { listUncovered, type StopCoverageMap, type StopCoverageRecord } from '../lib/stopLossPlan';
import { isGmxLiveRelayConfigured, resolveGmxLiveRelayConfig } from '../lib/gmxLiveConfig';
// ── 6G-2 §5 — 공식 GMX API v2 실행 경로 (legacy writeContract 경로 대체) ──────
import { createGmxApiTransport, type GmxApiTransport } from '../lib/gmxApiTransport';
import {
  executeViaGmxApi,
  buildActivationInput,
  usdPriceToGmxString,
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
// ── 6H-2B §11 — stop 실행 능력 파생 게이트 ──────────────────────────────────
import { deriveStopExecutionCapability, type StopCapabilityResult } from '../lib/stopExecutionCapability';
import { evaluateActionBudget } from '../lib/actionBudget';
import {
  listBlockingProtections, listActiveProtections, recordProtectionEvidenceFields,
} from '../lib/protectionOrders';
// ── 6H-2C §3·§4 — decimals 권위 소스 + 온체인 증거 수집기 ────────────────────
import {
  resolveIndexTokenDecimals as resolveDecimalsAuthoritative,
  lookupSdkIndexToken, getDecimalsCacheSnapshot, ARBITRUM_CHAIN_ID,
  type DecimalsEvidence,
} from '../lib/indexTokenDecimals';
import {
  collectProtectionEvidence, analyzeProtectionAnomalies, EVIDENCE_CONFIRMATION_DEPTH,
  type ProtectionAnomalies, type EvidenceClient,
} from '../lib/protectionEvidence';
import {
  EVENT_LOG_2_TOPIC0, ORDER_EVENT_NAME_HASH, resolveGmxEventEmitterAddress as resolveEmitterCfg,
  type RawLog,
} from '../lib/gmxOrderEvents';
import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';
import { ORDER_TYPE } from '../lib/gmxCreateOrder';
import {
  setProtectionSubmitFn, runEmergencyClose, reconcileProtections,
  checkStartupProtectionCoverage,
  type ProtectionSubmitRequest, type ProtectionSubmitOutcome,
} from './protectionExecutor';

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

/** 제출 미도달/실패 시 사전 예약된 PENDING 레코드 제거 (best-effort — 실패 시 fail-closed 잔존) */
export async function removeStopCoverageRecord(positionRef: string): Promise<boolean> {
  try {
    const loaded = await loadStopCoverage();
    if (!loaded.ok) return false;
    if (!(positionRef in loaded.map)) return true;
    const map = { ...loaded.map };
    delete map[positionRef];
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
  // 6H-2B — 보호 주문 제출 함수 결선 + startup coverage/재판정 (fail-closed)
  wireProtectionExecution();
  try { await runProtectionPass('startup'); } catch { /* 차단은 capability/게이트가 담당 */ }
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

/** authoritative 온체인 포지션 조회 (override 우선) — 실패 = null (fail-closed) */
export async function fetchAuthoritativeOpenPositions(): Promise<OpenPositionEvidence[] | null> {
  try {
    return _openPositionsFetchOverride
      ? await _openPositionsFetchOverride()
      : await fetchServerOpenPositions();
  } catch {
    return null;
  }
}

// ── 6H-2A §7 — stop 실행 능력 게이트 ──────────────────────────────────────────

export const STOP_EXECUTION_UNAVAILABLE = 'STOP_EXECUTION_UNAVAILABLE';

/**
 * 6H-2B §11 — stop 실행 능력은 상수가 아니라 실제 조건에서 파생한다.
 * deriveStopExecutionCapability(순수 함수)에 서버 상태를 공급해 캐시하며,
 * 어떤 조건도 낙관 기본값을 갖지 않는다 (초기값 = 미평가 → false).
 * 현 Production(서명·제출 잠금)에서는 available=false가 정상.
 */
let _stopCapability: StopCapabilityResult & { evaluatedAt: string | null } = {
  available: false,
  reasons: ['stop 실행 능력 미평가 — refreshStopExecutionCapability 필요 (fail-closed)'],
  evaluatedAt: null,
};
/** 테스트 전용 강제 override (null = 파생값 사용) */
let _stopCapabilityTestOverride: boolean | null = null;

export function isStopExecutionAvailable(): boolean {
  if (_stopCapabilityTestOverride !== null) return _stopCapabilityTestOverride;
  return _stopCapability.available;
}
export function getStopExecutionCapability(): StopCapabilityResult & { evaluatedAt: string | null } {
  return _stopCapability;
}
export function __setStopExecutionAvailabilityForTests(v: boolean | null): void {
  _stopCapabilityTestOverride = v;
}

/**
 * §2 — stop 스키마 런타임 검증: 로컬 ORDER_TYPE 상수를 설치된 공식 SDK enum과
 * 실시간 대조한다 (상수 true 금지 — SDK 로드/대조 실패 = false, 캐시).
 */
let _schemaVerifiedCache: boolean | null = null;
async function verifyStopSchemaAgainstSdk(): Promise<boolean> {
  if (_schemaVerifiedCache !== null) return _schemaVerifiedCache;
  try {
    const sdk = await import('@gmx-io/sdk/types/orders');
    const e = (sdk as unknown as { OrderType?: Record<string, number> }).OrderType;
    _schemaVerifiedCache = !!e &&
      Number(ORDER_TYPE.MarketIncrease) === e.MarketIncrease &&
      Number(ORDER_TYPE.MarketDecrease) === e.MarketDecrease &&
      Number(ORDER_TYPE.StopLossDecrease) === e.StopLossDecrease &&
      Number(ORDER_TYPE.Liquidation) === e.Liquidation;
  } catch { _schemaVerifiedCache = false; }
  return _schemaVerifiedCache;
}

/**
 * §11 — 실제 조건에서 stop 실행 능력 재평가. 조회 실패 = 해당 조건 false.
 * 어느 경로에서도 상수 true를 주입하지 않는다.
 */
export async function refreshStopExecutionCapability(): Promise<StopCapabilityResult> {
  // durable 저장소 + 차단 보호 주문
  let blockingProtectionCount: number | null = null;
  let durableStoreOk = false;
  try {
    const listed = await listBlockingProtections();
    if (listed.ok) { durableStoreOk = true; blockingProtectionCount = listed.rows.length; }
  } catch { /* fail-closed */ }
  // coverage (기존 worker_state 상태 머신)
  let uncoveredCount: number | null = null;
  try {
    const cov = await loadStopCoverage();
    if (cov.ok) uncoveredCount = listUncovered(cov.map).length;
  } catch { /* fail-closed */ }
  // action 예산 — canonical snapshot remaining (§7)
  const snap = getCanonicalSnapshot();
  const budget = evaluateActionBudget({
    remaining: snap?.remaining ?? null,
    expiresAt: snap?.expiresAt ?? null,
    nowMs: Date.now(),
    inFlightReservedActions: await countInFlightReservedActions(),
  });
  // fee freshness — 저장 스냅샷 (10분 활성 게이트와 동일 소스; 실행 직전 30초
  // 재확인은 executeLiveTestOrder의 validateExecutionEligibleSnapshot이 담당)
  const fe = getFeeEstimateState();
  const freshFeeQuote = fe.attempted && fe.ok && fe.atMs !== null && Date.now() - fe.atMs < 10 * 60_000;
  let noBlockingIntents = false;
  try { noBlockingIntents = !(await hasBlockingIntents()); } catch { /* fail-closed */ }

  const derived = deriveStopExecutionCapability({
    schemaVerified: await verifyStopSchemaAgainstSdk(), // 설치된 SDK enum 실시간 대조
    transportConfigured: isGmxLiveRelayConfigured() && resolveGmxEventEmitterAddress().ok,
    signerReady: isDelegatedSignerEnabled() && isSignerInitialized(),
    durableStoreOk,
    reconciliationOk: _reconciled && noBlockingIntents,
    actionBudgetSufficient: budget.sufficient,
    actionBudgetRemaining: budget.remainingActions,
    freshFeeQuote,
    uncoveredCount,
    blockingProtectionCount,
    executionUnlocked: !isLiveTestExecutionLocked() && !_emergencyStop,
    // ── 6H-2C §9 — 추가 조건 (전부 실제 파생, 상수 금지) ──
    decimalsSourceReady:
      Boolean(process.env.GMX_RPC_URL?.trim()) &&
      lookupSdkIndexToken(ARBITRUM_CHAIN_ID, '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336').ok, // SDK registry 로드 검증 (ETH/USD 공식 market)
    priceConversionVerified: verifyPriceConversionGolden(),
    evidenceCollectorReady: resolveEmitterCfg().ok && Boolean(process.env.GMX_RPC_URL?.trim()),
    protectionReconciliationClean:
      _protectionRecon.complete && !_protectionRecon.blockNewOpens,
    positionSnapshotFresh:
      _protectionRecon.lastPositionsFetchOkAtMs !== null &&
      Date.now() - _protectionRecon.lastPositionsFetchOkAtMs < 10 * 60_000,
  });
  _stopCapability = { ...derived, evaluatedAt: new Date().toISOString() };
  return derived;
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
// ── 6H-2B §5·§6 — 보호 주문 production wiring ────────────────────────────────

/**
 * 6H-2C §3 — 인덱스 토큰 decimals 권위 소스: SDK metadata + 온체인 ERC-20
 * decimals() 교차검증 (indexTokenDecimals 모듈). 어느 한쪽 실패/불일치 = null.
 * §13 고지: 여기서 read-only eth_call(decimals()) 1회를 GMX_RPC_URL로 수행한다.
 */
async function fetchOnchainErc20Decimals(tokenAddress: string): Promise<number | null> {
  const url = process.env.GMX_RPC_URL?.trim();
  if (!url) return null;
  try {
    const client = createPublicClient({ chain: arbitrum, transport: http(url, { timeout: 8_000 }) });
    const chainId = await client.getChainId();
    if (chainId !== ARBITRUM_CHAIN_ID) return null; // 네트워크 불일치 = 차단
    const v = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }],
      functionName: 'decimals',
    });
    return typeof v === 'number' ? v : Number(v);
  } catch { return null; }
}

/** 테스트 주입용 override (null = 실 경로) */
let _decimalsResolverOverride: ((marketAddress: string) => Promise<DecimalsEvidence | null>) | null = null;
export function __setDecimalsResolverForTests(fn: ((m: string) => Promise<DecimalsEvidence | null>) | null): void {
  _decimalsResolverOverride = fn;
}

async function resolveIndexTokenDecimalsEvidence(marketAddress: string): Promise<DecimalsEvidence | null> {
  if (_decimalsResolverOverride) return _decimalsResolverOverride(marketAddress);
  const res = await resolveDecimalsAuthoritative({
    chainId: ARBITRUM_CHAIN_ID,
    marketAddress,
    fetchOnchainDecimals: fetchOnchainErc20Decimals,
  });
  if (!res.ok) {
    console.error(`[LiveTestExecutor] decimals 확보 실패 — ${res.reason}`);
    return null;
  }
  return res.evidence;
}

/** §3 — 가격 변환 규칙 런타임 자기검증 (골든 값 대조; 상수 true 금지) */
let _priceConversionVerifiedCache: boolean | null = null;
export function verifyPriceConversionGolden(): boolean {
  if (_priceConversionVerifiedCache !== null) return _priceConversionVerifiedCache;
  try {
    _priceConversionVerifiedCache =
      usdPriceToGmxString(2000, 18) === (2000n * 10n ** 12n).toString() &&      // 10^(30-18)
      usdPriceToGmxString(65000, 8) === (65000n * 10n ** 22n).toString() &&     // 10^(30-8)
      usdPriceToGmxString(1.5, 8) === (15n * 10n ** 21n).toString();
  } catch { _priceConversionVerifiedCache = false; }
  return _priceConversionVerifiedCache;
}

let _protectionWired = false;

/**
 * 실제 보호 주문 제출 함수 결선 — executeViaGmxApi 경로 재사용 (activation gate·
 * durable intent·단일 submit 규칙 전부 그대로 적용). LIVE 잠금이면 gate가 차단
 * (네트워크 0회). 테스트가 setProtectionSubmitFn으로 override 가능.
 */
export function wireProtectionExecution(): void {
  if (_protectionWired) return;
  _protectionWired = true;
  setProtectionSubmitFn(async (req: ProtectionSubmitRequest): Promise<ProtectionSubmitOutcome> => {
    // 포지션 증거 필수 (STOP/CLOSE 공통 — authoritative readback)
    const positions = await fetchAuthoritativeOpenPositions();
    if (positions === null) return { status: 'FAILED_PRE_BROADCAST', reason: 'authoritative 포지션 조회 실패 — 제출 0회 (fail-closed)' };
    const pos = positions.find(
      (p) => p.marketAddress.toLowerCase() === req.marketAddress.toLowerCase() && p.isLong === req.isLong,
    ) ?? null;
    if (!pos) return { status: 'FAILED_PRE_BROADCAST', reason: '대상 포지션 없음 — 보호 주문 제출 0회' };

    const mainAddress = process.env.GMX_WALLET_ADDRESS ?? '';
    const isStop = req.purpose !== 'EMERGENCY_CLOSE';
    let triggerPriceGmx: string | undefined;
    let acceptablePriceGmx: string | undefined;
    if (isStop) {
      if (req.triggerPriceUsd === null || req.acceptablePriceUsd === null) {
        return { status: 'FAILED_PRE_BROADCAST', reason: 'stop trigger/acceptable 가격 누락 — 제출 0회' };
      }
      if (!verifyPriceConversionGolden()) {
        return { status: 'FAILED_PRE_BROADCAST', reason: '가격 변환 규칙 자기검증 실패 — stop 제출 0회 (fail-closed)' };
      }
      const dec = await resolveIndexTokenDecimalsEvidence(req.marketAddress);
      if (dec === null) {
        return { status: 'FAILED_PRE_BROADCAST', reason: '인덱스 토큰 decimals 권위 소스 확보 실패 (SDK+온체인 교차검증) — 가격 변환 불가, stop 제출 0회 (fail-closed)' };
      }
      try {
        triggerPriceGmx = usdPriceToGmxString(req.triggerPriceUsd, dec.decimals);
        acceptablePriceGmx = usdPriceToGmxString(req.acceptablePriceUsd, dec.decimals);
      } catch (e) {
        return { status: 'FAILED_PRE_BROADCAST', reason: `가격 정밀도 변환 실패 — ${(e as Error).message}` };
      }
      // §3 — durable decimals 증거 기록 (저장 실패 = 제출 금지, fail-closed)
      const snapNow = getCanonicalSnapshot();
      const budgetNow = evaluateActionBudget({
        remaining: snapNow?.remaining ?? null, expiresAt: snapNow?.expiresAt ?? null,
        nowMs: Date.now(), inFlightReservedActions: await countInFlightReservedActions(),
      });
      const recorded = await recordProtectionEvidenceFields(req.protectionId, {
        decimalsUsed: dec.decimals, decimalsSource: dec.source,
        decimalsTokenAddress: dec.indexTokenAddress, decimalsVerifiedAt: new Date(dec.verifiedAtMs),
        actionBudgetSnapshot: JSON.stringify({
          remaining: budgetNow.remainingActions, required: budgetNow.requiredActions,
          inFlight: budgetNow.inFlightReservedActions, shortfall: budgetNow.budgetShortfall,
          atMs: Date.now(),
        }),
      });
      if (!recorded) {
        return { status: 'FAILED_PRE_BROADCAST', reason: 'decimals 증거 durable 기록 실패 — stop 제출 0회 (fail-closed)' };
      }
    }

    const activationArgs = {
      kind: 'CLOSE' as const, liveTestMode: true,
      dbOk: true, rpcOk: Boolean(process.env.GMX_RPC_URL),
      selfIntentId: null,
    };
    const res = await executeViaGmxApi({
      transport: getGmxApiTransport(),
      req: {
        kind: isStop ? 'STOP_LOSS' : 'CLOSE',
        symbol: req.symbol, marketAddress: req.marketAddress, isLong: req.isLong,
        sizeUsd: req.sizeDeltaUsd, collateralUsd: 0,
        mainWallet: mainAddress, subaccountAddress: getSignerAddress() ?? '',
        ...(isStop ? { triggerPriceGmx, acceptablePriceGmx } : {}),
      },
      intentId: req.protectionId,
      activation: await buildExecutorActivationInput(activationArgs),
      reevaluateActivation: () => buildExecutorActivationInput(activationArgs),
      openPosition: pos,
      canonicalNonce: (() => {
        const snap = getCanonicalSnapshot();
        if (!snap?.approvalNonce) return null;
        try { return BigInt(snap.approvalNonce); } catch { return null; }
      })(),
    });
    if (res.finalStatus === 'TASK_ACCEPTED' && res.submitted) {
      // 6H-2D §2 — 서명 게이트(verifyOrderSemanticBinding)가 autoCancel=false를
      // 강제하므로, 수락된 주문의 인코딩값은 false임이 보장된다 → durable 기록.
      await recordProtectionEvidenceFields(req.protectionId, { autoCancelEncoded: false });
      return { status: 'ACCEPTED', requestId: res.gmxRequestId, typedDataDigest: null };
    }
    if (res.finalStatus === 'UNRESOLVED') {
      return { status: 'UNRESOLVED', reason: res.blockReasons.join('; ') || '제출 결과 불명' };
    }
    return { status: 'FAILED_PRE_BROADCAST', reason: res.blockReasons.join('; ') || '제출 미도달' };
  });
}

/**
 * §6·§9 — 주기 보호 주문 pass:
 *  1. ACTIVE stop 없는 열린 포지션 → runEmergencyClose (durable 1회 보장)
 *  2. 차단 상태 보호 주문 재판정 (증거 수집 미구현 = 전이 없음 + 차단 유지)
 * 실패해도 Worker는 계속 — 차단은 capability/OPEN 게이트가 담당 (fail-closed).
 */
// ── 6H-2C §4·§5 — 증거 수집기 + reconciliation 상태 ──────────────────────────

export interface ProtectionReconState {
  lastRunAtMs: number | null;
  complete: boolean;               // 전수 판정 성공 (조회 실패 없음)
  anomalies: ProtectionAnomalies | null;
  blockNewOpens: boolean;
  lastPositionsFetchOkAtMs: number | null;
  // ── 6H-2D §5 — ambiguous 증거·실행 소스 추적 ──
  ambiguousCount: number;
  ambiguousReasons: string[];
  lastSource: 'startup' | 'periodic' | null;
  confirmationDepth: number;
}
let _protectionRecon: ProtectionReconState = {
  lastRunAtMs: null, complete: false, anomalies: null, blockNewOpens: true,
  lastPositionsFetchOkAtMs: null,
  ambiguousCount: 0, ambiguousReasons: [], lastSource: null,
  confirmationDepth: EVIDENCE_CONFIRMATION_DEPTH,
};
export function getProtectionReconState(): ProtectionReconState { return _protectionRecon; }
/**
 * 테스트 주입 — sticky: 이후 runProtectionPass가 덮어쓰지 않는다 (null로 해제).
 * 6H-2D §6 — 테스트 런타임 밖에서 호출되면 즉시 throw (프로덕션 오용 차단).
 */
let _protectionReconOverride: ProtectionReconState | null = null;
export function __setProtectionReconStateForTests(s: ProtectionReconState | null): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    throw new Error('__setProtectionReconStateForTests는 테스트 런타임 전용 — 프로덕션 호출 금지');
  }
  _protectionReconOverride = s;
  if (s) _protectionRecon = s;
}

/** 테스트 주입용 evidence client override */
let _evidenceClientOverride: EvidenceClient | null = null;
export function __setEvidenceClientForTests(c: EvidenceClient | null): void { _evidenceClientOverride = c; }

/** §4 — orderKey 결속 EventLog2 로그 조회 클라이언트 (read-only eth_getLogs) */
function createEvidenceClient(): EvidenceClient | null {
  if (_evidenceClientOverride) return _evidenceClientOverride;
  const url = process.env.GMX_RPC_URL?.trim();
  if (!url) return null;
  const client = createPublicClient({ chain: arbitrum, transport: http(url, { timeout: 8_000 }) });
  return {
    async getOrderLogs(orderKey: string, emitters: string[]): Promise<RawLog[] | null> {
      try {
        const raw = await client.request({
          method: 'eth_getLogs',
          params: [{
            address: emitters,
            fromBlock: 'earliest', toBlock: 'latest',
            topics: [
              EVENT_LOG_2_TOPIC0,
              [
                ORDER_EVENT_NAME_HASH.OrderCreated, ORDER_EVENT_NAME_HASH.OrderExecuted,
                ORDER_EVENT_NAME_HASH.OrderCancelled, ORDER_EVENT_NAME_HASH.OrderFrozen,
              ],
              orderKey,
            ],
          }],
        } as never) as Array<{ address: string; topics: string[]; transactionHash?: string; blockNumber?: string; data?: string }>;
        return (raw ?? []).map(l => ({
          address: l.address, topics: l.topics,
          transactionHash: l.transactionHash ?? null,
          blockNumber: l.blockNumber ? String(BigInt(l.blockNumber)) : null,
          data: l.data ?? null,
        }));
      } catch { return null; }
    },
    // ── 6H-2D §4 — receipt·finality (read-only) ──
    async getReceipt(txHash: string) {
      try {
        const rc = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
        if (!rc) return null;
        return {
          status: rc.status === 'success' ? 'success' as const : 'reverted' as const,
          blockNumber: rc.blockNumber != null ? String(rc.blockNumber) : null,
          logs: (rc.logs ?? []).map(l => ({
            address: l.address, topics: l.topics as string[],
            transactionHash: l.transactionHash ?? null,
            blockNumber: l.blockNumber != null ? String(l.blockNumber) : null,
            data: l.data ?? null,
          })),
        };
      } catch (e) {
        // viem은 미존재 receipt에 throw — 미존재는 null(전이 없음), 그 외도 null (fail-closed)
        if ((e as Error)?.name === 'TransactionReceiptNotFoundError') return null;
        return null;
      }
    },
    async getLatestBlockNumber(): Promise<bigint | null> {
      try { return await client.getBlockNumber(); } catch { return null; }
    },
  };
}

/** §6 — 진행 중(비terminal) 보호 주문의 앞으로의 action 예약분 (조회 실패 = null) */
export async function countInFlightReservedActions(): Promise<number | null> {
  try {
    const listed = await listActiveProtections();
    if (!listed.ok) return null;
    // ACTIVE stop은 이미 action을 소비했지만 정리(cancel) 1회를 예약한다.
    // PLANNED~SUBMITTED/UNRESOLVED/FROZEN은 해소(제출 또는 취소) 1회 예약.
    return listed.rows.length;
  } catch { return null; }
}

export async function runProtectionPass(source: 'startup' | 'periodic' = 'periodic'): Promise<void> {
  wireProtectionExecution();
  if (_protectionReconOverride) { _protectionRecon = _protectionReconOverride; return; }
  try {
    const [positions, active] = await Promise.all([
      fetchAuthoritativeOpenPositions(), listActiveProtections(),
    ]);
    const activeKeys = new Set<string>(
      active.ok ? active.rows.filter((r) => r.status === 'ACTIVE').map((r) => r.positionKey) : [],
    );
    const posList = positions === null ? null : positions.map((p) => ({
      positionKey: `${p.marketAddress.toLowerCase()}:${p.isLong ? 'L' : 'S'}`,
      marketAddress: p.marketAddress, isLong: p.isLong, sizeUsd: p.sizeUsd,
    }));
    const cov = checkStartupProtectionCoverage({
      positions: active.ok ? posList : null, // 보호 주문 조회 실패도 차단으로 취급
      activeStopPositionKeys: activeKeys,
    });
    if (!cov.ok && posList) {
      for (const u of cov.uncovered) {
        const p = posList.find((x) => x.positionKey === u.positionKey);
        if (!p) continue;
        console.error(`[LiveTestExecutor] 🚨 ACTIVE stop 없는 포지션 ${u.positionKey} ($${u.sizeUsd}) — emergency close 시도`);
        const r = await runEmergencyClose({
          parentOpenIntentId: u.positionKey, positionKey: u.positionKey,
          symbol: p.marketAddress, marketAddress: p.marketAddress, isLong: p.isLong,
          fullSizeUsd: u.sizeUsd, reason: 'ACTIVE stop 부재 — 무방비 포지션 (§6)',
        });
        if (!r.ok) console.error(`[LiveTestExecutor] emergency close 결과: ${r.reason}`);
      }
    }
    // ── 6H-2C §4 — 온체인 증거 수집기 결선 (조회 실패 = 전이 없음 + 차단 유지) ──
    const evClient = createEvidenceClient();
    const emitterCfg = resolveEmitterCfg();
    const configuredEmitter = emitterCfg.ok ? emitterCfg.address : null;
    const positionsOk = positions !== null;
    if (positionsOk) _protectionRecon.lastPositionsFetchOkAtMs = Date.now();
    // 6H-2D §3 — 의미 결속 기대 account/receiver (main + subaccount 서명자)
    const mainWallet = (process.env.GMX_WALLET_ADDRESS ?? '').trim();
    const signerAddr = getSignerAddress() ?? '';
    const expectedAccounts = [mainWallet, signerAddr].filter(a => /^0x[0-9a-fA-F]{40}$/.test(a));
    const summary = await reconcileProtections(async (row) => {
      if (!evClient || !configuredEmitter) return null; // 수집기 미구성 — 판정 금지
      const posExists = positions === null ? null : positions.some(
        (p) => p.marketAddress.toLowerCase() === row.marketAddress.toLowerCase() && p.isLong === row.isLong,
      );
      return collectProtectionEvidence({
        row, client: evClient, configuredEmitter, positionExists: posExists,
        expectedAccounts,
        expectedReceiver: /^0x[0-9a-fA-F]{40}$/.test(mainWallet) ? mainWallet : null,
      });
    });

    // ── §5 — 포지션-stop 정합성 분석 (무stop/고아/oversized/다중/키 누락) ──────
    const anomalies = analyzeProtectionAnomalies({
      positions: posList,
      stopRows: active.ok ? active.rows.map((r) => ({
        id: r.id, positionKey: r.positionKey, status: r.status, purpose: r.purpose,
        sizeDeltaUsd: Number(r.sizeDeltaUsd), orderKey: r.orderKey,
      })) : null,
    });
    if (anomalies.blockNewOpens) {
      console.error(`[LiveTestExecutor] 보호 주문 정합성 불일치 — ${anomalies.details.join('; ')}`);
    }
    _protectionRecon = {
      lastRunAtMs: Date.now(),
      complete: positionsOk && active.ok && !summary.blockNewOpens && summary.ambiguousCount === 0,
      anomalies,
      blockNewOpens: summary.blockNewOpens || anomalies.blockNewOpens,
      lastPositionsFetchOkAtMs: _protectionRecon.lastPositionsFetchOkAtMs,
      ambiguousCount: summary.ambiguousCount,
      ambiguousReasons: summary.ambiguousReasons.slice(0, 10),
      lastSource: source,
      confirmationDepth: EVIDENCE_CONFIRMATION_DEPTH,
    };
  } catch (e) {
    _protectionRecon = { ..._protectionRecon, lastRunAtMs: Date.now(), complete: false, blockNewOpens: true, lastSource: source };
    console.error(`[LiveTestExecutor] 보호 주문 pass 오류 (fail-closed 유지): ${(e as Error).message}`);
  }
}

export async function runPeriodicIntentReconciliation(): Promise<void> {
  // §11 — stop 실행 능력 주기 재평가 (실패해도 Worker 계속, 능력은 fail-closed 유지)
  try { await refreshStopExecutionCapability(); } catch { /* fail-closed 유지 */ }
  // 6H-2B §6·§9 — 보호 주문 coverage·재판정 pass
  try { await runProtectionPass(); } catch { /* fail-closed 유지 */ }
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

  // ── 6H-2A §7 — stop 실행 능력 게이트: trigger 주문 제출 경로가 없으면
  // 실제(비시뮬) OPEN 자체를 차단한다. "오픈 후 stop 심기" 낙관 처리 금지.
  if (!isStopExecutionAvailable()) {
    const msg = `[LIVE TEST] ${STOP_EXECUTION_UNAVAILABLE}: stop(trigger) 주문 제출 경로 미구현 — 실제 OPEN 차단 (fail-closed)`;
    await appendAuditLog({
      id: entryId, decisionId: params.decisionId, cycleNumber: params.cycleNumber,
      symbol: params.symbol, orderType: 'MarketIncrease', isLong: params.isLong,
      sizeUsd: params.sizeUsd, collateralUsd: params.collateralUsd,
      txHash: null, orderKey: null, status: 'FAILED', error: msg,
      simulated: false, gateChecks: {}, submittedAt: executedAt, confirmedAt: null,
    });
    return { ok: false, txHash: null, orderKey: null, simulated: false, error: msg, executedAt };
  }

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

  // ── 6H-2B §10 — OPEN prepare 직전 실행 적격(30초) 비용 스냅샷 재확인 ──────
  // 표시용 cache(10분)는 여기서 절대 사용 금지 — sizingContext의 스냅샷이
  // 30초 창을 벗어났으면 OPEN 차단 (재조회는 aiWorker 다음 사이클 몫, fail-closed).
  {
    const eligible = validateExecutionEligibleSnapshot(
      params.sizingContext.costSnapshot,
      {
        market: params.marketAddress, isLong: params.isLong,
        orderType: 'MarketIncrease', notionalUsd: finalSizeUsd,
      },
      Date.now(),
    );
    if (!eligible.ok) {
      return sizingFail(`[LIVE TEST] 실행 적격 비용 스냅샷 확인 실패 — ${eligible.reason} — OPEN 차단 (fail-closed)`);
    }
  }

  // ── 6H-2B §7 — OPEN 직전 동기 action 예산 게이트 (캐시 아닌 현재 canonical) ──
  // OPEN 1 + INITIAL_STOP 1 + EMERGENCY_CLOSE 1 + stale CANCEL 1 = 최소 4 action.
  // capability 5분 캐시와 별개로 매 OPEN마다 재평가 — 부족 시 자동 확대 금지, 차단.
  {
    const snap = getCanonicalSnapshot();
    const budget = evaluateActionBudget({
      remaining: snap?.remaining ?? null,
      expiresAt: snap?.expiresAt ?? null,
      nowMs: Date.now(),
      inFlightReservedActions: await countInFlightReservedActions(),
    });
    if (!budget.sufficient) {
      return sizingFail(`[LIVE TEST] action 예산 부족/조회불가 — ${budget.reasons[0] ?? ''} — OPEN 차단 (자동 확대 금지)`);
    }
    // §5 — 최근 reconciliation 미완료/불일치 존재 시 OPEN 금지 (fail-closed)
    const recon = getProtectionReconState();
    if (!recon.complete || recon.blockNewOpens) {
      return sizingFail('[LIVE TEST] 보호 주문 reconciliation 미완료/불일치 — 신규 OPEN 차단 (fail-closed)');
    }
  }

  // ── 6H-2B §3 — 차단 상태 보호 주문(UNRESOLVED/FROZEN/미종결) 존재 시 OPEN 금지 ──
  {
    const listed = await listBlockingProtections();
    if (!listed.ok) {
      return sizingFail('[LIVE TEST] 보호 주문 상태 조회 실패 — OPEN 차단 (fail-closed)');
    }
    if (listed.rows.length > 0) {
      return sizingFail(`[LIVE TEST] 차단 상태 보호 주문 ${listed.rows.length}건 — 해소 전 신규 OPEN 금지`);
    }
  }

  // legacy calldata 빌드 제거됨 (6G-2 §5) — 주문 payload는 GMX API prepare가 생성한다.

  // ── 2) durable execution intent — writeContract 도달 전 PREPARED 커밋 필수 ──
  const intentId = buildIntentId(params.decisionId, 'open');

  // ── §8 진입 전 계약 — 제출 시도 전에 stop coverage PENDING을 원자적으로 예약.
  // 저장 실패 = OPEN 차단 (fail-closed). 제출 미도달/실패 시 아래에서 제거를
  // 시도하며, 제거 실패 시 PENDING 잔존 → 다음 OPEN이 차단된다 (역시 fail-closed).
  const covReserved = await saveStopCoverageRecord({
    positionRef: intentId, status: 'PENDING', stopOrderKey: null,
    triggerPriceUsd: null, updatedAt: new Date().toISOString(),
  });
  if (!covReserved) {
    return sizingFail('[LIVE TEST] stop coverage PENDING 예약 실패 — 신규 OPEN 차단 (fail-closed)');
  }
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

  // ── §8 사후 정리 — 실주문이 제출되지 않았으면(시뮬/실패) 사전 예약한 PENDING 제거.
  // 제거 실패 시 PENDING 잔존 → 다음 OPEN 차단 (fail-closed — false positive 허용).
  if (!flowRes.ok || flowRes.simulated) {
    const removed = await removeStopCoverageRecord(intentId);
    if (!removed) {
      console.error(`[LiveTestExecutor] stop coverage 예약 제거 실패 (${intentId}) — 잔존 PENDING이 다음 OPEN을 차단함 (fail-closed)`);
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
