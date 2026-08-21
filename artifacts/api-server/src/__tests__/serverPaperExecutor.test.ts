/**
 * Task #111 — 서버 권위 PAPER 실행기 adversarial 테스트.
 *
 * 시나리오: 정상 OPEN / 비용 누락·rate null / stale·합성 가격 / 게이트(동시 1개·
 * 일일 3회·레버리지 3배) / 중복 OPEN(unique) / SL·TP 터치 / CLOSE idempotency /
 * 정산(순손익 = gross − 진입·청산·funding·borrowing) / REDUCE70 1회 예약 /
 * pendingClose 영속·해제 / 구조적 LIVE 경로 import 0회.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mock (ESM 호이스팅 — regression-test-architecture 패턴) ────────────────
vi.mock('@workspace/db', () => {
  function chain(getResult: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'set', 'values',
      'onConflictDoNothing', 'onConflictDoUpdate', 'returning']) {
      c[m] = () => c;
    }
    (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
      (resolve) => Promise.resolve(getResult()).then(resolve);
    return c;
  }
  return {
    db: {
      select: vi.fn(() => chain(() => [])),
      insert: vi.fn(() => chain(() => [{ id: 'x' }])),
      update: vi.fn(() => chain(() => [])),
      delete: vi.fn(() => chain(() => 0)),
    },
    tradesTable: {
      id: 'id', symbol: 'symbol', side: 'side', action: 'action', size: 'size',
      price: 'price', pnl: 'pnl', strategy: 'strategy', timestamp: 'timestamp',
      closeTime: 'close_time', sizeInUsd: 'size_in_usd', managedBy: 'managed_by',
      openDecisionId: 'open_decision_id', closesTradeId: 'closes_trade_id',
      closeKind: 'close_kind', stopPriceUsd: 'stop_price_usd',
      takeProfitPriceUsd: 'take_profit_price_usd', leverage: 'leverage',
      estEntryCostUsd: 'est_entry_cost_usd', estExitCostUsd: 'est_exit_cost_usd',
      fundingRatePerHour: 'funding_rate_per_hour', borrowingRatePerHour: 'borrowing_rate_per_hour',
      costFetchedAt: 'cost_fetched_at', costSource: 'cost_source',
      $inferSelect: {},
    },
    workerStateTable: { key: 'key', value: 'value', updatedAt: 'updated_at' },
  };
});

vi.mock('../lib/paperCostCache', () => ({
  getPaperCostBinding: vi.fn(() => null),
}));

import { db } from '@workspace/db';
import { getPaperCostBinding } from '../lib/paperCostCache';
import {
  openServerPaperPosition, closeServerPaperPosition, reduceServerPaper70,
  requestServerPaperCloseAll, loadPendingCloseFromDb, manageServerPaperTick,
  reconcileStartupCloseIntent,
  getServerPaperStatus, __resetServerPaperStateForTests,
  MAX_ENTRY_PRICE_AGE_MS, MAX_MANAGE_PRICE_AGE_MS, PENDING_CLOSE_KEY,
} from '../workers/serverPaperExecutor';

function makeChain(getResult: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'set', 'values',
    'onConflictDoNothing', 'onConflictDoUpdate', 'returning']) {
    c[m] = () => c;
  }
  (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
    (resolve) => Promise.resolve(getResult()).then(resolve);
  return c;
}

const FRESH_BINDING = {
  costSource: 'PAPER_GMX_ESTIMATE' as const,
  estEntryCostUsd: 0.9,
  estExitCostUsd: 0.7,
  fundingRatePerHourFraction: 0.00001,
  borrowingRatePerHourFraction: 0.00002,
  costFetchedAt: new Date().toISOString(),
};

const BASE_OPEN = {
  decisionId: 'dec-1',
  symbol: 'BTC',
  side: 'LONG' as const,
  sizeUsd: 300,
  leverage: 3,
  quote: { priceUsd: 50_000, ageMs: 5_000 },
  tpPriceUsd: 52_000,
  openPositionCount: 0,
  entriesManilaDay: 0,
  riskProfileSnapshot: {
    name: 'conservative' as const,
    version: 'risk-profile/v1' as const,
    appliedAt: '2026-08-21T00:00:00.000Z',
    derivedLimits: {
      immediateEntryThreshold: 80, maxRiskPerTradePct: 0.75, reserveCashPct: 20,
      maxMarginPerTradeUsd: 334, maxConcurrentPositions: 1, cooldownMinutes: 30,
      maxLeverage: 3, maxTotalExposureUsd: 3_000,
      allocatedTradingCapitalUsd: 1_000, maxRiskPerTradeUsd: 7.5,
    },
  },
};

/** 서버 OPEN 행 fixture (managed_by='SERVER', close_time=0) */
function serverOpenRow(over: Record<string, unknown> = {}) {
  return {
    id: 'open-1', symbol: 'BTC', side: 'LONG', action: 'OPEN',
    size: '300', sizeInUsd: '300', price: '50000', pnl: '0',
    strategy: 'SERVER_WORKER_AI', timestamp: new Date(Date.now() - 3_600_000),
    closeTime: 0, managedBy: 'SERVER', leverage: '3',
    costSource: 'PAPER_GMX_ESTIMATE', estEntryCostUsd: '0.9', estExitCostUsd: '0.7',
    fundingRatePerHour: '0.00001', borrowingRatePerHour: '0.00002',
    costFetchedAt: new Date(), collateralToken: 'USDC',
    stopPriceUsd: '49500', takeProfitPriceUsd: '52000',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetServerPaperStateForTests();
  vi.mocked(getPaperCostBinding).mockReturnValue(FRESH_BINDING as ReturnType<typeof getPaperCostBinding>);
  vi.mocked(db.select).mockImplementation(() => makeChain(() => []) as never);
  vi.mocked(db.insert).mockImplementation(() => makeChain(() => [{ id: 'ins' }]) as never);
  vi.mocked(db.update).mockImplementation(() => makeChain(() => []) as never);
  vi.mocked(db.delete).mockImplementation(() => makeChain(() => 0) as never);
});

// ── OPEN — 정상 경로 ──────────────────────────────────────────────────────────

describe('openServerPaperPosition — 정상', () => {
  it('신선 시세+완전 비용 결속이면 OPEN 성공, SL/TP 계약 포함', async () => {
    const r = await openServerPaperPosition({ ...BASE_OPEN });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stopPriceUsd).toBeCloseTo(50_000 * 0.99, 6); // 1% stop distance
      expect(r.tpPriceUsd).toBe(52_000);
    }
    expect(db.insert).toHaveBeenCalledTimes(1);
    const status = getServerPaperStatus();
    expect(status.lastOpenAttempt?.ok).toBe(true);
  });

  it('SHORT의 이익 반대 방향 TP는 버린다 (엉뚱한 TP 저장 금지)', async () => {
    const r = await openServerPaperPosition({
      ...BASE_OPEN, side: 'SHORT', tpPriceUsd: 52_000, // SHORT인데 TP가 진입가 위 = 손실 방향
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tpPriceUsd).toBeNull();
  });
});

// ── OPEN — fail-closed 거부 시나리오 ─────────────────────────────────────────

describe('openServerPaperPosition — fail-closed', () => {
  it('비용 스냅샷 부재 → NO_TRADE (DB 미접촉)', async () => {
    vi.mocked(getPaperCostBinding).mockReturnValue(null);
    const r = await openServerPaperPosition({ ...BASE_OPEN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('비용');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('funding rate null → NO_TRADE (0 대체 금지)', async () => {
    vi.mocked(getPaperCostBinding).mockReturnValue({
      ...FRESH_BINDING, fundingRatePerHourFraction: null,
    } as never);
    const r = await openServerPaperPosition({ ...BASE_OPEN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('rate 누락');
  });

  it('시세 stale (>60s) → NO_TRADE', async () => {
    const r = await openServerPaperPosition({
      ...BASE_OPEN, quote: { priceUsd: 50_000, ageMs: MAX_ENTRY_PRICE_AGE_MS + 1 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('stale');
  });

  it('시세 부재/0 → NO_TRADE (합성 가격 금지)', async () => {
    expect((await openServerPaperPosition({ ...BASE_OPEN, quote: null })).ok).toBe(false);
    expect((await openServerPaperPosition({ ...BASE_OPEN, quote: { priceUsd: 0, ageMs: 1 } })).ok).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('동시 포지션 1개 초과 → 거부 (물타기 금지)', async () => {
    const r = await openServerPaperPosition({ ...BASE_OPEN, openPositionCount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('동시 포지션');
  });

  it('Manila 일일 3회 도달 → 거부', async () => {
    const r = await openServerPaperPosition({ ...BASE_OPEN, entriesManilaDay: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('일일 진입 한도');
  });

  it('레버리지 3배 초과 → 거부', async () => {
    const r = await openServerPaperPosition({ ...BASE_OPEN, leverage: 4 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('leverage');
  });

  it('decisionId 없음 → 거부 (idempotency 불가)', async () => {
    const r = await openServerPaperPosition({ ...BASE_OPEN, decisionId: '' });
    expect(r.ok).toBe(false);
  });

  it('unique index 위반(중복 결정/이중 OPEN) → no-op 거부', async () => {
    vi.mocked(db.insert).mockImplementation(() => {
      const c = makeChain(() => { throw new Error('duplicate key value violates unique constraint'); });
      return c as never;
    });
    const r = await openServerPaperPosition({ ...BASE_OPEN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('중복');
  });

  it('insert 결과 0행(onConflictDoNothing) → 중복 no-op', async () => {
    vi.mocked(db.insert).mockImplementation(() => makeChain(() => []) as never);
    const r = await openServerPaperPosition({ ...BASE_OPEN });
    expect(r.ok).toBe(false);
  });
});

// ── CLOSE — idempotency + 정산 ────────────────────────────────────────────────

describe('closeServerPaperPosition', () => {
  it('정상 FULL 청산 — 순손익 = gross − 진입 − 청산 − funding − borrowing', async () => {
    const openedAgoMs = 3_600_000; // 1시간
    const row = serverOpenRow({ timestamp: new Date(Date.now() - openedAgoMs) });
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [row]) as never);
    const r = await closeServerPaperPosition({
      openTradeId: 'open-1', reason: 'TAKE_PROFIT', kind: 'FULL',
      quote: { priceUsd: 51_000, ageMs: 1_000 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // gross = (51000-50000)/50000 * 300 = +6
      expect(r.grossPnlUsd).toBeCloseTo(6, 6);
      expect(r.netPnlEstimatedUsd).not.toBeNull();
      // 비용 = 0.9 + 0.7 + holding(1h, 센트 올림: funding ceil(300*1e-5*1*100)/100=0.01, borrowing 0.01)
      expect(r.netPnlEstimatedUsd!).toBeCloseTo(6 - 0.9 - 0.7 - 0.01 - 0.01, 2);
    }
    expect(db.insert).toHaveBeenCalledTimes(1); // CLOSE 행
    expect(db.update).toHaveBeenCalledTimes(1); // OPEN close_time 확정
  });

  it('이미 청산된 행 → alreadyClosed no-op (중복 CLOSE 절대 금지)', async () => {
    const row = serverOpenRow({ closeTime: Date.now() });
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [row]) as never);
    const r = await closeServerPaperPosition({
      openTradeId: 'open-1', reason: 'STOP_LOSS', kind: 'FULL',
      quote: { priceUsd: 49_000, ageMs: 1_000 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alreadyClosed).toBe(true);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('시세 stale → 청산 보류 (포지션 유지, 다음 틱 재시도)', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [serverOpenRow()]) as never);
    const r = await closeServerPaperPosition({
      openTradeId: 'open-1', reason: 'STOP_LOSS', kind: 'FULL',
      quote: { priceUsd: 49_000, ageMs: MAX_MANAGE_PRICE_AGE_MS + 1 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('보류');
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('서버 관리 행이 아니면 거부', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [serverOpenRow({ managedBy: null })]) as never);
    const r = await closeServerPaperPosition({
      openTradeId: 'open-1', reason: 'X', kind: 'FULL', quote: { priceUsd: 50_000, ageMs: 1 },
    });
    expect(r.ok).toBe(false);
  });

  it('CLOSE 행 unique conflict → repair 경로 (OPEN 확정 UPDATE는 진행)', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [serverOpenRow()]) as never);
    vi.mocked(db.insert).mockImplementation(() => {
      const c = makeChain(() => { throw new Error('duplicate key value violates unique constraint "trades_full_close_uq"'); });
      return c as never;
    });
    const r = await closeServerPaperPosition({
      openTradeId: 'open-1', reason: 'STOP_LOSS', kind: 'FULL',
      quote: { priceUsd: 49_000, ageMs: 1_000 },
    });
    expect(r.ok).toBe(true); // 자가 치유 — close_time 확정만 재시도
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('비용 필드 결손 OPEN 행 → 청산은 진행하되 net=null (0 대체 금지)', async () => {
    vi.mocked(db.select).mockImplementation(() =>
      makeChain(() => [serverOpenRow({ estEntryCostUsd: null, costSource: null })]) as never);
    const r = await closeServerPaperPosition({
      openTradeId: 'open-1', reason: 'STOP_LOSS', kind: 'FULL',
      quote: { priceUsd: 49_000, ageMs: 1_000 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.netPnlEstimatedUsd).toBeNull();
  });
});

// ── REDUCE70 — durable 1회 예약 ───────────────────────────────────────────────

describe('reduceServerPaper70', () => {
  it('기존 예약 기록 존재 → 상태 불문 재실행 금지', async () => {
    // worker_state 조회가 기존 CONFIRMED 기록 반환
    let selectCall = 0;
    vi.mocked(db.select).mockImplementation(() => makeChain(() => {
      selectCall += 1;
      return [{
        key: 'k', value: JSON.stringify({
          idempotencyKey: 'k', positionKey: 'p', dayKey: 'd',
          reduceSizeUsd: 210, fullClose: false, status: 'CONFIRMED',
          orderKey: null, createdAt: '', updatedAt: '',
        }),
      }];
    }) as never);
    const r = await reduceServerPaper70({
      openRow: serverOpenRow() as never, quote: { priceUsd: 51_000, ageMs: 1_000 },
    });
    expect(r.ok).toBe(false);
    expect(selectCall).toBeGreaterThan(0);
    expect(db.insert).not.toHaveBeenCalled(); // 거래 행 미생성
  });

  it('예약 조회 실패 → fail-closed 보류', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => { throw new Error('db down'); }) as never);
    const r = await reduceServerPaper70({
      openRow: serverOpenRow() as never, quote: { priceUsd: 51_000, ageMs: 1_000 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('fail-closed');
  });
});

// ── 관리 틱 — SL/TP/pendingClose/재시작 복구 ──────────────────────────────────

describe('manageServerPaperTick', () => {
  it('LONG stop 터치 → FULL 청산 실행', async () => {
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => makeChain(() => {
      call += 1;
      // 1번째: open rows 조회, 2번째: close 내부 행 조회, 이후: 잔여 조회 → 빈 배열
      if (call === 1) return [serverOpenRow()];
      if (call === 2) return [serverOpenRow()];
      return [];
    }) as never);
    await manageServerPaperTick(() => ({ priceUsd: 49_400, ageMs: 1_000 })); // stop 49500 아래
    expect(db.insert).toHaveBeenCalledTimes(1); // CLOSE 행
    const st = getServerPaperStatus();
    expect(st.lastCloseAction?.reason).toBe('STOP_LOSS');
  });

  it('TP 터치 → TAKE_PROFIT 청산', async () => {
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => makeChain(() => {
      call += 1;
      return call <= 2 ? [serverOpenRow()] : [];
    }) as never);
    await manageServerPaperTick(() => ({ priceUsd: 52_100, ageMs: 1_000 }));
    expect(getServerPaperStatus().lastCloseAction?.reason).toBe('TAKE_PROFIT');
  });

  it('시세 stale → 관리 스킵 (청산 없음, lastTickStale 표기)', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [serverOpenRow()]) as never);
    await manageServerPaperTick(() => ({ priceUsd: 40_000, ageMs: MAX_MANAGE_PRICE_AGE_MS + 1 }));
    expect(db.insert).not.toHaveBeenCalled();
    expect(getServerPaperStatus().lastTickStale).toBe(true);
  });

  it('SL/TP 사이 가격 → 청산 없음', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [serverOpenRow()]) as never);
    await manageServerPaperTick(() => ({ priceUsd: 50_500, ageMs: 1_000 }));
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('pendingClose 존재 → SL/TP 무관 전량 청산 후 요청 해제', async () => {
    await requestServerPaperCloseAll('RISK_CLOSE_ALL');
    vi.clearAllMocks();
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => makeChain(() => {
      call += 1;
      return call <= 2 ? [serverOpenRow()] : [];
    }) as never);
    await manageServerPaperTick(() => ({ priceUsd: 50_500, ageMs: 1_000 })); // SL/TP 미터치
    expect(db.insert).toHaveBeenCalledTimes(1); // 그래도 청산
    expect(getServerPaperStatus().pendingClose).toBeNull(); // 완료 후 해제
    expect(db.delete).toHaveBeenCalled(); // 영속 요청 삭제
  });

  it('pendingClose 영속 실패 → fail-closed (persisted=false + unresolved) → 틱에서 재시도 성공 시 해제', async () => {
    // worker_state write 실패 시뮬레이션: readWorkerState select는 성공, insert 실패
    vi.mocked(db.insert).mockImplementation(() => makeChain(() => { throw new Error('db down'); }) as never);
    const r = await requestServerPaperCloseAll('RISK_CLOSE_ALL');
    expect(r.persisted).toBe(false);
    expect(getServerPaperStatus().unresolved).toContain('영속 실패');
    // unresolved 동안 신규 진입 차단
    expect((await openServerPaperPosition({ ...BASE_OPEN })).ok).toBe(false);
    // 다음 틱에서 영속 재시도 성공 → unresolved 해제
    vi.mocked(db.insert).mockImplementation(() => makeChain(() => [{ id: 'ok' }]) as never);
    vi.mocked(db.select).mockImplementation(() => makeChain(() => []) as never);
    await manageServerPaperTick(() => null);
    expect(getServerPaperStatus().unresolved).toBeNull();
  });

  it('크래시 복구 — 영속 write 실패 → 크래시(모듈 리셋) → 재시작 후 사이클 재파생 재요청이 영속된다', async () => {
    // 1) close-all 요청 시점에 worker_state write 실패
    vi.mocked(db.insert).mockImplementation(() => makeChain(() => { throw new Error('db down'); }) as never);
    const first = await requestServerPaperCloseAll('RISK_CLOSE_ALL');
    expect(first.persisted).toBe(false);
    // 2) 프로세스 크래시 시뮬레이션 — 메모리 상태 전부 소실
    __resetServerPaperStateForTests();
    // 3) 재시작: DB 복구됐지만 pendingClose 행 없음 (write가 실패했으므로)
    vi.mocked(db.select).mockImplementation(() => makeChain(() => []) as never);
    vi.mocked(db.insert).mockImplementation(() => makeChain(() => [{ id: 'ok' }]) as never);
    await loadPendingCloseFromDb();
    expect(getServerPaperStatus().pendingClose).toBeNull(); // 의도는 DB에 없다
    // 4) 첫 사이클이 durable 소스(riskState/결정)에서 flat 의도를 재파생해 재요청
    //    (aiWorker.runServerPaperExecution의 wantsFlat 분기 — 매 사이클 재평가)
    const second = await requestServerPaperCloseAll('RISK_CLOSE_ALL');
    expect(second.persisted).toBe(true); // 이번에는 영속 성공
    expect(getServerPaperStatus().pendingClose?.reason).toBe('RISK_CLOSE_ALL');
    expect(getServerPaperStatus().unresolved).toBeNull();
  });

  it('startup reconciliation — 마지막 영속 결정이 CASH + 서버 미청산 존재 → close-all 재수립 (write-failure→crash→flip 반례 커버)', async () => {
    // pendingClose 행 없음(write 실패로 유실), 서버 OPEN 행 존재, 마지막 영속 결정=CASH
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => makeChain(() => {
      call += 1;
      if (call === 1) return [serverOpenRow()];      // loadServerOpenRows
      return [];                                     // writeWorkerState read
    }) as never);
    await reconcileStartupCloseIntent(async () => 'CASH');
    expect(getServerPaperStatus().pendingClose?.reason).toBe('STARTUP_RECONCILE');
    expect(getServerPaperStatus().unresolved).toBeNull();
  });

  it('startup reconciliation — 판정 실패 = durable 상태 불명 → OPEN 차단, 틱 재시도 성공 시 해제', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => { throw new Error('db down'); }) as never);
    await reconcileStartupCloseIntent(async () => 'CASH');
    expect(getServerPaperStatus().unresolved).toContain('reconciliation 실패');
    expect((await openServerPaperPosition({ ...BASE_OPEN })).ok).toBe(false);
    // DB 복구 → 틱이 저장된 fetcher로 재시도 → 해제 (open 행 없음 → 재수립 불필요)
    vi.mocked(db.select).mockImplementation(() => makeChain(() => []) as never);
    await manageServerPaperTick(() => null);
    expect(getServerPaperStatus().unresolved).toBeNull();
  });

  it('startup reconciliation — 마지막 결정이 LONG이면 재수립하지 않는다', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [serverOpenRow()]) as never);
    await reconcileStartupCloseIntent(async () => 'LONG');
    expect(getServerPaperStatus().pendingClose).toBeNull();
  });

  it('크래시 복구 — startup read 실패 = durable 상태 불명 → OPEN 차단, 틱 재시도 성공 시 해제', async () => {
    // 재시작 직후 worker_state 읽기 실패 시뮬레이션
    vi.mocked(db.select).mockImplementation(() => makeChain(() => { throw new Error('db down'); }) as never);
    await loadPendingCloseFromDb();
    expect(getServerPaperStatus().unresolved).toContain('로드 실패');
    // durable 상태 불명 동안 신규 진입 fail-closed
    expect((await openServerPaperPosition({ ...BASE_OPEN })).ok).toBe(false);
    // DB 복구 → 틱에서 재읽기 성공(기록된 close-all 의도 채택) → unresolved 해제
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => makeChain(() => {
      call += 1;
      if (call === 1) return [{ key: PENDING_CLOSE_KEY, value: JSON.stringify({ reason: 'RISK_CLOSE_ALL', requestedAt: new Date().toISOString() }) }];
      return []; // open rows 없음 → pendingClose 해제 경로
    }) as never);
    await manageServerPaperTick(() => null);
    expect(getServerPaperStatus().unresolved).toBeNull();
  });

  it('재시작 복구 — loadPendingCloseFromDb가 영속 요청을 복원한다', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => [{
      key: PENDING_CLOSE_KEY,
      value: JSON.stringify({ reason: 'CASH_TRANSITION', requestedAt: new Date().toISOString() }),
    }]) as never);
    await loadPendingCloseFromDb();
    expect(getServerPaperStatus().pendingClose?.reason).toBe('CASH_TRANSITION');
  });

  it('동시성 — 틱 singleflight (재진입 즉시 반환)', async () => {
    let resolveSelect: (() => void) | null = null;
    let selectCalls = 0;
    vi.mocked(db.select).mockImplementation(() => makeChain(() => {
      selectCalls += 1;
      return new Promise<unknown[]>(res => { resolveSelect = () => res([]); });
    }) as never);
    const first = manageServerPaperTick(() => null);
    await manageServerPaperTick(() => null); // 재진입 — no-op이어야 함
    expect(selectCalls).toBe(1);
    const releaseSelect = resolveSelect as unknown as (() => void) | null;
    releaseSelect?.();
    await first;
  });
});

// ── 구조적 LIVE 차단 — 금지 import 0회 ───────────────────────────────────────

describe('구조적 LIVE/서명 경로 차단', () => {
  it('serverPaperExecutor 소스는 relay/GMX submit/서명 모듈을 import하지 않는다', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../workers/serverPaperExecutor.ts'), 'utf8');
    const importLines = src.split('\n').filter(l => /^\s*import\s/.test(l));
    const forbidden = /relay|gelato|internalExecutor|liveTestExecutor|gmxOrderSubmit|subaccount|signer|ethers|viem|delegated/i;
    for (const line of importLines) {
      expect(line).not.toMatch(forbidden);
    }
  });
});
