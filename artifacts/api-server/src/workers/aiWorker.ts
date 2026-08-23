/**
 * AI Worker — 서버 사이드 24/7 AI 사이클 관리자
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 보안 원칙 (절대 변경 금지)
 * ──────────────────────────────────────────────────────────────────────────────
 * ❌ eth_sendTransaction, GMX SDK order 메서드 호출 없음
 * ❌ 서명 키(private key) 없음
 * ✅ PAPER/DRY-RUN 의사결정 + DB 저장 + live_approvals 생성까지만 수행
 *
 * 동작 방식:
 *  - 10s 간격으로 GMX 가격 캐시에서 심볼별 가격 히스토리를 업데이트
 *  - 60s 간격으로 AI 사이클 실행 (완료 후 다음 예약 — setInterval 아님)
 *  - isRunning atomic lock으로 동일 사이클 중복 실행 방지
 *  - 시작 시 DB에서 PENDING live_approvals 로드 → 중복 생성 방지
 *  - LIVE 모드 (WORKER_ENGINE_MODE=LIVE) 시에만 live_approvals INSERT
 */

import { db, aiDecisionsTable, liveApprovalsTable, strategyConfigTable, tradesTable, workerStateTable } from "@workspace/db";
import { and, desc, eq, like, lt } from "drizzle-orm";
import { computeIndicators, computeScores } from "./indicators";
import { runAiEngine } from "./stateEngine";
import { getCachedPrices, getCachedChange24h, ensureGmxPoller } from "../routes/gmx";
import { fetchServerLiveTestData } from "../routes/gmx";
import type { AiOperatingState, RiskLimits, SymbolAnalysis, ServerAiDecision } from "./serverTypes";
import { executeLiveTestOrder, closeLiveTestPosition, getLastSizingEnforcement, fetchAuthoritativeOpenPositions, type SizingEnforcementSnapshot } from "./liveTestExecutor";
import { enforceOrderSizing } from "../lib/orderSizingEnforcement";
import { fetchPaperCostSnapshot, fetchLiveCostSnapshot, COST_DATA_UNAVAILABLE, type LiveCostFetchers } from "../lib/costSnapshot";
import { storePaperCostSnapshot } from "../lib/paperCostCache";
import { reconcileLiveSettlements, type ReconcileResult, type SettlementEvidenceFetcher } from "../lib/tradeSettlement";
import { createProductionCloseSettlementFetcher } from "../lib/productionCloseSettlementFetcher";
import { DEFAULT_STOP_DISTANCE_FRACTION, computeStopTrigger } from "../lib/stopLossPlan";
import {
  manilaDayKey, computeReduction, GMX_MIN_POSITION_NOTIONAL_USD,
  buildProfitProtectKey, canExecuteReduction, type ProfitProtectRecord,
} from "../lib/profitProtection";
import { buildCloseAllPlan, summarizeCloseAll, type CloseAllSummary } from "../lib/closeAllOrchestrator";
import { LIVE_TEST_CAPS } from "../lib/liveTestGate";
import { MARKET_BY_SYMBOL_SERVER } from "../lib/gmxMarkets";
import {
  BASELINE_DAILY_KEY, BASELINE_WEEKLY_KEY,
  dailyPeriodStartUtc, weeklyPeriodStartUtc,
  parseBaseline, rollBaseline, computePeriodPnl,
  type EquityBaseline,
} from "../lib/equityBaselines";
import { RISK_POLICY, deriveDailyTargets, clampDailyTargetUSDT, type DerivedRiskTargets } from "../lib/riskPolicy";
import { dailyRiskCapital, weeklyRiskCapital, positionSizingCapital } from "../lib/riskCapital";
import { evaluateRiskState, type RiskEvaluationResult, type RiskOperatingState } from "../lib/riskStateMachine";
import {
  initialRiskEngineState, rollRiskPeriods, loadRiskEngineState, saveRiskEngineState,
  type PersistedRiskEngineState,
} from "../lib/riskEngineState";
import { manilaDayStartIso, manilaWeekStartIso, msUntilNextManilaDay } from "../lib/manilaTime";
import { runIntelServiceCycle, runStrategyShadowWorkerReadOnly, stopIntelService, resumeIntelService } from "../intel/intelService";
import { buildStrategyShadowWorkerEnvelope } from "../intel/strategyShadowWorkerEnvelopeV2";
import { buildStrategyRiskWorkerAdvisory } from "../intel/strategyRiskWorkerBridgeV2";
import { buildStrategyDecisionExplainabilityRuntimeAdvisory } from "../intel/strategyDecisionExplainabilityRuntimeV2";
import type { SignalLifecycleSnapshotV2 } from "../intel/signalLifecycleSnapshotV2";
import {
  advanceStrategyShadowLifecycleSnapshot,
  restoreStrategyShadowLifecycleFromDecisionFullJson,
} from "../intel/strategyShadowLifecycleRuntimeV2";
import {
  openServerPaperPosition, closeServerPaperPosition, reduceServerPaper70,
  requestServerPaperCloseAll, loadPendingCloseFromDb, manageServerPaperTick,
  loadServerOpenRows, getServerPaperStatus, MAX_MANAGE_PRICE_AGE_MS,
  reconcileStartupCloseIntent,
  type ServerPaperExecStatus, type PriceQuote,
} from "./serverPaperExecutor";
import {
  applyRiskProfileToLimits,
  promoteRiskProfileAtSafeBoundary,
} from "../lib/riskProfiles";

// ── Constants ─────────────────────────────────────────────────────────────────

/** GMX V2 Arbitrum One 핵심 심볼 */
const WORKER_SYMBOLS = ["BTC", "ETH", "SOL", "ARB", "LINK", "AVAX", "DOGE"];

/** 심볼별 가격 히스토리 최대 길이 (3s 틱 × 500 ≈ 25분) */
const MAX_PRICE_HISTORY = 500;

/** AI 사이클 간격 */
const CYCLE_INTERVAL_MS = 60_000;

/** 초기 사이클 지연 — 가격 히스토리 축적 대기 */
const INITIAL_DELAY_MS = 30_000;

/**
 * 기본 리스크 한도 — RISK_POLICY($1,000 최종 정책, 6H-1)에서 파생.
 * DB에 전략 설정이 없을 때 사용하는 보수적 기본값.
 * 구형 $10,000/$500/$1,500 기본값은 6H-1에서 제거됨.
 */
export const DEFAULT_LIMITS: RiskLimits = {
  dailyLossLimitUSDT:  RISK_POLICY.maxRiskCapitalUsd * RISK_POLICY.dailyMaxLossPercent / 100,   // $30
  maxDrawdownPercent:        15,   // hard stop -15% ($850)과 정합
  consecutiveLossLimit: RISK_POLICY.maxConsecutiveLosses,                                        // 3
  maxLeverage:          RISK_POLICY.baseMaxLeverage,                                             // 3x
  maxMarginPerTrade:        334,   // ≈ capital/3 — 1포지션 담보 상한
  maxTotalExposureUSDT: RISK_POLICY.maxRiskCapitalUsd * RISK_POLICY.baseMaxLeverage,             // $3,000
  tradingCapital:       RISK_POLICY.initialCapitalUsd,                                           // $1,000
  reserveCashPct:            20,
  profitLockThresholdPct: RISK_POLICY.primaryProfitTargetPercent,                                // 5%
  maxSimultaneousPositions: RISK_POLICY.maxConcurrentPositions,                                  // 1
  maxRiskPerSymbolPct:       10,
  weeklyLossLimitUSDT:  RISK_POLICY.maxRiskCapitalUsd * RISK_POLICY.weeklyMaxLossPercent / 100,  // $80
  rolling24hLossLimitUSDT:    0,  // 0 = disabled by default
  cooldownMinutes:           30,
  maxTradesPerHour:           6,
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkerCycleResult {
  cycleNumber: number;
  at: string;
  operatingState: AiOperatingState;
  primarySymbol: string | null;
  confidence: number;
  analysesCount: number;
  approvalCreated: boolean;
  error?: string;
}

export interface WorkerStatus {
  workerRunning: boolean;
  lastCycleAt: string | null;
  lastCycleResult: WorkerCycleResult | null;
  cycleCount: number;
  /** 마지막 사이클에 사용된 Risk Limits (상태 카드 표시용). null = 사이클 미실행 */
  lastLimitsUsed: import('./serverTypes').RiskLimits | null;
  /** 현재 계좌 Equity High-Water Mark (USD). null = HWM 미수립 */
  equityHwm: number | null;
  // ── LIVE TEST MODE ──────────────────────────────────────────────────────────
  /** True when liveTestMode is enabled in strategy limits */
  liveTestMode: boolean;
  /** Reason the last LIVE TEST hardcap blocked a trade, or null */
  liveTestVetoReason: string | null;
  /** Accumulated test losses tracked since activation (USD) */
  liveTestAccumLossUsd: number;
  /** true = DB query succeeded; false = DB failed → LIVE TEST fail-closed */
  liveTestDbOk: boolean;
  // ── 기간 PnL (equity 기준점 기반 — UTC) ─────────────────────────────────────
  /** Daily PnL = 현재 equity − 오늘 00:00 UTC 기준점 equity. null = 기준점 없음(N/A) */
  dailyPnlUsd: number | null;
  /** Weekly PnL = 현재 equity − 월요일 00:00 UTC 기준점 equity. null = 기준점 없음(N/A) */
  weeklyPnlUsd: number | null;
  /** Daily 기준점 (periodStart/equity/recordedAt). null = 미수립 */
  dailyBaseline: import('../lib/equityBaselines').EquityBaseline | null;
  /** Weekly 기준점. null = 미수립 */
  weeklyBaseline: import('../lib/equityBaselines').EquityBaseline | null;
  /** 오늘(00:00 UTC 이후) 실현 PnL — breakdown 표시용 (dailyPnl − dailyRealized = 미실현 변화분) */
  dailyRealizedPnlUsd: number | null;
  /** 이번 주(월요일 00:00 UTC 이후) 실현 PnL — breakdown 표시용 */
  weeklyRealizedPnlUsd: number | null;
  /** 마지막 사이클의 currentEquity (USD). null = 사이클 미실행/DB 실패 */
  currentEquityUsd: number | null;
  /** 기간 PnL 마지막 갱신 시각 (ISO). null = 미갱신 — 클라이언트는 stale 판정에 사용 */
  periodPnlUpdatedAt: string | null;
  // ── RiskEngine (6H-1 — Manila 기준 $1,000 정책) ─────────────────────────────
  /** 현재 Risk 운용 상태. null = 미평가 */
  riskOperatingState: import('../lib/riskStateMachine').RiskOperatingState | null;
  /** RiskEngine이 신규 진입을 허용하는지 */
  riskEntryAllowed: boolean;
  /** 진입 차단 사유 목록 (빈 배열 = 차단 없음) */
  riskBlockReasons: string[];
  /** RiskEngine DB 영속 정상 여부 — false = fail-closed */
  riskDbOk: boolean;
  /** Manila 거래일 신규 진입 횟수 / 연속 손실 횟수 */
  riskDailyEntryCount: number | null;
  riskConsecutiveLossCount: number | null;
  /** Manila 거래일/거래주 시작 (UTC ISO) */
  riskDayPeriodStart: string | null;
  riskWeekPeriodStart: string | null;
  /** 파생 목표값 (start-of-day risk capital 기준). null = 미산출 */
  riskDerivedTargets: import('../lib/riskPolicy').DerivedRiskTargets | null;
  /** 다음 Manila 거래일까지 남은 ms */
  msUntilNextManilaDay: number;
  // ── 6H-2 — 사이징 강제·close-all 진행 상태 ──────────────────────────────────
  /** 마지막 PAPER 사이징 엔진 결과 (LIVE와 동일 엔진). null = 미실행 */
  paperSizing: PaperSizingSnapshot | null;
  /** 마지막 LIVE 실행 경로 사이징 강제 결과. null = 미실행 */
  liveSizingEnforcement: SizingEnforcementSnapshot | null;
  /** 마지막 CLOSE_ALL orchestration 요약. null = 발생 없음 */
  closeAllSummary: CloseAllSummary | null;
  // ── 6H-2A §5 — LIVE 정산 reconciliation ─────────────────────────────────────
  /** 마지막 정산 reconciliation 결과. incomplete=true → 신규 LIVE 진입 차단 */
  settlementReconcile: ReconcileResult | null;
  // ── Task #111 — 서버 권위 PAPER 실행기 관측값 ───────────────────────────────
  /** 서버 PAPER 실행기 스냅샷. null = 미기동 */
  serverPaperExec: ServerPaperExecStatus | null;
}

/** PAPER 사이징 엔진 결과 요약 — 상태 카드 표시용 */
export interface PaperSizingSnapshot {
  at: string;
  ok: boolean;
  reason: string | null;
  finalNotionalUsd: number | null;
  finalLeverage: number | null;
  allowedRiskUsd: number | null;
  clamped: boolean;
  clampDetails: string[];
  estimatedRoundTripCostUsd: number | null;
  /** 6H-2A §9 — PAPER 비용 출처 (성공 시 'PAPER_GMX_ESTIMATE', 미확보 시 null) */
  costSource: string | null;
}

// ── 주입식 조회 경로 (6H-2A — 실제 네트워크 호출은 이번 단계 금지) ──────────────

/**
 * PAPER 비용 조회 fetchers — 기본은 env readonly 플래그 + fetchCosts 미구성.
 * 미구성이면 fetchPaperCostSnapshot이 COST_DATA_UNAVAILABLE을 반환하고
 * PAPER도 신규 진입하지 않는다 (§3 fail-closed — zero-fee/고정 모델 fallback 없음).
 */
let paperCostFetchers: LiveCostFetchers | null = null;
export function __setPaperCostFetchersForTests(f: LiveCostFetchers | null): void {
  paperCostFetchers = f;
}
function getPaperCostFetchers(): LiveCostFetchers {
  return paperCostFetchers ?? { readonlyEnabled: process.env.GMX_API_READONLY_ENABLED === 'true' };
}

/** LIVE 정산 증거 fetcher — production은 read-only RPC/status/PositionReader만 사용 */
let settlementEvidenceFetcher: SettlementEvidenceFetcher = createProductionCloseSettlementFetcher();
export function __setSettlementEvidenceFetcherForTests(f: SettlementEvidenceFetcher): void {
  settlementEvidenceFetcher = f;
}

// ── WorkerManager ─────────────────────────────────────────────────────────────

class WorkerManager {
  /** true일 때 사이클 실행 중 — 중복 실행 방지용 atomic lock */
  private isRunning = false;

  /** 완료된 총 사이클 수 */
  private cycleCount = 0;

  /** 마지막 사이클 완료 시각 */
  private lastCycleAt: Date | null = null;

  /** 마지막 사이클 결과 */
  private lastCycleResult: WorkerCycleResult | null = null;

  /** 이전 사이클 결정 상태 (state transition 추적용) */
  private prevState: AiOperatingState = 'CASH';

  /**
   * 계좌 Equity High-Water Mark (USD).
   * tradingCapital + totalRealizedPnl + totalUnrealizedPnl의 최댓값.
   * 재시작 시 초기화 — 최대 드로다운 강제는 HWM 수립 이후부터 적용.
   */
  private equityHighWaterMark: number | null = null;

  /** 마지막 사이클에서 사용된 Strategy Limits — 상태 엔드포인트 노출용 */
  private lastLimitsUsed: RiskLimits | null = null;

  // ── 기간 PnL 기준점 (worker_state 영속 — 재시작 후 유지) ────────────────────
  private dailyBaseline:  EquityBaseline | null = null;
  private weeklyBaseline: EquityBaseline | null = null;
  private lastDailyPnlUsd:  number | null = null;
  private lastWeeklyPnlUsd: number | null = null;
  private lastDailyRealizedUsd:  number | null = null;
  private lastWeeklyRealizedUsd: number | null = null;
  private lastCurrentEquityUsd:  number | null = null;
  /** 마지막 기간 PnL 갱신 시각 (ISO). 클라이언트 staleness 판정용 */
  private periodPnlUpdatedAt: string | null = null;

  // ── LIVE TEST MODE class fields ─────────────────────────────────────────────
  /** Accumulated LIVE TEST losses persisted in worker_state DB */
  private liveTestAccumLossUsd: number = 0;
  /** Reason the most recent LIVE TEST hardcap blocked a trade (null = no block) */
  private lastLiveTestVetoReason: string | null = null;
  /** Whether liveTestMode was active in the last cycle */
  private lastLiveTestMode: boolean = false;

  // ── 6H-2 사이징·close-all 상태 ──────────────────────────────────────────────
  private lastPaperSizing: PaperSizingSnapshot | null = null;
  private lastCloseAllSummary: CloseAllSummary | null = null;
  /** 6H-2A §5 — 마지막 LIVE 정산 reconciliation 결과 */
  private lastSettlementReconcile: ReconcileResult | null = null;
  /** Whether the liveTestAccumLossUsd DB query succeeded in the last cycle */
  private lastLiveTestDbOk: boolean = true;
  // ────────────────────────────────────────────────────────────────────────────

  /** 심볼별 가격 히스토리 버퍼 */
  private priceBuffer = new Map<string, number[]>();

  /** 마지막 가격 업데이트 시각 (dataFreshMs 계산용) */
  private lastPriceAt: number = 0;
  /** Task #111 — 심볼별 마지막 유효 가격 수신 시각 (per-symbol stale 판정) */
  private priceAtBySymbol = new Map<string, number>();
  /** #120 — 심볼별 마지막으로 관측한 upstream tick.updatedAt (stale 캐시 재인증 방지) */
  private lastTickUpdatedAtBySymbol = new Map<string, number>();

  /** 가격 폴링 타이머 */
  private pricePollTimer: ReturnType<typeof setInterval> | null = null;

  /** 사이클 타이머 */
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Task #111 — 서버 권위 PAPER 관리 틱 타이머 (PAPER 모드 전용) */
  private serverPaperTimer: ReturnType<typeof setInterval> | null = null;

  /** 워커 루프 활성 여부 */
  private active = false;

  /**
   * PENDING live_approvals 중복 방지 세트.
   * 키 형식: "symbol:operatingState" (예: "BTC:LONG")
   */
  private pendingApprovalKeys = new Set<string>();

  // ── RiskEngine 상태 (6H-1 — Manila 기준, worker_state 영속) ─────────────────
  /** 영속 RiskEngine 상태. null = 미수립/로드 실패 → 신규 진입 차단 */
  private riskState: PersistedRiskEngineState | null = null;
  /** 마지막 RiskEngine 로드/저장 성공 여부 — false면 fail-closed */
  private riskDbOk = false;
  /** 마지막 사이클 RiskEngine 평가 결과 (상태 노출용) */
  private lastRiskEvaluation: RiskEvaluationResult | null = null;

  /** SHADOW 전용 lifecycle 연속성. Risk·PAPER/LIVE 실행 권한과 무관하다. */
  private strategyLifecycleSnapshot: SignalLifecycleSnapshotV2 | null = null;
  /** 마지막 fullJson 복원이 손상되면 SHADOW 평가만 fail-closed로 차단한다. */
  private strategyLifecycleRestoreBlocked = true;

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;

    // GMX 가격 폴러가 아직 시작되지 않았으면 시작
    ensureGmxPoller();

    // DB에서 기존 PENDING 승인 로드 (재시작 복구)
    await this.loadPendingApprovals();

    // DB에서 equity HWM 복구 (재시작 후에도 maxDrawdown 강제 연속성 유지)
    await this.loadHwmFromDb();

    // DB에서 Daily/Weekly equity 기준점 복구 (재시작 후 기간 PnL 연속성 유지)
    await this.loadBaselinesFromDb();

    // 기존 ai_decisions.fullJson만 read하여 SHADOW lifecycle 연속성을 복원한다.
    // 별도 schema/migration/write를 만들지 않으며 실패는 SHADOW 평가만 차단한다.
    await this.loadStrategyLifecycleSnapshotFromDb();

    // RiskEngine 영속 상태 복구 (6H-1 §11 — 잠금·카운터·Manila 기준점)
    const riskLoad = await loadRiskEngineState();
    if (riskLoad.ok) {
      this.riskState = riskLoad.state; // null이면 첫 사이클에서 수립
      this.riskDbOk = true;
      if (riskLoad.state) {
        console.info(`[AIWorker] RiskEngine 상태 복구 — ${riskLoad.state.riskOperatingState}, day=${riskLoad.state.dayPeriodStart}`);
      }
    } else {
      this.riskState = null;
      this.riskDbOk = false; // fail-closed — 신규 진입 차단
      console.error(`[AIWorker] ${riskLoad.reason} — 신규 진입 차단 (fail-closed)`);
    }

    // 가격 버퍼 폴링 시작 (10s 간격)
    this.updatePriceBuffers(); // 즉시 첫 실행
    this.pricePollTimer = setInterval(() => this.updatePriceBuffers(), 10_000);

    // ── Task #111 — 서버 권위 PAPER 관리 틱 (PAPER 모드 전용, 15s) ────────────
    // 재시작 복구: 권위 상태는 전부 DB — pendingClose 로드 후 틱이 open 행 재발견
    if (process.env.WORKER_ENGINE_MODE !== 'LIVE') {
      await loadPendingCloseFromDb();
      // write-failure → crash 복구: 마지막 영속 결정이 flat 지시 + 서버 미청산 존재 시
      // close-all 재수립 (판정 실패 = fail-closed unresolved, 틱 재시도)
      await reconcileStartupCloseIntent(async () => {
        const rows = await db.select().from(aiDecisionsTable)
          .orderBy(desc(aiDecisionsTable.createdAt)).limit(1);
        return rows[0]?.direction ?? null;
      });
      this.serverPaperTimer = setInterval(() => {
        // 신선한 시세가 전혀 없으면 어떤 관리 판정도 불가 (stale 스킵과 동일) — DB 접근 생략
        if (this.priceBuffer.size === 0) return;
        if (this.lastPriceAt === 0 || Date.now() - this.lastPriceAt > MAX_MANAGE_PRICE_AGE_MS) return;
        void manageServerPaperTick((sym) => this.serverPaperQuote(sym));
      }, 15_000);
    }

    // 초기 지연 후 사이클 시작 (가격 히스토리 축적 대기)
    this.cycleTimer = setTimeout(() => void this.runCycle(), INITIAL_DELAY_MS);

    resumeIntelService();   // stop() 이후 재기동 시 intel 진입 차단 해제
    console.info('[AIWorker] 시작 — 60초 AI 사이클, 10초 가격 폴링');
  }

  stop(): void {
    this.active = false;
    if (this.pricePollTimer) { clearInterval(this.pricePollTimer); this.pricePollTimer = null; }
    if (this.cycleTimer)    { clearTimeout(this.cycleTimer);       this.cycleTimer    = null; }
    if (this.serverPaperTimer) { clearInterval(this.serverPaperTimer); this.serverPaperTimer = null; }
    stopIntelService();   // 6I-2 §3 — 신규 intel 사이클/enrichment 진입 차단
    console.info('[AIWorker] 정지');
  }


  /** Task #111 — priceBuffer 마지막 값 + 심볼별 수신 시각 기반 시세 조회 (합성 금지).
   *  다른 심볼만 갱신돼도 이 심볼이 fresh로 판정되지 않도록 per-symbol 시각을 쓴다. */
  /**
   * #135 — 수동 Controlled Canary용 공개 시세 조회 (read-only).
   * priceBuffer 최신값 + per-symbol 수신 시각 기반. 합성/추정 금지.
   */
  getPriceQuote(symbol: string): PriceQuote | null {
    return this.serverPaperQuote(symbol);
  }

  private serverPaperQuote(symbol: string): PriceQuote | null {
    const buf = this.priceBuffer.get(symbol);
    const price = buf && buf.length > 0 ? buf[buf.length - 1] : null;
    const symbolAt = this.priceAtBySymbol.get(symbol) ?? 0;
    if (price == null || !Number.isFinite(price) || price <= 0 || symbolAt <= 0) return null;
    return { priceUsd: price, ageMs: Date.now() - symbolAt };
  }

  /**
   * Task #111 — 서버 권위 PAPER 실행 (사이클 내, persistDecision 직전).
   * PAPER 모드에서만 호출된다. LIVE/GMX submit/서명 경로 호출 0회.
   *
   * 순서:
   *  1) RiskEngine REDUCE_POSITION_70PCT → durable 1회 축소
   *  2) RiskEngine CLOSE_ALL 또는 CASH/NO_TRADE 결정 + 서버 미청산 존재 → 전량 청산 요청(영속)
   *  3) riskApproved LONG/SHORT 신규 진입(perp_*_open만 — scale_in 등 물타기 거부) → OPEN
   * 성공 시 decision.paperExecuted/paperOrderId 갱신.
   */
  private async runServerPaperExecution(
    decision: ServerAiDecision,
    paperState: Awaited<ReturnType<WorkerManager['loadPaperState']>>,
    riskEval: RiskEvaluationResult | null,
    cycleNum: number,
  ): Promise<void> {
    const serverOpenRows = await loadServerOpenRows();

    // 1) 수익 보호 70% 축소 (RiskEngine 액션)
    if (riskEval?.actions.includes('REDUCE_POSITION_70PCT') && serverOpenRows.length > 0) {
      const row = serverOpenRows[0];
      const r = await reduceServerPaper70({ openRow: row, quote: this.serverPaperQuote(row.symbol) });
      console.info(`[AIWorker] 사이클 #${cycleNum} 서버 PAPER REDUCE70 — ${r.ok ? '실행' : r.reason}`);
    }

    // 2) 전량 청산 (RiskEngine CLOSE_ALL 우선, CASH/NO_TRADE 전환 포함)
    //
    // 크래시 내구성 불변식: close-all 의도는 매 사이클 durable 소스(DB의 riskState·
    // 결정 입력)에서 재파생된다. pendingClose 영속 write가 실패한 직후 크래시해도,
    // 재시작 후 첫 사이클이 같은 조건에서 wantsFlat을 다시 도출해 재요청한다.
    // 신규 진입(3)은 이 분기 이후에만 도달하므로, 유실된 의도가 잘못된 OPEN으로
    // 이어지는 경로는 구조적으로 없다.
    const wantsFlat =
      riskEval?.actions.includes('CLOSE_ALL_POSITIONS') === true ||
      decision.operatingState === 'CASH';
    if (wantsFlat && serverOpenRows.length > 0) {
      const reason = riskEval?.actions.includes('CLOSE_ALL_POSITIONS') ? 'RISK_CLOSE_ALL' : 'CASH_TRANSITION';
      await requestServerPaperCloseAll(reason);
      // 즉시 1회 시도 — 시세 stale이면 관리 틱이 완료까지 재시도 (영속 요청)
      for (const row of serverOpenRows) {
        await closeServerPaperPosition({
          openTradeId: row.id, reason, kind: 'FULL', quote: this.serverPaperQuote(row.symbol),
        });
      }
      return; // 청산 사이클에는 신규 진입 없음
    }

    // 3) 신규 진입 — 즉시 진입 유형만 (scale_in/scale_out/hedge 등 물타기·복합 거부)
    const isEntry =
      (decision.operatingState === 'LONG' || decision.operatingState === 'SHORT') &&
      decision.riskApproved === true &&
      (decision.executionType === 'perp_long_open' || decision.executionType === 'perp_short_open');
    if (!isEntry || !decision.primarySymbol || decision.sizeUsd == null || decision.leverage == null) return;
    if (riskEval?.entryAllowed !== true) return; // RiskEngine 최종 허용 재확인

    const result = await openServerPaperPosition({
      decisionId:        decision.id,
      symbol:            decision.primarySymbol,
      side:              decision.operatingState === 'LONG' ? 'LONG' : 'SHORT',
      sizeUsd:           decision.sizeUsd,
      leverage:          decision.leverage,
      quote:             this.serverPaperQuote(decision.primarySymbol),
      tpPriceUsd:        decision.tpPrice ?? null,
      // paperState.positions는 trades 전체(서버 행 포함)에서 파생 — 서버 행 수와 큰 쪽 사용
      openPositionCount: Math.max(paperState.positions.length, serverOpenRows.length),
      maxConcurrentPositions: decision.riskProfile.derivedLimits.maxConcurrentPositions,
      riskProfileSnapshot: decision.riskProfile,
      entriesManilaDay:  paperState.entriesManilaDay,
    });
    if (result.ok) {
      decision.paperExecuted = true;
      decision.paperOrderId  = result.tradeId;
      console.info(`[AIWorker] 사이클 #${cycleNum} 서버 PAPER OPEN 성공 — trade=${result.tradeId}`);
    } else {
      console.info(`[AIWorker] 사이클 #${cycleNum} 서버 PAPER OPEN 거부 — ${result.reason}`);
    }
  }

  getStatus(): WorkerStatus {
    return {
      workerRunning:        this.isRunning,
      lastCycleAt:          this.lastCycleAt?.toISOString() ?? null,
      lastCycleResult:      this.lastCycleResult,
      cycleCount:           this.cycleCount,
      lastLimitsUsed:       this.lastLimitsUsed,
      equityHwm:            this.equityHighWaterMark,
      liveTestMode:         this.lastLiveTestMode,
      liveTestVetoReason:   this.lastLiveTestVetoReason,
      liveTestAccumLossUsd: this.liveTestAccumLossUsd,
      liveTestDbOk:         this.lastLiveTestDbOk,
      dailyPnlUsd:          this.lastDailyPnlUsd,
      weeklyPnlUsd:         this.lastWeeklyPnlUsd,
      dailyBaseline:        this.dailyBaseline,
      weeklyBaseline:       this.weeklyBaseline,
      dailyRealizedPnlUsd:  this.lastDailyRealizedUsd,
      weeklyRealizedPnlUsd: this.lastWeeklyRealizedUsd,
      currentEquityUsd:     this.lastCurrentEquityUsd,
      periodPnlUpdatedAt:   this.periodPnlUpdatedAt,
      // ── RiskEngine (6H-1) ─────────────────────────────────────────────────
      riskOperatingState:       this.lastRiskEvaluation?.state ?? null,
      riskEntryAllowed:         this.lastRiskEvaluation?.entryAllowed === true,
      riskBlockReasons:         this.lastRiskEvaluation?.blockReasons ?? [],
      riskDbOk:                 this.riskDbOk,
      riskDailyEntryCount:      this.riskState?.dailyEntryCount ?? null,
      riskConsecutiveLossCount: this.riskState?.consecutiveLossCount ?? null,
      riskDayPeriodStart:       this.riskState?.dayPeriodStart ?? null,
      riskWeekPeriodStart:      this.riskState?.weekPeriodStart ?? null,
      riskDerivedTargets:       this.riskState
        ? deriveDailyTargets(Math.min(this.riskState.startOfDayEquityUsd, RISK_POLICY.maxRiskCapitalUsd))
        : null,
      msUntilNextManilaDay:     msUntilNextManilaDay(new Date()),
      // ── 6H-2 사이징 강제·close-all ────────────────────────────────────────
      paperSizing:           this.lastPaperSizing,
      liveSizingEnforcement: getLastSizingEnforcement(),
      closeAllSummary:       this.lastCloseAllSummary,
      settlementReconcile:   this.lastSettlementReconcile,
      serverPaperExec:       process.env.WORKER_ENGINE_MODE !== 'LIVE' ? getServerPaperStatus() : null,
    };
  }

  // ── Equity HWM persistence ───────────────────────────────────────────────────

  /**
   * 서버 재시작 시 DB에서 equity HWM을 복구합니다.
   * 복구 성공 시 첫 사이클부터 maxDrawdown 강제가 즉시 적용됩니다.
   */
  // ── 기간 PnL 기준점 persistence ─────────────────────────────────────────────

  /** 서버 재시작 시 DB에서 Daily/Weekly equity 기준점을 복구합니다. */
  private async loadBaselinesFromDb(): Promise<void> {
    try {
      const rows = await db.select().from(workerStateTable);
      for (const row of rows) {
        if (row.key === BASELINE_DAILY_KEY)  this.dailyBaseline  = parseBaseline(row.value);
        if (row.key === BASELINE_WEEKLY_KEY) this.weeklyBaseline = parseBaseline(row.value);
      }
      if (this.dailyBaseline)  console.info(`[AIWorker] Daily 기준점 복구: ${this.dailyBaseline.periodStart} $${this.dailyBaseline.equity.toFixed(2)}`);
      if (this.weeklyBaseline) console.info(`[AIWorker] Weekly 기준점 복구: ${this.weeklyBaseline.periodStart} $${this.weeklyBaseline.equity.toFixed(2)}`);
    } catch (err) {
      console.warn('[AIWorker] 기간 PnL 기준점 로드 실패 (기준점 미수립 → N/A 유지):', (err as Error).message);
    }
  }

  /** 기준점을 worker_state에 upsert. 성공 여부 반환 (fail-closed 판단용). */
  private async saveBaselineToDb(key: string, baseline: EquityBaseline): Promise<boolean> {
    try {
      const value = JSON.stringify(baseline);
      await db
        .insert(workerStateTable)
        .values({ key, value })
        .onConflictDoUpdate({
          target: workerStateTable.key,
          set: { value, updatedAt: new Date() },
        });
      return true;
    } catch (err) {
      console.warn(`[AIWorker] 기준점 저장 실패 (${key}):`, (err as Error).message);
      return false;
    }
  }

  /** 기간 PnL 상태를 전부 null로 (DB 실패·기준점 미확정 시 fail-closed → UI N/A) */
  private clearPeriodPnl(): void {
    this.lastCurrentEquityUsd  = null;
    this.lastDailyPnlUsd       = null;
    this.lastWeeklyPnlUsd      = null;
    this.lastDailyRealizedUsd  = null;
    this.lastWeeklyRealizedUsd = null;
    this.periodPnlUpdatedAt    = null;
  }

  /**
   * 사이클마다 기간 PnL을 갱신합니다 (equity 기준점 기반, UTC).
   * 기준점이 없거나 기간이 바뀌면 현재 equity로 새 기준점을 수립하고
   * **영속화 성공을 확인한 뒤에만** 유효한 것으로 취급합니다 (fail-closed).
   * → 전날부터 보유한 포지션의 기존 미실현 수익이 오늘 PnL에 중복되지 않는다.
   */
  private async updatePeriodPnl(
    currentEquity: number,
    dailyRealized: number,
    weeklyRealized: number,
    now: Date = new Date(),
  ): Promise<void> {
    const daily = rollBaseline(this.dailyBaseline, dailyPeriodStartUtc(now), currentEquity, now);
    if (daily.changed) {
      // 저장 성공 전에는 새 기준점을 유효한 것으로 노출하지 않음 (재시작 연속성 보장)
      const saved = await this.saveBaselineToDb(BASELINE_DAILY_KEY, daily.baseline);
      this.dailyBaseline = saved ? daily.baseline : null;
    }
    const weekly = rollBaseline(this.weeklyBaseline, weeklyPeriodStartUtc(now), currentEquity, now);
    if (weekly.changed) {
      const saved = await this.saveBaselineToDb(BASELINE_WEEKLY_KEY, weekly.baseline);
      this.weeklyBaseline = saved ? weekly.baseline : null;
    }
    this.lastCurrentEquityUsd    = currentEquity;
    this.lastDailyPnlUsd         = computePeriodPnl(currentEquity, this.dailyBaseline);
    this.lastWeeklyPnlUsd        = computePeriodPnl(currentEquity, this.weeklyBaseline);
    this.lastDailyRealizedUsd    = dailyRealized;
    this.lastWeeklyRealizedUsd   = weeklyRealized;
    this.periodPnlUpdatedAt      = now.toISOString();
  }

  private async loadHwmFromDb(): Promise<void> {
    try {
      const rows = await db
        .select()
        .from(workerStateTable)
        .where(eq(workerStateTable.key, 'equityHwm'));
      if (rows[0]?.value) {
        const saved = parseFloat(rows[0].value);
        if (!isNaN(saved) && saved > 0) {
          this.equityHighWaterMark = saved;
          console.info(`[AIWorker] Equity HWM 복구: $${saved.toFixed(2)}`);
        }
      }
    } catch (err) {
      console.warn('[AIWorker] HWM 로드 실패 (무시):', (err as Error).message);
    }
  }

  /**
   * 현재 equity HWM을 DB에 저장합니다 (fire-and-forget).
   * 사이클 지연을 최소화하기 위해 await 없이 호출합니다.
   */
  private async saveHwmToDb(hwm: number): Promise<void> {
    try {
      await db
        .insert(workerStateTable)
        .values({ key: 'equityHwm', value: String(hwm) })
        .onConflictDoUpdate({
          target: workerStateTable.key,
          set: { value: String(hwm), updatedAt: new Date() },
        });
    } catch (err) {
      console.warn('[AIWorker] HWM 저장 실패 (무시):', (err as Error).message);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * PENDING live_approvals를 DB에서 재조회해 중복 방지 세트를 원자적으로 교체한다.
   * 매 사이클 시작 시 호출 — 승인/거절/만료된 항목은 자동으로 세트에서 제거된다.
   *
   * 1. expiresAt < now 인 PENDING 행을 먼저 EXPIRED로 업데이트 (서버 사이드 만료)
   * 2. 남은 PENDING 행만 조회해 새 Set을 생성 후 교체 (누적 아님)
   */
  private async loadPendingApprovals(): Promise<void> {
    try {
      const now = new Date();

      // ① 서버 사이드 만료: expiresAt이 지난 PENDING 행을 EXPIRED로 처리
      await db
        .update(liveApprovalsTable)
        .set({ status: "EXPIRED" })
        .where(
          and(
            eq(liveApprovalsTable.status, "PENDING"),
            lt(liveApprovalsTable.expiresAt, now),
          ),
        );

      // ② 여전히 PENDING인 행만 조회
      const rows = await db
        .select()
        .from(liveApprovalsTable)
        .where(eq(liveApprovalsTable.status, "PENDING"));

      // ③ 새 Set으로 원자적 교체 — 이전 세트 완전 대체 (누적 방지)
      const fresh = new Set<string>();
      for (const row of rows) {
        try {
          const decision = JSON.parse(row.decisionJson) as Partial<ServerAiDecision>;
          const sym = decision.primarySymbol ?? "MULTI";
          const dir = decision.operatingState;
          if (sym && dir) fresh.add(`${sym}:${dir}`);
        } catch { /* 파싱 실패는 무시 */ }
      }
      this.pendingApprovalKeys = fresh;

      console.debug(`[AIWorker] PENDING 세트 재구성: ${fresh.size}건`);
    } catch (err) {
      console.error("[AIWorker] PENDING 승인 로드 실패:", err);
      // 오류 시 기존 세트 유지 (다음 사이클에 재시도)
    }
  }

  /** GMX 가격 캐시에서 심볼별 가격 히스토리를 업데이트한다. */
  private updatePriceBuffers(): void {
    const prices = getCachedPrices();
    if (!prices || prices.length === 0) return;

    let latestAdvancedObservedAt = 0;
    const receivedAt = Date.now();

    for (const tick of prices) {
      const sym = tick.tokenSymbol;
      if (!WORKER_SYMBOLS.includes(sym)) continue;
      if (tick.priceUsd <= 0) continue;
      if (!Number.isFinite(tick.updatedAt) || tick.updatedAt <= 0 || tick.updatedAt > receivedAt + 5_000) continue;

      // #120 P0 — stale 캐시 재인증 금지: upstream tick(updatedAt)이 실제로
      // 전진했을 때만 버퍼·신선도를 갱신한다. 전량 폐기로 캐시가 동결되면
      // updatedAt이 멈추므로 priceAtBySymbol도 함께 낡아져 freshness 게이트가
      // 정상적으로 진입/관리를 차단한다.
      const lastSeen = this.lastTickUpdatedAtBySymbol.get(sym) ?? 0;
      if (!(tick.updatedAt > lastSeen)) continue;
      this.lastTickUpdatedAtBySymbol.set(sym, tick.updatedAt);
      latestAdvancedObservedAt = Math.max(latestAdvancedObservedAt, tick.updatedAt);

      const buf = this.priceBuffer.get(sym) ?? [];
      buf.push(tick.priceUsd);
      if (buf.length > MAX_PRICE_HISTORY) buf.shift();
      this.priceAtBySymbol.set(sym, tick.updatedAt);
      this.priceBuffer.set(sym, buf);
    }

    if (latestAdvancedObservedAt > 0) {
      this.lastPriceAt = Math.max(this.lastPriceAt, latestAdvancedObservedAt);
    }
  }

  /** 현재 가격 버퍼에서 SymbolAnalysis 배열을 빌드한다. */
  private buildAnalyses(): SymbolAnalysis[] {
    const change24h = getCachedChange24h() ?? {};
    const analyses: SymbolAnalysis[] = [];

    for (const sym of WORKER_SYMBOLS) {
      const buf = this.priceBuffer.get(sym);
      if (!buf || buf.length < 5) continue;

      const price = buf[buf.length - 1];
      if (price <= 0) continue;

      const priceChange24h = change24h[sym] ?? 0;
      const indicators = computeIndicators(buf, priceChange24h);
      const { bullishScore, bearishScore, directionalBias, opportunityScore } = computeScores(indicators);

      analyses.push({
        symbol:           sym,
        displaySymbol:    sym,
        price,
        indicators,
        bullishScore,
        bearishScore,
        directionalBias,
        opportunityScore,
      });
    }

    return analyses.sort((a, b) => b.opportunityScore - a.opportunityScore);
  }

  /** 마지막 AI decision fullJson에서 SHADOW lifecycle snapshot을 읽기 전용 복원한다. */
  private async loadStrategyLifecycleSnapshotFromDb(): Promise<void> {
    try {
      const rows = await db.select().from(aiDecisionsTable)
        .where(like(aiDecisionsTable.fullJson, '%"source":"server_worker"%'))
        .orderBy(desc(aiDecisionsTable.ts)).limit(1);
      const restored = restoreStrategyShadowLifecycleFromDecisionFullJson(
        rows[0]?.fullJson ?? null,
        Date.now(),
      );
      this.strategyLifecycleSnapshot = restored.snapshot;
      this.strategyLifecycleRestoreBlocked = restored.status === 'BLOCKED';
      if (restored.status === 'BLOCKED') {
        console.error(`[AIWorker] ${restored.reason} — Strategy SHADOW 평가 차단`);
      } else {
        console.info(`[AIWorker] ${restored.reason} — records=${restored.snapshot.records.length}, history=${restored.snapshot.historyEvents.length}`);
      }
    } catch (error) {
      this.strategyLifecycleSnapshot = null;
      this.strategyLifecycleRestoreBlocked = true;
      console.error(`[AIWorker] SHADOW lifecycle DB read 실패(${error instanceof Error ? error.name : 'unknown'}) — SHADOW 평가 차단`);
    }
  }

  /** 결정을 ai_decisions 테이블에 저장한다. 성공 여부를 반환한다 (Task #111 —
   *  서버 PAPER 실행은 결정이 durable하게 기록된 후에만 허용). */
  private async persistDecision(decision: ServerAiDecision): Promise<boolean> {
    try {
      await db.insert(aiDecisionsTable).values({
        ts:               new Date(decision.createdAt),
        symbol:           decision.primarySymbol ?? "MULTI",
        direction:        decision.operatingState === "LONG" ? "LONG"
                          : decision.operatingState === "SHORT" ? "SHORT"
                          : "NO_TRADE",
        confidence:       decision.confidence / 100,
        rationale:        `[Worker] ${decision.stateRationale}`,
        strategy:         `WORKER_AI_5STATE_${decision.operatingState}`,
        riskResult:       decision.riskApproved ? "APPROVED" : "VETOED",
        riskNote:         decision.riskVetoReason ?? null,
        executionOutcome: "SIMULATED",
        fullJson:         JSON.stringify(decision),
        testMode:         decision.testMode ?? false,
      });
      return true;
    } catch (err) {
      console.error("[AIWorker] persistDecision 실패:", err);
      return false;
    }
  }

  /** Task #111 — 실행 후 paperExecuted/paperOrderId 반영 (full_json 갱신, 실패는 로그만). */
  private async updateDecisionExecutionFlags(decision: ServerAiDecision): Promise<void> {
    try {
      // 결정 UUID는 fullJson에만 존재 — LIKE 매칭 (uuid는 전역 유일)
      await db.update(aiDecisionsTable)
        .set({ fullJson: JSON.stringify(decision) })
        .where(like(aiDecisionsTable.fullJson, `%"id":"${decision.id}"%`));
    } catch (err) {
      console.error("[AIWorker] 결정 실행 플래그 갱신 실패:", (err as Error).message);
    }
  }

  /**
   * LIVE 모드일 때 actionable한 결정을 live_approvals에 INSERT한다.
   * 이미 같은 심볼+방향의 PENDING 승인이 있으면 건너뛴다.
   */
  private async maybeCreateApproval(decision: ServerAiDecision): Promise<boolean> {
    // LIVE 모드 확인 (env var로 제어)
    if (process.env.WORKER_ENGINE_MODE !== "LIVE") return false;

    const isActionable =
      decision.operatingState !== "CASH" &&
      decision.riskApproved &&
      decision.executionType !== "hold";

    if (!isActionable) return false;

    // 중복 체크
    const sym = decision.primarySymbol ?? "MULTI";
    const dir = decision.operatingState;
    const key = `${sym}:${dir}`;

    if (this.pendingApprovalKeys.has(key)) {
      console.debug(`[AIWorker] 중복 승인 건너뜀: ${key}`);
      return false;
    }

    try {
      const id       = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60_000); // 15분 후 만료

      await db.insert(liveApprovalsTable).values({
        id,
        decisionJson: JSON.stringify(decision),
        status:       "PENDING",
        expiresAt,
        testMode:     decision.testMode ?? false,
      });

      this.pendingApprovalKeys.add(key);
      console.info(`[AIWorker] LIVE 승인 생성: ${key} (id=${id})`);
      return true;
    } catch (err) {
      console.error("[AIWorker] live_approval INSERT 실패:", err);
      return false;
    }
  }

  // ── Strategy limits from DB ─────────────────────────────────────────────
  /**
   * DB에서 사용자 Strategy 설정을 읽어 RiskLimits 반환.
   * 설정이 없거나 실패하면 보수적인 DEFAULT_LIMITS 반환.
   */
  private async loadStrategyLimits(): Promise<RiskLimits> {
    try {
      const rows = await db.select().from(strategyConfigTable).limit(1);
      const row = rows[0];
      if (!row?.limits) return DEFAULT_LIMITS;
      const raw = (
        typeof row.limits === 'string'
          ? JSON.parse(row.limits as string)
          : row.limits
      ) as Partial<RiskLimits>;
      const merged = { ...DEFAULT_LIMITS, ...raw };
      // legacy 저장값(예: 구형 $500)은 읽기 경로에서도 정책 상한으로 클램프 —
      // lastLimitsUsed/status에 legacy 값이 그대로 노출되지 않게 한다 (DB 무변경).
      if ('dailyTargetUSDT' in merged) {
        merged.dailyTargetUSDT = clampDailyTargetUSDT(merged.dailyTargetUSDT);
      }
      return merged;
    } catch (err) {
      console.warn('[AIWorker] loadStrategyLimits 실패 — DEFAULT_LIMITS 사용:', (err as Error).message);
      return DEFAULT_LIMITS;
    }
  }

  // ── Paper trading state from DB ─────────────────────────────────────────
  /**
   * PAPER 거래 DB에서 실제 운용 상태를 계산합니다.
   *
   * - realizedPnLToday:       당일(UTC 자정~현재) CLOSE 거래 PnL 합계
   * - realizedPnLRolling24h:  최근 24h 롤링 윈도우 PnL 합계
   * - realizedPnLWeekly:      이번 주 월요일 00:00 UTC~ PnL 합계
   * - consecutiveLosses:      최신 CLOSE 거래부터 연속 음수 PnL 카운트
   * - positions:              action=OPEN + closeTime=0 레코드에서 추출
   *
   * ⚠️ LIVE 실제 계정 데이터와 절대 혼합하지 않습니다.
   */
  private async loadPaperState(): Promise<{
    realizedPnLToday: number;
    realizedPnLRolling24h: number;
    realizedPnLWeekly: number;
    /** §5 (6H-2) — UNSETTLED 이익 제외 UTC 합계 (엔진 손익 입력용, 보수적) */
    realizedPnLTodayGated: number;
    realizedPnLWeeklyGated: number;
    /** 전체 기간 누적 실현 PnL — HWM 계산 기준 */
    totalRealizedPnlAllTime: number;
    consecutiveLosses: number;
    positions: import('./serverTypes').Position[];
    /** OPEN 거래 수 (최근 1시간 내) — maxTradesPerHour 강제용 */
    tradesInLastHour: number;
    /** 마지막 OPEN 거래 Unix ms — cooldownMinutes 강제용. null = 기록 없음 */
    lastOpenTradeTimestampMs: number | null;
    /** mark-to-market 기준 미실현 PnL 합계 (USD) */
    totalUnrealizedPnl: number;
    /** LIVE TEST MODE test_mode=true CLOSE 거래의 누적 손실 절댓값 합계 (USD) */
    liveTestAccumLossUsd: number;
    /** true = DB 조회 성공; false = 실패 → LIVE TEST fail-closed */
    liveTestDbOk: boolean;
    /** Manila 거래일(00:00 Asia/Manila~) 실현 PnL — RiskEngine 전용 (6H-1) */
    realizedPnLManilaDay: number;
    /** Manila 거래주(월요일 00:00 Asia/Manila~) 실현 PnL */
    realizedPnLManilaWeek: number;
    /** Manila 거래일 신규 진입(OPEN) 횟수 — maxDailyEntries 강제용 */
    entriesManilaDay: number;
  }> {
    const ZEROS = {
      realizedPnLToday: 0, realizedPnLRolling24h: 0, realizedPnLWeekly: 0,
      realizedPnLTodayGated: 0, realizedPnLWeeklyGated: 0,
      totalRealizedPnlAllTime: 0,
      consecutiveLosses: 0, positions: [],
      tradesInLastHour: 0, lastOpenTradeTimestampMs: null, totalUnrealizedPnl: 0,
      liveTestAccumLossUsd: 0, liveTestDbOk: false,  // false = DB 실패 → fail-closed
      realizedPnLManilaDay: 0, realizedPnLManilaWeek: 0, entriesManilaDay: 0,
    };

    try {
      const now = Date.now();

      // 당일 시작: UTC 자정
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);

      // Rolling 24h / 최근 1시간 시작
      const rolling24hStart    = new Date(now - 24 * 60 * 60 * 1000);
      const oneHourAgoMs       = now - 60 * 60 * 1000;

      // 이번 주 월요일 00:00 UTC
      const weekStart = new Date();
      weekStart.setUTCHours(0, 0, 0, 0);
      const dow = weekStart.getUTCDay();
      weekStart.setUTCDate(weekStart.getUTCDate() - (dow === 0 ? 6 : dow - 1));

      // DB에서 전체 거래 조회 (최신순)
      const allTrades = await db
        .select()
        .from(tradesTable)
        .orderBy(desc(tradesTable.timestamp));

      // CLOSE 거래에서 실현 PnL 계산
      const closeTrades = allTrades.filter(
        t => t.action === 'CLOSE' || t.action === 'CLOSE_ALL',
      );

      // Manila 거래일/거래주 시작 (6H-1 §11 — RiskEngine 전용, UTC 기준점과 별도)
      const nowDate = new Date(now);
      const manilaDayStartMs  = new Date(manilaDayStartIso(nowDate)).getTime();
      const manilaWeekStartMs = new Date(manilaWeekStartIso(nowDate)).getTime();

      let realizedPnLToday         = 0;
      let realizedPnLRolling24h    = 0;
      let realizedPnLWeekly        = 0;
      let realizedPnLTodayGated    = 0;   // §5 — UNSETTLED 이익 제외 (엔진 입력용)
      let realizedPnLWeeklyGated   = 0;
      let totalRealizedPnlAllTime  = 0;
      let realizedPnLManilaDay     = 0;
      let realizedPnLManilaWeek    = 0;

      for (const t of closeTrades) {
        const ts  = new Date(t.timestamp as string | Date).getTime();
        const pnl = parseFloat(t.pnl ?? '0') || 0;
        // 6H-2A §3·§5 gated PnL:
        //  - SETTLED: pnl(실제 순) 그대로
        //  - PAPER_ESTIMATED + netPnlEstimatedUsd: 추정 순 PnL 사용 (이익/손실 모두)
        //  - 그 외(UNSETTLED / legacy PAPER_ZERO_FEE / 비용 불명): 이익 미반영,
        //    gross 손실만 즉시 반영 (보수적 비대칭 — zero-fee 이익 인정 금지)
        const st = (t as { settlementStatus?: string | null }).settlementStatus ?? 'UNSETTLED';
        const netEstRaw = (t as { netPnlEstimatedUsd?: string | null }).netPnlEstimatedUsd;
        const netEst = netEstRaw != null ? parseFloat(netEstRaw) : NaN;
        let gatedPnl: number;
        if (st === 'SETTLED') gatedPnl = pnl;
        else if (st === 'PAPER_ESTIMATED' && Number.isFinite(netEst)) gatedPnl = netEst;
        else gatedPnl = pnl < 0 ? pnl : 0;
        totalRealizedPnlAllTime  += pnl;                                    // 전체 누적
        if (ts >= todayStart.getTime())      realizedPnLToday      += pnl;
        if (ts >= rolling24hStart.getTime()) realizedPnLRolling24h += pnl;
        if (ts >= weekStart.getTime())       realizedPnLWeekly     += pnl;
        if (ts >= todayStart.getTime())      realizedPnLTodayGated  += gatedPnl;
        if (ts >= weekStart.getTime())       realizedPnLWeeklyGated += gatedPnl;
        if (ts >= manilaDayStartMs)          realizedPnLManilaDay  += gatedPnl;
        if (ts >= manilaWeekStartMs)         realizedPnLManilaWeek += gatedPnl;
      }

      // LIVE TEST 누적 손실: test_mode=true CLOSE 거래 중 pnl < 0인 것의 절댓값 합계.
      // DB에서 매 사이클 재계산하므로 서버 재시작 후에도 자동 복원됩니다.
      const liveTestAccumLossUsd = closeTrades
        .filter(t => t.testMode === true && parseFloat(t.pnl ?? '0') < 0)
        .reduce((sum, t) => sum + Math.abs(parseFloat(t.pnl ?? '0')), 0);

      // 연속 손실 카운트: 최신 CLOSE부터 연속 음수 PnL
      let consecutiveLosses = 0;
      for (const t of closeTrades) {
        const pnl = parseFloat(t.pnl ?? '0') || 0;
        if (pnl < 0) consecutiveLosses++;
        else break;
      }

      // ── 시간당 거래 횟수 + 쿨다운 추적 ───────────────────────────────────
      const openTrades = allTrades.filter(
        t => t.action === 'OPEN' && (!t.closeTime || t.closeTime === 0),
      );
      const allOpenActions = allTrades.filter(t => t.action === 'OPEN');

      const tradesInLastHour = allOpenActions.filter(t => {
        const ts = new Date(t.timestamp as string | Date).getTime();
        return ts >= oneHourAgoMs;
      }).length;

      // Manila 거래일 신규 진입 횟수 — OPEN action만 집계.
      // 취소·prepare 실패는 trades에 기록되지 않으므로 세지 않음.
      // 부분청산(CLOSE)은 OPEN이 아니므로 신규 진입으로 세지 않음 (§10).
      const entriesManilaDay = allOpenActions.filter(t => {
        const ts = new Date(t.timestamp as string | Date).getTime();
        return ts >= manilaDayStartMs;
      }).length;

      // 가장 최근 OPEN 거래 시각 (쿨다운 기준)
      const latestOpen = allOpenActions[0]; // 이미 최신순 정렬
      const lastOpenTradeTimestampMs = latestOpen
        ? new Date(latestOpen.timestamp as string | Date).getTime()
        : null;

      // ── 현재 GMX 시장가 캐시 (mark-to-market용) ─────────────────────────
      const cachedPrices = getCachedPrices();
      const priceMap = new Map<string, number>();
      if (cachedPrices) {
        for (const p of cachedPrices) {
          if (p.priceUsd > 0) priceMap.set(p.tokenSymbol, p.priceUsd);
        }
      }

      // ── 미청산 포지션 구성 + mark-to-market ──────────────────────────────
      let totalUnrealizedPnl = 0;

      const positions: import('./serverTypes').Position[] = openTrades.map(t => {
        const sizeInUsd   = parseFloat(t.sizeInUsd ?? t.size ?? '0') || 0;
        const entryPrice  = parseFloat(t.price ?? '0') || 0;

        // Leverage: DB 기록값 우선, 없으면 1x (보수적 처리)
        const leverage = parseFloat(t.leverage ?? '1') || 1;

        // Collateral: DB 기록값 우선, 없으면 sizeInUsd/leverage 계산
        const dbCollateral = parseFloat(t.collateralUsd ?? '0');
        const collateralUsd = dbCollateral > 0
          ? dbCollateral
          : (leverage > 1 && sizeInUsd > 0 ? sizeInUsd / leverage : sizeInUsd);

        const side = (t.side === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT';

        // ── Mark-to-market unrealized PnL ──────────────────────────────────
        // 계산 조건: entryPrice > 0 AND 현재 시장가 캐시에 심볼이 있어야 함.
        // 어느 한 조건이라도 없으면 0 (추정 금지 — 보수적 처리).
        let unrealizedPnl = 0;
        const currentPrice = priceMap.get(t.symbol) ?? 0;
        if (entryPrice > 0 && currentPrice > 0 && sizeInUsd > 0) {
          // 진입 당시 토큰 수량 ≈ sizeInUsd / entryPrice
          const sizeInTokens = sizeInUsd / entryPrice;
          const pnlPerToken  = side === 'LONG'
            ? (currentPrice - entryPrice)
            : (entryPrice - currentPrice);
          unrealizedPnl = pnlPerToken * sizeInTokens;
        }

        totalUnrealizedPnl += unrealizedPnl;

        return { symbol: t.symbol, side, sizeInUsd, collateralUsd, unrealizedPnl, entryPrice, leverage };
      });

      return {
        realizedPnLToday, realizedPnLRolling24h, realizedPnLWeekly,
        realizedPnLTodayGated, realizedPnLWeeklyGated,
        totalRealizedPnlAllTime,
        consecutiveLosses, positions,
        tradesInLastHour, lastOpenTradeTimestampMs, totalUnrealizedPnl,
        liveTestAccumLossUsd,
        liveTestDbOk: true,
        realizedPnLManilaDay, realizedPnLManilaWeek, entriesManilaDay,
      };
    } catch (err) {
      console.warn('[AIWorker] loadPaperState 실패 — synthetic zeros 사용 (LIVE TEST fail-closed):', (err as Error).message);
      return ZEROS;
    }
  }

  /** 60초 AI 사이클 — setTimeout 루프 (완료 후 다음 예약). */
  private async runCycle(): Promise<void> {
    if (!this.active) return;

    // Atomic lock: 이전 사이클이 아직 실행 중이면 건너뜀
    if (this.isRunning) {
      console.warn("[AIWorker] 이전 사이클 실행 중 — 이번 사이클 건너뜀");
      this.cycleTimer = setTimeout(() => void this.runCycle(), CYCLE_INTERVAL_MS);
      return;
    }

    this.isRunning = true;
    this.cycleCount++;
    const cycleNum = this.cycleCount;
    const cycleStartMs = Date.now();

    try {
      // 사이클마다 PENDING 세트를 DB에서 재구성 — 승인/거절/만료된 항목 자동 제거
      await this.loadPendingApprovals();

      // 프로필 변경은 사이클 시작의 안전 경계에서만 승격한다. API는 desired만 기록하며
      // Worker 외 다른 경로는 applied를 변경할 수 없다.
      const [baseLimits, paperState] = await Promise.all([
        this.loadStrategyLimits(),
        this.loadPaperState(),
      ]);
      const riskProfileStatus = await promoteRiskProfileAtSafeBoundary(baseLimits);
      const riskProfile = riskProfileStatus.applied;
      const limits = applyRiskProfileToLimits(baseLimits, riskProfile);
      this.lastLimitsUsed = limits;

      const analyses = this.buildAnalyses();

      // 데이터 신선도 — 가격이 60초 이상 오래됐으면 CASH로 처리
      const dataFreshMs = this.lastPriceAt > 0 ? Date.now() - this.lastPriceAt : 999_999;

      if (analyses.length < 2) {
        const err = `가격 히스토리 부족 (심볼 ${analyses.length}개, 최소 2개 필요)`;
        console.info(`[AIWorker] 사이클 #${cycleNum} 건너뜀 — ${err}`);
        this.lastCycleResult = {
          cycleNumber: cycleNum,
          at: new Date().toISOString(),
          operatingState: "CASH",
          primarySymbol: null,
          confidence: 0,
          analysesCount: analyses.length,
          approvalCreated: false,
          error: err,
        };
        return;
      }

      // ── 기간 PnL 갱신 (equity 기준점 기반, UTC) ─────────────────────────────
      // ⚠️ 반드시 cooldown/거래한도 게이트보다 먼저 수행 — 게이트 조기 반환 시에도
      //    PnL이 매 사이클 갱신되어 stale 값이 노출되지 않는다.
      // paperState가 DB 실패로 synthetic zeros면 가짜 PnL을 만들지 않도록 스킵(fail-closed).
      if (paperState.liveTestDbOk) {
        const equityNow =
          limits.tradingCapital
          + paperState.totalRealizedPnlAllTime
          + paperState.totalUnrealizedPnl;
        await this.updatePeriodPnl(equityNow, paperState.realizedPnLToday, paperState.realizedPnLWeekly);
      } else {
        this.clearPeriodPnl();
      }

      // ── Cooldown 강제 ─────────────────────────────────────────────────────
      // 마지막 OPEN 거래 후 cooldownMinutes가 경과하지 않으면 신규 진입 차단.
      const cooldownMs = (limits.cooldownMinutes ?? 0) * 60_000;
      if (cooldownMs > 0 && paperState.lastOpenTradeTimestampMs !== null) {
        const msSinceLastTrade = Date.now() - paperState.lastOpenTradeTimestampMs;
        if (msSinceLastTrade < cooldownMs) {
          const remainSec = Math.ceil((cooldownMs - msSinceLastTrade) / 1000);
          console.info(`[AIWorker] 사이클 #${cycleNum} 쿨다운 — ${remainSec}s 남음 (설정: ${limits.cooldownMinutes}분)`);
          this.lastCycleResult = {
            cycleNumber: cycleNum, at: new Date().toISOString(),
            operatingState: "CASH", primarySymbol: null, confidence: 0,
            analysesCount: analyses.length, approvalCreated: false,
            error: `쿨다운 중 (${remainSec}초 남음)`,
          };
          return;
        }
      }

      // ── 시간당 거래 횟수 강제 ────────────────────────────────────────────
      const maxTradesPerHour = limits.maxTradesPerHour ?? 0;
      if (maxTradesPerHour > 0 && paperState.tradesInLastHour >= maxTradesPerHour) {
        console.info(`[AIWorker] 사이클 #${cycleNum} 시간당 거래 한도 초과 — ${paperState.tradesInLastHour}/${maxTradesPerHour}건`);
        this.lastCycleResult = {
          cycleNumber: cycleNum, at: new Date().toISOString(),
          operatingState: "CASH", primarySymbol: null, confidence: 0,
          analysesCount: analyses.length, approvalCreated: false,
          error: `시간당 거래 한도 초과 (${paperState.tradesInLastHour}/${maxTradesPerHour}건)`,
        };
        return;
      }

      // ── Equity HWM 및 계좌 드로다운 계산 ───────────────────────────────
      // currentEquity = 초기 자본 + 전체 누적 실현 PnL + mark-to-market 미실현 PnL
      // totalRealizedPnlAllTime을 사용해 오늘만이 아닌 전체 계좌 가치를 반영합니다.
      const currentEquity =
        limits.tradingCapital
        + paperState.totalRealizedPnlAllTime  // 전체 기간 누적 실현 PnL
        + paperState.totalUnrealizedPnl;      // mark-to-market 미실현 PnL

      // HWM 갱신: 첫 사이클은 현재 equity로 초기화.
      // DB에 저장해 서버 재시작 후에도 maxDrawdown 강제가 연속성을 갖도록 함.
      if (this.equityHighWaterMark === null || currentEquity > this.equityHighWaterMark) {
        this.equityHighWaterMark = currentEquity;
        void this.saveHwmToDb(currentEquity); // fire-and-forget: 사이클 지연 최소화
      }

      // HWM 대비 드로다운 % (HWM > 0이고 현재 equity < HWM일 때만 의미 있음)
      const accountDrawdownPct =
        this.equityHighWaterMark !== null && this.equityHighWaterMark > 0
          ? Math.max(0, (this.equityHighWaterMark - currentEquity) / this.equityHighWaterMark * 100)
          : undefined;

      // (기간 PnL 갱신은 cooldown/거래한도 게이트 이전에 이미 수행됨 — 위 참조)

      // ── RiskEngine 평가 (6H-1 — Manila 기준, fail-closed) ─────────────────
      const nowRisk = new Date();
      // 상태 미수립이면 현재 equity로 수립 (첫 실행)
      if (this.riskState === null && this.riskDbOk) {
        this.riskState = initialRiskEngineState(nowRisk, currentEquity);
      }
      let riskEval: RiskEvaluationResult | null = null;
      if (this.riskState) {
        // Manila 기간 롤오버 (daily reset은 weekly/hard 잠금을 해제하지 않음)
        const rolled = rollRiskPeriods(this.riskState, nowRisk, currentEquity);
        this.riskState = rolled.state;

        // 기준점 관측 시각 = 기간 시작. maxAge = 8일 (주간 기준점도 유효해야 함)
        const RISK_OBS_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
        const dCap = dailyRiskCapital(
          { equityUsd: this.riskState.startOfDayEquityUsd, recordedAt: this.riskState.dayPeriodStart },
          nowRisk, RISK_OBS_MAX_AGE_MS,
        );
        const wCap = weeklyRiskCapital(
          { equityUsd: this.riskState.startOfWeekEquityUsd, recordedAt: this.riskState.weekPeriodStart },
          nowRisk, RISK_OBS_MAX_AGE_MS,
        );

        // PAPER 모드: 시뮬레이션 체결에 수수료 0으로 정의 → 실현 PnL = 순 PnL.
        // LIVE 모드에서는 fee breakdown 필수 — 결측 시 feeDataOk=false로 fail-closed.
        const dailyRealizedNet = paperState.liveTestDbOk ? paperState.realizedPnLManilaDay : null;
        const weeklyRealizedNet = paperState.liveTestDbOk ? paperState.realizedPnLManilaWeek : null;
        const hasOpenPositions = paperState.positions.length > 0;
        const estimatedExit = dailyRealizedNet !== null && hasOpenPositions
          ? dailyRealizedNet + paperState.totalUnrealizedPnl
          : (dailyRealizedNet !== null ? null : null);
        const lossAware = dailyRealizedNet !== null
          ? (hasOpenPositions ? Math.min(dailyRealizedNet, dailyRealizedNet + paperState.totalUnrealizedPnl) : dailyRealizedNet)
          : null;

        riskEval = evaluateRiskState({
          dailyRiskCapitalUsd:  dCap.ok ? dCap.capitalUsd : null,
          weeklyRiskCapitalUsd: wCap.ok ? wCap.capitalUsd : null,
          currentEquityUsd:     Number.isFinite(currentEquity) ? currentEquity : null,
          dailyRealizedNetPnlUsd:  dailyRealizedNet,
          dailyLossAwareNetPnlUsd: lossAware,
          estimatedExitNetPnlUsd:  estimatedExit,
          weeklyRealizedNetPnlUsd: weeklyRealizedNet,
          dailyEntryCount:      paperState.entriesManilaDay,
          consecutiveLossCount: paperState.consecutiveLosses,
          openPositionCount:    paperState.positions.length,
          maxConcurrentPositions: riskProfile.derivedLimits.maxConcurrentPositions,
          dbOk:                 this.riskDbOk && paperState.liveTestDbOk,
          feeDataOk:            true,  // PAPER: 수수료 0 정의. LIVE 실행 경로는 별도 fee 게이트.
          marketDataFresh:      dataFreshMs < 120_000,
          locks: this.riskState.locks,
        });

        // 평가 결과 영속화 — 저장 실패 시 다음 사이클 fail-closed
        this.riskState = {
          ...this.riskState,
          dailyRealizedNetPnlUsd:  dailyRealizedNet ?? this.riskState.dailyRealizedNetPnlUsd,
          dailyLossAwareNetPnlUsd: lossAware ?? this.riskState.dailyLossAwareNetPnlUsd,
          weeklyRealizedNetPnlUsd: weeklyRealizedNet ?? this.riskState.weeklyRealizedNetPnlUsd,
          dailyEntryCount:      paperState.entriesManilaDay,
          consecutiveLossCount: paperState.consecutiveLosses,
          riskOperatingState:   riskEval.state,
          locks:                riskEval.locks,
          lastUpdatedAt:        nowRisk.toISOString(),
        };
        const saved = await saveRiskEngineState(this.riskState);
        if (!saved.ok) {
          this.riskDbOk = false; // fail-closed — 이번+다음 사이클 진입 차단
          console.error(`[AIWorker] ${saved.reason} — 신규 진입 차단`);
          riskEval = { ...riskEval, entryAllowed: false, blockReasons: [...riskEval.blockReasons, 'RiskEngine 상태 저장 실패 — fail-closed'] };
        } else {
          this.riskDbOk = true;
        }
      }
      this.lastRiskEvaluation = riskEval;
      const riskEntryAllowed = riskEval?.entryAllowed === true;

      const isLiveMode = process.env.WORKER_ENGINE_MODE === 'LIVE';
      // LIVE TEST verification: query GMX subgraph/RPC server-side using GMX_WALLET_ADDRESS.
      // This is the authoritative source — browser-posted diagnostics are NOT used for
      // safety-critical decisions (they are unauthenticated and can be spoofed).
      const liveTestData = isLiveMode
        ? await fetchServerLiveTestData()
        : { positionCount: 0, subgraphOk: true };  // PAPER mode — safety checks don't apply
      const walletSubgraphOk = liveTestData.subgraphOk;

      const engineResult = runAiEngine({
        cycleNumber:      cycleNum,
        prevState:        this.prevState,
        analyses,
        positions:        paperState.positions,
        account: {
          balance:          limits.tradingCapital,
          // reserveCash 차감은 stateEngine 내부에서 한 번만 수행됩니다.
          // 여기서 미리 차감하면 stateEngine이 다시 차감해 이중 공제가 됩니다.
          availableBalance: limits.tradingCapital,
          unrealizedPnl:    paperState.totalUnrealizedPnl,
          // §5 (6H-2): UNSETTLED 이익은 엔진 손익 입력에서 제외 — 미정산 이익이
          // 손실을 상쇄해 일일 손실 한도 발동을 지연시키는 것을 방지 (보수적).
          realizedPnlToday: paperState.realizedPnLTodayGated,
        },
        limits,
        engineState:              "RUNNING",
        consecutiveLosses:        paperState.consecutiveLosses,
        dataFreshMs,
        dailyRealizedPnlUsd:      paperState.realizedPnLTodayGated,
        weeklyRealizedPnlUsd:     paperState.realizedPnLWeeklyGated,
        rolling24hRealizedPnlUsd: paperState.realizedPnLRolling24h,
        tradingCapital:           limits.tradingCapital,
        accountDrawdownPct,
        // ── LIVE TEST MODE ────────────────────────────────────────────────
        isLiveMode,
        liveTestAccumLossUsd: paperState.liveTestAccumLossUsd,  // DB 기반, 재시작 후 자동 복원
        liveTestDbOk:         paperState.liveTestDbOk,           // false → stateEngine fail-closed
        walletSubgraphOk,  // false when stale, disconnected, or wrong-network
        // Server-authoritative on-chain position count (RPC → 999 fail-closed).
        // Never uses browser-posted data; see fetchServerLiveTestData() in gmx.ts.
        livePositionCount: liveTestData.positionCount,
        immediateEntryThreshold: riskProfile.derivedLimits.immediateEntryThreshold,
      });

      // ── RiskEngine 강제 (6H-1) — LONG/SHORT 결정 veto + 레버리지 클램프 ────
      // CLOSE_ALL_POSITIONS 액션 시 결정 유형과 무관하게 CASH로 강제 —
      // CASH는 하위 실행 경로(LIVE TEST 청산·자동 실행)에서 전량 청산을 트리거한다.
      if (riskEval?.actions.includes('CLOSE_ALL_POSITIONS') && engineResult.operatingState !== 'CASH') {
        const reasons = riskEval.blockReasons.join('; ') || 'RiskEngine 강제 청산';
        engineResult.operatingState = 'CASH';
        engineResult.riskApproved = false;
        engineResult.riskVetoReason = `[RISK_ENGINE] 강제 청산 — ${reasons}`;
        engineResult.sizeUsd = undefined;
        engineResult.leverage = undefined;
        console.warn(`[AIWorker] 사이클 #${cycleNum} RiskEngine CLOSE_ALL — ${reasons}`);

        // ── close-all orchestration 계획 (6H-2 §10) — 결정적 intent id 기반 ──
        // 실행은 CASH 하위 경로(LIVE TEST 청산·PAPER 청산)가 담당하고, 여기서는
        // 포지션 전수 기준 계획·요약만 수립한다. 전부 terminal 확인 전에는
        // lockRequired=true가 유지되어 신규 진입이 차단된다.
        try {
          const dayKey = manilaDayKey(new Date());
          const positionsForClose = paperState.positions.map((p, i) => ({
            positionKey: `${p.symbol}:${p.side}:${i}`,
            marketAddress: MARKET_BY_SYMBOL_SERVER.get(p.symbol)?.marketToken ?? '',
            isLong: p.side === 'LONG',
            sizeUsd: p.sizeInUsd,
          }));
          const plan = buildCloseAllPlan({ dayKey, positions: positionsForClose });
          if (plan.ok) {
            this.lastCloseAllSummary = summarizeCloseAll(
              plan.intents.map(it => ({ intentId: it.intentId, positionKey: it.positionKey, status: 'PENDING' as const })),
            );
          } else {
            // 계획 수립 불가 — 잠금 유지 요약 (fail-closed)
            this.lastCloseAllSummary = {
              total: 0, confirmed: 0, terminalFailed: 0, unresolved: 0, pending: 0,
              allTerminal: false, allConfirmed: false, lockRequired: true, rolloverAllowed: false,
            };
            console.error(`[AIWorker] close-all 계획 수립 실패 — ${plan.reason}`);
          }
        } catch (err) {
          console.error('[AIWorker] close-all 계획 오류:', err);
        }
      }
      if (engineResult.operatingState === 'LONG' || engineResult.operatingState === 'SHORT') {
        if (!riskEntryAllowed) {
          const reasons = riskEval?.blockReasons.join('; ') ?? 'RiskEngine 상태 미수립 (fail-closed)';
          engineResult.operatingState = 'CASH';
          engineResult.riskApproved = false;
          engineResult.riskVetoReason = `[RISK_ENGINE] ${reasons}`;
          engineResult.sizeUsd = undefined;
          engineResult.leverage = undefined;
          console.info(`[AIWorker] 사이클 #${cycleNum} RiskEngine veto — ${reasons}`);
        } else if (riskEval) {
          // 레버리지 클램프 (NORMAL 3x / DEFENSIVE 2x) + size factor
          if (typeof engineResult.leverage === 'number') {
            engineResult.leverage = Math.min(engineResult.leverage, riskEval.maxLeverage);
          }
          if (typeof engineResult.sizeUsd === 'number') {
            engineResult.sizeUsd = engineResult.sizeUsd * riskEval.sizeFactor;
          }

          // ── PAPER도 동일 사이징 엔진 사용 (6H-2 §3) — LIVE와 다른 크기 관용 금지 ──
          const paperMkt = engineResult.primarySymbol
            ? MARKET_BY_SYMBOL_SERVER.get(engineResult.primarySymbol) : undefined;
          if (typeof engineResult.sizeUsd === 'number' && engineResult.sizeUsd > 0 && paperMkt) {
            const nowSizing = new Date();
            const lev = typeof engineResult.leverage === 'number' ? Math.max(1, engineResult.leverage) : 1;
            const sizingCap = Math.min(limits.tradingCapital, RISK_POLICY.maxRiskCapitalUsd);
            const tierCap = sizingCap * riskEval.maxLeverage;

            // ── 6H-2A §3 — PAPER 비용은 공식 GMX read-only 추정(PAPER_GMX_ESTIMATE)만.
            // 확보 실패 시 PAPER도 진입 금지: NO_TRADE(COST_DATA_UNAVAILABLE).
            // 이전 quote fallback·고정 모델·zero-fee 대체 금지.
            const paperCostRes = await fetchPaperCostSnapshot(
              {
                market: paperMkt.marketToken,
                isLong: engineResult.operatingState === 'LONG',
                orderType: 'MarketIncrease',
                notionalUsd: engineResult.sizeUsd,
                now: nowSizing,
              },
              getPaperCostFetchers(),
            );
            if (!paperCostRes.ok) {
              this.lastPaperSizing = {
                at: nowSizing.toISOString(), ok: false,
                reason: `NO_TRADE: ${paperCostRes.reason}`,
                finalNotionalUsd: null, finalLeverage: null, allowedRiskUsd: null,
                clamped: false, clampDetails: [], estimatedRoundTripCostUsd: null,
                costSource: null,
              };
              engineResult.operatingState = 'CASH';
              engineResult.riskApproved = false;
              engineResult.riskVetoReason = `[RISK_ENGINE] NO_TRADE: ${COST_DATA_UNAVAILABLE} — ${paperCostRes.reason}`;
              engineResult.sizeUsd = undefined;
              engineResult.leverage = undefined;
              console.info(`[AIWorker] 사이클 #${cycleNum} PAPER 비용 미확보 — NO_TRADE (${paperCostRes.reason})`);
            } else {
            // 신선한 스냅샷을 캐시에 저장 — 거래 저장 시 비용 결속에 사용 (data.ts)
            storePaperCostSnapshot(engineResult.primarySymbol ?? '', paperCostRes.snapshot, nowSizing.getTime());
            const paperEnf = enforceOrderSizing({
              requestedSizeUsd: engineResult.sizeUsd,
              requestedCollateralUsd: engineResult.sizeUsd / lev,
              requestedLeverage: lev,
              positionSizingCapitalUsd: sizingCap,
              stopDistanceFraction: DEFAULT_STOP_DISTANCE_FRACTION,
              costSnapshot: paperCostRes.snapshot,
              // PAPER 시뮬 유동성 상한 = tier cap (명시적 시뮬레이션 정의 — LIVE에선 실측 필수)
              liquidityCapUsd: tierCap,
              tierNotionalCapUsd: tierCap,
              defensiveMode: riskEval.sizeFactor < 1,
              liveMode: false,
              canaryActive: false,
              expected: {
                market: paperMkt.marketToken,
                isLong: engineResult.operatingState === 'LONG',
                orderType: 'MarketIncrease',
              },
              now: nowSizing,
              riskBudgetPct: riskProfile.derivedLimits.maxRiskPerTradePct,
            });
            if (paperEnf.ok) {
              engineResult.sizeUsd = paperEnf.finalNotionalUsd;
              engineResult.leverage = paperEnf.finalLeverage;
              this.lastPaperSizing = {
                at: nowSizing.toISOString(), ok: true, reason: null,
                finalNotionalUsd: paperEnf.finalNotionalUsd,
                finalLeverage: paperEnf.finalLeverage,
                allowedRiskUsd: paperEnf.allowedRiskUsd,
                clamped: paperEnf.clamped, clampDetails: paperEnf.clampDetails,
                estimatedRoundTripCostUsd: paperEnf.estimatedRoundTripCostUsd,
                costSource: paperCostRes.snapshot.source,
              };
              if (paperEnf.clamped) {
                console.warn(`[AIWorker] 사이클 #${cycleNum} PAPER 사이징 clamp — ${paperEnf.clampDetails.join('; ')}`);
              }
            } else {
              // 사이징 엔진 거부 → 진입 자체 취소 (fail-closed)
              this.lastPaperSizing = {
                at: nowSizing.toISOString(), ok: false, reason: paperEnf.reason,
                finalNotionalUsd: null, finalLeverage: null, allowedRiskUsd: null,
                clamped: false, clampDetails: [], estimatedRoundTripCostUsd: null,
                costSource: paperCostRes.snapshot.source,
              };
              engineResult.operatingState = 'CASH';
              engineResult.riskApproved = false;
              engineResult.riskVetoReason = `[RISK_ENGINE] 사이징 거부 — ${paperEnf.reason}`;
              engineResult.sizeUsd = undefined;
              engineResult.leverage = undefined;
              console.info(`[AIWorker] 사이클 #${cycleNum} PAPER 사이징 거부 — ${paperEnf.reason}`);
            }
            } // paperCostRes.ok
          }
        }
      }

      // ── 6H-2A §5 — LIVE 정산 reconciliation (비치명 — 실패해도 Worker 생존) ──
      // UNSETTLED LIVE 거래가 있고 전부 SETTLED 전환하지 못하면 incomplete=true →
      // 아래 tryLiveTestExecution 호출부에서 신규 LIVE 진입이 차단된다.
      try {
        this.lastSettlementReconcile = await reconcileLiveSettlements(settlementEvidenceFetcher);
        if (this.lastSettlementReconcile.incomplete) {
          console.warn(`[AIWorker] 사이클 #${cycleNum} LIVE_SETTLEMENT_INCOMPLETE — 신규 LIVE 진입 차단 (${this.lastSettlementReconcile.reasons[0] ?? ''})`);
        }
      } catch (err) {
        // reconcileLiveSettlements는 예외를 던지지 않도록 설계됨 — 방어적 이중 안전망
        this.lastSettlementReconcile = {
          ok: false, unsettledCount: -1, settledNow: 0, incomplete: true,
          reasons: [`LIVE_SETTLEMENT_INCOMPLETE: 예외 — ${(err as Error).message}`],
        };
      }

      // LIVE TEST MODE: 상태 업데이트 + 누적 손실 캐시 갱신
      const testModeActive = Boolean(limits.liveTestMode && isLiveMode);
      this.lastLiveTestMode     = testModeActive;
      this.liveTestAccumLossUsd = paperState.liveTestAccumLossUsd;
      this.lastLiveTestDbOk     = paperState.liveTestDbOk;
      if (testModeActive) {
        const vetoPrefix = '[LIVE TEST]';
        const isTestVeto = engineResult.riskVetoReason?.startsWith(vetoPrefix);
        this.lastLiveTestVetoReason = isTestVeto ? (engineResult.riskVetoReason ?? null) : null;
      } else {
        this.lastLiveTestVetoReason = null;
      }

      // 상태 업데이트 — 청산 방향 판정을 위해 갱신 전 상태를 먼저 캡처
      this.prevState = engineResult.operatingState;

      // 전체 결정 객체 조립
      const decisionId = crypto.randomUUID();
      const decisionCreatedAt = new Date().toISOString();
      const strategyShadowExistingAi = {
        decisionId,
        action: engineResult.operatingState === 'LONG' ? 'LONG' as const
          : engineResult.operatingState === 'SHORT' ? 'SHORT' as const : 'NO_TRADE' as const,
        confidence: engineResult.confidence,
        primarySymbol: typeof engineResult.primarySymbol === 'string'
          && engineResult.primarySymbol.trim() ? engineResult.primarySymbol : null,
        createdAt: decisionCreatedAt,
      };
      let strategyEnsembleShadow = buildStrategyShadowWorkerEnvelope({
        cycleNumber: cycleNum,
        generatedAt: Date.parse(decisionCreatedAt),
        expectedSymbols: analyses.map(analysis => analysis.symbol),
        records: [],
        existingAi: strategyShadowExistingAi,
        lifecycleSnapshot: this.strategyLifecycleSnapshot,
        notEvaluatedReason: this.strategyLifecycleRestoreBlocked
          ? 'SHADOW lifecycle 이전 상태 복원 실패 — 외부 read 미제출·fail-closed'
          : 'MTF Strategy Ensemble read 시작 전 — SHADOW 결과 없음',
      });
      if (!this.strategyLifecycleRestoreBlocked && this.strategyLifecycleSnapshot !== null) {
        try {
          strategyEnsembleShadow = await runStrategyShadowWorkerReadOnly({
            cycleNumber: cycleNum,
            evaluatedAt: Date.parse(decisionCreatedAt),
            expectedSymbols: analyses.map(analysis => analysis.symbol),
            existingAi: strategyShadowExistingAi,
            lifecycleSnapshot: this.strategyLifecycleSnapshot,
          });
        } catch (error) {
          // service 자체도 fail-closed지만 Worker 생존을 위한 방어적 이중 안전망.
          console.warn(`[AIWorker] 사이클 #${cycleNum} MTF SHADOW read 실패 — NOT_EVALUATED 유지: ${error instanceof Error ? error.name : 'unknown'}`);
        }
      }
      let nextStrategyLifecycleSnapshot = this.strategyLifecycleSnapshot;
      if (!this.strategyLifecycleRestoreBlocked && this.strategyLifecycleSnapshot !== null) {
        const advanced = advanceStrategyShadowLifecycleSnapshot(
          this.strategyLifecycleSnapshot,
          strategyEnsembleShadow,
          Date.parse(decisionCreatedAt),
        );
        if (advanced) {
          nextStrategyLifecycleSnapshot = advanced;
          strategyEnsembleShadow = { ...strategyEnsembleShadow, lifecycleSnapshot: advanced };
        } else {
          strategyEnsembleShadow = buildStrategyShadowWorkerEnvelope({
            cycleNumber: cycleNum,
            generatedAt: Date.parse(decisionCreatedAt),
            expectedSymbols: analyses.map(analysis => analysis.symbol),
            records: [],
            existingAi: strategyShadowExistingAi,
            lifecycleSnapshot: this.strategyLifecycleSnapshot,
            notEvaluatedReason: 'SHADOW lifecycle snapshot 갱신 실패 — 평가 결과 미채택·fail-closed',
          });
        }
      }
      const strategyRiskAdvisory = buildStrategyRiskWorkerAdvisory({
        shadowEnvelope: strategyEnsembleShadow,
        riskEvaluation: riskEval,
      });
      const decision: ServerAiDecision = {
        id:          decisionId,
        createdAt:   decisionCreatedAt,
        paperExecuted: false,
        paperOrderId:  null,
        source:        "server_worker",
        testMode:      testModeActive,
        riskProfile,
        strategyEnsembleShadow,
        strategyRiskAdvisory,
        strategyDecisionExplainability: buildStrategyDecisionExplainabilityRuntimeAdvisory({
          shadowEnvelope: strategyEnsembleShadow,
          riskAdvisory: strategyRiskAdvisory,
          // The runtime cannot independently fetch or infer downstream evidence.
          // A later shared-readiness handoff may replace this explicit null.
          downstreamEvidence: null,
        }),
        ...engineResult,
      };

      // DB 저장 — 반드시 서버 PAPER 실행 '이전' (durable-intent-first).
      // 결정이 durable하게 기록된 후에만 실행을 허용해야, close-all 영속 write 실패 후
      // 크래시해도 재시작 reconciliation이 마지막 영속 결정(CASH/NO_TRADE)에서 의도를
      // 복원할 수 있다. 기록 실패 = 실행 불가 (fail-closed).
      const decisionPersisted = await this.persistDecision(decision);
      if (decisionPersisted && nextStrategyLifecycleSnapshot !== null) {
        // durable decision에 snapshot이 포함된 뒤에만 메모리 상태를 전진시킨다.
        this.strategyLifecycleSnapshot = nextStrategyLifecycleSnapshot;
      }

      // ── Task #111 — 서버 권위 PAPER 실행 (PAPER 모드 전용, LIVE/승인 경로와 분리) ──
      if (!isLiveMode && !testModeActive) {
        if (!decisionPersisted) {
          console.error(`[AIWorker] 사이클 #${cycleNum} 결정 영속 실패 — 서버 PAPER 실행 차단 (fail-closed)`);
        } else {
          try {
            await this.runServerPaperExecution(decision, paperState, riskEval, cycleNum);
            // 실행 결과(paperExecuted/paperOrderId)를 durable 기록에 반영
            if (decision.paperExecuted) await this.updateDecisionExecutionFlags(decision);
          } catch (err) {
            // 실행기 오류는 사이클을 중단하지 않는다 — OPEN은 내부적으로 fail-closed
            console.error(`[AIWorker] 사이클 #${cycleNum} 서버 PAPER 실행 오류:`, (err as Error).message);
          }
        }
      }

      // LIVE 모드: 승인 큐 추가 (PAPER 승인 흐름)
      const approvalCreated = await this.maybeCreateApproval(decision);

      // LIVE TEST 자율 실행 (운영자 반복 승인 없음 — 별도 실행 경로)
      if (testModeActive && isLiveMode) {
        void this.tryLiveTestExecution(
          decision, analyses, liveTestData, paperState, limits, cycleNum,
          {
            closeAllRequested: riskEval?.actions.includes('CLOSE_ALL_POSITIONS') === true,
            reduce70Requested: riskEval?.actions.includes('REDUCE_POSITION_70PCT') === true,
          },
        );
      }

      // ── 6I-1 §14 — Market Intelligence 사이클 (SHADOW_ONLY, 비치명 격리) ──
      // 주문 실행 경로를 호출하지 않는다. 실패해도 매매 루프에 영향 없음.
      void runIntelServiceCycle({
        cycleNum,
        gates: {
          riskEngineAllowsEntry: riskEval?.entryAllowed === true,
          riskEngineBlockReason: riskEval ? (riskEval.blockReasons[0] ?? null) : 'RiskEngine 평가 없음',
          openPositionExists: paperState.positions.length > 0,
          dailyEntryLimitReached:
            (limits.maxTradesPerHour ?? 0) > 0 && paperState.tradesInLastHour >= (limits.maxTradesPerHour ?? 0),
          nowMs: Date.now(),
        },
      });

      this.lastCycleAt = new Date();
      this.lastCycleResult = {
        cycleNumber:     cycleNum,
        at:              this.lastCycleAt.toISOString(),
        operatingState:  decision.operatingState,
        primarySymbol:   decision.primarySymbol,
        confidence:      decision.confidence,
        analysesCount:   analyses.length,
        approvalCreated,
      };

      console.info(
        `[AIWorker] 사이클 #${cycleNum} 완료 — ` +
        `${decision.operatingState} ${decision.primarySymbol ?? "MULTI"} ` +
        `conf=${decision.confidence}% ` +
        `(${Date.now() - cycleStartMs}ms)`,
      );

    } catch (err: unknown) {
      const msg = (err as Error).message ?? "Unknown error";
      console.error(`[AIWorker] 사이클 #${cycleNum} 오류:`, err);
      this.lastCycleResult = {
        cycleNumber:    cycleNum,
        at:             new Date().toISOString(),
        operatingState: "CASH",
        primarySymbol:  null,
        confidence:     0,
        analysesCount:  0,
        approvalCreated: false,
        error:          msg,
      };
    } finally {
      this.isRunning = false;
      // 완료 후 다음 사이클 예약 (setInterval이 아닌 재귀 setTimeout)
      if (this.active) {
        this.cycleTimer = setTimeout(() => void this.runCycle(), CYCLE_INTERVAL_MS);
      }
    }
  }

  // ── LIVE TEST 자율 실행 ────────────────────────────────────────────────────────

  /**
   * AI 결정이 LONG/SHORT일 때 LIVE TEST 실행 경로를 시도한다.
   * - 내부에서 liveTestGate를 모두 검증한 후 SubaccountRouter 주문 제출
   * - 잠금(LIVE_TEST_EXECUTION_LOCKED=true) 상태면 simulated=true 로그만 남김
   * - 오류는 삼켜서 워커 사이클 전체에 영향을 주지 않는다
   */
  private async tryLiveTestExecution(
    decision:     ServerAiDecision,
    analyses:     SymbolAnalysis[],
    liveTestData: { positionCount: number },
    paperState:   { liveTestAccumLossUsd: number; liveTestDbOk: boolean },
    limits:       RiskLimits,
    cycleNum:     number,
    /** 6H-2A §6·§8 — RiskEngine 액션 실배선 플래그 */
    riskActions: { closeAllRequested: boolean; reduce70Requested: boolean } =
      { closeAllRequested: false, reduce70Requested: false },
  ): Promise<void> {
    try {
      const { operatingState, primarySymbol } = decision;
      const mainAddress = process.env.GMX_WALLET_ADDRESS ?? '';
      // 자동 Worker의 모든 fund-moving LIVE action(OPEN/CLOSE/REDUCE)은 동일한
      // 명시적 opt-in 없이는 금지. Manual Canary는 이 메서드를 거치지 않는다.
      if (process.env.AUTO_WORKER_LIVE_ENABLED !== 'true') {
        console.info('[AIWorker] LIVE 자동 실행 차단 — AUTO_WORKER_LIVE_ENABLED ≠ true (OPEN/CLOSE/REDUCE 공통)');
        return;
      }

      // ── 6H-2A §8 — CLOSE_ALL 실배선: authoritative 포지션 전수 청산 ─────────
      // primarySymbol과 무관하게 실행 — 위험 액션은 특정 심볼 결정에 종속되지 않는다.
      // "CASH 표시만으로 완료 처리 금지" — 포지션별 실제 청산 시도 결과로
      // summarizeCloseAll을 갱신한다. 조회 실패 = lockRequired 유지 (fail-closed).
      if (riskActions.closeAllRequested && liveTestData.positionCount > 0) {
        await this.executeCloseAllPositions(decision, paperState, limits, cycleNum, mainAddress, analyses);
        return; // close-all 사이클에는 신규 진입 없음
      }

      // ── 6H-2A §6 — REDUCE_POSITION_70PCT 실배선: 부분 청산 실행 ─────────────
      if (riskActions.reduce70Requested && liveTestData.positionCount > 0) {
        await this.executeProfitProtectReduction(decision, paperState, limits, cycleNum, mainAddress, analyses);
        return; // 축소 사이클에는 신규 진입 없음
      }

      // ── CASH 신호 + 열린 포지션 → authoritative snapshot 기반 전수 청산 ─────
      // 고정 $15/직전 방향 추정 금지 — 정확한 포지션 크기·방향으로 reduce-only.
      if (operatingState === 'CASH' && liveTestData.positionCount > 0) {
        await this.executeCloseAllPositions(decision, paperState, limits, cycleNum, mainAddress, analyses);
        return;
      }

      if (!primarySymbol) return;

      const market = MARKET_BY_SYMBOL_SERVER.get(primarySymbol);
      if (!market) return;

      const currentAnalysis = analyses.find(a => a.symbol === primarySymbol);
      const currentPrice    = currentAnalysis?.price ?? 0;
      if (currentPrice <= 0) return;

      if (operatingState === 'LONG' || operatingState === 'SHORT') {
        // ── 6H-2A §5 — 정산 미완료 동안 신규 LIVE 진입 차단 (청산은 허용) ──
        const rec = this.lastSettlementReconcile;
        if (!rec || rec.incomplete) {
          console.warn(`[AIWorker] LIVE TEST OPEN 차단 — LIVE_SETTLEMENT_INCOMPLETE (${rec?.reasons[0] ?? 'reconciliation 미실행'})`);
          return;
        }
        // 레버리지: stateEngine 값 존재 시 사용, 없으면 1x (LIVE TEST 하드캡 2x 적용)
        const rawLeverage   = decision.leverage ?? 1;
        const leverage      = Math.max(1, Math.min(rawLeverage, LIVE_TEST_CAPS.maxLeverage));
        // 담보: tradingCapital을 레버리지로 나눈 값, $15 하드캡 이내
        const collateralUsd = Math.min(limits.tradingCapital, LIVE_TEST_CAPS.maxCapitalUsd / leverage);
        const sizeUsd       = Math.min(collateralUsd * leverage, LIVE_TEST_CAPS.maxCapitalUsd);

        // ── §8 진입 전 stop 계약 — trigger 계산 불가면 OPEN 자체를 시도하지 않음 ──
        const stopPlan = computeStopTrigger({
          entryPriceUsd: currentPrice,
          isLong: operatingState === 'LONG',
        });
        if (!stopPlan.ok) {
          console.warn(`[AIWorker] LIVE TEST OPEN 취소 — ${stopPlan.reason}`);
          return;
        }

        // ── §3·§4 서버 사이징 컨텍스트 — 비용 스냅샷은 LIVE 조회 필수(fail-closed).
        // 실측 비용/유동성 조회 경로가 미배선인 동안 executor의 사이징 강제가
        // COST_DATA_UNAVAILABLE로 실제 제출을 차단한다 (가짜 성공·고정 fallback 금지).
        const costRes = await fetchLiveCostSnapshot(
          {
            market: market.marketToken, isLong: operatingState === 'LONG',
            orderType: 'MarketIncrease', notionalUsd: sizeUsd, now: new Date(),
          },
          { readonlyEnabled: process.env.GMX_API_READONLY_ENABLED === 'true' },
        );
        const sizingContext = {
          positionSizingCapitalUsd: Math.min(limits.tradingCapital, RISK_POLICY.maxRiskCapitalUsd),
          stopDistanceFraction: stopPlan.plan.stopDistanceFraction,
          costSnapshot: costRes.ok ? costRes.snapshot : null,
          liquidityCapUsd: null as number | null, // 실측 유동성 조회 미배선 — fail-closed
          tierNotionalCapUsd: LIVE_TEST_CAPS.maxCapitalUsd,
          defensiveMode: this.lastRiskEvaluation?.sizeFactor != null && this.lastRiskEvaluation.sizeFactor < 1,
          canaryActive: true, // LIVE TEST = Canary 하드캡 우선순위 적용 (§11)
            riskBudgetPct: decision.riskProfile.derivedLimits.maxRiskPerTradePct,
        };

        const result = await executeLiveTestOrder({
          decisionId:        decision.id,
          riskProfileSnapshot: decision.riskProfile,
          cycleNumber:       cycleNum,
          symbol:            primarySymbol,
          marketAddress:     market.marketToken,
          isLong:            operatingState === 'LONG',
          sizeUsd,
          collateralUsd,
          leverage,
          currentPriceUsd:   currentPrice,
          mainAddress,
          accumLossUsd:      paperState.liveTestAccumLossUsd,
          dbOk:              paperState.liveTestDbOk,
          openPositionCount: liveTestData.positionCount,
          liveTestMode:      Boolean(limits.liveTestMode),
          sizingContext,
        });

        if (result.simulated) {
          console.info(`[AIWorker] LIVE TEST 시뮬레이션 (잠금) — ${operatingState} ${primarySymbol}`);
        } else if (result.ok) {
          console.info(
            `[AIWorker] LIVE TEST 주문 제출 — ${operatingState} ${primarySymbol} ` +
            `size=$${sizeUsd.toFixed(2)} txHash=${result.txHash}`,
          );
          // 제출 수락 → durable UNSETTLED 기록 (reconciliation 대상)
          await this.recordLiveTradeUnsettled({
            symbol: primarySymbol, action: 'OPEN', isLong: operatingState === 'LONG',
            sizeUsd, priceUsd: currentPrice, marketAddress: market.marketToken,
            leverage, collateralUsd,
          });
        }
      }
    } catch (err: unknown) {
      // LIVE TEST 실행 오류는 워커 사이클 전체에 전파하지 않는다 (fail-silent)
      console.error(`[AIWorker] LIVE TEST 실행 오류 (cycle #${cycleNum}):`, err);
    }
  }

  /**
   * 6H-2A 리뷰 반영 — LIVE 제출 수락 시 durable UNSETTLED trade 행 기록.
   * reconciliation은 이 행을 대상으로 actual fee/PnL을 확보한다.
   * 저장 실패 = lastSettlementReconcile을 incomplete로 강제해 신규 OPEN 차단 (fail-closed).
   */
  private async recordLiveTradeUnsettled(args: {
    symbol: string; action: 'OPEN' | 'CLOSE'; isLong: boolean;
    sizeUsd: number; priceUsd: number; marketAddress: string;
    leverage?: number; collateralUsd?: number;
  }): Promise<void> {
    try {
      const now = new Date();
      await db.insert(tradesTable).values({
        id: crypto.randomUUID(),
        symbol: args.symbol,
        side: args.isLong ? 'LONG' : 'SHORT',
        action: args.action,
        size: String(args.priceUsd > 0 ? args.sizeUsd / args.priceUsd : 0),
        price: String(args.priceUsd),
        pnl: '0',
        strategy: 'LIVE_TEST_EXECUTOR',
        timestamp: now,
        closeTime: args.action === 'CLOSE' ? now.getTime() : 0,
        gmxMarketAddress: args.marketAddress,
        sizeInUsd: String(args.sizeUsd),
        leverage: args.leverage != null ? String(args.leverage) : null,
        collateralUsd: args.collateralUsd != null ? String(args.collateralUsd) : null,
        testMode: true,
        settlementStatus: 'UNSETTLED', // actual fee 증거 확보 전까지 이익 목표 미반영
      });
    } catch (err) {
      console.error('[AIWorker] LIVE UNSETTLED trade 기록 실패 — 신규 OPEN 차단 (fail-closed):', err);
      this.lastSettlementReconcile = {
        ok: false, unsettledCount: -1, settledNow: 0, incomplete: true,
        reasons: ['LIVE_SETTLEMENT_INCOMPLETE: UNSETTLED trade 기록 실패 — DB 확인 필요'],
      };
    }
  }

  /** worker_state 'profitProtectRecordsV1' — 70% 축소 durable 기록 로드 (실패=null) */
  private async loadProfitProtectRecords(): Promise<Record<string, ProfitProtectRecord> | null> {
    try {
      const rows = await db.select().from(workerStateTable)
        .where(eq(workerStateTable.key, 'profitProtectRecordsV1')).limit(1);
      if (rows.length === 0) return {};
      return JSON.parse(rows[0].value) as Record<string, ProfitProtectRecord>;
    } catch (err) {
      console.error('[AIWorker] profitProtectRecordsV1 로드 실패:', err);
      return null;
    }
  }

  /** worker_state 'profitProtectRecordsV1' 저장 — 실패 시 false (호출측 fail-closed) */
  private async saveProfitProtectRecords(records: Record<string, ProfitProtectRecord>): Promise<boolean> {
    try {
      await db.insert(workerStateTable)
        .values({ key: 'profitProtectRecordsV1', value: JSON.stringify(records), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: workerStateTable.key,
          set: { value: JSON.stringify(records), updatedAt: new Date() },
        });
      return true;
    } catch (err) {
      console.error('[AIWorker] profitProtectRecordsV1 저장 실패:', err);
      return false;
    }
  }

  /** marketAddress → 심볼 역조회 (대소문자 무시) — 미등록 시장 = null */
  private symbolForMarket(marketAddress: string): string | null {
    for (const [sym, m] of MARKET_BY_SYMBOL_SERVER) {
      if (m.marketToken.toLowerCase() === marketAddress.toLowerCase()) return sym;
    }
    return null;
  }

  /**
   * 6H-2A §8 — CLOSE_ALL 실배선.
   * authoritative(온체인/공식) 포지션 전수 조회 → 포지션별 closeLiveTestPosition
   * 실제 시도 → 실제 결과로 summarizeCloseAll 갱신. 조회 실패·부분 실패 =
   * lockRequired 유지 (fail-closed). "CASH 표시"만으로는 완료 처리하지 않는다.
   */
  private async executeCloseAllPositions(
    decision: ServerAiDecision,
    paperState: { liveTestAccumLossUsd: number; liveTestDbOk: boolean },
    limits: RiskLimits,
    cycleNum: number,
    mainAddress: string,
    analyses: SymbolAnalysis[],
  ): Promise<void> {
    const positions = await fetchAuthoritativeOpenPositions();
    if (positions === null) {
      // 조회 실패 — 계획조차 수립 불가 → 잠금 유지 요약 (fail-closed)
      this.lastCloseAllSummary = {
        total: 0, confirmed: 0, terminalFailed: 0, unresolved: 0, pending: 0,
        allTerminal: false, allConfirmed: false, lockRequired: true, rolloverAllowed: false,
      };
      console.error('[AIWorker] CLOSE_ALL — authoritative 포지션 조회 실패, 잠금 유지 (fail-closed)');
      return;
    }
    const dayKey = manilaDayKey(new Date());
    const plan = buildCloseAllPlan({
      dayKey,
      positions: positions.map((p, i) => ({
        positionKey: `${p.marketAddress.toLowerCase()}:${p.isLong ? 'LONG' : 'SHORT'}:${i}`,
        marketAddress: p.marketAddress, isLong: p.isLong, sizeUsd: p.sizeUsd,
      })),
    });
    if (!plan.ok) {
      this.lastCloseAllSummary = {
        total: 0, confirmed: 0, terminalFailed: 0, unresolved: 0, pending: 0,
        allTerminal: false, allConfirmed: false, lockRequired: true, rolloverAllowed: false,
      };
      console.error(`[AIWorker] CLOSE_ALL 계획 수립 실패 — ${plan.reason} (잠금 유지)`);
      return;
    }
    const progress: { intentId: string; positionKey: string; status: 'PENDING' | 'SUBMITTED' | 'FAILED' | 'UNRESOLVED' }[] = [];
    for (const intent of plan.intents) {
      const symbol = this.symbolForMarket(intent.marketAddress);
      const price = symbol ? (analyses.find(a => a.symbol === symbol)?.price ?? 0) : 0;
      if (!symbol || price <= 0) {
        progress.push({ intentId: intent.intentId, positionKey: intent.positionKey, status: 'FAILED' });
        console.error(`[AIWorker] CLOSE_ALL — 시장/가격 미확인 (${intent.marketAddress}) → FAILED 기록`);
        continue;
      }
      const result = await closeLiveTestPosition({
        decisionId: `${decision.id}:closeall:${intent.positionKey}`,
        riskProfileSnapshot: decision.riskProfile,
        cycleNumber: cycleNum, symbol,
        marketAddress: intent.marketAddress, isLong: intent.isLong,
        sizeUsd: intent.closeSizeUsd, currentPriceUsd: price, mainAddress,
        accumLossUsd: paperState.liveTestAccumLossUsd, dbOk: paperState.liveTestDbOk,
        liveTestMode: Boolean(limits.liveTestMode),
      });
      // 실제 결과 기반 상태 — 제출 수락=SUBMITTED(온체인 확정은 reconciler),
      // 시뮬(잠금)=PENDING(실주문 미제출 — 완료로 간주 금지), 실패=FAILED.
      progress.push({
        intentId: intent.intentId, positionKey: intent.positionKey,
        status: result.simulated ? 'PENDING' : result.ok ? 'SUBMITTED' : 'FAILED',
      });
      // CLOSE durable UNSETTLED 행은 closeLiveTestPosition이 제출 전에 intent와
      // 원자적으로 생성한다. 여기서 legacy 행을 추가하면 미결속 중복이 생긴다.
    }
    this.lastCloseAllSummary = summarizeCloseAll(progress);
    console.warn(
      `[AIWorker] CLOSE_ALL 실행 — 대상 ${plan.intents.length}건, ` +
      `제출 ${progress.filter(p => p.status === 'SUBMITTED').length}건, ` +
      `실패 ${progress.filter(p => p.status === 'FAILED').length}건, lockRequired=${this.lastCloseAllSummary.lockRequired}`,
    );
  }

  /**
   * 6H-2A §6 — REDUCE_POSITION_70PCT 실배선.
   * authoritative 포지션 조회 → computeReduction(보수적 내림, 70% 초과 금지,
   * 잔여<최소면 100% 종료) → closeLiveTestPosition 부분 청산. 조회/계산 실패 =
   * 실행 0회 (fail-closed).
   */
  private async executeProfitProtectReduction(
    decision: ServerAiDecision,
    paperState: { liveTestAccumLossUsd: number; liveTestDbOk: boolean },
    limits: RiskLimits,
    cycleNum: number,
    mainAddress: string,
    analyses: SymbolAnalysis[],
  ): Promise<void> {
    const positions = await fetchAuthoritativeOpenPositions();
    if (positions === null || positions.length === 0) {
      console.error('[AIWorker] REDUCE_70PCT — authoritative 포지션 조회 실패/없음, 실행 0회 (fail-closed)');
      return;
    }
    // ── durable idempotency — 동일 포지션/거래일 재축소 금지 (재시작 내구성) ──
    const records = await this.loadProfitProtectRecords();
    if (records === null) {
      console.error('[AIWorker] REDUCE_70PCT — 축소 기록 로드 실패, 실행 0회 (fail-closed, 중복 제출 방지 불가 상태)');
      return;
    }
    const dayKey = manilaDayKey(new Date());
    for (const p of positions) {
      const positionKey = `${p.marketAddress.toLowerCase()}:${p.isLong ? 'LONG' : 'SHORT'}`;
      const idempotencyKey = buildProfitProtectKey(dayKey, positionKey);
      const gate = canExecuteReduction(records[idempotencyKey]);
      if (!gate.ok) {
        console.warn(`[AIWorker] REDUCE_70PCT 재제출 차단 — ${gate.reason}`);
        continue;
      }
      const reduction = computeReduction({
        openSizeUsd: p.sizeUsd,
        minPositionNotionalUsd: GMX_MIN_POSITION_NOTIONAL_USD,
      });
      if (!reduction.ok) {
        console.error(`[AIWorker] REDUCE_70PCT 계산 거부 (${p.marketAddress}) — ${reduction.reason}`);
        continue;
      }
      const symbol = this.symbolForMarket(p.marketAddress);
      const price = symbol ? (analyses.find(a => a.symbol === symbol)?.price ?? 0) : 0;
      if (!symbol || price <= 0) {
        console.error(`[AIWorker] REDUCE_70PCT — 시장/가격 미확인 (${p.marketAddress}), 해당 포지션 건너뜀 (fail-closed)`);
        continue;
      }
      // 제출 "전" 예약 영속화 — 저장 실패 시 제출하지 않음 (중복 제출 방지 우선)
      const nowIso = new Date().toISOString();
      records[idempotencyKey] = {
        idempotencyKey, positionKey, dayKey,
        reduceSizeUsd: reduction.reduceSizeUsd, fullClose: reduction.fullClose,
        status: 'UNRESOLVED', orderKey: null, createdAt: nowIso, updatedAt: nowIso,
      };
      if (!(await this.saveProfitProtectRecords(records))) {
        console.error('[AIWorker] REDUCE_70PCT — 예약 저장 실패, 해당 포지션 제출 취소 (fail-closed)');
        delete records[idempotencyKey];
        continue;
      }
      const result = await closeLiveTestPosition({
        decisionId: idempotencyKey,
        riskProfileSnapshot: decision.riskProfile,
        cycleNumber: cycleNum, symbol,
        marketAddress: p.marketAddress, isLong: p.isLong,
        sizeUsd: reduction.reduceSizeUsd, currentPriceUsd: price, mainAddress,
        accumLossUsd: paperState.liveTestAccumLossUsd, dbOk: paperState.liveTestDbOk,
        liveTestMode: Boolean(limits.liveTestMode),
      });
      // 결과 반영 — 시뮬(잠금)=실주문 미제출이므로 예약 해제(CANCELLED가 아닌 삭제),
      // 제출 수락=SUBMITTED, 실패=FAILED(재제출 금지 유지·신규 진입 차단 상태).
      if (result.simulated) {
        delete records[idempotencyKey];
      } else {
        records[idempotencyKey] = {
          ...records[idempotencyKey],
          status: result.ok ? 'SUBMITTED' : 'FAILED',
          orderKey: result.orderKey ?? null,
          updatedAt: new Date().toISOString(),
        };
      }
      await this.saveProfitProtectRecords(records); // 상태 갱신 실패 = 예약(UNRESOLVED) 유지 → 재제출 계속 차단
      console.warn(
        `[AIWorker] REDUCE_70PCT — ${symbol} ${reduction.fullClose ? '100% 종료(잔여<최소)' : `$${reduction.reduceSizeUsd.toFixed(2)} 축소`} ` +
        `→ ${result.simulated ? '시뮬레이션(잠금)' : result.ok ? '제출' : `실패(${result.error ?? ''})`}`,
      );
    }
  }
}

// ── Singleton 인스턴스 ─────────────────────────────────────────────────────────
export const workerManager = new WorkerManager();

/** 현재 워커 상태 스냅샷 (읽기 전용) — 라우트에서 사용 */
export function getWorkerStatus(): WorkerStatus {
  return workerManager.getStatus();
}
