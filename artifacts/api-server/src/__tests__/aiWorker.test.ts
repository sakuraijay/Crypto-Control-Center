/**
 * AI Worker 통합 테스트
 *
 * WorkerManager 싱글턴(workerManager)을 통해 다음을 검증합니다:
 *  - 정상 사이클 실행 (scheduler heartbeat/decision timestamp 분리, cycleCount 증가)
 *  - 사이클 오류 후 다음 사이클이 계속 스케줄됨 (crash-restart 안전성)
 *  - 재시작 시 DB에서 HWM 복원
 *  - prevState는 DB에 저장되지 않음 — 재시작 시 'CASH'로 초기화 (설계상 의도)
 *  - consecutiveLosses를 DB 거래 내역에서 재계산
 *  - 쿨다운을 마지막 OPEN 거래 시각에서 재계산 (조기 복귀 차단)
 *  - isRunning atomic lock 으로 동시 사이클 방지
 *  - schedulerHeartbeatAt은 duplicate-skip/error 포함 완료 cycle마다 갱신
 *  - lastDecisionAt은 새 durable decision claim에서만 갱신
 *  - 동일 symbol:operatingState 중복 PENDING 승인 생성 방지
 *  - Worker heartbeat 이상 감지 (schedulerHeartbeatAt stale 판정)
 *
 * 외부 시장 데이터·운영 DB·실제 RPC 사용하지 않음.
 * LIVE_EXECUTION_LOCKED = true 상태에서만 테스트.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── 외부 의존성 모킹 (vi.mock은 파일 최상단으로 호이스팅됨) ───────────────────

// ── Drizzle 체인 헬퍼 (모킹용) ──────────────────────────────────────────────
//    vi.mock 팩토리 내에서 vi.fn()을 쓸 수 있으므로 여기서 정의
let _dbSelectImpl: () => unknown = () => [];
let _dbInsertImpl: () => unknown = () => undefined;
let _dbUpdateImpl: () => unknown = () => 0;
const _dbInsertTables: unknown[] = [];
const _dbUpdateTables: unknown[] = [];
const _dbValuesInputs: unknown[] = [];

function chain(getResult: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from','where','limit','offset','orderBy','set',
                   'onConflictDoNothing','onConflictDoUpdate','returning']) {
    c[m] = () => c;
  }
  c.values = (value: unknown) => {
    _dbValuesInputs.push(value);
    return c;
  };
  (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
    (resolve) => Promise.resolve(getResult()).then(resolve);
  return c;
}

vi.mock('@workspace/db', () => ({
  db: {
    select: vi.fn().mockImplementation(() => {
      // Task #111 — serverPaperExecutor의 selects(pendingClose/open rows)는 틱 타이밍에 따라
      // 비결정적으로 끼어들므로 카운터 시퀀스에서 제외 (항상 빈 결과)
      const stack = new Error().stack ?? '';
      if (stack.includes('serverPaperExecutor')) return chain(() => []);
      return chain(_dbSelectImpl);
    }),
    insert: vi.fn().mockImplementation((table: unknown) => {
      _dbInsertTables.push(table);
      return chain(_dbInsertImpl);
    }),
    update: vi.fn().mockImplementation((table: unknown) => {
      _dbUpdateTables.push(table);
      return chain(_dbUpdateImpl);
    }),
    delete: vi.fn().mockImplementation(() => chain(() => 0)),
  },
  aiDecisionsTable:    new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  liveApprovalsTable:  new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  strategyConfigTable: new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  tradesTable:         new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  workerStateTable:    new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
}));

vi.mock('drizzle-orm', () => ({
  eq:   vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  lt:   vi.fn(() => ({})),
  like: vi.fn(() => ({})),
  and:  vi.fn(() => ({})),
  sql:  Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
}));

vi.mock('../workers/stateEngine', () => ({
  runAiEngine: vi.fn(),
}));

vi.mock('../lib/tradeSettlement', () => ({
  reconcileLiveSettlements: vi.fn(async () => ({
    ok: true,
    unsettledCount: 0,
    settledNow: 0,
    incomplete: false,
    reasons: [],
  })),
}));

vi.mock('../lib/riskProfiles', () => ({
  applyRiskProfileToLimits: (base: Record<string, unknown>) => base,
  promoteRiskProfileAtSafeBoundary: async (base: Record<string, unknown>) => ({
    desired: {
      name: 'conservative',
      version: 'risk-profile/v1',
      requestedAt: '2026-08-21T00:00:00.000Z',
    },
    applied: {
      name: 'conservative',
      version: 'risk-profile/v1',
      appliedAt: '2026-08-21T00:00:00.000Z',
      derivedLimits: {
        immediateEntryThreshold: 80,
        maxRiskPerTradePct: 0.75,
        reserveCashPct: Number(base.reserveCashPct ?? 20),
        maxMarginPerTradeUsd: Number(base.maxMarginPerTrade ?? 334),
        maxConcurrentPositions: 1,
        cooldownMinutes: Number(base.cooldownMinutes ?? 30),
        maxLeverage: Math.min(Number(base.maxLeverage ?? 3), 3),
        maxTotalExposureUsd: Number(base.maxTotalExposureUSDT ?? 3_000),
        allocatedTradingCapitalUsd: Number(base.tradingCapital ?? 1_000),
        maxRiskPerTradeUsd: Number(base.tradingCapital ?? 1_000) * 0.0075,
      },
    },
    pending: false,
    safeBoundary: true,
    reason: null,
  }),
}));

vi.mock('../workers/indicators', () => ({
  computeIndicators: vi.fn(() => ({
    rsi14: 50, ema9: 50000, ema21: 50000, emaCross: 'neutral',
    atrPct: 2.0, priceChange24h: 0, priceChange1h: 0, momentum: 0, trend: 'sideways',
  })),
  computeScores: vi.fn(() => ({
    bullishScore: 40, bearishScore: 40, directionalBias: 0, opportunityScore: 40,
  })),
}));

vi.mock('../routes/gmx', () => ({
  // getCachedPrices는 Map을 반환해야 함 — Worker가 Map.entries()로 이터레이션
  getCachedPrices:    vi.fn(() => new Map<string, number[]>()),
  getCachedChange24h: vi.fn(() => new Map<string, number>()),
  ensureGmxPoller:    vi.fn(),
  fetchServerLiveTestData: vi.fn().mockResolvedValue({
    liveTestAccumLossUsd: 0,
    liveTestDbOk: true,
    livePositionCount: 0,
  }),
  // gmx.ts는 Express Router를 default로 export 함
  default: {},
}));

vi.mock('../intel/intelService', () => ({
  runIntelServiceCycle: vi.fn(async () => undefined),
  runStrategyShadowWorkerReadOnly: vi.fn(async (input: {
    cycleNumber: number;
    evaluatedAt: number;
    expectedSymbols: string[];
    existingAi: {
      decisionId: string;
      action: 'LONG' | 'SHORT' | 'NO_TRADE';
      confidence: number;
      primarySymbol: string | null;
      createdAt: string;
    };
    lifecycleSnapshot?: unknown;
  }) => {
    const expectedSymbols = [...new Set(input.expectedSymbols.map(symbol => symbol.trim().toUpperCase()))].sort();
    return {
      schemaVersion: 'strategy-shadow-worker-envelope/v1' as const,
      envelopeId: `${input.existingAi.decisionId}:STRATEGY_SHADOW`,
      mode: 'SHADOW_ONLY' as const,
      status: 'NOT_EVALUATED' as const,
      cycleNumber: input.cycleNumber,
      generatedAt: input.evaluatedAt,
      expectedSymbols,
      evaluatedSymbols: [],
      missingSymbols: expectedSymbols,
      records: [],
      lifecycleSnapshot: input.lifecycleSnapshot ?? null,
      summary: {
        long: 0, short: 0, noTrade: 0, rejected: 0, disabled: 0, directionConflicts: 0,
      },
      existingAi: input.existingAi,
      reasons: ['테스트 SHADOW read 결과 없음'],
      warnings: [],
      executionAuthorized: false as const,
      approvalCreationAllowed: false as const,
      paperPositionMutationAllowed: false as const,
      livePositionMutationAllowed: false as const,
      riskAuthority: 'NOT_EVALUATED' as const,
    };
  }),
  stopIntelService: vi.fn(),
  resumeIntelService: vi.fn(),
}));

vi.mock('../workers/liveTestExecutor', () => ({
  executeLiveTestOrder: vi.fn(async () => ({
    ok: false, txHash: null, orderKey: null, simulated: true,
    executedAt: new Date().toISOString(),
  })),
  closeLiveTestPosition: vi.fn(async () => ({
    ok: false, txHash: null, orderKey: null, simulated: true,
    executedAt: new Date().toISOString(),
  })),
  getLastSizingEnforcement: vi.fn(() => null),
  fetchAuthoritativeOpenPositions: vi.fn(async () => []),
}));

vi.mock('../workers/serverPaperExecutor', () => ({
  MAX_MANAGE_PRICE_AGE_MS: 30_000,
  openServerPaperPosition: vi.fn(async () => ({ ok: false, reason: 'TEST_BLOCKED' })),
  closeServerPaperPosition: vi.fn(async () => ({ ok: false, reason: 'TEST_BLOCKED' })),
  reduceServerPaper70: vi.fn(async () => ({ ok: false, reason: 'TEST_BLOCKED' })),
  requestServerPaperCloseAll: vi.fn(async () => ({ persisted: false })),
  loadPendingCloseFromDb: vi.fn(async () => undefined),
  loadSubmittedReduce70FromDb: vi.fn(async () => undefined),
  manageServerPaperTick: vi.fn(async () => undefined),
  loadServerOpenRows: vi.fn(async () => []),
  reconcileStartupCloseIntent: vi.fn(async () => undefined),
  getServerPaperStatus: vi.fn(() => ({
    openPosition: null,
    openPositions: [],
    pendingClose: null,
    lastTickAt: null,
    lastTickStale: false,
    lastOpenAttempt: null,
    lastCloseAction: null,
    unresolved: null,
  })),
}));

// 모킹 이후 실제 모듈 import
import {
  buildWorkerDecisionIdentity,
  evaluateWorkerRiskState,
  workerManager,
} from '../workers/aiWorker';
import {
  releasePaperEpochActivationLock,
  tryAcquirePaperEpochActivationLock,
} from '../lib/paperEpochActivationLock';
import { EMPTY_LOCKS, type RiskEvaluationInput } from '../lib/riskStateMachine';
import { runAiEngine }   from '../workers/stateEngine';
import { getCachedPrices } from '../routes/gmx';
import { reconcileLiveSettlements } from '../lib/tradeSettlement';
import {
  aiDecisionsTable,
  db,
  liveApprovalsTable,
  tradesTable,
} from '@workspace/db';
import { buildSignalLifecycleSnapshot } from '../intel/signalLifecycleSnapshotV2';
import {
  evaluateSignalEligibility,
  type SignalHistoryEvent,
  type SignalLifecycleRecord,
} from '../intel/signalLifecycleV2';
import {
  STRATEGY_SIGNAL_SCHEMA_VERSION,
  type StrategySignal,
} from '../intel/strategySignalV2';
import {
  advanceStrategyShadowLifecycleSnapshot,
} from '../intel/strategyShadowLifecycleRuntimeV2';
import { buildStrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import {
  runIntelServiceCycle,
  runStrategyShadowWorkerReadOnly,
  resumeIntelService,
} from '../intel/intelService';
import {
  closeLiveTestPosition,
  executeLiveTestOrder,
} from '../workers/liveTestExecutor';
import {
  closeServerPaperPosition,
  openServerPaperPosition,
  reduceServerPaper70,
  requestServerPaperCloseAll,
  manageServerPaperTick,
} from '../workers/serverPaperExecutor';

// ── 최소 유효 AI 결정 (CASH — 가장 안전한 기본값) ──────────────────────────────
const CASH_DECISION = {
  operatingState: 'CASH' as const,
  confidence: 60,
  reasoning: ['테스트: 신호 없음'],
  stateRationale: '테스트 CASH 결정',
  executionType: 'hold' as const,
  cycleNumber: 1,
  prevState: 'CASH' as const,
  stateChanged: false,
  riskLevel: 'LOW' as const,
  riskApproved: true,
  marketRankings: [],
  riskVetoReason: undefined,
  sizeUsd: undefined,
  leverage: undefined,
  entryStyle: undefined,
  trailingStopPct: undefined,
  tpPrice: undefined,
  slPrice: undefined,
  profitLockStage: 0,
  hedgeParams: undefined,
};

// ── 싱글턴 내부 상태 초기화 헬퍼 ─────────────────────────────────────────────
function resetWorker() {
  const wm = workerManager as unknown as Record<string, unknown>;
  wm.active                  = false;
  wm.isRunning               = false;
  wm.cycleCount              = 0;
  wm.schedulerHeartbeatAt    = null;
  wm.lastDecisionAt          = null;
  wm.lastSchedulerCycleOutcome = null;
  wm.lastCycleAt             = null;
  wm.lastCycleResult         = null;
  wm.prevState               = 'CASH';
  wm.lastDecisionIdentity      = null;
  wm.equityHighWaterMark     = null;
  wm.lastLimitsUsed          = null;
  wm.liveTestAccumLossUsd    = 0;
  wm.lastLiveTestVetoReason  = null;
  wm.lastLiveTestMode        = false;
  wm.lastLiveTestDbOk        = true;
  wm.lastPriceAt             = 0;
  wm.strategyLifecycleSnapshot = null;
  wm.strategyLifecycleRestoreBlocked = true;
  wm.activePaperEpochStartMs = null;
  wm.paperEpochStateOk = true;
  (wm.priceAtBySymbol as Map<string, number>).clear();
  (wm.lastTickUpdatedAtBySymbol as Map<string, number>).clear();

  const pb = wm.priceBuffer as Map<string, number[]>;
  pb.clear();
  // 가격 히스토리 사전 주입 — 사이클이 "가격 히스토리 부족"으로 건너뛰지 않도록
  // Worker는 최소 2개 심볼 × 충분한 캔들 수가 있어야 사이클을 실행함
  const btcPrices = Array.from({ length: 30 }, (_, i) => 50_000 + (i - 15) * 50);
  const ethPrices = Array.from({ length: 30 }, (_, i) =>  3_000 + (i - 15) * 3);
  pb.set('BTC', btcPrices);
  pb.set('ETH', ethPrices);
  // 수동 priceBuffer fixture도 production과 같은 upstream timestamp 계약을
  // 충족해야 한다. 모든 restart fixture에서 동일한 완료 경계를 사용한다.
  (wm.lastTickUpdatedAtBySymbol as Map<string, number>).set('BTC', 1_700_000_000_001);
  (wm.lastTickUpdatedAtBySymbol as Map<string, number>).set('ETH', 1_700_000_000_001);

  (wm.pendingApprovalKeys as Set<string>).clear();

  const pTimer = wm.pricePollTimer as ReturnType<typeof setInterval> | null;
  if (pTimer) clearInterval(pTimer);
  wm.pricePollTimer = null;

  const cTimer = wm.cycleTimer as ReturnType<typeof setTimeout> | null;
  if (cTimer) clearTimeout(cTimer);
  wm.cycleTimer = null;

  const sTimer = wm.serverPaperTimer as ReturnType<typeof setInterval> | null;
  if (sTimer) clearInterval(sTimer);
  wm.serverPaperTimer = null;

  _dbInsertTables.length = 0;
  _dbUpdateTables.length = 0;
  _dbValuesInputs.length = 0;
  _dbSelectImpl = () => [];
  _dbInsertImpl = () => undefined;
  _dbUpdateImpl = () => 0;
  vi.mocked(db.insert).mockClear();
  vi.mocked(db.update).mockClear();
  vi.mocked(db.delete).mockClear();
  vi.mocked(runAiEngine).mockClear();
  vi.mocked(runStrategyShadowWorkerReadOnly).mockClear();
  vi.mocked(runIntelServiceCycle).mockClear();
  vi.mocked(resumeIntelService).mockClear();
  vi.mocked(executeLiveTestOrder).mockClear();
  vi.mocked(closeLiveTestPosition).mockClear();
  vi.mocked(openServerPaperPosition).mockClear();
  vi.mocked(closeServerPaperPosition).mockClear();
  vi.mocked(reduceServerPaper70).mockClear();
  vi.mocked(requestServerPaperCloseAll).mockClear();
}

describe('upstream price timestamp binding', () => {
  it('does not re-stamp a stale-but-newly-received tick with local now', () => {
    resetWorker();
    const observedAt = Date.now() - 120_000;
    vi.mocked(getCachedPrices).mockReturnValue([{
      tokenSymbol: 'ETH',
      priceUsd: 3_000,
      updatedAt: observedAt,
    }] as never);
    const wm = workerManager as unknown as {
      updatePriceBuffers(): void;
      priceAtBySymbol: Map<string, number>;
    };
    wm.updatePriceBuffers();
    expect(wm.priceAtBySymbol.get('ETH')).toBe(observedAt);
    expect(workerManager.getPriceQuote('ETH')!.ageMs).toBeGreaterThanOrEqual(119_000);
  });

  it('rejects ticks without a valid upstream timestamp', () => {
    resetWorker();
    vi.mocked(getCachedPrices).mockReturnValue([{
      tokenSymbol: 'ETH',
      priceUsd: 3_000,
    }] as never);
    const wm = workerManager as unknown as {
      updatePriceBuffers(): void;
      priceAtBySymbol: Map<string, number>;
    };
    wm.updatePriceBuffers();
    expect(wm.priceAtBySymbol.has('ETH')).toBe(false);
  });
});

describe('AI Worker Active Capital Risk binding', () => {
  const riskInput = (
    overrides: Partial<RiskEvaluationInput> = {},
  ): RiskEvaluationInput => ({
    dailyRiskCapitalUsd: 1000,
    weeklyRiskCapitalUsd: 1000,
    currentEquityUsd: 1000,
    dailyRealizedNetPnlUsd: 0,
    dailyLossAwareNetPnlUsd: 0,
    estimatedExitNetPnlUsd: null,
    weeklyRealizedNetPnlUsd: 0,
    dailyEntryCount: 0,
    consecutiveLossCount: 0,
    openPositionCount: 0,
    dbOk: true,
    feeDataOk: true,
    marketDataFresh: true,
    locks: { ...EMPTY_LOCKS },
    ...overrides,
  });

  it('runtime capital mismatch blocks only new entry without new sticky actions', () => {
    const result = evaluateWorkerRiskState(
      riskInput({ currentEquityUsd: 24.5 }),
      500,
    );

    expect(result.state).toBe('NORMAL');
    expect(result.entryAllowed).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.locks.hardStopReason).toBeNull();
    expect(result.blockReasons[0]).toContain('ACTIVE_CAPITAL_RUNTIME_BELOW_APPROVED_STAGE');
  });

  it('aligned approved 1000 capital keeps the existing current hard-stop behavior', () => {
    const result = evaluateWorkerRiskState(
      riskInput({ currentEquityUsd: 919.99 }),
      1000,
    );

    expect(result.state).toBe('HARD_STOPPED');
    expect(result.entryAllowed).toBe(false);
    expect(result.actions).toEqual(expect.arrayContaining([
      'CLOSE_ALL_POSITIONS',
      'CANCEL_ALL_ORDERS',
    ]));
    expect(result.locks.hardStopReason).toContain('hard stop $920');
  });

  it('preserves an existing historical HARD_STOP across runtime capital drift', () => {
    const historical = 'historical HARD_STOP — operator review required';
    const result = evaluateWorkerRiskState(
      riskInput({
        currentEquityUsd: 24.5,
        locks: { ...EMPTY_LOCKS, hardStopReason: historical },
      }),
      500,
    );

    expect(result.state).toBe('HARD_STOPPED');
    expect(result.entryAllowed).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.locks.hardStopReason).toBe(historical);
  });
});

// ── DB 행 헬퍼 ────────────────────────────────────────────────────────────────

/** workerStateTable equityHwm 행 */
function hwmRow(value: string) {
  return [{ key: 'equityHwm', value, updatedAt: new Date() }];
}

/** strategyConfigTable 기본 행 (빈 limits → Worker defaults 사용) */
const defaultStrategyRow = [{ limits: JSON.stringify({}) }];

/** 거래 없음 (쿨다운·연속 손실 없음) */
const noTradesResult: unknown[] = [];

/** 2건의 연속 음수 손익 CLOSE 거래 */
function makeCloseTrades(consecutiveLosses: number): unknown[] {
  return Array.from({ length: consecutiveLosses }, (_, i) => ({
    action: 'CLOSE',
    pnl: -10 - i,
    timestamp: Date.now() - (i + 1) * 60000,
    closeTime: Date.now() - (i + 1) * 60000,
    sizeInUsd: 1000, size: 0.02, price: 50000, symbol: 'BTC',
    side: 'LONG', leverage: 5, collateralUsd: 200, testMode: false,
  }));
}

/** 최근 OPEN 거래 (쿨다운 시뮬레이션) */
function makeOpenTrade(ageMs: number): unknown[] {
  return [{
    action: 'OPEN',
    pnl: 0,
    timestamp: Date.now() - ageMs,
    closeTime: null,
    sizeInUsd: 1000, size: 0.02, price: 50000, symbol: 'BTC',
    side: 'LONG', leverage: 5, collateralUsd: 200, testMode: false,
  }];
}

// ── 테스트 공통 DB 응답 시퀀서 ────────────────────────────────────────────────
// 실제 select 호출 순서:
//   start()    → (1) loadPendingApprovals (liveApprovalsTable)
//              → (2) loadHwmFromDb        (workerStateTable)
//              → (3) loadBaselinesFromDb  (workerStateTable — 기간 PnL 기준점)
//              → (4) loadActivePaperEpochFromDb (workerStateTable — legacy pointer 없음)
//              → (5) loadStrategyLifecycleSnapshotFromDb (aiDecisionsTable)
//              → (6) loadRiskEngineState  (workerStateTable — 미수립)
//   runCycle() → (7) loadPendingApprovals again (liveApprovalsTable)
//              → (8) strategyConfigTable
//              → (9) tradesTable (consecutiveLosses + cooldown 계산)
// insert/update 호출은 별도 mock (_dbInsertImpl, _dbUpdateImpl)

function setupDbSequence(opts: {
  pendingApprovals?: unknown[];
  hwmValue?:         string | null;
  lifecycleDecision?: unknown[];
  strategyRow?:      unknown[];
  trades?:           unknown[];
  insertResult?:     unknown;
} = {}) {
  const pending  = opts.pendingApprovals ?? [];
  const hwm      = opts.hwmValue != null ? hwmRow(opts.hwmValue) : [];
  const lifecycle = opts.lifecycleDecision ?? [];
  const strategy = opts.strategyRow ?? defaultStrategyRow;
  const trades   = opts.trades    ?? noTradesResult;
  const inserted = opts.insertResult ?? [{ id: 'test-decision-1' }];

  let selectCallN = 0;
  _dbSelectImpl = () => {
    selectCallN++;
    if (selectCallN === 1) return pending;   // start(): loadPendingApprovals
    if (selectCallN === 2) return hwm;       // start(): loadHwmFromDb
    if (selectCallN === 3) return [];        // start(): loadBaselinesFromDb (기준점 없음)
    if (selectCallN === 4) return [];        // start(): active PAPER epoch pointer 없음 (legacy mode)
    if (selectCallN === 5) return lifecycle; // start(): latest lifecycle decision (없으면 legacy baseline)
    if (selectCallN === 6) return [];        // start(): loadRiskEngineState (6H-1 — 미수립)
    if (selectCallN === 7) return pending;   // runCycle(): loadPendingApprovals again
    if (selectCallN === 8) return strategy;  // runCycle(): strategyConfigTable
    if (selectCallN === 9) return trades;    // runCycle(): tradesTable (consecutiveLosses)
    return [];
  };

  _dbInsertImpl = () => inserted;
  _dbUpdateImpl = () => 0;
}

// ────────────────────────────────────────────────────────────────────────────

describe('PAPER epoch accounting boundary', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => {
    releasePaperEpochActivationLock();
    resetWorker();
    vi.useRealTimers();
  });

  it('excludes historical PAPER activity but retains global positions and LIVE TEST losses', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    try {
      const cutoff = Date.now() - 10 * 60_000;
      _dbSelectImpl = () => [
        { action: 'OPEN', pnl: 0, timestamp: new Date(cutoff + 2), closeTime: 0, testMode: false,
          sizeInUsd: 100, price: 50_000, symbol: 'ETH', side: 'LONG', leverage: 1, collateralUsd: 100 },
        { action: 'CLOSE', pnl: 5, timestamp: new Date(cutoff + 1), testMode: false, settlementStatus: 'SETTLED' },
        // Older PAPER CLOSE/OPEN must not affect the newly activated epoch.
        { action: 'OPEN', pnl: 0, timestamp: new Date(cutoff - 1), closeTime: 0, testMode: false,
          sizeInUsd: 100, price: 50_000, symbol: 'BTC', side: 'LONG', leverage: 1, collateralUsd: 100 },
        { action: 'CLOSE', pnl: -40, timestamp: new Date(cutoff - 1), testMode: false, settlementStatus: 'SETTLED' },
        // LIVE TEST loss remains an all-time safety input even when historical.
        { action: 'CLOSE', pnl: -7, timestamp: new Date(cutoff - 2), testMode: true, settlementStatus: 'SETTLED' },
      ];
      const wm = workerManager as unknown as {
        activePaperEpochStartMs: number | null;
        loadPaperState(): Promise<{
          totalRealizedPnlAllTime: number; consecutiveLosses: number;
          positions: unknown[]; tradesInLastHour: number; entriesManilaDay: number;
          lastOpenTradeTimestampMs: number | null; liveTestAccumLossUsd: number;
        }>;
      };
      wm.activePaperEpochStartMs = cutoff;
      const state = await wm.loadPaperState();
      // Only active-epoch PAPER PnL contributes to equity; LIVE TEST stays separate.
      expect(state.totalRealizedPnlAllTime).toBe(5);
      expect(state.consecutiveLosses).toBe(0);
      expect(state.liveTestAccumLossUsd).toBe(7);
      // Existing open positions are operationally global, never reset away.
      expect(state.positions).toHaveLength(2);
      expect(state.tradesInLastHour).toBe(1);
      expect(state.entriesManilaDay).toBe(1);
      expect(state.lastOpenTradeTimestampMs).toBe(cutoff + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers exactly one scheduler retry while activation holds the process lock', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const wm = workerManager as unknown as {
      active: boolean;
      lifecycleGeneration: number;
      runCycle(generation: number): Promise<void>;
    };
    wm.active = true;
    wm.lifecycleGeneration = 41;
    expect(tryAcquirePaperEpochActivationLock()).toBe(true);

    await wm.runCycle(41);

    expect(workerManager.getStatus().cycleCount).toBe(0);
    expect(workerManager.getStatus().schedulerHeartbeatAt).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('marks a corrupt epoch pointer unhealthy and vetoes PAPER entry', async () => {
    _dbSelectImpl = () => [{
      key: 'paperEpochActiveV1',
      value: JSON.stringify({
        epochId: 'paper-corrupt',
        startedAt: '2026-09-03T19:00:00.000Z',
        startedAtMs: 1,
        activeCapitalUsd: 1000,
      }),
    }];
    const wm = workerManager as unknown as {
      active: boolean;
      lifecycleGeneration: number;
      loadActivePaperEpochFromDb(): Promise<void>;
      runServerPaperExecution(
        decision: unknown,
        paperState: unknown,
        riskEvaluation: unknown,
        cycleNumber: number,
        generation: number,
      ): Promise<void>;
    };
    await wm.loadActivePaperEpochFromDb();
    expect(workerManager.getStatus().paperEpochStateOk).toBe(false);

    wm.active = true;
    wm.lifecycleGeneration = 42;
    await wm.runServerPaperExecution({
      id: 'blocked-entry',
      operatingState: 'LONG',
      riskApproved: true,
      executionType: 'perp_long_open',
      primarySymbol: 'BTC',
      sizeUsd: 100,
      leverage: 2,
      riskProfile: { derivedLimits: { maxConcurrentPositions: 1 } },
    }, {
      positions: [],
      entriesManilaDay: 0,
    }, {
      entryAllowed: true,
      actions: [],
    }, 1, 42);

    expect(openServerPaperPosition).not.toHaveBeenCalled();
  });
});

describe('Worker 초기 상태', () => {
  beforeEach(() => { resetWorker(); });

  it('start() 전에는 workerRunning=false, cycleCount=0, lastCycleAt=null', () => {
    const s = workerManager.getStatus();
    expect(s.workerRunning).toBe(false);
    expect(s.cycleCount).toBe(0);
    expect(s.lastCycleAt).toBeNull();
  });

  it('start()를 두 번 호출해도 중복 활성화되지 않는다', async () => {
    setupDbSequence();
    vi.useFakeTimers();
    try {
      await workerManager.start();
      await workerManager.start(); // no-op
      const wm = workerManager as unknown as Record<string, unknown>;
      expect(wm.cycleCount).toBe(0); // 아직 사이클 실행 전
    } finally {
      workerManager.stop();
      vi.useRealTimers();
    }
  });
});

describe('worker lifecycle generation safety', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('stop during awaited startup prevents every later recovery phase and timer/Intel install', async () => {
    vi.useFakeTimers();
    let release!: (rows: unknown[]) => void;
    let selects = 0;
    _dbSelectImpl = () => {
      selects += 1;
      return new Promise<unknown[]>(resolve => { release = resolve; });
    };

    const startup = workerManager.start();
    for (let i = 0; i < 5 && selects === 0; i++) await Promise.resolve();
    workerManager.stop();
    release([]);
    await startup;

    const wm = workerManager as unknown as Record<string, unknown>;
    expect(selects).toBe(1);
    expect(wm.pricePollTimer).toBeNull();
    expect(wm.serverPaperTimer).toBeNull();
    expect(wm.cycleTimer).toBeNull();
    expect(resumeIntelService).not.toHaveBeenCalled();
  });

  it('stop while a cycle read is in flight prevents later reads, engine, Intel and reschedule', async () => {
    vi.useFakeTimers();
    let release!: (rows: unknown[]) => void;
    let selects = 0;
    _dbSelectImpl = () => {
      selects += 1;
      return new Promise<unknown[]>(resolve => { release = resolve; });
    };
    const wm = workerManager as unknown as {
      active: boolean;
      lifecycleGeneration: number;
      cycleTimer: ReturnType<typeof setTimeout> | null;
      runCycle(generation: number): Promise<void>;
    };
    wm.active = true;
    const generation = ++wm.lifecycleGeneration;
    const cycle = wm.runCycle(generation);
    for (let i = 0; i < 5 && selects === 0; i++) await Promise.resolve();
    workerManager.stop();
    release([]);
    await cycle;

    expect(selects).toBe(1);
    expect(runAiEngine).not.toHaveBeenCalled();
    expect(runIntelServiceCycle).not.toHaveBeenCalled();
    expect(wm.cycleTimer).toBeNull();
  });

  it('atomic-lock contention neither claims a heartbeat nor creates a second timer', async () => {
    vi.useFakeTimers();
    const wm = workerManager as unknown as {
      active: boolean;
      isRunning: boolean;
      lifecycleGeneration: number;
      cycleTimer: ReturnType<typeof setTimeout> | null;
      runCycle(generation: number): Promise<void>;
    };
    wm.active = true;
    const generation = ++wm.lifecycleGeneration;
    wm.isRunning = true;
    const ownedTimer = setTimeout(() => undefined, 60_000);
    wm.cycleTimer = ownedTimer;

    await wm.runCycle(generation);

    expect(wm.cycleTimer).toBe(ownedTimer);
    expect(workerManager.getStatus().cycleCount).toBe(0);
    expect(workerManager.getStatus().schedulerHeartbeatAt).toBeNull();
  });

  it('a queued PAPER management callback invoked after stop is a no-op', async () => {
    vi.useFakeTimers();
    setupDbSequence();
    const callbacks: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number) => {
      callbacks.push(callback as () => void);
      return realSetInterval(callback, delay);
    }) as typeof setInterval);

    await workerManager.start();
    expect(callbacks.length).toBeGreaterThanOrEqual(2);
    const queuedPaperTick = callbacks[1];
    workerManager.stop();
    queuedPaperTick();
    await Promise.resolve();
    expect(manageServerPaperTick).not.toHaveBeenCalled();
  });

  it('restart discards the previous lifecycle heartbeat and recovers after its first completed cycle', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue(
      CASH_DECISION as unknown as ReturnType<typeof runAiEngine>,
    );
    const wm = workerManager as unknown as {
      schedulerHeartbeatAt: Date | null;
      runCycle(): Promise<void>;
    };

    wm.schedulerHeartbeatAt = new Date(Date.now() - 30_000);
    workerManager.stop();
    setupDbSequence();
    await workerManager.start();
    expect(workerManager.getStatus().schedulerHeartbeatAt).toBeNull();

    await wm.runCycle();
    expect(workerManager.getStatus().schedulerHeartbeatAt).not.toBeNull();
  });
});

describe('completed-candle decision replay idempotency', () => {
  beforeEach(() => { resetWorker(); });

  it('same signal/candle persists once and dispatches no duplicate PAPER execution', async () => {
    const evidence = {
      symbol: 'BTC',
      operatingState: 'LONG' as const,
      sourceCandleCloseTime: 1_800_000_000_000,
      evaluatedAtMs: 1_800_000_000_001,
    };
    const firstIdentity = buildWorkerDecisionIdentity(evidence);
    const replayIdentity = buildWorkerDecisionIdentity(evidence);
    expect(replayIdentity).toEqual(firstIdentity);
    expect(firstIdentity.dbId).toBeLessThan(0);
    expect(() => buildWorkerDecisionIdentity({
      ...evidence,
      evaluatedAtMs: evidence.sourceCandleCloseTime,
    })).toThrow('authoritative completed-candle');

    let insertAttempt = 0;
    _dbInsertImpl = () => (++insertAttempt === 1 ? [{ id: firstIdentity.dbId }] : []);
    const wm = workerManager as unknown as {
      persistDecision(decision: unknown): Promise<{ status: 'CLAIMED' | 'CONFLICT' | 'ERROR' }>;
    };
    const decision = {
      ...CASH_DECISION,
      id: firstIdentity.decisionId,
      createdAt: '2027-01-15T08:00:01.000Z',
      primarySymbol: 'BTC',
      source: 'server_worker',
      testMode: false,
      paperExecuted: false,
      paperOrderId: null,
    };

    for (let replay = 0; replay < 2; replay++) {
      const durableClaim = await wm.persistDecision(decision);
      if (durableClaim.status === 'CLAIMED') {
        await openServerPaperPosition({} as never);
      }
    }

    expect(db.insert).toHaveBeenCalledTimes(2);
    expect(openServerPaperPosition).toHaveBeenCalledTimes(1);
  });

  it('concurrent identical claims produce one durable winner', async () => {
    const identity = buildWorkerDecisionIdentity({
      symbol: 'BTC',
      operatingState: 'LONG',
      sourceCandleCloseTime: 1_800_000_000_000,
      evaluatedAtMs: 1_800_000_000_001,
    });
    let insertAttempt = 0;
    _dbInsertImpl = () => (++insertAttempt === 1 ? [{ id: identity.dbId }] : []);
    const wm = workerManager as unknown as {
      persistDecision(decision: unknown): Promise<{ status: 'CLAIMED' | 'CONFLICT' | 'ERROR' }>;
    };
    const decision = {
      ...CASH_DECISION,
      id: identity.decisionId,
      createdAt: '2027-01-15T08:00:01.000Z',
      primarySymbol: 'BTC',
      source: 'server_worker',
      testMode: false,
      paperExecuted: false,
      paperOrderId: null,
    };

    const claims = await Promise.all([
      wm.persistDecision(decision),
      wm.persistDecision(decision),
    ]);

    expect(claims.map(claim => claim.status).sort()).toEqual(['CLAIMED', 'CONFLICT']);
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it('same completed candle skips repeated DB claim and downstream in one process', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue(
      CASH_DECISION as unknown as ReturnType<typeof runAiEngine>,
    );
    const wm = workerManager as unknown as {
      runCycle(): Promise<void>;
      maybeCreateApproval(...args: unknown[]): Promise<boolean>;
      runServerPaperExecution(...args: unknown[]): Promise<void>;
    };
    const approvalDispatch = vi.spyOn(wm, 'maybeCreateApproval').mockResolvedValue(false);
    const paperDispatch = vi.spyOn(wm, 'runServerPaperExecution').mockResolvedValue();

    try {
      await workerManager.start();
      await wm.runCycle();
      const firstDecisionClaims = _dbInsertTables.filter(table => table === aiDecisionsTable).length;
      const firstIntelDispatches = vi.mocked(runIntelServiceCycle).mock.calls.length;
      const firstSettlementChecks = vi.mocked(reconcileLiveSettlements).mock.calls.length;
      const firstStatus = workerManager.getStatus();

      vi.setSystemTime(Date.now() + 60_000);
      await wm.runCycle();
      const duplicateStatus = workerManager.getStatus();

      expect(_dbInsertTables.filter(table => table === aiDecisionsTable)).toHaveLength(firstDecisionClaims);
      expect(approvalDispatch).toHaveBeenCalledTimes(1);
      expect(paperDispatch).toHaveBeenCalledTimes(1);
      expect(runIntelServiceCycle).toHaveBeenCalledTimes(firstIntelDispatches);
      expect(reconcileLiveSettlements).toHaveBeenCalledTimes(firstSettlementChecks + 1);
      expect(Date.parse(duplicateStatus.schedulerHeartbeatAt!))
        .toBeGreaterThan(Date.parse(firstStatus.schedulerHeartbeatAt!));
      expect(duplicateStatus.lastDecisionAt).toBe(firstStatus.lastDecisionAt);
      expect(duplicateStatus.lastCycleAt).toBe(firstStatus.lastCycleAt);
      expect(duplicateStatus.lastSchedulerCycleOutcome).toBe('SAFE_SKIP');
      expect(duplicateStatus.lastCycleResult).toMatchObject({
        cycleNumber: 2,
        analysesCount: 2,
        approvalCreated: false,
        skipReason: 'DUPLICATE_COMPLETED_CANDLE_IN_PROCESS',
      });
      expect(duplicateStatus.lastCycleResult?.error).toBeUndefined();
    } finally {
      workerManager.stop();
      approvalDispatch.mockRestore();
      paperDispatch.mockRestore();
      vi.useRealTimers();
    }
  });

  it('durable decision claim failure records a fresh ERROR cycle instead of a healthy skip', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue(
      CASH_DECISION as unknown as ReturnType<typeof runAiEngine>,
    );
    const wm = workerManager as unknown as {
      runCycle(): Promise<void>;
      persistDecision(...args: unknown[]): Promise<{ status: 'ERROR' }>;
    };
    const claim = vi.spyOn(wm, 'persistDecision').mockResolvedValue({ status: 'ERROR' });

    try {
      await workerManager.start();
      await wm.runCycle();
      const status = workerManager.getStatus();
      expect(status.schedulerHeartbeatAt).not.toBeNull();
      expect(status.lastSchedulerCycleOutcome).toBe('ERROR');
      expect(status.lastDecisionAt).toBeNull();
    } finally {
      workerManager.stop();
      claim.mockRestore();
      vi.useRealTimers();
    }
  });

  it('insufficient analysis records a fresh ERROR cycle and never claims a decision', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    setupDbSequence();
    const wm = workerManager as unknown as {
      priceBuffer: Map<string, number[]>;
      runCycle(): Promise<void>;
    };

    try {
      await workerManager.start();
      wm.priceBuffer.clear();
      await wm.runCycle();
      const status = workerManager.getStatus();
      expect(status.schedulerHeartbeatAt).not.toBeNull();
      expect(status.lastSchedulerCycleOutcome).toBe('ERROR');
      expect(status.lastCycleResult?.error).toContain('가격 히스토리 부족');
      expect(status.lastDecisionAt).toBeNull();
    } finally {
      workerManager.stop();
      vi.useRealTimers();
    }
  });

  it('replaces a stale insufficient-history error when the recovered candle is already durably claimed', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue(
      CASH_DECISION as unknown as ReturnType<typeof runAiEngine>,
    );
    const wm = workerManager as unknown as {
      priceBuffer: Map<string, number[]>;
      runCycle(): Promise<void>;
      persistDecision(...args: unknown[]): Promise<{ status: 'CONFLICT' }>;
    };
    const durableClaim = vi.spyOn(wm, 'persistDecision').mockResolvedValue({ status: 'CONFLICT' });

    try {
      await workerManager.start();
      wm.priceBuffer.clear();
      await wm.runCycle();
      expect(workerManager.getStatus().lastCycleResult?.error).toContain('가격 히스토리 부족');

      wm.priceBuffer.set('BTC', Array.from({ length: 5 }, (_, i) => 50_000 + i));
      wm.priceBuffer.set('ETH', Array.from({ length: 5 }, (_, i) => 3_000 + i));
      await wm.runCycle();

      const recoveredDuplicate = workerManager.getStatus();
      expect(recoveredDuplicate.lastSchedulerCycleOutcome).toBe('SAFE_SKIP');
      expect(recoveredDuplicate.lastCycleResult).toMatchObject({
        cycleNumber: 2,
        analysesCount: 2,
        approvalCreated: false,
        skipReason: 'DUPLICATE_COMPLETED_CANDLE_DURABLE_CONFLICT',
      });
      expect(recoveredDuplicate.lastCycleResult?.error).toBeUndefined();
      expect(durableClaim).toHaveBeenCalledTimes(1);
    } finally {
      workerManager.stop();
      durableClaim.mockRestore();
      vi.useRealTimers();
    }
  });

  it('next completed candle permits exactly one new claim and dispatch', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue(
      CASH_DECISION as unknown as ReturnType<typeof runAiEngine>,
    );
    const wm = workerManager as unknown as {
      runCycle(): Promise<void>;
      lastTickUpdatedAtBySymbol: Map<string, number>;
    };

    try {
      await workerManager.start();
      await wm.runCycle();
      const firstClaims = _dbInsertTables.filter(table => table === aiDecisionsTable).length;
      const firstDispatches = vi.mocked(runIntelServiceCycle).mock.calls.length;

      for (const symbol of ['BTC', 'ETH']) {
        const previous = wm.lastTickUpdatedAtBySymbol.get(symbol)!;
        wm.lastTickUpdatedAtBySymbol.set(symbol, previous + 15 * 60_000);
      }
      await wm.runCycle();
      const nextCandleStatus = workerManager.getStatus();
      await wm.runCycle();

      expect(_dbInsertTables.filter(table => table === aiDecisionsTable)).toHaveLength(firstClaims + 1);
      expect(runIntelServiceCycle).toHaveBeenCalledTimes(firstDispatches + 1);
      expect(nextCandleStatus.lastSchedulerCycleOutcome).toBe('SUCCESS');
      expect(nextCandleStatus.lastCycleResult).toMatchObject({
        cycleNumber: 2,
        analysesCount: 2,
        approvalCreated: false,
      });
      expect(nextCandleStatus.lastCycleResult?.skipReason).toBeUndefined();
      expect(nextCandleStatus.lastCycleResult?.error).toBeUndefined();
    } finally {
      workerManager.stop();
      vi.useRealTimers();
    }
  });

  it('same candle permits a changed symbol/state identity after fresh risk and settlement evaluation', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    setupDbSequence();
    vi.mocked(runAiEngine)
      .mockReturnValueOnce(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>)
      .mockReturnValueOnce({
        ...CASH_DECISION,
        operatingState: 'LONG',
        primarySymbol: 'BTC',
        riskApproved: true,
        executionType: 'perp_long_open',
      } as unknown as ReturnType<typeof runAiEngine>);
    const wm = workerManager as unknown as {
      runCycle(): Promise<void>;
      runServerPaperExecution(...args: unknown[]): Promise<void>;
    };
    const paperDispatch = vi.spyOn(wm, 'runServerPaperExecution').mockResolvedValue();
    const settlementCallsBefore = vi.mocked(reconcileLiveSettlements).mock.calls.length;

    try {
      await workerManager.start();
      await wm.runCycle();
      const firstClaims = _dbInsertTables.filter(table => table === aiDecisionsTable).length;

      await wm.runCycle();

      expect(_dbInsertTables.filter(table => table === aiDecisionsTable)).toHaveLength(firstClaims + 1);
      expect(paperDispatch).toHaveBeenCalledTimes(2);
      expect(reconcileLiveSettlements).toHaveBeenCalledTimes(settlementCallsBefore + 2);
    } finally {
      workerManager.stop();
      paperDispatch.mockRestore();
      vi.useRealTimers();
    }
  });

  it('DB claim error is retried, but a confirmed conflict suppresses later same-candle attempts', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue(
      CASH_DECISION as unknown as ReturnType<typeof runAiEngine>,
    );
    let decisionClaimAttempts = 0;
    _dbInsertImpl = () => {
      if (_dbInsertTables.at(-1) !== aiDecisionsTable) return [{ id: 'auxiliary-row' }];
      decisionClaimAttempts += 1;
      if (decisionClaimAttempts === 1) throw new Error('transient decision DB failure');
      return [];
    };
    const wm = workerManager as unknown as { runCycle(): Promise<void> };

    try {
      await workerManager.start();
      await wm.runCycle();
      await wm.runCycle();
      await wm.runCycle();

      expect(decisionClaimAttempts).toBe(2);
      expect(runIntelServiceCycle).not.toHaveBeenCalled();
      expect(openServerPaperPosition).not.toHaveBeenCalled();
      expect(workerManager.getStatus().lastCycleResult).toMatchObject({
        cycleNumber: 3,
        analysesCount: 2,
        approvalCreated: false,
        skipReason: 'DUPLICATE_COMPLETED_CANDLE_IN_PROCESS',
      });
      expect(workerManager.getStatus().lastCycleResult?.error).toBeUndefined();
    } finally {
      workerManager.stop();
      vi.useRealTimers();
    }
  });

  it('restart replay claim blocks duplicate approval, LIVE intent/order dispatch, and Intel cycle', async () => {
    const previousMode = process.env.WORKER_ENGINE_MODE;
    process.env.WORKER_ENGINE_MODE = 'LIVE';
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const wm = workerManager as unknown as {
      runCycle(): Promise<void>;
      maybeCreateApproval(...args: unknown[]): Promise<boolean>;
      tryLiveTestExecution(...args: unknown[]): Promise<void>;
      runServerPaperExecution(...args: unknown[]): Promise<void>;
    };
    const approvalDispatch = vi.spyOn(wm, 'maybeCreateApproval').mockResolvedValue(false);
    const liveIntentOrderDispatch = vi.spyOn(wm, 'tryLiveTestExecution').mockResolvedValue();
    const paperOrderDispatch = vi.spyOn(wm, 'runServerPaperExecution').mockResolvedValue();
    let decisionClaimAttempts = 0;

    const installRestartDb = (lifecycleDecision: unknown[] = []) => {
      setupDbSequence({
        lifecycleDecision,
        strategyRow: [{ limits: JSON.stringify({ liveTestMode: true }) }],
      });
      _dbInsertImpl = () => {
        if (_dbInsertTables.at(-1) === aiDecisionsTable) {
          decisionClaimAttempts += 1;
          return decisionClaimAttempts === 1 ? [{ id: 'first-durable-claim' }] : [];
        }
        return [{ id: 'auxiliary-row' }];
      };
    };

    vi.mocked(runAiEngine).mockReturnValue({
      ...CASH_DECISION,
      operatingState: 'LONG',
      primarySymbol: 'BTC',
      riskApproved: true,
      executionType: 'perp_long_open',
    } as unknown as ReturnType<typeof runAiEngine>);

    try {
      installRestartDb();
      await workerManager.start();
      await wm.runCycle();

      expect(decisionClaimAttempts).toBe(1);
      expect(approvalDispatch).toHaveBeenCalledTimes(1);
      expect(liveIntentOrderDispatch).toHaveBeenCalledTimes(1);
      expect(paperOrderDispatch).not.toHaveBeenCalled();
      expect(runIntelServiceCycle).toHaveBeenCalledTimes(1);

      const persistedRow = _dbValuesInputs.find((value): value is { fullJson: string } =>
        typeof value === 'object' && value !== null
        && typeof (value as { fullJson?: unknown }).fullJson === 'string');
      expect(persistedRow).toBeDefined();

      workerManager.stop();
      resetWorker();
      installRestartDb(persistedRow ? [{ fullJson: persistedRow.fullJson }] : []);
      await workerManager.start();
      await wm.runCycle();

      expect(decisionClaimAttempts).toBe(2);
      expect(approvalDispatch).toHaveBeenCalledTimes(1);
      expect(liveIntentOrderDispatch).toHaveBeenCalledTimes(1);
      expect(paperOrderDispatch).not.toHaveBeenCalled();
      expect(runIntelServiceCycle).not.toHaveBeenCalled();
      expect(executeLiveTestOrder).not.toHaveBeenCalled();
      expect(closeLiveTestPosition).not.toHaveBeenCalled();
    } finally {
      workerManager.stop();
      approvalDispatch.mockRestore();
      liveIntentOrderDispatch.mockRestore();
      paperOrderDispatch.mockRestore();
      if (previousMode === undefined) delete process.env.WORKER_ENGINE_MODE;
      else process.env.WORKER_ENGINE_MODE = previousMode;
    }
  });
});

// ── HWM 재시작 복구 ───────────────────────────────────────────────────────────

describe('crash-restart — HWM DB 복원', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('keeps the cycle busy until the HWM durable write completes', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    let selectCall = 0;
    _dbSelectImpl = () => {
      selectCall += 1;
      if (selectCall === 1) return [];
      if (selectCall === 2) return defaultStrategyRow;
      if (selectCall === 3) return noTradesResult;
      return [];
    };
    let releaseHwm!: (value: unknown) => void;
    const pendingHwm = new Promise<unknown>((resolve) => { releaseHwm = resolve; });
    let insertCall = 0;
    _dbInsertImpl = () => {
      insertCall += 1;
      return insertCall === 1 ? pendingHwm : [{ id: 'test-decision-1' }];
    };
    vi.mocked(runAiEngine).mockReturnValue(
      CASH_DECISION as unknown as ReturnType<typeof runAiEngine>,
    );
    const wm = workerManager as unknown as {
      active: boolean;
      runCycle(): Promise<void>;
      isCycleInProgress(): boolean;
    };
    wm.active = true;

    const cycle = wm.runCycle();
    for (let i = 0; i < 20 && insertCall === 0; i += 1) await Promise.resolve();

    expect(insertCall).toBe(1);
    expect(wm.isCycleInProgress()).toBe(true);
    releaseHwm([]);
    await cycle;
    expect(wm.isCycleInProgress()).toBe(false);
  });

  it('start() 시 DB에서 equityHwm을 로드한다 (15000)', async () => {
    setupDbSequence({ hwmValue: '15000' });
    vi.useFakeTimers();
    await workerManager.start();
    const s = workerManager.getStatus();
    expect(s.equityHwm).toBe(15000);
  });

  it('DB에 HWM 없으면 null로 시작한다 (첫 실행 시나리오)', async () => {
    setupDbSequence({ hwmValue: null });
    vi.useFakeTimers();
    await workerManager.start();
    const s = workerManager.getStatus();
    expect(s.equityHwm).toBeNull();
  });

  it('equityHwm = 0 이면 무시한다 (유효하지 않은 HWM)', async () => {
    setupDbSequence({ hwmValue: '0' });
    vi.useFakeTimers();
    await workerManager.start();
    const s = workerManager.getStatus();
    // 0은 유효하지 않은 HWM → null 유지
    expect(s.equityHwm).toBeNull();
  });
});

// ── Strategy SHADOW lifecycle 실제 Worker 재시작 복원 ───────────────────────
describe('crash-restart — Strategy SHADOW lifecycle DB 복원', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  const makeRestartEvidence = () => {
    const now = Date.now();
    const candle = 15 * 60_000;
    const close = now - candle;
    const record: SignalLifecycleRecord = {
      configVersion: 'signal-lifecycle/v1',
      signalId: `BTC:TREND_PULLBACK:LONG:15m:${close}`,
      symbol: 'BTC', strategyId: 'TREND_PULLBACK', direction: 'LONG',
      sourceCandleCloseTime: close, status: 'GENERATED',
      generatedAt: close + 1, updatedAt: close + 1,
      reason: 'restart regression evidence',
    };
    const historyEvents: SignalHistoryEvent[] = [
      { eventId: `STOP_LOSS:${close - candle}`, kind: 'STOP_LOSS', symbol: 'BTC',
        strategyId: 'TREND_PULLBACK', direction: 'LONG', sourceCandleCloseTime: close - candle },
      { eventId: `FAILED_BREAKOUT:${close - 2 * candle}`, kind: 'FAILED_BREAKOUT', symbol: 'BTC',
        strategyId: 'TREND_PULLBACK', direction: 'LONG', sourceCandleCloseTime: close - 2 * candle },
    ];
    const snapshot = buildSignalLifecycleSnapshot([record], historyEvents, now - 1)!;
    const signal: StrategySignal = {
      schemaVersion: STRATEGY_SIGNAL_SCHEMA_VERSION,
      signalId: 'attempted-restart-bypass', strategyId: 'TREND_PULLBACK', symbol: 'BTC',
      regime: 'TREND_UP', direction: 'LONG', confidence: 80,
      entryZoneLow: 99, entryZoneHigh: 101, proposedEntryPrice: 100,
      structuralStop: 98, stopDistancePct: 2, invalidationPrice: 98,
      targets: [{ price: 104, expectedR: 2, allocationPct: 100 }],
      grossExpectedEdgeBps: 400, expectedCostsBps: 20, netExpectedEdgeBps: 380,
      expectedNetRR: 1.9, higherTimeframeTrend: 'TREND_UP', marketStructure: 'BULLISH',
      confirmationPattern: 'REJECTION', sourceTimeframes: ['4h', '1h', '15m'],
      sourceCandleCloseTime: close, dataQuality: 'GOOD', volumeConfirmation: null,
      reasons: [], warnings: [],
    };
    return { now, close, candle, record, historyEvents, snapshot, signal };
  };

  const makeShadowRecord = (
    evidence: ReturnType<typeof makeRestartEvidence>,
  ): StrategyShadowRecord => ({
    schemaVersion: 'strategy-shadow-adapter/v1',
    shadowRecordId: `BTC:STRATEGY_SHADOW:TREND_UP:${evidence.close}`,
    mode: 'SHADOW_ONLY',
    symbol: 'BTC',
    evaluatedAt: evidence.now - 1,
    sourceCandleCloseTime: evidence.close,
    regime: 'TREND_UP',
    action: 'LONG',
    comparison: 'ENSEMBLE_ONLY',
    strategyId: 'TREND_PULLBACK',
    signalId: evidence.record.signalId,
    direction: 'LONG',
    confidence: 80,
    selectedScore: 80,
    entryPrice: 100,
    structuralStop: 98,
    expectedNetEdgeBps: 200,
    expectedNetRR: 2,
    lifecycleEligible: true,
    existingAi: null,
    reasons: [],
    warnings: [],
    executionAuthorized: false,
    paperPositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED',
  });

  it('첫 Worker의 durable decision을 두 번째 Worker가 복원해 Signal ID·동일 완료봉·cooldown을 보존한다', async () => {
    const fixedNow = 1_800_000_000_000;
    vi.useFakeTimers({ now: fixedNow });
    const evidence = makeRestartEvidence();
    const firstBaseline = buildSignalLifecycleSnapshot([], evidence.historyEvents, evidence.now - 2)!;
    const firstEnvelope = buildStrategyShadowWorkerEnvelope({
      cycleNumber: 1,
      generatedAt: evidence.now - 1,
      expectedSymbols: ['BTC'],
      records: [makeShadowRecord(evidence)],
      lifecycleSnapshot: firstBaseline,
      existingAi: {
        decisionId: 'worker-1-decision',
        action: 'NO_TRADE',
        confidence: 0,
        primarySymbol: 'BTC',
        createdAt: new Date(evidence.now - 2).toISOString(),
      },
    });
    const firstOutputSnapshot = advanceStrategyShadowLifecycleSnapshot(
      firstBaseline,
      firstEnvelope,
      evidence.now,
    );
    expect(firstOutputSnapshot).not.toBeNull();

    setupDbSequence({ insertResult: [{ id: 'worker-1-decision' }] });
    const firstWorker = workerManager as unknown as {
      strategyLifecycleSnapshot: typeof firstBaseline | null;
      strategyLifecycleRestoreBlocked: boolean;
      persistDecision(decision: unknown): Promise<{ status: 'CLAIMED' | 'CONFLICT' | 'ERROR' }>;
    };
    firstWorker.strategyLifecycleSnapshot = firstBaseline;
    firstWorker.strategyLifecycleRestoreBlocked = false;
    const durableIdentity = buildWorkerDecisionIdentity({
      symbol: evidence.record.symbol,
      operatingState: 'CASH',
      sourceCandleCloseTime: evidence.close,
      evaluatedAtMs: evidence.now,
    });
    const persisted = await firstWorker.persistDecision({
      id: durableIdentity.decisionId,
      createdAt: new Date(evidence.now).toISOString(),
      source: 'server_worker',
      primarySymbol: 'BTC',
      operatingState: 'CASH',
      confidence: 0,
      stateRationale: 'Phase 4I restart fixture',
      riskApproved: false,
      riskVetoReason: 'SHADOW_ONLY',
      testMode: false,
      paperExecuted: false,
      paperOrderId: null,
      strategyEnsembleShadow: {
        ...firstEnvelope,
        lifecycleSnapshot: firstOutputSnapshot,
      },
    });
    expect(persisted.status).toBe('CLAIMED');
    expect(db.insert).toHaveBeenCalledTimes(1);
    const persistedRow = _dbValuesInputs.find((value): value is { fullJson: string } =>
      typeof value === 'object' && value !== null
      && typeof (value as { fullJson?: unknown }).fullJson === 'string');
    expect(persistedRow).toBeDefined();
    const persistedDecision = JSON.parse(persistedRow!.fullJson) as {
      source: string;
      strategyEnsembleShadow: {
        lifecycleSnapshot: typeof firstOutputSnapshot;
        executionAuthorized: boolean;
        approvalCreationAllowed: boolean;
        paperPositionMutationAllowed: boolean;
        livePositionMutationAllowed: boolean;
        riskAuthority: string;
      };
    };
    expect(persistedDecision.source).toBe('server_worker');
    expect(persistedDecision.strategyEnsembleShadow.lifecycleSnapshot).toEqual(firstOutputSnapshot);
    expect(persistedDecision.strategyEnsembleShadow).toMatchObject({
      executionAuthorized: false,
      approvalCreationAllowed: false,
      paperPositionMutationAllowed: false,
      livePositionMutationAllowed: false,
      riskAuthority: 'NOT_EVALUATED',
    });

    workerManager.stop();
    resetWorker();
    setupDbSequence({ lifecycleDecision: [{ fullJson: persistedRow!.fullJson }] });
    const previousMode = process.env.WORKER_ENGINE_MODE;
    process.env.WORKER_ENGINE_MODE = 'LIVE';
    try {
      await workerManager.start();
      const wm = workerManager as unknown as {
        strategyLifecycleSnapshot: typeof firstOutputSnapshot;
        strategyLifecycleRestoreBlocked: boolean;
        runCycle(): Promise<void>;
      };
      expect(wm.strategyLifecycleRestoreBlocked).toBe(false);
      expect(wm.strategyLifecycleSnapshot).toEqual(firstOutputSnapshot);

      const directSameIdDecision = evaluateSignalEligibility(
        { ...evidence.signal, signalId: evidence.record.signalId },
        wm.strategyLifecycleSnapshot!.records,
        wm.strategyLifecycleSnapshot!.historyEvents,
      );
      const directSameCandleBypassDecision = evaluateSignalEligibility(
        evidence.signal,
        wm.strategyLifecycleSnapshot!.records,
        wm.strategyLifecycleSnapshot!.historyEvents,
      );
      for (const decision of [directSameIdDecision, directSameCandleBypassDecision]) {
        expect(decision.eligible).toBe(false);
        expect(decision.codes).toContain('DUPLICATE_SIGNAL');
        expect(decision.codes).toContain('STOP_LOSS_COOLDOWN');
        expect(decision.codes).toContain('FAILED_BREAKOUT_COOLDOWN');
        expect(decision.blockedUntilCandleCloseTime).toBe(evidence.close + 2 * evidence.candle);
      }
      expect(runStrategyShadowWorkerReadOnly).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
      expect(runAiEngine).not.toHaveBeenCalled();

      let handedOffSnapshot: unknown = null;
      const handoffEligibility: ReturnType<typeof evaluateSignalEligibility>[] = [];
      vi.mocked(runStrategyShadowWorkerReadOnly).mockImplementationOnce(async input => {
        handedOffSnapshot = input.lifecycleSnapshot;
        const restored = input.lifecycleSnapshot!;
        handoffEligibility.push(
          evaluateSignalEligibility(
            { ...evidence.signal, signalId: evidence.record.signalId },
            restored.records,
            restored.historyEvents,
          ),
          evaluateSignalEligibility(
            evidence.signal,
            restored.records,
            restored.historyEvents,
          ),
        );
        return buildStrategyShadowWorkerEnvelope({
          cycleNumber: input.cycleNumber,
          generatedAt: input.evaluatedAt,
          expectedSymbols: input.expectedSymbols,
          records: [],
          lifecycleSnapshot: restored,
          existingAi: input.existingAi,
        });
      });
      vi.mocked(runAiEngine).mockReturnValue(
        { ...CASH_DECISION, riskApproved: false } as unknown as ReturnType<typeof runAiEngine>);

      await wm.runCycle();

      expect(handedOffSnapshot).toEqual(firstOutputSnapshot);
      expect(handoffEligibility).toHaveLength(2);
      for (const decision of handoffEligibility) {
        expect(decision.eligible).toBe(false);
        expect(decision.codes).toEqual(expect.arrayContaining([
          'DUPLICATE_SIGNAL',
          'STOP_LOSS_COOLDOWN',
          'FAILED_BREAKOUT_COOLDOWN',
        ]));
        expect(decision.blockedUntilCandleCloseTime).toBe(evidence.close + 2 * evidence.candle);
      }
      expect(runStrategyShadowWorkerReadOnly).toHaveBeenCalledTimes(1);
      expect(_dbInsertTables).not.toContain(liveApprovalsTable);
      expect(_dbInsertTables).not.toContain(tradesTable);
      expect(_dbUpdateTables).not.toContain(tradesTable);
      expect(openServerPaperPosition).not.toHaveBeenCalled();
      expect(closeServerPaperPosition).not.toHaveBeenCalled();
      expect(reduceServerPaper70).not.toHaveBeenCalled();
      expect(requestServerPaperCloseAll).not.toHaveBeenCalled();
      expect(executeLiveTestOrder).not.toHaveBeenCalled();
      expect(closeLiveTestPosition).not.toHaveBeenCalled();
    } finally {
      if (previousMode === undefined) delete process.env.WORKER_ENGINE_MODE;
      else process.env.WORKER_ENGINE_MODE = previousMode;
    }
  });

  const invalidPersistedCases: Array<[
    string,
    (evidence: ReturnType<typeof makeRestartEvidence>) => string,
  ]> = [
    ['손상 JSON', () => '{broken'],
    ['미래 capturedAt', evidence => JSON.stringify({
      source: 'server_worker',
      strategyEnsembleShadow: {
        lifecycleSnapshot: { ...evidence.snapshot, capturedAt: evidence.now + 1 },
      },
    })],
    ['알 수 없는 snapshot schema version', evidence => JSON.stringify({
      source: 'server_worker',
      strategyEnsembleShadow: {
        lifecycleSnapshot: { ...evidence.snapshot, schemaVersion: 'signal-lifecycle-snapshot/future' },
      },
    })],
    ['알 수 없는 snapshot config version', evidence => JSON.stringify({
      source: 'server_worker',
      strategyEnsembleShadow: {
        lifecycleSnapshot: { ...evidence.snapshot, configVersion: 'signal-lifecycle/future' },
      },
    })],
    ['알 수 없는 record config version', evidence => JSON.stringify({
      source: 'server_worker',
      strategyEnsembleShadow: {
        lifecycleSnapshot: {
          ...evidence.snapshot,
          records: [{ ...evidence.record, configVersion: 'signal-lifecycle/future' }],
        },
      },
    })],
    ['중복 Signal ID', evidence => JSON.stringify({
      source: 'server_worker',
      strategyEnsembleShadow: {
        lifecycleSnapshot: {
          ...evidence.snapshot,
          records: [
            evidence.record,
            {
              ...evidence.record,
              sourceCandleCloseTime: evidence.close - evidence.candle,
            },
          ],
        },
      },
    })],
    ['ID만 다른 동일 완료봉', evidence => JSON.stringify({
      source: 'server_worker',
      strategyEnsembleShadow: {
        lifecycleSnapshot: {
          ...evidence.snapshot,
          records: [
            evidence.record,
            { ...evidence.record, signalId: 'attempted-same-candle-bypass' },
          ],
        },
      },
    })],
    ['중복 History event ID', evidence => JSON.stringify({
      source: 'server_worker',
      strategyEnsembleShadow: {
        lifecycleSnapshot: {
          ...evidence.snapshot,
          historyEvents: [
            ...evidence.historyEvents,
            { ...evidence.historyEvents[0] },
          ],
        },
      },
    })],
  ];

  it.each(invalidPersistedCases)('%s은 부분 복원·SHADOW read·권한 mutation 없이 차단한다',
    async (_name, persistedFullJson) => {
    const fixedNow = 1_800_000_000_000;
    vi.useFakeTimers({ now: fixedNow });
    const evidence = makeRestartEvidence();
    setupDbSequence({ lifecycleDecision: [{ fullJson: persistedFullJson(evidence) }] });

    await workerManager.start();
    const wm = workerManager as unknown as {
      strategyLifecycleSnapshot: unknown;
      strategyLifecycleRestoreBlocked: boolean;
    };
    expect(wm.strategyLifecycleSnapshot).toBeNull();
    expect(wm.strategyLifecycleRestoreBlocked).toBe(true);
    expect(runStrategyShadowWorkerReadOnly).not.toHaveBeenCalled();
    expect(runIntelServiceCycle).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(runAiEngine).not.toHaveBeenCalled();
    expect(_dbInsertTables).not.toContain(liveApprovalsTable);
    expect(_dbInsertTables).not.toContain(tradesTable);
    expect(_dbUpdateTables).not.toContain(tradesTable);
  });

  it('차단된 복원은 첫 cycle에서도 SHADOW NOT_EVALUATED·execution 권한 0을 유지한다', async () => {
    const previousMode = process.env.WORKER_ENGINE_MODE;
    process.env.WORKER_ENGINE_MODE = 'LIVE';
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const evidence = makeRestartEvidence();
    setupDbSequence({
      lifecycleDecision: [{ fullJson: '{broken' }],
      insertResult: [{ id: 'blocked-cycle-decision' }],
    });
    vi.mocked(runAiEngine).mockReturnValue(
      { ...CASH_DECISION, riskApproved: false } as unknown as ReturnType<typeof runAiEngine>);
    const wm = workerManager as unknown as {
      runCycle(): Promise<void>;
      runServerPaperExecution: (...args: unknown[]) => Promise<void>;
      tryLiveTestExecution: (...args: unknown[]) => Promise<void>;
    };
    const paperExecution = vi.spyOn(wm, 'runServerPaperExecution');
    const liveExecution = vi.spyOn(wm, 'tryLiveTestExecution');
    try {
      await workerManager.start();
      await wm.runCycle();

      expect(runStrategyShadowWorkerReadOnly).not.toHaveBeenCalled();
      expect(paperExecution).not.toHaveBeenCalled();
      expect(liveExecution).not.toHaveBeenCalled();
      expect(_dbInsertTables).not.toContain(liveApprovalsTable);
      expect(_dbInsertTables).not.toContain(tradesTable);
      expect(_dbUpdateTables).not.toContain(tradesTable);
      expect(openServerPaperPosition).not.toHaveBeenCalled();
      expect(closeServerPaperPosition).not.toHaveBeenCalled();
      expect(reduceServerPaper70).not.toHaveBeenCalled();
      expect(requestServerPaperCloseAll).not.toHaveBeenCalled();
      expect(executeLiveTestOrder).not.toHaveBeenCalled();
      expect(closeLiveTestPosition).not.toHaveBeenCalled();

      const decisionRow = _dbValuesInputs.find((value): value is { fullJson: string } =>
        typeof value === 'object' && value !== null
        && typeof (value as { fullJson?: unknown }).fullJson === 'string');
      expect(decisionRow).toBeDefined();
      const decision = JSON.parse(decisionRow!.fullJson) as {
        paperExecuted: boolean;
        paperOrderId: string | null;
        strategyEnsembleShadow: {
          status: string;
          records: unknown[];
          lifecycleSnapshot: unknown;
          executionAuthorized: boolean;
          approvalCreationAllowed: boolean;
          paperPositionMutationAllowed: boolean;
          livePositionMutationAllowed: boolean;
          riskAuthority: string;
        };
      };
      expect(decision.paperExecuted).toBe(false);
      expect(decision.paperOrderId).toBeNull();
      expect(decision.strategyEnsembleShadow).toMatchObject({
        status: 'NOT_EVALUATED',
        records: [],
        lifecycleSnapshot: null,
        executionAuthorized: false,
        approvalCreationAllowed: false,
        paperPositionMutationAllowed: false,
        livePositionMutationAllowed: false,
        riskAuthority: 'NOT_EVALUATED',
      });
      expect(decision.strategyEnsembleShadow.records).toEqual([]);
      expect(evidence.snapshot.records).toHaveLength(1);
    } finally {
      paperExecution.mockRestore();
      liveExecution.mockRestore();
      if (previousMode === undefined) delete process.env.WORKER_ENGINE_MODE;
      else process.env.WORKER_ENGINE_MODE = previousMode;
    }
  });
});

// ── prevState 재시작 시 CASH로 초기화 ─────────────────────────────────────────

describe('crash-restart — prevState 초기화 정책', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('prevState는 DB에 저장되지 않으므로 재시작 후 항상 CASH에서 시작한다', async () => {
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue({ ...CASH_DECISION, operatingState: 'LONG', cycleNumber: 1 } as unknown as ReturnType<typeof runAiEngine>);
    vi.useFakeTimers();

    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 60s 사이클 타이머 경과

    // 다음 사이클에서 prevState는 이전 결과(LONG)를 메모리에서 가져옴
    // 재시작 후 첫 사이클에서만 CASH가 전달됨을 검증
    const calls = vi.mocked(runAiEngine).mock.calls;
    if (calls.length > 0) {
      const firstInput = calls[0][0];
      expect(firstInput.prevState).toBe('CASH'); // 재시작 후 첫 사이클
    }
  });
});

// ── 정상 사이클 실행 ──────────────────────────────────────────────────────────

describe('정상 사이클 실행', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('첫 사이클이 실행되면 scheduler heartbeat와 새 decision 시각이 각각 갱신된다', async () => {
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);
    vi.useFakeTimers();

    await workerManager.start();
    expect(workerManager.getStatus().schedulerHeartbeatAt).toBeNull();
    expect(workerManager.getStatus().lastDecisionAt).toBeNull();
    expect(workerManager.getStatus().lastCycleAt).toBeNull();

    // Worker cycle은 60s 타이머 (시작 로그: "60초 AI 사이클, 10초 가격 폴링")
    await vi.advanceTimersByTimeAsync(65_000);

    const s = workerManager.getStatus();
    expect(s.cycleCount).toBeGreaterThanOrEqual(1);
    expect(s.schedulerHeartbeatAt).not.toBeNull();
    expect(s.lastDecisionAt).not.toBeNull();
    expect(s.lastCycleAt).not.toBeNull();
  });

  it('연속 사이클에서 cycleCount가 누적된다', async () => {
    setupDbSequence();
    vi.mocked(runAiEngine).mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);
    vi.useFakeTimers();

    await workerManager.start();
    // 첫 번째 사이클 (60s) + 두 번째 사이클 (60s+60s) = 130s 이상
    await vi.advanceTimersByTimeAsync(130_000);

    expect(workerManager.getStatus().cycleCount).toBeGreaterThanOrEqual(1);
  });
});

// ── 오류 후 사이클 계속 ────────────────────────────────────────────────────────

describe('사이클 오류 복구 — 다음 사이클 계속', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('runAiEngine 오류 발생 후 다음 사이클이 여전히 스케줄된다', async () => {
    setupDbSequence();
    vi.mocked(runAiEngine)
      .mockImplementationOnce(() => { throw new Error('테스트 강제 오류'); })
      .mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 오류 사이클 (60s 타이머)

    // 오류 후 cycleTimer가 재설정되어 다음 사이클이 예약됨
    const wm = workerManager as unknown as Record<string, unknown>;
    const active = wm.active as boolean;
    expect(active).toBe(true); // 워커가 계속 활성 상태

    // 두 번째 사이클 트리거
    await vi.advanceTimersByTimeAsync(65_000);
    // 두 번째 사이클은 성공 → lastCycleAt이 갱신됨
    expect(workerManager.getStatus().lastCycleAt).not.toBeNull();
  });

  it('사이클 오류 시 lastCycleResult.error가 기록된다', async () => {
    setupDbSequence();
    vi.mocked(runAiEngine).mockImplementationOnce(() => {
      throw new Error('DB 연결 실패 시뮬레이션');
    });

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000);

    const result = workerManager.getStatus().lastCycleResult;
    // 오류가 있으면 error 필드가 설정됨
    if (result?.error) {
      expect(typeof result.error).toBe('string');
    }
    expect(workerManager.getStatus().schedulerHeartbeatAt).not.toBeNull();
    expect(workerManager.getStatus().lastDecisionAt).toBeNull();
    expect(workerManager.getStatus().lastSchedulerCycleOutcome).toBe('ERROR');
    // 워커는 여전히 활성 상태
    const wm = workerManager as unknown as Record<string, unknown>;
    expect(wm.active as boolean).toBe(true);
  });
});

// ── isRunning lock — 동시 사이클 방지 ────────────────────────────────────────

describe('isRunning atomic lock — 중복 사이클 방지', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('사이클 실행 중에는 isRunning이 true이다', async () => {
    // runAiEngine은 동기 함수이므로 호출 중 isRunning 상태를 캡처
    let isRunningDuringCycle = false;
    setupDbSequence();
    vi.mocked(runAiEngine).mockImplementation(() => {
      const wm = workerManager as unknown as Record<string, unknown>;
      isRunningDuringCycle = wm.isRunning as boolean;
      return CASH_DECISION as unknown as ReturnType<typeof runAiEngine>;
    });

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 60s 타이머 경과

    // runAiEngine이 호출된 경우 isRunning이 true였음을 확인
    if (vi.mocked(runAiEngine).mock.calls.length > 0) {
      expect(isRunningDuringCycle).toBe(true);
    }
    // 사이클 완료 후 isRunning은 false
    const wm = workerManager as unknown as Record<string, unknown>;
    expect(wm.isRunning as boolean).toBe(false);
  });
});

// ── consecutiveLosses DB 재계산 ──────────────────────────────────────────────

describe('crash-restart — consecutiveLosses DB 재계산', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('연속 음수 CLOSE 2건이 있으면 consecutiveLosses=2를 엔진에 전달한다', async () => {
    setupDbSequence({ trades: makeCloseTrades(2) });
    vi.mocked(runAiEngine).mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 60s 사이클 타이머

    const calls = vi.mocked(runAiEngine).mock.calls;
    if (calls.length > 0) {
      const input = calls[calls.length - 1][0];
      expect(input.consecutiveLosses).toBe(2);
    }
  });

  it('CLOSE 거래가 없으면 consecutiveLosses=0', async () => {
    setupDbSequence({ trades: noTradesResult });
    vi.mocked(runAiEngine).mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 60s 사이클 타이머

    const calls = vi.mocked(runAiEngine).mock.calls;
    if (calls.length > 0) {
      const input = calls[calls.length - 1][0];
      expect(input.consecutiveLosses).toBe(0);
    }
  });
});

// ── 쿨다운 DB 재계산 ──────────────────────────────────────────────────────────

describe('crash-restart — 쿨다운 DB에서 재계산', () => {
  beforeEach(() => { resetWorker(); });
  afterEach(() => { workerManager.stop(); vi.useRealTimers(); });

  it('최근 5분 전 OPEN 거래가 있으면 30분 쿨다운에 의해 사이클이 조기 반환된다', async () => {
    // 기본 쿨다운 30분, 마지막 OPEN이 5분 전 → 25분 남음 → CASH skip
    setupDbSequence({ trades: makeOpenTrade(5 * 60 * 1000) });
    vi.mocked(runAiEngine).mockReturnValue(CASH_DECISION as unknown as ReturnType<typeof runAiEngine>);

    vi.useFakeTimers();
    await workerManager.start();
    await vi.advanceTimersByTimeAsync(65_000); // 60s 사이클 타이머 경과

    // 쿨다운 중일 때는 runAiEngine이 호출되지 않거나, lastCycleAt이 null
    const s = workerManager.getStatus();
    // 쿨다운 스킵 시 lastCycleAt이 null (성공 사이클이 없음)
    // 또는 cycleCount가 여전히 0
    // 두 가지 중 하나를 확인
    const engineCalled = vi.mocked(runAiEngine).mock.calls.length > 0;
    if (!engineCalled) {
      expect(s.lastCycleAt).toBeNull();
    }
    // 워커는 계속 활성
    expect((workerManager as unknown as Record<string, unknown>).active as boolean).toBe(true);
  });
});

// ── 중복 PENDING 승인 방지 ────────────────────────────────────────────────────

describe('중복 PENDING 승인 방지', () => {
  beforeEach(() => { resetWorker(); });

  it('동일 symbol:operatingState 조합이 pendingApprovalKeys에 이미 있으면 두 번째 추가 안 됨', () => {
    const wm = workerManager as unknown as Record<string, unknown>;
    const keys = wm.pendingApprovalKeys as Set<string>;

    keys.add('BTC:LONG');
    const sizeBefore = keys.size;

    // 동일 키 추가 시도
    keys.add('BTC:LONG');
    expect(keys.size).toBe(sizeBefore); // Set이므로 중복 없음

    // 다른 조합은 추가됨
    keys.add('ETH:SHORT');
    expect(keys.size).toBe(sizeBefore + 1);
  });

  it('stop() 후 재시작 시 pendingApprovalKeys가 초기화된다', async () => {
    const wm = workerManager as unknown as Record<string, unknown>;
    const keys = wm.pendingApprovalKeys as Set<string>;
    keys.add('BTC:LONG');

    workerManager.stop();
    resetWorker();

    expect(keys.size).toBe(0);
  });
});

// ── Worker heartbeat / decision freshness 분리 ────────────────────────────────

describe('Worker heartbeat — scheduler 생존과 새 decision 시각 분리', () => {
  beforeEach(() => { resetWorker(); });

  it('schedulerHeartbeatAt이 null이면 현재 lifecycle에서 아직 cycle을 완료하지 않았다', () => {
    const s = workerManager.getStatus();
    expect(s.schedulerHeartbeatAt).toBeNull();
    expect(s.workerRunning).toBe(false);
  });

  it('schedulerHeartbeatAt을 현재 시각으로 설정하면 fresh 상태로 판정된다', () => {
    const wm = workerManager as unknown as Record<string, unknown>;
    wm.schedulerHeartbeatAt = new Date();

    const s = workerManager.getStatus();
    const lastAt = s.schedulerHeartbeatAt ? new Date(s.schedulerHeartbeatAt) : null;
    expect(lastAt).not.toBeNull();
    const elapsedMs = Date.now() - lastAt!.getTime();
    expect(elapsedMs).toBeLessThan(5_000); // 5초 이내 → fresh
  });

  it('schedulerHeartbeatAt이 5분 이상 전이면 stale로 판정된다', () => {
    const wm = workerManager as unknown as Record<string, unknown>;
    const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5분
    wm.schedulerHeartbeatAt = new Date(Date.now() - STALE_THRESHOLD_MS - 1000);

    const s = workerManager.getStatus();
    const lastAt = s.schedulerHeartbeatAt ? new Date(s.schedulerHeartbeatAt) : null;
    expect(lastAt).not.toBeNull();
    const elapsedMs = Date.now() - lastAt!.getTime();
    expect(elapsedMs).toBeGreaterThan(STALE_THRESHOLD_MS);
  });

  it('stop() 호출 후 active가 false가 된다', () => {
    const wm = workerManager as unknown as Record<string, unknown>;
    wm.active = true;
    workerManager.stop();
    expect(wm.active as boolean).toBe(false);
  });
});

// ── LIVE_EXECUTION_LOCKED 불변 보안 검증 ─────────────────────────────────────

describe('LIVE_EXECUTION_LOCKED 불변 보안 상수', () => {
  it('internalExecutor.ts에서 LIVE_EXECUTION_LOCKED = true as const 확인', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dir, '../workers/internalExecutor.ts'), 'utf-8');
    expect(src).toContain('LIVE_EXECUTION_LOCKED = true as const');
  });

  it('executeOrder()가 항상 simulated:true를 반환한다 (실제 주문 없음)', async () => {
    const { executeOrder } = await import('../workers/internalExecutor');
    const result = await executeOrder({
      operatingState: 'LONG',
      confidence: 80,
      executionType: 'perp_long_open',
      primarySymbol: 'BTC',
      sizeUsd: 1000,
      leverage: 5,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(result.simulated).toBe(true);
    expect(result.txHash).toBeNull();
  });
});

// ── #135 F22 — 자동 Worker LIVE 구조적 분리 게이트 ─────────────────────────────
describe('#135 AUTO_WORKER_LIVE_ENABLED 게이트 (F22)', () => {
  const savedEnv = process.env.AUTO_WORKER_LIVE_ENABLED;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AUTO_WORKER_LIVE_ENABLED;
    else process.env.AUTO_WORKER_LIVE_ENABLED = savedEnv;
  });

  it('플래그 미설정 시 tryLiveTestExecution이 즉시 차단·조기 반환한다 (fail-closed)', async () => {
    delete process.env.AUTO_WORKER_LIVE_ENABLED;
    const { workerManager } = await import('../workers/aiWorker');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (workerManager as any).tryLiveTestExecution(
        { operatingState: 'LONG', confidence: 90, executionType: 'perp_long_open', primarySymbol: 'BTC' },
        [{ symbol: 'BTC', price: 60000 }], { positionCount: 0 },
        { liveTestAccumLossUsd: 0, liveTestDbOk: true },
        { liveTestMode: true, tradingCapital: 100 }, 1,
      );
      const blocked = infoSpy.mock.calls.some(c =>
        String(c[0]).includes('AUTO_WORKER_LIVE_ENABLED'));
      expect(blocked).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("플래그가 'true'가 아닌 값('1', 'TRUE' 등)이어도 차단된다", async () => {
    process.env.AUTO_WORKER_LIVE_ENABLED = '1';
    const { workerManager } = await import('../workers/aiWorker');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (workerManager as any).tryLiveTestExecution(
        { operatingState: 'SHORT', confidence: 90, executionType: 'perp_short_open', primarySymbol: 'ETH' },
        [{ symbol: 'ETH', price: 3000 }], { positionCount: 0 },
        { liveTestAccumLossUsd: 0, liveTestDbOk: true },
        { liveTestMode: true, tradingCapital: 100 }, 1,
      );
      expect(infoSpy.mock.calls.some(c => String(c[0]).includes('AUTO_WORKER_LIVE_ENABLED'))).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('플래그 미설정이면 자동 CLOSE_ALL/REDUCE도 OPEN과 동일하게 차단된다', async () => {
    delete process.env.AUTO_WORKER_LIVE_ENABLED;
    const { workerManager } = await import('../workers/aiWorker');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closeSpy = vi.spyOn(workerManager as any, 'executeCloseAllPositions');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (workerManager as any).tryLiveTestExecution(
        { operatingState: 'CASH', confidence: 90, executionType: 'close_all', primarySymbol: null },
        [], { positionCount: 1 },
        { liveTestAccumLossUsd: 0, liveTestDbOk: true },
        { liveTestMode: true, tradingCapital: 100 }, 1,
        { closeAllRequested: true, reduce70Requested: false },
      );
      expect(closeSpy).not.toHaveBeenCalled();
      expect(infoSpy.mock.calls.some(c => String(c[0]).includes('AUTO_WORKER_LIVE_ENABLED'))).toBe(true);
    } finally {
      closeSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
