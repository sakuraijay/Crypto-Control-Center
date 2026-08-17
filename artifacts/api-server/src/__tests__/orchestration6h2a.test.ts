/**
 * 6H-2A §11 — 70% 축소·close-all orchestration 실배선 E2E (11~20) +
 * 리스크 트리거 5종(+10%/-3%/-8%/$850/emergency) → CLOSE_ALL 액션 검증.
 *
 * DB 불필요 (CI db-free) — liveTestExecutor 실행 함수는 mock으로 대체하고
 * WorkerManager의 orchestration 메서드가 "실제 청산 시도 결과"로 요약을
 * 갱신하는지(=CASH 표시만으로 완료 금지)를 검증한다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── DB mock (aiWorker가 top-level import) ────────────────────────────────────
function chain(getResult: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from','where','limit','offset','orderBy','set','values',
                   'onConflictDoNothing','onConflictDoUpdate','returning']) {
    c[m] = () => c;
  }
  (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
    (resolve) => Promise.resolve(getResult()).then(resolve);
  return c;
}
vi.mock('@workspace/db', () => ({
  db: {
    select: vi.fn().mockImplementation(() => chain(() => [])),
    insert: vi.fn().mockImplementation(() => chain(() => undefined)),
    update: vi.fn().mockImplementation(() => chain(() => 0)),
    delete: vi.fn().mockImplementation(() => chain(() => 0)),
  },
  aiDecisionsTable:    new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  liveApprovalsTable:  new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  strategyConfigTable: new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  tradesTable:         new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
  workerStateTable:    new Proxy({}, { get: (_, k) => ({ col: String(k) }) }),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})), desc: vi.fn(() => ({})), lt: vi.fn(() => ({})),
  and: vi.fn(() => ({})), or: vi.fn(() => ({})),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
}));
vi.mock('../routes/gmx', () => ({
  getCachedPrices: vi.fn(() => new Map<string, number[]>()),
  getCachedChange24h: vi.fn(() => new Map<string, number>()),
  ensureGmxPoller: vi.fn(),
  fetchServerLiveTestData: vi.fn().mockResolvedValue({
    liveTestAccumLossUsd: 0, liveTestDbOk: true, livePositionCount: 1,
  }),
  default: {},
}));

// ── liveTestExecutor mock — 제출 횟수·인자 검증용 ─────────────────────────────
const closeMock = vi.fn();
const openMock = vi.fn();
let authoritativePositions: { marketAddress: string; isLong: boolean; sizeUsd: number }[] | null = [];
vi.mock('../workers/liveTestExecutor', () => ({
  executeLiveTestOrder: (...a: unknown[]) => openMock(...a),
  closeLiveTestPosition: (...a: unknown[]) => closeMock(...a),
  fetchAuthoritativeOpenPositions: vi.fn(async () => authoritativePositions),
  getLastSizingEnforcement: vi.fn(() => null),
  isStopExecutionAvailable: vi.fn(() => false),
  STOP_EXECUTION_UNAVAILABLE: 'STOP_EXECUTION_UNAVAILABLE',
}));

import { workerManager } from '../workers/aiWorker';
import { MARKET_BY_SYMBOL_SERVER } from '../lib/gmxMarkets';
import { evaluateRiskState, EMPTY_LOCKS, type RiskEvaluationInput } from '../lib/riskStateMachine';

const ETH_MARKET = MARKET_BY_SYMBOL_SERVER.get('ETH')!.marketToken;
const BTC_MARKET = MARKET_BY_SYMBOL_SERVER.get('BTC')!.marketToken;

const wm = workerManager as unknown as {
  executeCloseAllPositions: (...a: unknown[]) => Promise<void>;
  executeProfitProtectReduction: (...a: unknown[]) => Promise<void>;
  lastCloseAllSummary: { lockRequired: boolean; allConfirmed: boolean; total: number; pending: number } | null;
};

const decision = { id: 'd-6h2a', operatingState: 'CASH', primarySymbol: 'ETH' };
const paperState = { liveTestAccumLossUsd: 0, liveTestDbOk: true };
const limits = { liveTestMode: true } as Record<string, unknown>;
const analyses = [
  { symbol: 'ETH', price: 3000 },
  { symbol: 'BTC', price: 60000 },
];

beforeEach(() => {
  closeMock.mockReset();
  openMock.mockReset();
  authoritativePositions = [];
  wm.lastCloseAllSummary = null;
  closeMock.mockResolvedValue({ ok: true, txHash: null, orderKey: 'gmxreq:1', simulated: false, executedAt: new Date().toISOString() });
});

describe('§11-11 70% 축소 orchestration', () => {
  it('포지션 size의 정확히 70%(보수적 내림)로 부분 청산 1회 제출', async () => {
    authoritativePositions = [{ marketAddress: ETH_MARKET, isLong: true, sizeUsd: 100 }];
    await wm.executeProfitProtectReduction(decision, paperState, limits, 7, '0xMain', analyses);
    expect(closeMock).toHaveBeenCalledTimes(1); // §11-20: submit 최대 1회
    const arg = closeMock.mock.calls[0][0] as { sizeUsd: number; symbol: string; isLong: boolean };
    expect(arg.sizeUsd).toBeCloseTo(70, 6);
    expect(arg.sizeUsd).toBeLessThanOrEqual(100 * 0.7 + 1e-9); // 70% 초과 절대 금지
    expect(arg.symbol).toBe('ETH');
  });

  it('잔여 30%가 최소 포지션 미만이면 100% 종료로 전환', async () => {
    authoritativePositions = [{ marketAddress: ETH_MARKET, isLong: true, sizeUsd: 5 }]; // 잔여 $1.5 < $2
    await wm.executeProfitProtectReduction(decision, paperState, limits, 7, '0xMain', analyses);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect((closeMock.mock.calls[0][0] as { sizeUsd: number }).sizeUsd).toBeCloseTo(5, 6);
  });

  it('authoritative 조회 실패 → 실행 0회 (fail-closed)', async () => {
    authoritativePositions = null;
    await wm.executeProfitProtectReduction(decision, paperState, limits, 7, '0xMain', analyses);
    expect(closeMock).not.toHaveBeenCalled();
  });
});

describe('§11-14~19 close-all orchestration', () => {
  it('포지션 2건 전수 청산 — 포지션별 정확히 1회 제출, 전부 제출 수락 시에도 SUBMITTED(잠금 유지)', async () => {
    authoritativePositions = [
      { marketAddress: ETH_MARKET, isLong: true, sizeUsd: 10 },
      { marketAddress: BTC_MARKET, isLong: false, sizeUsd: 12 },
    ];
    await wm.executeCloseAllPositions(decision, paperState, limits, 8, '0xMain', analyses);
    expect(closeMock).toHaveBeenCalledTimes(2); // §11-20: 포지션당 최대 1회
    const summary = wm.lastCloseAllSummary!;
    expect(summary.total).toBe(2);
    // SUBMITTED는 온체인 확정 전 — allConfirmed=false, lockRequired=true 유지
    expect(summary.allConfirmed).toBe(false);
    expect(summary.lockRequired).toBe(true);
  });

  it('19. 시뮬레이션(잠금) 결과는 PENDING — CASH 표시만으로 완료 처리 금지', async () => {
    authoritativePositions = [{ marketAddress: ETH_MARKET, isLong: true, sizeUsd: 10 }];
    closeMock.mockResolvedValue({ ok: true, txHash: null, orderKey: null, simulated: true, executedAt: new Date().toISOString() });
    await wm.executeCloseAllPositions(decision, paperState, limits, 8, '0xMain', analyses);
    const summary = wm.lastCloseAllSummary!;
    expect(summary.pending).toBe(1);
    expect(summary.lockRequired).toBe(true);
    expect(summary.allConfirmed).toBe(false);
  });

  it('청산 실패 → FAILED 기록 + lockRequired 유지', async () => {
    authoritativePositions = [{ marketAddress: ETH_MARKET, isLong: true, sizeUsd: 10 }];
    closeMock.mockResolvedValue({ ok: false, txHash: null, orderKey: null, simulated: false, error: 'gate', executedAt: new Date().toISOString() });
    await wm.executeCloseAllPositions(decision, paperState, limits, 8, '0xMain', analyses);
    expect(wm.lastCloseAllSummary!.lockRequired).toBe(true);
  });

  it('authoritative 조회 실패 → 청산 시도 0회 + lockRequired=true (fail-closed)', async () => {
    authoritativePositions = null;
    await wm.executeCloseAllPositions(decision, paperState, limits, 8, '0xMain', analyses);
    expect(closeMock).not.toHaveBeenCalled();
    expect(wm.lastCloseAllSummary!.lockRequired).toBe(true);
  });
});

// ── 리스크 트리거 5종 → CLOSE_ALL_POSITIONS 액션 (E2E 진입점) ─────────────────
function baseRisk(over: Partial<RiskEvaluationInput> = {}): RiskEvaluationInput {
  return {
    dailyRiskCapitalUsd: 1000, weeklyRiskCapitalUsd: 1000, currentEquityUsd: 1000,
    dailyRealizedNetPnlUsd: 0, dailyLossAwareNetPnlUsd: 0, estimatedExitNetPnlUsd: null,
    weeklyRealizedNetPnlUsd: 0, dailyEntryCount: 0, consecutiveLossCount: 0,
    openPositionCount: 1, dbOk: true, feeDataOk: true, marketDataFresh: true,
    locks: { ...EMPTY_LOCKS }, ...over,
  };
}

describe('§11-14~18 close-all 트리거 5종', () => {
  it('14. +10% 절대 상한 → CLOSE_ALL_POSITIONS', () => {
    const r = evaluateRiskState(baseRisk({ dailyRealizedNetPnlUsd: 100 }));
    expect(r.actions).toContain('CLOSE_ALL_POSITIONS');
    expect(r.entryAllowed).toBe(false);
  });
  it('15. -3% 일일 손실 → CLOSE_ALL_POSITIONS', () => {
    const r = evaluateRiskState(baseRisk({ dailyLossAwareNetPnlUsd: -30 }));
    expect(r.actions).toContain('CLOSE_ALL_POSITIONS');
    expect(r.state).toBe('DAILY_LOSS_LOCKED');
  });
  it('16. -8% 주간 손실 → CLOSE_ALL_POSITIONS', () => {
    const r = evaluateRiskState(baseRisk({ weeklyRealizedNetPnlUsd: -80 }));
    expect(r.actions).toContain('CLOSE_ALL_POSITIONS');
    expect(r.state).toBe('WEEKLY_LOSS_LOCKED');
  });
  it('17. equity ≤ $850 hard stop → CLOSE_ALL_POSITIONS + 영구 차단', () => {
    const r = evaluateRiskState(baseRisk({ currentEquityUsd: 850 }));
    expect(r.actions).toContain('CLOSE_ALL_POSITIONS');
    expect(r.state).toBe('HARD_STOPPED');
    // 자동 해제 금지 — 잠금 이월 시 즉시 차단
    const again = evaluateRiskState(baseRisk({ currentEquityUsd: 999, locks: r.locks }));
    expect(again.state).toBe('HARD_STOPPED');
  });
  it('18. +5% Profit Protection에서 floor 후퇴 → 잔여 전량 종료(CLOSE_ALL)', () => {
    const first = evaluateRiskState(baseRisk({ estimatedExitNetPnlUsd: 50 }));
    expect(first.actions).toContain('REDUCE_POSITION_70PCT');
    const retreat = evaluateRiskState(baseRisk({ estimatedExitNetPnlUsd: 30, locks: first.locks }));
    expect(retreat.actions).toContain('CLOSE_ALL_POSITIONS');
  });
});
