/**
 * #135 — Manual Controlled Canary (운영자 1회 수동 실행 경로)
 *
 * 자동 Worker와 구조적으로 분리된, 운영자 인증 하의 단 1회 $10 Canary
 * (OPEN → stop ACTIVE → Close → 온체인 CONFIRMED → readback) 전용 모듈.
 *
 * 원칙 (docs/manual-canary.md):
 *  - 하드캡은 서버에서 강제하며 요청 입력으로 확대 불가 (초과=거부, clamp 없음 — 명시 거부).
 *  - preflight는 read-only (주문·서명·키 복호화·설정 변경 0회).
 *  - 실행은 2단계: preflightId(120s TTL) + confirm 문구 + 실행 직전 전 조건 재평가.
 *  - 일일 1회 예산은 durable CAS claim을 제출 **이전**에 수행 (fail-closed).
 *  - deterministic decisionId → 기존 execution_intents PK/unique로 중복 제출 구조 차단.
 *  - timeout/모호 응답 = UNRESOLVED (기존 계층), 자동 재제출 금지.
 *  - PIN·서명·암호문·개인키·RPC URL은 어떤 출력에도 미포함.
 *
 * #142 — ManualCanaryPreflightDeps: preflight/evaluate 경로에는 실행 능력이
 *  구조적으로 없다 (executeOrder·closePosition·runEmergencyClose 등 완전 부재).
 *  PREFLIGHT_OPERATION_ALLOWLIST: 동결 allowlist — readonly check 와 preflight-token
 *  CAS만 포함. GITHUB_CI blocker는 앱 측 자격증명 없이 UNATTESTED fail-closed.
 */
import { db, workerStateTable } from '@workspace/db';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { LiveOrderParams, LiveOrderResult } from '../workers/liveTestExecutor';
import type { ClosePositionBinding } from './executionIntents';
import type { CostSnapshot } from '../lib/costSnapshot';
import { computeStopTrigger } from './stopLossPlan';
import { manilaDayKey } from './profitProtection';

// ── 하드캡 (동결 — UI/요청 입력으로 확대 불가) ────────────────────────────────
export const MANUAL_CANARY_CAPS = Object.freeze({
  maxCollateralUsd: 10,
  maxLeverage: 2,
  maxNotionalUsd: 20,
  maxOpenPositions: 1,
  maxAccumLossUsd: 3,
  maxOrdersPerDay: 1,
  maxRoundTripCostUsd: 0.4,       // RiskEngine보다 엄격한 왕복 비용 상한
  maxPriceDriftFraction: 0.005,   // preflight 대비 실행 시 0.5% — 시장가 추격 방지
  allowedSymbols: ['BTC', 'ETH'] as readonly string[],
  preflightTtlMs: 120_000,
});

export const CANARY_CONFIRM_OPEN = 'EXECUTE-CANARY-OPEN';
export const CANARY_CONFIRM_CLOSE = 'EXECUTE-CANARY-CLOSE';

const STATE_KEY_PREFLIGHT = 'manualCanaryPreflight';
const STATE_KEY_DAILY = 'manualCanaryDaily';

// ── #142: Preflight Operation Allowlist (동결 — 실행 능력 진입 불가) ──────────
/**
 * Preflight 단계에서 허용되는 연산의 안정 ID 목록.
 * 카테고리:
 *  - readonly: 부작용 없는 읽기 전용 검사
 *  - cas_preflight_token: preflight 토큰 durable 저장 (preflightId 발급 전제)
 * 금지: executeOrder, closePosition, runEmergencyClose, nonce 읽기,
 *       서명, relay task, 자금, signer record mutation, intent submit 등.
 */
export const PREFLIGHT_OPERATION_ALLOWLIST = Object.freeze({
  readonly: Object.freeze([
    'clock',
    'random_id',
    'deployment',
    'router_pin',
    'signer_binding',
    'owner_approval',
    'allowance',
    'gmx_api',
    'rpc',
    'reconciliation',
    'open_positions',
    'decimals',
    'stop_capability',
    'cost_snapshot',
    'accum_loss',
    'daily_budget',
    'env_submission',
    'price',
    'github_ci',
    'preflight_token_read',
  ] as readonly string[]),
  /** preflight CAS — preflightId 토큰 저장만. daily claim CAS는 실행 단계 전용. */
  cas_preflight_token: Object.freeze(['manualCanaryPreflight'] as readonly string[]),
} as const);

export const CANARY_PREFLIGHT_FORBIDDEN_OPERATIONS = Object.freeze([
  'owner_approval_prepare',
  'metamask_sign',
  'delegated_signer_sign',
  'gmx_prepare',
  'gmx_submit',
  'nonce_create',
  'relay_task_create',
  'execution_intent_create',
  'protection_order_create',
  'signer_record_mutate',
  'fund_transfer',
] as const);

export type PreflightOperationKind = keyof typeof PREFLIGHT_OPERATION_ALLOWLIST;

/**
 * Every preflight/status dependency call must pass through this runtime gate.
 * Unknown operations are rejected before the callback can run.
 */
export async function runAllowedPreflightOperation<T>(
  kind: PreflightOperationKind,
  operation: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  const allowed = PREFLIGHT_OPERATION_ALLOWLIST[kind] as readonly string[];
  if (!allowed.includes(operation)) {
    throw new Error(`CANARY_PREFLIGHT_OPERATION_DENIED:${kind}:${operation}`);
  }
  return await callback();
}

// ── 타입 ─────────────────────────────────────────────────────────────────────
export interface PreflightItem { id: string; label: string; ok: boolean; detail: string }

export interface PreflightResult {
  ok: boolean;
  atMs: number;
  preflightId: string | null; // ok=true일 때만 발급
  items: PreflightItem[];
  /** 실행 시 드리프트 검증용 — preflight 시점 가격 */
  priceUsd: number | null;
}

interface StoredPreflight {
  id: string; atMs: number; ok: boolean;
  symbol: string; direction: 'LONG' | 'SHORT'; priceUsd: number | null;
}

export interface DailyCanaryState {
  dayKey: string;
  opens: number;
  openIntentId: string | null;
  closeIntentId: string | null;
  emergencyCloseUsed: boolean;
  openedAt: string | null;
  /** OPEN 요청 결속 — close가 preflight 전역 상태가 아닌 durable 기록을 쓰도록 */
  open: {
    symbol: string; direction: 'LONG' | 'SHORT';
    collateralUsd: number; leverage: number; requestedSizeUsd: number;
  } | null;
}

export interface CheckOutcome { ok: boolean; detail: string }

// ── #142: Sanitized blocker categories ─────────────────────────────────────
/**
 * Canary launch blocker categories with stable IDs and sanitized messages.
 * No secret values, raw env values, RPC URLs, addresses, signatures, or raw errors.
 */
export const CANARY_BLOCKER_CATEGORIES = Object.freeze({
  CODE: Object.freeze({
    id: 'CODE' as const,
    stableMessage: '코드/배포 검증 실패 — 배포 manifest·SDK router pin 불일치',
  }),
  CONFIGURATION: Object.freeze({
    id: 'CONFIGURATION' as const,
    stableMessage: '설정 미충족 — signer 결속·allowance·환경 플래그·비용 상한 조건 위반',
  }),
  OPERATOR_MANUAL_ACTION: Object.freeze({
    id: 'OPERATOR_MANUAL_ACTION' as const,
    stableMessage: '운영자 조치 필요 — Owner Approval 갱신·reconciliation 수동 처리·preflight 재수행',
  }),
  GITHUB_CI: Object.freeze({
    id: 'GITHUB_CI' as const,
    /**
     * GITHUB_CI는 앱 측 GitHub 자격증명 없이 UNATTESTED fail-closed.
     * CI 인증 상태는 외부에서 주입되지 않으며, 미확인 = 차단.
     */
    stableMessage: 'GITHUB_CI: CI 인증 미확인 (UNATTESTED) — 앱 측 GitHub 자격증명 없음, fail-closed',
    attestedStatus: 'UNATTESTED' as const,
  }),
} as const);

export type CanaryBlockerCategoryId = keyof typeof CANARY_BLOCKER_CATEGORIES;

export interface CanaryBlocker {
  category: CanaryBlockerCategoryId;
  /** Stable machine identifier; intentionally contains no runtime values. */
  id: CanaryBlockerCategoryId;
  /** Stable sanitized operator message; intentionally contains no raw details. */
  message: string;
  blocking: true;
  /** 실패한 preflight check ID 목록 (sanitized — raw 값 미포함) */
  failedCheckIds: readonly string[];
}

// ── #142: ManualCanaryPreflightDeps (narrow capability type) ────────────────
/**
 * Preflight 및 evaluateAllChecks 전용 의존성 타입.
 * 실행 능력(executeOrder, closePosition, runEmergencyClose, nonce, relay task,
 * intent submit, signer record mutation, 자금)이 구조적으로 부재.
 * 테스트에서 forbidden 능력 0회 호출/접근을 구조적으로 보장.
 */
export interface ManualCanaryPreflightDeps {
  now(): Date;
  randomId(): string;
  // read-only preflight 소스들 (실행 능력 완전 부재)
  routerPin(): CheckOutcome;
  deploymentVerified(): CheckOutcome;
  signerBinding(): Promise<CheckOutcome>;          // 암호문/공개주소 존재+결속만, 복호화 0회
  ownerApproval(nowMs: number): Promise<CheckOutcome>;
  allowance(): Promise<CheckOutcome>;
  gmxApiReadonly(): CheckOutcome;
  rpcHealthy(): Promise<CheckOutcome>;
  reconciliationClean(): Promise<CheckOutcome>;    // blocking intents/tasks/protections=0 + startup reconcile
  openPositionCount(): Promise<number | null>;     // authoritative readback, 실패=null
  openPositions(): Promise<Array<{
    positionKey: string;
    accountAddress: string;
    marketAddress: string;
    collateralToken: string;
    isLong: boolean;
    sizeUsd: number;
    sizeUsd30: string;
  }> | null>;
  /** read-only preflight 전용 costSnapshot — recordExecutionEligibleCostEvidence 호출 금지 */
  costSnapshot(args: { symbol: string; isLong: boolean; notionalUsd: number }): Promise<
    { ok: true; snapshot: CostSnapshot; roundTripCostUsd: number | null } | { ok: false; reason: string }>;
  /** BTC와 ETH 모두의 fresh SDK+onchain decimals 증거가 있어야 한다. */
  canaryDecimalsReady(): Promise<CheckOutcome>;
  stopCapability(): Promise<CheckOutcome>;
  currentPriceUsd(symbol: string): Promise<number | null>;
  accumCanaryLossUsd(): Promise<{ ok: boolean; lossUsd: number | null }>;
  marketAddress(symbol: string): string | null;
  mainAddress(): string;
  liveTestMode(): boolean;
  envSubmissionState(): { locked: boolean; submissionEnabled: boolean; detail: string };
  /**
   * #142: GITHUB_CI attestation check — 앱 측 GitHub 자격증명 없이 UNATTESTED fail-closed.
   * production은 항상 { ok: false, detail: UNATTESTED }를 반환해야 한다.
   * 테스트에서만 override 허용 (forbidden capability 검증용).
   */
  githubCiAttestation(): CheckOutcome;
  // durable state — preflight token CAS만 허용 (daily claim CAS는 실행 단계 전용)
  loadState(key: string): Promise<string | null>;
  casState(key: string, prevRaw: string | null, nextRaw: string): Promise<boolean>;
}

/** 전체 의존성 주입 — 실행 단계 포함 */
export interface ManualCanaryDeps extends ManualCanaryPreflightDeps {
  // 실행 (기존 durable 경로 재사용 — 자동 재제출 없음)
  executeOrder(params: LiveOrderParams): Promise<LiveOrderResult>;
  closePosition(params: {
    decisionId: string; cycleNumber: number; symbol: string; marketAddress: string;
    isLong: boolean; sizeUsd: number; currentPriceUsd: number; mainAddress: string;
    accumLossUsd: number; dbOk: boolean; liveTestMode: boolean; manualCanary?: true;
    /** 0030: exact 포지션 결속 — manualCanary 경로는 반드시 제공해야 한다 */
    exactPosition?: ClosePositionBinding | null;
  }): Promise<LiveOrderResult>;
  runEmergencyClose(openIntentId: string): Promise<CheckOutcome>;
  // 상태 판독 (온체인 증거 기반 — API 수락만으로 성공 처리 금지)
  intentStatus(intentId: string): Promise<{ status: string; orderKey: string | null; txHash: string | null } | null>;
  initialStopStatus(openIntentId: string): Promise<{ status: string | null; orderKey: string | null }>;
  /**
   * #142: 실행 직전 전용 비용 증거 기록.
   * executeOrder 바로 직전에만 호출 — 기록 불가 시 fail-closed (제출 0회).
   * production 구현은 recordExecutionEligibleCostEvidence 위임.
   * preflight costSnapshot 경로에는 이 메서드가 구조적으로 부재.
   */
  recordCostEvidenceForExecution(snapshot: CostSnapshot, args: {
    market: string; isLong: boolean; orderType: 'MarketIncrease' | 'MarketDecrease'; notionalUsd: number;
  }, nowMs: number): boolean; // #142: execution-only — structurally unavailable in ManualCanaryPreflightDeps
}

// ── worker_state CAS 기본 구현 ────────────────────────────────────────────────
async function loadWorkerState(key: string): Promise<string | null> {
  const rows = await db.select().from(workerStateTable).where(eq(workerStateTable.key, key));
  return rows[0]?.value ?? null;
}

/**
 * compare-and-set: prevRaw=null이면 INSERT(onConflictDoNothing), 아니면
 * 조건부 UPDATE(value=prevRaw). 영향 0행 = 경합/불일치 → false (fail-closed).
 */
async function casWorkerState(key: string, prevRaw: string | null, nextRaw: string): Promise<boolean> {
  if (prevRaw === null) {
    const inserted = await db.insert(workerStateTable)
      .values({ key, value: nextRaw, updatedAt: new Date() })
      .onConflictDoNothing()
      .returning({ key: workerStateTable.key });
    return inserted.length === 1;
  }
  const updated = await db.update(workerStateTable)
    .set({ value: nextRaw, updatedAt: new Date() })
    .where(and(eq(workerStateTable.key, key), eq(workerStateTable.value, prevRaw)))
    .returning({ key: workerStateTable.key });
  return updated.length === 1;
}

export const __canaryStateAccess = { loadWorkerState, casWorkerState };

// ── Preflight ────────────────────────────────────────────────────────────────
export function validateCanaryRequest(symbol: unknown, direction: unknown):
  { ok: true; symbol: string; direction: 'LONG' | 'SHORT' } | { ok: false; reason: string } {
  if (typeof symbol !== 'string' || !MANUAL_CANARY_CAPS.allowedSymbols.includes(symbol)) {
    return { ok: false, reason: `허용 시장 아님 — BTC/ETH만 가능` };
  }
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return { ok: false, reason: '방향은 LONG/SHORT만 가능' };
  }
  return { ok: true, symbol, direction };
}

/**
 * #142: evaluateAllChecks는 ManualCanaryPreflightDeps만 사용.
 * 실행 능력(executeOrder 등)은 구조적으로 접근 불가.
 */
async function evaluateAllChecks(
  deps: ManualCanaryPreflightDeps, symbol: string, direction: 'LONG' | 'SHORT',
): Promise<{ items: PreflightItem[]; priceUsd: number | null; costSnapshot: CostSnapshot | null }> {
  const items: PreflightItem[] = [];
  const push = (id: string, label: string, o: CheckOutcome) =>
    items.push({ id, label, ok: o.ok, detail: o.detail });
  const now = await runAllowedPreflightOperation('readonly', 'clock', () => deps.now());
  const nowMs = now.getTime();

  push('deployment', '배포 코드/manifest 검증',
    await runAllowedPreflightOperation('readonly', 'deployment', () => deps.deploymentVerified()));
  push('router_pin', 'SDK router pin 대조',
    await runAllowedPreflightOperation('readonly', 'router_pin', () => deps.routerPin()));
  push('signer_binding', 'signer 암호문+공개주소 결속(복호화 0회)',
    await runAllowedPreflightOperation('readonly', 'signer_binding', () => deps.signerBinding()));
  push('owner_approval', 'fresh Owner Approval (8회·nonce·deadline)',
    await runAllowedPreflightOperation('readonly', 'owner_approval', () => deps.ownerApproval(nowMs)));
  push('allowance', 'USDC allowance 15',
    await runAllowedPreflightOperation('readonly', 'allowance', () => deps.allowance()));
  push('gmx_api', 'GMX API read-only',
    await runAllowedPreflightOperation('readonly', 'gmx_api', () => deps.gmxApiReadonly()));
  push('rpc', 'RPC 정상',
    await runAllowedPreflightOperation('readonly', 'rpc', () => deps.rpcHealthy()));
  push('reconciliation', 'reconciliation 완료·미종결 0',
    await runAllowedPreflightOperation('readonly', 'reconciliation', () => deps.reconciliationClean()));

  const posCount = await runAllowedPreflightOperation(
    'readonly', 'open_positions', () => deps.openPositionCount(),
  );
  push('open_positions', '열린 포지션 0', posCount === null
    ? { ok: false, detail: 'authoritative 포지션 조회 실패 (fail-closed)' }
    : posCount === 0 ? { ok: true, detail: '0건' }
    : { ok: false, detail: `${posCount}건 — 동시 ${MANUAL_CANARY_CAPS.maxOpenPositions}개 캡 위반` });

  push('decimals', 'BTC+ETH index token decimals 검증',
    await runAllowedPreflightOperation('readonly', 'decimals', () => deps.canaryDecimalsReady()));
  push('stop_capability', 'Stop 실행 능력',
    await runAllowedPreflightOperation('readonly', 'stop_capability', () => deps.stopCapability()));

  const cost = await runAllowedPreflightOperation(
    'readonly',
    'cost_snapshot',
    () => deps.costSnapshot({
      symbol,
      isLong: direction === 'LONG',
      notionalUsd: MANUAL_CANARY_CAPS.maxNotionalUsd,
    }),
  );
  let costSnapshot: CostSnapshot | null = null;
  if (!cost.ok) {
    push('cost_snapshot', 'fresh cost snapshot', { ok: false, detail: cost.reason });
  } else if (cost.roundTripCostUsd === null) {
    // 비용 불명 = 상한 검증 불가 → fail-closed (하위 계층 재검증에 위임 금지)
    push('cost_snapshot', 'fresh cost snapshot', { ok: false, detail: '왕복 비용 산정 불가 — 상한 검증 불가 (fail-closed)' });
  } else if (cost.roundTripCostUsd > MANUAL_CANARY_CAPS.maxRoundTripCostUsd) {
    push('cost_snapshot', 'fresh cost snapshot', {
      ok: false,
      detail: `왕복 비용 $${cost.roundTripCostUsd.toFixed(3)} > 상한 $${MANUAL_CANARY_CAPS.maxRoundTripCostUsd} (Canary 엄격 상한)`,
    });
  } else {
    costSnapshot = cost.snapshot;
    push('cost_snapshot', 'fresh cost snapshot', { ok: true, detail: `왕복 비용 $${cost.roundTripCostUsd.toFixed(3)}` });
  }

  const loss = await runAllowedPreflightOperation(
    'readonly', 'accum_loss', () => deps.accumCanaryLossUsd(),
  );
  push('accum_loss', `누적 손실 < $${MANUAL_CANARY_CAPS.maxAccumLossUsd}`, !loss.ok || loss.lossUsd === null
    ? { ok: false, detail: '누적 손실 조회 실패 (fail-closed)' }
    : loss.lossUsd >= MANUAL_CANARY_CAPS.maxAccumLossUsd
      ? { ok: false, detail: `누적 손실 $${loss.lossUsd.toFixed(2)} ≥ 상한` }
      : { ok: true, detail: `$${loss.lossUsd.toFixed(2)}` });

  const dailyRes = await runAllowedPreflightOperation(
    'readonly', 'daily_budget', () => loadDailyState(deps),
  );
  const dayKey = manilaDayKey(now);
  if (dailyRes.corrupt) {
    // 영속 상태 손상 = 해석 불가 → fail-closed (null로 위장해 새 claim 허용 금지)
    push('daily_budget', `일일 주문 ${MANUAL_CANARY_CAPS.maxOrdersPerDay}회`,
      { ok: false, detail: '일일 상태 레코드 손상 — 수동 조사 필요 (fail-closed)' });
  } else {
    const daily = dailyRes.state;
    const used = daily && daily.dayKey === dayKey ? daily.opens : 0;
    push('daily_budget', `일일 주문 ${MANUAL_CANARY_CAPS.maxOrdersPerDay}회`, used >= MANUAL_CANARY_CAPS.maxOrdersPerDay
      ? { ok: false, detail: `오늘(${dayKey}) 이미 ${used}회 사용` }
      : { ok: true, detail: `잔여 ${MANUAL_CANARY_CAPS.maxOrdersPerDay - used}회` });
  }

  const env = await runAllowedPreflightOperation(
    'readonly', 'env_submission', () => deps.envSubmissionState(),
  );
  push('env_submission', '제출 플래그/잠금 상태', env.locked || !env.submissionEnabled
    ? { ok: false, detail: env.detail }
    : { ok: true, detail: env.detail });

  const priceUsd = await runAllowedPreflightOperation(
    'readonly', 'price', () => deps.currentPriceUsd(symbol),
  );
  push('price', '현재가 확보', priceUsd !== null && priceUsd > 0
    ? { ok: true, detail: `$${priceUsd.toFixed(2)}` }
    : { ok: false, detail: '가격 조회 실패' });

  // #142: GITHUB_CI check — 앱 측 자격증명 없이 UNATTESTED fail-closed
  // 비밀값·raw 환경값·RPC URL·주소·서명·raw 오류 미포함
  // production은 deps.githubCiAttestation()이 항상 UNATTESTED를 반환한다.
  push('github_ci', 'GitHub CI 인증 상태',
    await runAllowedPreflightOperation('readonly', 'github_ci', () => deps.githubCiAttestation()));

  return { items, priceUsd: priceUsd !== null && priceUsd > 0 ? priceUsd : null, costSnapshot };
}

/**
 * #142: runCanaryPreflight는 ManualCanaryPreflightDeps만 사용.
 * 실행 능력(executeOrder 등)은 구조적으로 접근 불가.
 */
export async function runCanaryPreflight(
  deps: ManualCanaryPreflightDeps, symbolRaw: unknown, directionRaw: unknown,
): Promise<PreflightResult> {
  const atMs = (await runAllowedPreflightOperation('readonly', 'clock', () => deps.now())).getTime();
  const req = validateCanaryRequest(symbolRaw, directionRaw);
  if (!req.ok) {
    return { ok: false, atMs, preflightId: null, priceUsd: null, items: [{ id: 'request', label: '요청 검증', ok: false, detail: req.reason }] };
  }
  const { items, priceUsd } = await evaluateAllChecks(deps, req.symbol, req.direction);
  const ok = items.every(i => i.ok);
  let preflightId: string | null = null;
  if (ok) {
    preflightId = await runAllowedPreflightOperation(
      'readonly', 'random_id', () => deps.randomId(),
    );
    const stored: StoredPreflight = { id: preflightId, atMs, ok, symbol: req.symbol, direction: req.direction, priceUsd };
    const prev = await runAllowedPreflightOperation(
      'readonly', 'preflight_token_read', () => deps.loadState(STATE_KEY_PREFLIGHT),
    );
    const casOk = await runAllowedPreflightOperation(
      'cas_preflight_token',
      STATE_KEY_PREFLIGHT,
      () => deps.casState(STATE_KEY_PREFLIGHT, prev, JSON.stringify(stored)),
    );
    if (!casOk) {
      // durable 저장 미확정 = 유효 preflightId 발급 금지 (best-effort 전환 금지)
      return {
        ok: false, atMs, preflightId: null, priceUsd,
        items: [...items, { id: 'persist', label: 'preflight durable 저장', ok: false, detail: 'CAS 경합/실패 — preflight 재수행 필요 (fail-closed)' }],
      };
    }
  }
  return { ok, atMs, preflightId, items, priceUsd };
}

// ── Daily durable claim ──────────────────────────────────────────────────────
/** 손상(파싱 실패)은 null과 구분 — 손상 시 어떤 실행 경로도 진행 금지 (fail-closed) */
async function loadDailyState(deps: Pick<ManualCanaryPreflightDeps, 'loadState'>): Promise<
  { corrupt: false; state: DailyCanaryState | null; raw: string | null } | { corrupt: true; state: null; raw: string | null }
> {
  const raw = await deps.loadState(STATE_KEY_DAILY);
  if (!raw) return { corrupt: false, state: null, raw: null };
  try {
    const parsed = JSON.parse(raw) as DailyCanaryState;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.dayKey !== 'string') {
      return { corrupt: true, state: null, raw };
    }
    return { corrupt: false, state: parsed, raw };
  } catch { return { corrupt: true, state: null, raw }; }
}

/** 제출 전 durable claim — CAS 실패/예산 소진/상태 손상 = fail-closed */
export async function claimDailyBudget(
  deps: ManualCanaryDeps, openIntentId: string,
  openBinding: DailyCanaryState['open'] = null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const dayKey = manilaDayKey(deps.now());
  const loaded = await loadDailyState(deps);
  if (loaded.corrupt) return { ok: false, reason: '일일 상태 레코드 손상 — 새 claim 금지 (fail-closed)' };
  const prev = loaded.state;
  const prevRaw = loaded.raw;
  if (prev && prev.dayKey === dayKey && prev.opens >= MANUAL_CANARY_CAPS.maxOrdersPerDay) {
    return { ok: false, reason: `일일 ${MANUAL_CANARY_CAPS.maxOrdersPerDay}회 소진 (${dayKey})` };
  }
  const next: DailyCanaryState = {
    dayKey, opens: (prev && prev.dayKey === dayKey ? prev.opens : 0) + 1,
    openIntentId, closeIntentId: null, emergencyCloseUsed: false,
    openedAt: deps.now().toISOString(),
    open: openBinding,
  };
  const casOk = await deps.casState(STATE_KEY_DAILY, prevRaw, JSON.stringify(next));
  if (!casOk) return { ok: false, reason: '일일 예산 durable claim 경합/실패 — 제출 0회 (fail-closed)' };
  return { ok: true };
}

// ── Execute (2단계) ──────────────────────────────────────────────────────────
export interface ExecuteResult {
  ok: boolean;
  phase: 'REJECTED' | 'SIMULATED' | 'SUBMITTED' | 'ERROR';
  reason: string | null;
  intentId: string | null;
  failures: PreflightItem[];
}

export function buildCanaryDecisionId(dayKey: string): string { return `manual-canary:${dayKey}`; }

export async function executeManualCanaryOpen(deps: ManualCanaryDeps, body: {
  preflightId?: unknown; confirm?: unknown; symbol?: unknown; direction?: unknown;
  collateralUsd?: unknown; leverage?: unknown;
}): Promise<ExecuteResult> {
  const reject = (reason: string, failures: PreflightItem[] = []): ExecuteResult =>
    ({ ok: false, phase: 'REJECTED', reason, intentId: null, failures });

  if (body.confirm !== CANARY_CONFIRM_OPEN) return reject(`confirm 문구 불일치 — "${CANARY_CONFIRM_OPEN}" 필요`);
  const req = validateCanaryRequest(body.symbol, body.direction);
  if (!req.ok) return reject(req.reason);

  // 하드캡: 요청이 캡 초과를 시도하면 clamp가 아니라 명시 거부 (UI 변조 방지)
  const collateralUsd = typeof body.collateralUsd === 'number' ? body.collateralUsd : MANUAL_CANARY_CAPS.maxCollateralUsd;
  const leverage = typeof body.leverage === 'number' ? body.leverage : MANUAL_CANARY_CAPS.maxLeverage;
  if (!(collateralUsd > 0) || collateralUsd > MANUAL_CANARY_CAPS.maxCollateralUsd) {
    return reject(`담보는 0 < x ≤ $${MANUAL_CANARY_CAPS.maxCollateralUsd} — 확대 불가`);
  }
  if (!(leverage >= 1) || leverage > MANUAL_CANARY_CAPS.maxLeverage) {
    return reject(`레버리지는 1 ≤ x ≤ ${MANUAL_CANARY_CAPS.maxLeverage}x — 확대 불가`);
  }

  // 2단계: preflightId 결속 (120s TTL, 심볼/방향 일치)
  const storedRaw = await deps.loadState(STATE_KEY_PREFLIGHT);
  if (!storedRaw || typeof body.preflightId !== 'string') return reject('preflight 미수행 — 1단계 preflight 필요');
  let stored: StoredPreflight | null = null;
  try { stored = JSON.parse(storedRaw) as StoredPreflight; } catch { stored = null; }
  const nowMs = deps.now().getTime();
  if (!stored || stored.id !== body.preflightId || !stored.ok) return reject('preflightId 불일치/무효 — 재수행 필요');
  if (nowMs - stored.atMs > MANUAL_CANARY_CAPS.preflightTtlMs) return reject('preflight 만료(120초) — 재수행 필요');
  if (stored.symbol !== req.symbol || stored.direction !== req.direction) return reject('preflight와 시장/방향 불일치 — 재수행 필요');

  // 실행 직전 전 조건 서버 재평가 (fail-closed)
  const re = await evaluateAllChecks(deps, req.symbol, req.direction);
  const failures = re.items.filter(i => !i.ok);
  if (failures.length > 0) return reject('실행 직전 재평가 실패 — 제출 0회', failures);

  // 시장가 추격 방지: preflight 대비 가격 드리프트 상한
  if (stored.priceUsd === null || re.priceUsd === null) return reject('가격 확인 불가 — 제출 0회');
  const drift = Math.abs(re.priceUsd - stored.priceUsd) / stored.priceUsd;
  if (drift > MANUAL_CANARY_CAPS.maxPriceDriftFraction) {
    return reject(`가격 드리프트 ${(drift * 100).toFixed(2)}% > ${(MANUAL_CANARY_CAPS.maxPriceDriftFraction * 100).toFixed(1)}% — 추격 금지, preflight 재수행`);
  }

  const isLong = req.direction === 'LONG';
  const stopPlan = computeStopTrigger({ entryPriceUsd: re.priceUsd, isLong });
  if (!stopPlan.ok) return reject(`stop 계획 불가 — ${stopPlan.reason}`);

  const marketAddress = deps.marketAddress(req.symbol);
  if (!marketAddress) return reject('시장 주소 미확인');

  const loss = await deps.accumCanaryLossUsd();
  if (!loss.ok || loss.lossUsd === null) return reject('누적 손실 조회 실패 — 제출 0회');

  const dayKey = manilaDayKey(deps.now());
  const decisionId = buildCanaryDecisionId(dayKey);
  const intentId = `intent:open:${decisionId}`;

  const sizeUsd = Math.min(collateralUsd * leverage, MANUAL_CANARY_CAPS.maxNotionalUsd);

  // 최종 제출 크기 기준 fresh 비용 재검증 — 불명/초과 = 명시 거부 (claim 전, 예산 미소진)
  const cost = await deps.costSnapshot({ symbol: req.symbol, isLong, notionalUsd: sizeUsd });
  if (!cost.ok) return reject(`최종 크기 비용 조회 실패 — ${cost.reason} (제출 0회)`);
  if (cost.roundTripCostUsd === null) return reject('최종 크기 왕복 비용 산정 불가 — 상한 검증 불가 (제출 0회)');
  if (cost.roundTripCostUsd > MANUAL_CANARY_CAPS.maxRoundTripCostUsd) {
    return reject(`최종 크기 왕복 비용 $${cost.roundTripCostUsd.toFixed(3)} > 상한 $${MANUAL_CANARY_CAPS.maxRoundTripCostUsd} — 명시 거부`);
  }

  // durable claim 및 execute 직전 BTC+ETH 권위 decimals를 다시 확인한다.
  // 선택 심볼만 통과하거나 preflight 시점의 UI 상태만 믿는 경로를 금지한다.
  const finalDecimals = await deps.canaryDecimalsReady();
  if (!finalDecimals.ok) {
    return reject(`실행 직전 BTC+ETH decimals 재검증 실패 — ${finalDecimals.detail} (제출 0회)`);
  }

  // durable claim 먼저 (제출 전) — 실패 시 제출 0회. OPEN 요청 결속 함께 영속.
  const claim = await claimDailyBudget(deps, intentId, {
    symbol: req.symbol, direction: req.direction, collateralUsd, leverage, requestedSizeUsd: sizeUsd,
  });
  if (!claim.ok) return reject(claim.reason);

  // #142: 실행 직전 전용 비용 증거 기록 — 기록 불가 시 fail-closed (제출 0회)
  const evidenceRecorded = deps.recordCostEvidenceForExecution(
    cost.snapshot,
    { market: deps.marketAddress(req.symbol) ?? '', isLong, orderType: 'MarketIncrease', notionalUsd: sizeUsd },
    deps.now().getTime(),
  );
  if (!evidenceRecorded) {
    return reject('실행 직전 비용 증거 기록 실패 — 제출 0회 (fail-closed)');
  }

  const result = await deps.executeOrder({
    decisionId,
    cycleNumber: 0, // 수동 경로 — worker 사이클 아님
    symbol: req.symbol,
    marketAddress,
    isLong,
    sizeUsd,
    collateralUsd,
    leverage,
    currentPriceUsd: re.priceUsd,
    mainAddress: deps.mainAddress(),
    accumLossUsd: loss.lossUsd,
    dbOk: true,
    openPositionCount: 0, // 재평가에서 0 확인됨
    liveTestMode: deps.liveTestMode(),
    sizingContext: {
      positionSizingCapitalUsd: collateralUsd,
      stopDistanceFraction: stopPlan.plan.stopDistanceFraction,
      costSnapshot: cost.snapshot,
      liquidityCapUsd: null,
      tierNotionalCapUsd: MANUAL_CANARY_CAPS.maxNotionalUsd,
      defensiveMode: true, // Canary는 항상 방어 모드 (명목 0.5배 축소 허용)
      canaryActive: true,
      operatorApprovedNotionalCapUsd: MANUAL_CANARY_CAPS.maxNotionalUsd,
    },
  });

  if (result.simulated) return { ok: false, phase: 'SIMULATED', reason: 'LIVE 잠금 — 시뮬레이션 (실제 주문 0건)', intentId, failures: [] };
  if (result.ok) return { ok: true, phase: 'SUBMITTED', reason: null, intentId, failures: [] };
  // 실패/모호 — 자동 재제출 금지 (intent 계층이 UNRESOLVED 판정·유지)
  return { ok: false, phase: 'ERROR', reason: result.error ?? '제출 실패 — 자동 재제출 없음', intentId, failures: [] };
}

// ── Close (stop ACTIVE 증거 필수, 아니면 emergency만) ────────────────────────
export async function executeManualCanaryClose(deps: ManualCanaryDeps, body: {
  confirm?: unknown; mode?: unknown;
}): Promise<ExecuteResult> {
  const reject = (reason: string): ExecuteResult => ({ ok: false, phase: 'REJECTED', reason, intentId: null, failures: [] });
  if (body.confirm !== CANARY_CONFIRM_CLOSE) return reject(`confirm 문구 불일치 — "${CANARY_CONFIRM_CLOSE}" 필요`);
  const loaded = await loadDailyState(deps);
  if (loaded.corrupt) return reject('일일 상태 레코드 손상 — close 진행 금지 (fail-closed)');
  const daily = loaded.state;
  if (!daily?.openIntentId) return reject('오늘 실행된 canary OPEN 없음');

  const open = await deps.intentStatus(daily.openIntentId);
  if (!open) return reject('OPEN intent 조회 실패 (fail-closed)');
  if (open.status !== 'CONFIRMED') return reject(`OPEN 미확정 (${open.status}) — 온체인 CONFIRMED 후에만 close 가능`);

  const stop = await deps.initialStopStatus(daily.openIntentId);
  const stopActive = stop.status === 'ACTIVE' && !!stop.orderKey;
  const emergency = body.mode === 'emergency';

  if (!stopActive && !emergency) {
    return reject('Stop-Loss ACTIVE 미확인 — 일반 close 금지, emergency close 경로만 허용');
  }
  if (emergency) {
    if (daily.emergencyCloseUsed) return reject('emergency close 이미 1회 사용 — 재제출 금지');
    const prevRaw = loaded.raw;
    const next = { ...daily, emergencyCloseUsed: true };
    const cas = await deps.casState(STATE_KEY_DAILY, prevRaw, JSON.stringify(next));
    if (!cas) return reject('durable 상태 갱신 실패 — 제출 0회 (fail-closed)');
    const r = await deps.runEmergencyClose(daily.openIntentId);
    return r.ok
      ? { ok: true, phase: 'SUBMITTED', reason: `emergency close: ${r.detail}`, intentId: daily.openIntentId, failures: [] }
      : { ok: false, phase: 'ERROR', reason: r.detail, intentId: daily.openIntentId, failures: [] };
  }

  // 일반 close — deterministic decisionId, 단일 제출
  const dayKey = manilaDayKey(deps.now());
  const decisionId = `${buildCanaryDecisionId(dayKey)}:close`;
  // 심볼/방향 = OPEN claim 시점 durable 결속 (전역 preflight 상태 사용 금지)
  if (!daily.open) return reject('OPEN 결속 기록 없음 — emergency close 사용 (fail-closed)');
  const sym = daily.open.symbol;
  const isLong = daily.open.direction === 'LONG';
  const marketAddress = deps.marketAddress(sym);
  const price = await deps.currentPriceUsd(sym);
  if (!marketAddress || price === null) return reject('시장/가격 확인 불가 — 제출 0회');

  // close 크기 및 exact 포지션 결속 = authoritative 온체인 포지션 실측 (요청/고정값 사용 금지)
  // positionKey + collateralToken을 포함한 full identity를 lower 계층에 넘겨
  // closeLiveTestPosition 내 re-read가 다른 포지션을 대체하지 못하도록 한다.
  const positions = await deps.openPositions();
  if (positions === null) return reject('온체인 포지션 조회 실패 — 제출 0회 (fail-closed)');
  const matched = positions.filter(p =>
    p.marketAddress.toLowerCase() === marketAddress.toLowerCase()
    && p.isLong === isLong
    && p.accountAddress.toLowerCase() === deps.mainAddress().toLowerCase()
  );
  const pos = matched.length === 1 ? matched[0] : null;
  if (!pos || !(pos.sizeUsd > 0)) return reject('결속된 canary 포지션을 온체인에서 확인 불가 — 제출 0회');

  // exact 포지션 결속: positionKey와 collateralToken은 PositionReader canonical 값 (0030)
  const exactPosition: ClosePositionBinding = {
    account:               deps.mainAddress().toLowerCase(),
    marketAddress:         pos.marketAddress.toLowerCase(),
    collateralToken:       pos.collateralToken.toLowerCase(),
    positionKey:           pos.positionKey,
    preSizeUsd:            pos.sizeUsd,
    preSizeUsd30:          pos.sizeUsd30,
    requestedReductionUsd: pos.sizeUsd,  // 전량 청산 — CLOSE는 항상 full
    requestedReductionUsd30: pos.sizeUsd30,
  };

  const loss = await deps.accumCanaryLossUsd();
  if (!loss.ok || loss.lossUsd === null) return reject('누적 손실 조회 실패 — 제출 0회');

  const prevRaw = loaded.raw;
  const closeIntentId = `intent:close:${decisionId}`;
  const cas = await deps.casState(STATE_KEY_DAILY, prevRaw, JSON.stringify({ ...daily, closeIntentId }));
  if (!cas) return reject('durable 상태 갱신 실패 — 제출 0회 (fail-closed)');

  const result = await deps.closePosition({
    decisionId, cycleNumber: 0, symbol: sym, marketAddress, isLong,
    sizeUsd: pos.sizeUsd, currentPriceUsd: price,
    mainAddress: deps.mainAddress(), accumLossUsd: loss.lossUsd, dbOk: true,
    liveTestMode: deps.liveTestMode(), manualCanary: true,
    exactPosition,  // 0030: exact 포지션 결속 — lower re-read 대체 금지
  });
  if (result.simulated) return { ok: false, phase: 'SIMULATED', reason: 'LIVE 잠금 — 시뮬레이션', intentId: closeIntentId, failures: [] };
  if (result.ok) return { ok: true, phase: 'SUBMITTED', reason: null, intentId: closeIntentId, failures: [] };
  return { ok: false, phase: 'ERROR', reason: result.error ?? 'close 제출 실패 — 자동 재제출 없음', intentId: closeIntentId, failures: [] };
}

// ── Status (단계별 — 온체인 증거 기반) ───────────────────────────────────────

/**
 * #142: Sanitized blocker analysis for CanaryStageStatus.
 * No secret values, raw env values, RPC URLs, addresses, signatures, raw errors.
 */
function deriveCanaryBlockers(failedItems: PreflightItem[]): CanaryBlocker[] {
  const blockers: CanaryBlocker[] = [];
  const ids = new Set(failedItems.map(i => i.id));

  const codeChecks = new Set(['deployment', 'router_pin']);
  const configChecks = new Set(['allowance', 'gmx_api', 'env_submission', 'cost_snapshot', 'signer_binding']);
  const operatorChecks = new Set(['owner_approval', 'reconciliation', 'rpc', 'open_positions', 'decimals', 'stop_capability', 'accum_loss', 'daily_budget', 'price', 'persist']);

  const codeIds = failedItems.filter(i => codeChecks.has(i.id)).map(i => i.id);
  if (codeIds.length > 0) {
    blockers.push({
      category: 'CODE',
      id: 'CODE',
      message: CANARY_BLOCKER_CATEGORIES.CODE.stableMessage,
      blocking: true,
      failedCheckIds: codeIds,
    });
  }

  const configIds = failedItems.filter(i => configChecks.has(i.id)).map(i => i.id);
  if (configIds.length > 0) {
    blockers.push({
      category: 'CONFIGURATION',
      id: 'CONFIGURATION',
      message: CANARY_BLOCKER_CATEGORIES.CONFIGURATION.stableMessage,
      blocking: true,
      failedCheckIds: configIds,
    });
  }

  const operatorIds = failedItems.filter(i => operatorChecks.has(i.id)).map(i => i.id);
  if (operatorIds.length > 0) {
    blockers.push({
      category: 'OPERATOR_MANUAL_ACTION',
      id: 'OPERATOR_MANUAL_ACTION',
      message: CANARY_BLOCKER_CATEGORIES.OPERATOR_MANUAL_ACTION.stableMessage,
      blocking: true,
      failedCheckIds: operatorIds,
    });
  }

  // GITHUB_CI always fails closed as UNATTESTED — no app-side credentials
  if (ids.has('github_ci')) {
    blockers.push({
      category: 'GITHUB_CI',
      id: 'GITHUB_CI',
      message: CANARY_BLOCKER_CATEGORIES.GITHUB_CI.stableMessage,
      blocking: true,
      failedCheckIds: ['github_ci'],
    });
  }

  return blockers;
}

export interface CanaryStageStatus {
  caps: typeof MANUAL_CANARY_CAPS;
  dayKey: string;
  daily: DailyCanaryState | null;
  stages: {
    open: { status: string; detail: string };
    stop: { status: string; detail: string };
    close: { status: string; detail: string };
    confirmed: { status: string; detail: string };
    readback: { status: string; detail: string };
  };
  /** #142: Sanitized blocker categories — no secret/raw values */
  blockers: CanaryBlocker[];
}

export async function getCanaryStatus(deps: ManualCanaryDeps): Promise<CanaryStageStatus> {
  const dayKey = manilaDayKey(deps.now());
  const loaded = await loadDailyState(deps);
  const daily = loaded.corrupt ? null : loaded.state;
  const pending = { status: 'PENDING', detail: '대기' };
  const stages: CanaryStageStatus['stages'] = {
    open: { ...pending }, stop: { ...pending }, close: { ...pending },
    confirmed: { ...pending }, readback: { ...pending },
  };
  if (daily?.openIntentId) {
    const open = await deps.intentStatus(daily.openIntentId);
    stages.open = !open
      ? { status: 'UNKNOWN', detail: 'intent 조회 실패' }
      : { status: open.status, detail: open.status === 'CONFIRMED' ? `온체인 확정 (orderKey ${open.orderKey ? '확보' : '없음'})` : open.status };
    if (open?.status === 'CONFIRMED') {
      const stop = await deps.initialStopStatus(daily.openIntentId);
      stages.stop = stop.status === 'ACTIVE' && stop.orderKey
        ? { status: 'ACTIVE', detail: '온체인 orderKey 증거 확인' }
        : { status: stop.status ?? 'MISSING', detail: stop.status ? `미확정 (${stop.status}) — 신규 주문 금지, emergency close만` : 'stop 없음 — emergency close만' };
    }
  }
  if (daily?.closeIntentId) {
    const close = await deps.intentStatus(daily.closeIntentId);
    stages.close = close ? { status: close.status, detail: close.status } : { status: 'UNKNOWN', detail: 'intent 조회 실패' };
    if (close?.status === 'CONFIRMED') {
      stages.confirmed = { status: 'CONFIRMED', detail: '온체인 확정' };
      const posCount = await deps.openPositionCount();
      const loss = await deps.accumCanaryLossUsd();
      stages.readback = posCount === 0 && loss.ok
        ? { status: 'DONE', detail: `포지션 0 · 누적 손실 $${(loss.lossUsd ?? 0).toFixed(2)}` }
        : { status: 'PENDING', detail: posCount === null ? '포지션 조회 실패' : `포지션 ${posCount}건 / PnL readback ${loss.ok ? '완료' : '실패'}` };
    }
  }

  // #142: derive sanitized blockers from current preflight state
  // Run a minimal evaluation to identify active blockers for status display
  // (read-only, no execution capability)
  const blockers: CanaryBlocker[] = [];
  try {
    const sym = daily?.open?.symbol ?? MANUAL_CANARY_CAPS.allowedSymbols[0]!;
    const dir = (daily?.open?.direction ?? 'LONG') as 'LONG' | 'SHORT';
    const eval_ = await evaluateAllChecks(deps, sym, dir);
    const failedItems = eval_.items.filter(i => !i.ok);
    blockers.push(...deriveCanaryBlockers(failedItems));
  } catch {
    // fail-closed: status evaluation error → report OPERATOR_MANUAL_ACTION
    blockers.push({
      category: 'OPERATOR_MANUAL_ACTION',
      id: 'OPERATOR_MANUAL_ACTION',
      message: CANARY_BLOCKER_CATEGORIES.OPERATOR_MANUAL_ACTION.stableMessage,
      blocking: true,
      failedCheckIds: ['status_evaluation_error'],
    });
  }

  return { caps: MANUAL_CANARY_CAPS, dayKey, daily, stages, blockers };
}

export const __defaultIdFactory = { randomUUID };
