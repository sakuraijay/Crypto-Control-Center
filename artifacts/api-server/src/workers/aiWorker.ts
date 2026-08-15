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

import { db, aiDecisionsTable, liveApprovalsTable } from "@workspace/db";
import { and, eq, lt } from "drizzle-orm";
import { computeIndicators, computeScores } from "./indicators";
import { runAiEngine } from "./stateEngine";
import { getCachedPrices, getCachedChange24h, ensureGmxPoller } from "../routes/gmx";
import type { AiOperatingState, RiskLimits, SymbolAnalysis, ServerAiDecision } from "./serverTypes";

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
      workerRunning:   this.isRunning,
      lastCycleAt:     this.lastCycleAt?.toISOString() ?? null,
      lastCycleResult: this.lastCycleResult,
      cycleCount:      this.cycleCount,
    };
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
      });

      this.pendingApprovalKeys.add(key);
      console.info(`[AIWorker] LIVE 승인 생성: ${key} (id=${id})`);
      return true;
    } catch (err) {
      console.error("[AIWorker] live_approval INSERT 실패:", err);
      return false;
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

      const engineResult = runAiEngine({
        cycleNumber:      cycleNum,
        prevState:        this.prevState,
        analyses,
        positions:        [],   // 서버는 온체인 포지션 없음
        account: {
          balance:           DEFAULT_LIMITS.tradingCapital,
          availableBalance:  DEFAULT_LIMITS.tradingCapital * (1 - DEFAULT_LIMITS.reserveCashPct / 100),
          unrealizedPnl:     0,
          realizedPnlToday:  0,
        },
        limits:           DEFAULT_LIMITS,
        engineState:      "RUNNING",
        consecutiveLosses: 0,
        dataFreshMs,
        dailyRealizedPnlUsd: 0,
        tradingCapital:   DEFAULT_LIMITS.tradingCapital,
      });

      // 상태 업데이트
      this.prevState = engineResult.operatingState;

      // 전체 결정 객체 조립
      const decision: ServerAiDecision = {
        id:          crypto.randomUUID(),
        createdAt:   new Date().toISOString(),
        paperExecuted: false,
        paperOrderId:  null,
        source:        "server_worker",
        ...engineResult,
      };

      // DB 저장
      await this.persistDecision(decision);

      // LIVE 모드: 승인 큐 추가
      const approvalCreated = await this.maybeCreateApproval(decision);

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
}

// ── Singleton 인스턴스 ─────────────────────────────────────────────────────────
export const workerManager = new WorkerManager();
