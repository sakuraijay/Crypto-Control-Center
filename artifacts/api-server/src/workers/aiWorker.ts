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
import { and, desc, eq, lt } from "drizzle-orm";
import { computeIndicators, computeScores } from "./indicators";
import { runAiEngine } from "./stateEngine";
import { getCachedPrices, getCachedChange24h, ensureGmxPoller } from "../routes/gmx";
import { fetchServerLiveTestData } from "../routes/gmx";
import type { AiOperatingState, RiskLimits, SymbolAnalysis, ServerAiDecision } from "./serverTypes";
import { executeLiveTestOrder, closeLiveTestPosition } from "./liveTestExecutor";
import { LIVE_TEST_CAPS } from "../lib/liveTestGate";
import { MARKET_BY_SYMBOL_SERVER } from "../lib/gmxMarkets";

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
 * 기본 리스크 한도
 * DB에 전략 설정이 없을 때 사용하는 보수적 기본값.
 */
const DEFAULT_LIMITS: RiskLimits = {
  dailyLossLimitUSDT:       500,
  maxDrawdownPercent:        10,
  consecutiveLossLimit:       3,
  maxLeverage:                5,
  maxMarginPerTrade:        200,
  maxTotalExposureUSDT:    2000,
  tradingCapital:         10_000,
  reserveCashPct:            20,
  profitLockThresholdPct:     1,
  maxSimultaneousPositions:   3,
  maxRiskPerSymbolPct:       10,
  weeklyLossLimitUSDT:     1500,
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

  // ── LIVE TEST MODE class fields ─────────────────────────────────────────────
  /** Accumulated LIVE TEST losses persisted in worker_state DB */
  private liveTestAccumLossUsd: number = 0;
  /** Reason the most recent LIVE TEST hardcap blocked a trade (null = no block) */
  private lastLiveTestVetoReason: string | null = null;
  /** Whether liveTestMode was active in the last cycle */
  private lastLiveTestMode: boolean = false;
  /** Whether the liveTestAccumLossUsd DB query succeeded in the last cycle */
  private lastLiveTestDbOk: boolean = true;
  // ────────────────────────────────────────────────────────────────────────────

  /** 심볼별 가격 히스토리 버퍼 */
  private priceBuffer = new Map<string, number[]>();

  /** 마지막 가격 업데이트 시각 (dataFreshMs 계산용) */
  private lastPriceAt: number = 0;

  /** 가격 폴링 타이머 */
  private pricePollTimer: ReturnType<typeof setInterval> | null = null;

  /** 사이클 타이머 */
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;

  /** 워커 루프 활성 여부 */
  private active = false;

  /**
   * PENDING live_approvals 중복 방지 세트.
   * 키 형식: "symbol:operatingState" (예: "BTC:LONG")
   */
  private pendingApprovalKeys = new Set<string>();

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

    // 가격 버퍼 폴링 시작 (10s 간격)
    this.updatePriceBuffers(); // 즉시 첫 실행
    this.pricePollTimer = setInterval(() => this.updatePriceBuffers(), 10_000);

    // 초기 지연 후 사이클 시작 (가격 히스토리 축적 대기)
    this.cycleTimer = setTimeout(() => void this.runCycle(), INITIAL_DELAY_MS);

    console.info('[AIWorker] 시작 — 60초 AI 사이클, 10초 가격 폴링');
  }

  stop(): void {
    this.active = false;
    if (this.pricePollTimer) { clearInterval(this.pricePollTimer); this.pricePollTimer = null; }
    if (this.cycleTimer)    { clearTimeout(this.cycleTimer);       this.cycleTimer    = null; }
    console.info('[AIWorker] 정지');
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
    };
  }

  // ── Equity HWM persistence ───────────────────────────────────────────────────

  /**
   * 서버 재시작 시 DB에서 equity HWM을 복구합니다.
   * 복구 성공 시 첫 사이클부터 maxDrawdown 강제가 즉시 적용됩니다.
   */
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

    this.lastPriceAt = Date.now();

    for (const tick of prices) {
      const sym = tick.tokenSymbol;
      if (!WORKER_SYMBOLS.includes(sym)) continue;
      if (tick.priceUsd <= 0) continue;

      const buf = this.priceBuffer.get(sym) ?? [];
      buf.push(tick.priceUsd);
      if (buf.length > MAX_PRICE_HISTORY) buf.shift();
      this.priceBuffer.set(sym, buf);
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

  /** 결정을 ai_decisions 테이블에 저장한다. */
  private async persistDecision(decision: ServerAiDecision): Promise<void> {
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
    } catch (err) {
      console.error("[AIWorker] persistDecision 실패:", err);
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
      return { ...DEFAULT_LIMITS, ...raw };
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
  }> {
    const ZEROS = {
      realizedPnLToday: 0, realizedPnLRolling24h: 0, realizedPnLWeekly: 0,
      totalRealizedPnlAllTime: 0,
      consecutiveLosses: 0, positions: [],
      tradesInLastHour: 0, lastOpenTradeTimestampMs: null, totalUnrealizedPnl: 0,
      liveTestAccumLossUsd: 0, liveTestDbOk: false,  // false = DB 실패 → fail-closed
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

      let realizedPnLToday         = 0;
      let realizedPnLRolling24h    = 0;
      let realizedPnLWeekly        = 0;
      let totalRealizedPnlAllTime  = 0;

      for (const t of closeTrades) {
        const ts  = new Date(t.timestamp as string | Date).getTime();
        const pnl = parseFloat(t.pnl ?? '0') || 0;
        totalRealizedPnlAllTime  += pnl;                                    // 전체 누적
        if (ts >= todayStart.getTime())      realizedPnLToday      += pnl;
        if (ts >= rolling24hStart.getTime()) realizedPnLRolling24h += pnl;
        if (ts >= weekStart.getTime())       realizedPnLWeekly     += pnl;
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
        totalRealizedPnlAllTime,
        consecutiveLosses, positions,
        tradesInLastHour, lastOpenTradeTimestampMs, totalUnrealizedPnl,
        liveTestAccumLossUsd,
        liveTestDbOk: true,
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

      // ── 사용자 설정 + PAPER 운용 상태를 DB에서 로드 ────────────────────────────
      // ⚠️ LIVE 실제 계정 데이터와 절대 혼합하지 않음 (지갑 미연결 = PAPER 데이터 전용)
      const [limits, paperState] = await Promise.all([
        this.loadStrategyLimits(),
        this.loadPaperState(),
      ]);

      // 이번 사이클에 사용된 설정 저장 (상태 엔드포인트 노출용)
      this.lastLimitsUsed = limits;

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
          realizedPnlToday: paperState.realizedPnLToday,
        },
        limits,
        engineState:              "RUNNING",
        consecutiveLosses:        paperState.consecutiveLosses,
        dataFreshMs,
        dailyRealizedPnlUsd:      paperState.realizedPnLToday,
        weeklyRealizedPnlUsd:     paperState.realizedPnLWeekly,
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
      });

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

      // 상태 업데이트
      this.prevState = engineResult.operatingState;

      // 전체 결정 객체 조립
      const decision: ServerAiDecision = {
        id:          crypto.randomUUID(),
        createdAt:   new Date().toISOString(),
        paperExecuted: false,
        paperOrderId:  null,
        source:        "server_worker",
        testMode:      testModeActive,
        ...engineResult,
      };

      // DB 저장
      await this.persistDecision(decision);

      // LIVE 모드: 승인 큐 추가 (PAPER 승인 흐름)
      const approvalCreated = await this.maybeCreateApproval(decision);

      // LIVE TEST 자율 실행 (운영자 반복 승인 없음 — 별도 실행 경로)
      if (testModeActive && isLiveMode) {
        void this.tryLiveTestExecution(decision, analyses, liveTestData, paperState, limits, cycleNum);
      }

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
  ): Promise<void> {
    try {
      const { operatingState, primarySymbol } = decision;
      if (!primarySymbol) return;

      const market = MARKET_BY_SYMBOL_SERVER.get(primarySymbol);
      if (!market) return;

      const currentAnalysis = analyses.find(a => a.symbol === primarySymbol);
      const currentPrice    = currentAnalysis?.price ?? 0;
      if (currentPrice <= 0) return;

      const mainAddress = process.env.GMX_WALLET_ADDRESS ?? '';

      if (operatingState === 'LONG' || operatingState === 'SHORT') {
        // 레버리지: stateEngine 값 존재 시 사용, 없으면 1x (LIVE TEST 하드캡 2x 적용)
        const rawLeverage   = decision.leverage ?? 1;
        const leverage      = Math.max(1, Math.min(rawLeverage, LIVE_TEST_CAPS.maxLeverage));
        // 담보: tradingCapital을 레버리지로 나눈 값, $15 하드캡 이내
        const collateralUsd = Math.min(limits.tradingCapital, LIVE_TEST_CAPS.maxCapitalUsd / leverage);
        const sizeUsd       = Math.min(collateralUsd * leverage, LIVE_TEST_CAPS.maxCapitalUsd);

        const result = await executeLiveTestOrder({
          decisionId:        decision.id,
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
        });

        if (result.simulated) {
          console.info(`[AIWorker] LIVE TEST 시뮬레이션 (잠금) — ${operatingState} ${primarySymbol}`);
        } else {
          console.info(
            `[AIWorker] LIVE TEST 주문 제출 — ${operatingState} ${primarySymbol} ` +
            `size=$${sizeUsd.toFixed(2)} txHash=${result.txHash}`,
          );
        }
      } else if (operatingState === 'CASH' && liveTestData.positionCount > 0) {
        // CASH 신호 + 열린 포지션 존재 → 직전 방향 기준으로 청산 시도
        const prevIsLong = this.prevState === 'LONG';

        const result = await closeLiveTestPosition({
          decisionId:      decision.id,
          cycleNumber:     cycleNum,
          symbol:          primarySymbol,
          marketAddress:   market.marketToken,
          isLong:          prevIsLong,
          sizeUsd:         LIVE_TEST_CAPS.maxCapitalUsd, // GMX가 포지션 크기로 자동 조정
          currentPriceUsd: currentPrice,
          mainAddress,
          accumLossUsd:    paperState.liveTestAccumLossUsd,
          dbOk:            paperState.liveTestDbOk,
        });

        if (result.simulated) {
          console.info(`[AIWorker] LIVE TEST 청산 시뮬레이션 (잠금) — ${primarySymbol}`);
        } else {
          console.info(
            `[AIWorker] LIVE TEST 청산 제출 — ${primarySymbol} txHash=${result.txHash}`,
          );
        }
      }
    } catch (err: unknown) {
      // LIVE TEST 실행 오류는 워커 사이클 전체에 전파하지 않는다 (fail-silent)
      console.error(`[AIWorker] LIVE TEST 실행 오류 (cycle #${cycleNum}):`, err);
    }
  }
}

// ── Singleton 인스턴스 ─────────────────────────────────────────────────────────
export const workerManager = new WorkerManager();
