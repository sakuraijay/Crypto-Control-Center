/**
 * 6I-2 §12 — 런타임 완성 회귀 테스트.
 *  1. 중복·수명주기: 결정적 windowKey, single-flight, shutdown 차단, timeout 폐기
 *  2. 요청 예산·캐시: candle close 전 재요청 0, dedupe, 예산 초과 fail-closed, 429 backoff
 *  3. 정밀도: 1e30 BigInt 경로 golden fixtures + ranking 순서 adversarial
 *  4. outcome: AMBIGUOUS_INTRABAR, coverage/증거 필드, counterfactual 분류
 *  5. 분리: intel 모듈이 실행 경로를 import하지 않음 (정적 검사)
 * 외부 네트워크·DB 0회 (전부 mock/순수 모듈).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── db mock (intelService → shadowStore → @workspace/db) ────────────────────
vi.mock('@workspace/db', () => {
  function chain(getResult: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'set', 'values',
      'onConflictDoNothing', 'onConflictDoUpdate', 'returning', 'innerJoin', 'leftJoin']) {
      c[m] = () => c;
    }
    (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
      (resolve) => Promise.resolve(getResult()).then(resolve);
    return c;
  }
  return {
    db: {
      select: () => chain(() => []),
      insert: () => chain(() => []),
      update: () => chain(() => []),
      delete: () => chain(() => []),
    },
    marketIntelligenceSnapshotsTable: { createdAt: 'created_at' },
    opportunityCandidatesTable: { id: 'id', decidedAtMs: 'decided_at_ms' },
    shadowOutcomesTable: { candidateId: 'candidate_id', complete: 'complete', outcomeStatus4h: 'outcome_status_4h', attempts: 'attempts', createdAt: 'created_at' },
    runMigrations: vi.fn(async () => {}),
  };
});
// routes/gmx mock — intelService의 프로덕션 배선 (테스트에서는 미사용 경로)
vi.mock('../routes/gmx', () => ({
  getCachedPrices: () => null,
  getCachedChange24h: () => null,
  fetchGmxCandles: vi.fn(async () => null),
  getCandleFetchStats: () => ({ requests: 0, ok: 0, http429: 0, http5xx: 0, httpOther: 0, timeouts: 0, invalidPayload: 0, totalLatencyMs: 0, maxLatencyMs: 0, lastErrorKind: null, last429AtMs: null }),
}));

import {
  runIntelServiceCycle, getIntelServiceState, stopIntelService, resumeIntelService,
  computeCycleWindowKey, cycleIdForWindow, INTEL_CYCLE_MIN_INTERVAL_MS, INTEL_CYCLE_TIMEOUT_MS,
  __resetIntelServiceForTests, __setIntelHandleForTests,
} from '../intel/intelService';
import { __resetIntelCycleLockForTests } from '../intel/intelCycle';
import {
  createProductionFetchers, CYCLE_CANDLE_REQUEST_BUDGET,
  RequestBudgetExceededError, RateLimitBackoffError, ProductionFetchersHandle,
} from '../intel/dataSource';
import { parseBigIntStr, usd30ToNumber, usd30StrToNumber, usd30SumToNumber, rate30PerSecToPerHour } from '../intel/usd30';
import { computeShadowOutcome } from '../intel/shadowOutcome';
import {
  classifyCounterfactual, summarizeCounterfactuals, computeShadowMaturity,
  ShadowOutcomeRow, RESEARCH_PREVIEW_MIN, MANUAL_REVIEW_MIN,
} from '../intel/shadowMetrics';
import { RankingGates } from '../intel/ranking';
import { computeEnrichAttempt, ENRICH_MAX_ATTEMPTS, OUTCOME_HORIZON_4H_MS } from '../intel/shadowStore';

const gates = (nowMs: number): RankingGates => ({
  riskEngineAllowsEntry: true, riskEngineBlockReason: null,
  openPositionExists: false, dailyEntryLimitReached: false, nowMs,
});

/** 항상 빈 universe를 반환하는 무해한 handle (외부 호출 0회) */
function stubHandle(over?: Partial<ProductionFetchersHandle['fetchers']> & { delayMs?: number }): ProductionFetchersHandle {
  const delay = over?.delayMs ?? 0;
  return {
    fetchers: {
      fetchMarketRows: over?.fetchMarketRows ?? (async () => {
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        return { rows: [], complete: true, failureReason: null };
      }),
      fetchCandles: over?.fetchCandles ?? (async () => null),
      fetchPrice: async () => null,
      fetch24hChange: async () => null,
      fetchFundingBorrowing: async () => null,
    },
    stats: {
      candleRequests: 0, candleCacheHits: 0, candleCacheMisses: 0, candleDeduped: 0,
      marketsRequests: 0, marketsCacheHits: 0, budgetExceededCount: 0, backoffSkips: 0,
      lastCycleCandleRequests: 0,
      tickersRequests: 0, tickersCacheHits: 0, tickersSchemaRejects: 0,
    },
    beginCycle: () => {},
    noteRateLimited: () => {},
  };
}

beforeEach(() => {
  __resetIntelServiceForTests();
  __resetIntelCycleLockForTests();
});

// ── 1. 중복·수명주기 ─────────────────────────────────────────────────────────
describe('6I-2 §3 수명주기', () => {
  it('cycleWindowKey는 결정적 — 같은 5분 창은 재시작해도 같은 cycleId', () => {
    const t = 5_956_667 * INTEL_CYCLE_MIN_INTERVAL_MS;   // window 경계 정렬
    const k1 = computeCycleWindowKey(t);
    const k2 = computeCycleWindowKey(t + INTEL_CYCLE_MIN_INTERVAL_MS - 1);
    const k3 = computeCycleWindowKey(t + INTEL_CYCLE_MIN_INTERVAL_MS);
    expect(k1).toBe(k2);
    expect(k3).toBe(k1 + 1);
    expect(cycleIdForWindow(k1)).toBe(`w${k1}`);
    expect(cycleIdForWindow(computeCycleWindowKey(t))).toBe(cycleIdForWindow(k1)); // 재시작 idempotent
  });

  it('single-flight — 실행 중 재진입은 SKIPPED_IN_FLIGHT로 즉시 반환', async () => {
    __setIntelHandleForTests(stubHandle({ delayMs: 50 }));
    const t = Date.now();
    const p1 = runIntelServiceCycle({ cycleNum: 1, gates: gates(t) });
    // 두 번째 호출은 다른 window로 위장해도 in-flight에 걸린다
    const p2 = runIntelServiceCycle({ cycleNum: 2, gates: gates(t + INTEL_CYCLE_MIN_INTERVAL_MS) });
    await Promise.all([p1, p2]);
    const s = getIntelServiceState();
    expect(s.skippedInFlight).toBe(1);
    expect(s.inFlight).toBe(false);
    expect(s.cycleCount).toBe(1); // 동시 실행 0회
  });

  it('같은 관측 시간창은 두 번 실행하지 않는다', async () => {
    __setIntelHandleForTests(stubHandle());
    const t = Date.now();
    await runIntelServiceCycle({ cycleNum: 1, gates: gates(t) });
    await runIntelServiceCycle({ cycleNum: 2, gates: gates(t + 1000) }); // 같은 window
    expect(getIntelServiceState().cycleCount).toBe(1);
  });

  it('shutdown 이후 신규 사이클 진입 차단, resume으로 해제', async () => {
    __setIntelHandleForTests(stubHandle());
    stopIntelService();
    const t = Date.now();
    await runIntelServiceCycle({ cycleNum: 1, gates: gates(t) });
    let s = getIntelServiceState();
    expect(s.cycleCount).toBe(0);
    expect(s.lastAttempt?.status).toBe('SKIPPED_SHUTDOWN');
    resumeIntelService();
    await runIntelServiceCycle({ cycleNum: 2, gates: gates(t + INTEL_CYCLE_MIN_INTERVAL_MS) });
    s = getIntelServiceState();
    expect(s.cycleCount).toBe(1);
  });

  it('timeout 시 flight ownership 유지 — 늦은 작업이 끝날 때까지 새 사이클 진입 불가', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const blocked = new Promise<void>(r => { release = r; });
      __setIntelHandleForTests(stubHandle({
        fetchMarketRows: async () => { await blocked; return { rows: [], complete: true, failureReason: null }; },
      }));
      const t = Date.now();
      const p = runIntelServiceCycle({ cycleNum: 1, gates: gates(t) });
      await vi.advanceTimersByTimeAsync(INTEL_CYCLE_TIMEOUT_MS + 1);
      await p;
      let s = getIntelServiceState();
      expect(s.lastAttempt?.status).toBe('TIMEOUT');
      expect(s.inFlight).toBe(true);                            // 늦은 작업이 아직 실행 중 → ownership 유지
      // 새 window 진입 시도 → in-flight로 차단
      await runIntelServiceCycle({ cycleNum: 2, gates: gates(t + INTEL_CYCLE_MIN_INTERVAL_MS) });
      expect(getIntelServiceState().skippedInFlight).toBe(1);
      // 늦은 작업 종료 → ownership 해제
      release();
      await vi.advanceTimersByTimeAsync(1);
      s = getIntelServiceState();
      expect(s.inFlight).toBe(false);
      expect(s.cycleCount).toBe(0);                             // timeout 결과는 폐기 (성공 위장 없음)
    } finally {
      vi.useRealTimers();
    }
  });

  it('4h horizon 도달 전에는 attempts를 소진하지 않는다 — 조기 DATA_UNAVAILABLE 종결 불가', () => {
    const decidedAtMs = 1_787_000_000_000;
    // 4h 도달 전 — 아무리 여러 번 재계산해도 attempts 불변·종결 불가
    const before = computeEnrichAttempt({ prevAttempts: ENRICH_MAX_ATTEMPTS + 5, nowMs: decidedAtMs + OUTCOME_HORIZON_4H_MS - 1, decidedAtMs });
    expect(before.past4h).toBe(false);
    expect(before.attempts).toBe(ENRICH_MAX_ATTEMPTS + 5);      // 증가 없음
    expect(before.exhaustEligible).toBe(false);                 // 조기 종결 구조적 불가
    // 4h 경과 후 — 시도 소진 시작, 상한 도달 시에만 종결 가능
    const after1 = computeEnrichAttempt({ prevAttempts: 0, nowMs: decidedAtMs + OUTCOME_HORIZON_4H_MS, decidedAtMs });
    expect(after1.past4h).toBe(true);
    expect(after1.attempts).toBe(1);
    expect(after1.exhaustEligible).toBe(false);
    const afterMax = computeEnrichAttempt({ prevAttempts: ENRICH_MAX_ATTEMPTS - 1, nowMs: decidedAtMs + OUTCOME_HORIZON_4H_MS + 1, decidedAtMs });
    expect(afterMax.exhaustEligible).toBe(true);
  });

  it('사이클 실패 시 이전 성공 스냅샷은 stale로 표시 (성공 위장 금지)', async () => {
    __setIntelHandleForTests(stubHandle());
    const t = Date.now();
    await runIntelServiceCycle({ cycleNum: 1, gates: gates(t) });
    expect(getIntelServiceState().lastRecordStale).toBe(false);
    __setIntelHandleForTests(stubHandle({
      fetchMarketRows: async () => { throw new Error('외부 조회 폭발'); },
    }));
    // fetchMarketRows throw는 intelCycle 내부에서 catch되지 않고 밖으로 전파되는지 확인:
    // scanUniverse 경로는 실패 사유를 담아 계속 진행하므로, persist 실패로 강제
    __setIntelHandleForTests(stubHandle());
    const failing = stubHandle();
    failing.fetchers.fetchMarketRows = async () => { throw new RequestBudgetExceededError(CYCLE_CANDLE_REQUEST_BUDGET); };
    __setIntelHandleForTests(failing);
    await runIntelServiceCycle({ cycleNum: 2, gates: gates(t + INTEL_CYCLE_MIN_INTERVAL_MS) });
    const s = getIntelServiceState();
    expect(s.failedCount).toBe(1);
    expect(s.lastRecordStale).toBe(true);
    expect(s.lastRecord).not.toBeNull();   // 스냅샷은 남아 있되 stale
    expect(s.lastAttempt?.status).toBe('FAILED');
  });
});

// ── 2. 요청 예산·캐시 ────────────────────────────────────────────────────────
describe('6I-2 §4 요청 예산·캐시', () => {
  const T0 = 1_787_000_000_000 - (1_787_000_000_000 % 900_000); // 15m 경계 정렬
  const mkPrices = (n: number, lastOpenSec: number): number[][] =>
    Array.from({ length: n }, (_, i) => [lastOpenSec - (n - 1 - i) * 900, 100, 101, 99, 100]);

  function handleWithClock(fetchImpl: (s: string, p: string, c: number) => Promise<{ prices: number[][] } | null>, clock: { now: number }) {
    return createProductionFetchers({
      getCachedPrices: () => null,
      getCachedChange24h: () => null,
      fetchGmxCandles: fetchImpl,
      nowFn: () => clock.now,
    });
  }

  it('candle close 전 재요청 0회 (캐시 적중), close 후 재요청', async () => {
    const clock = { now: T0 + 100_000 };                     // 마지막 close 이후
    const lastOpenSec = (T0 - 900_000) / 1000;               // 마지막 폐쇄 캔들 open
    const fetchMock = vi.fn(async () => ({ prices: mkPrices(96, lastOpenSec) }));
    const h = handleWithClock(fetchMock, clock);
    h.beginCycle();
    await h.fetchers.fetchCandles('BTC', '15m', 96);
    await h.fetchers.fetchCandles('BTC', '15m', 96);         // 같은 창 → 캐시
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.stats.candleCacheHits).toBe(1);
    // 다음 캔들 close 경과 → 재요청 허용
    clock.now = lastOpenSec * 1000 + 2 * 900_000 + 1;
    h.beginCycle();
    await h.fetchers.fetchCandles('BTC', '15m', 96);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('진행 중(미폐쇄) 캔들은 판단 입력에서 제외', async () => {
    const clock = { now: T0 + 100_000 };
    const lastClosedOpenSec = (T0 - 900_000) / 1000;
    const inProgressOpenSec = T0 / 1000;                     // close = T0+900s > now
    const fetchMock = vi.fn(async () => ({ prices: [...mkPrices(5, lastClosedOpenSec), [inProgressOpenSec, 100, 200, 50, 150]] }));
    const h = handleWithClock(fetchMock, clock);
    h.beginCycle();
    const candles = await h.fetchers.fetchCandles('ETH', '15m', 6);
    expect(candles).not.toBeNull();
    expect(candles!.every(c => c.t + 900_000 <= clock.now)).toBe(true);
    expect(candles!.some(c => c.h === 200)).toBe(false);     // 미폐쇄 고가 미주입
  });

  it('동일 key 동시 요청은 in-flight dedupe로 1회 병합', async () => {
    const clock = { now: T0 + 100_000 };
    let resolveFetch: (v: { prices: number[][] }) => void;
    const fetchMock = vi.fn(() => new Promise<{ prices: number[][] }>(r => { resolveFetch = r; }));
    const h = handleWithClock(fetchMock as never, clock);
    h.beginCycle();
    const p1 = h.fetchers.fetchCandles('SOL', '15m', 96);
    const p2 = h.fetchers.fetchCandles('SOL', '15m', 96);
    resolveFetch!({ prices: mkPrices(96, (T0 - 900_000) / 1000) });
    await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.stats.candleDeduped).toBe(1);
  });

  it('cycle 요청 예산 초과 = RequestBudgetExceededError (fail-closed, 무한 요청 금지)', async () => {
    const clock = { now: T0 + 100_000 };
    const fetchMock = vi.fn(async () => null);               // 캐시 미적재 → 매번 miss
    const h = handleWithClock(fetchMock, clock);
    h.beginCycle();
    for (let i = 0; i < CYCLE_CANDLE_REQUEST_BUDGET; i++) {
      await h.fetchers.fetchCandles(`S${i}`, '15m', 96);
    }
    await expect(h.fetchers.fetchCandles('OVER', '15m', 96)).rejects.toBeInstanceOf(RequestBudgetExceededError);
    expect(h.stats.budgetExceededCount).toBe(1);
    // beginCycle로 다음 사이클 예산 리셋
    h.beginCycle();
    await expect(h.fetchers.fetchCandles('NEXT', '15m', 96)).resolves.toBeNull();
  });

  it('candle upstream 429(계측 last429AtMs 경유) 감지 시 backoff 설정 — 다음 요청 차단', async () => {
    const clock = { now: T0 + 100_000 };
    let last429: number | null = null;
    const fetchMock = vi.fn(async () => { last429 = clock.now; return null; }); // gmx.ts처럼 429를 null로 소거
    const h = createProductionFetchers({
      getCachedPrices: () => null, getCachedChange24h: () => null,
      fetchGmxCandles: fetchMock, getLast429AtMs: () => last429, nowFn: () => clock.now,
    });
    h.beginCycle();
    await h.fetchers.fetchCandles('BTC', '15m', 96);          // 429 발생 (null 반환)
    await expect(h.fetchers.fetchCandles('ETH', '15m', 96)).rejects.toBeInstanceOf(RateLimitBackoffError);
    expect(fetchMock).toHaveBeenCalledTimes(1);               // 이후 외부 요청 0회
  });

  it('429 backoff 중 신규 외부 요청 차단 — stale cache로 위장하지 않음', async () => {
    const clock = { now: T0 + 100_000 };
    const fetchMock = vi.fn(async () => ({ prices: mkPrices(96, (T0 - 900_000) / 1000) }));
    const h = handleWithClock(fetchMock, clock);
    h.beginCycle();
    h.noteRateLimited(clock.now);
    await expect(h.fetchers.fetchCandles('BTC', '15m', 96)).rejects.toBeInstanceOf(RateLimitBackoffError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.stats.backoffSkips).toBe(1);
  });
});

// ── 3. 1e30 정밀도 ───────────────────────────────────────────────────────────
describe('6I-2 §6 1e30 정밀도 (BigInt 경로)', () => {
  it('golden fixtures — 문자열→USD 변환', () => {
    expect(usd30StrToNumber('1000000000000000000000000000000000000')).toBe(1_000_000);   // 1e36/1e30
    expect(usd30StrToNumber('2500000000000000000000000000000')).toBe(2.5);               // 2.5e30
    expect(usd30StrToNumber('1000000000000000000000000')).toBe(0.000001);                // 1 micro-USD
    expect(usd30StrToNumber('0')).toBe(0);
  });

  it('Number 조기 변환이 뭉개는 micro-USD 차이를 BigInt 경로는 보존 (ranking 순서 adversarial)', () => {
    const a = '1000000000000000000000000000000000000';                 // 1e36 = 1e6 USD
    const b = '1000000000000000001' + '0'.repeat(18);                   // +1e18 = 1e-12 USD (micro 미만 → 절사)
    const c = '1000000000001' + '0'.repeat(24);                         // +1e24 = 1e-6 USD (보존 대상)
    const va = usd30StrToNumber(a)!;
    const vc = usd30StrToNumber(c)!;
    expect(vc).toBeGreaterThan(va);                                    // micro-USD 순서 보존
    expect(vc - va).toBeCloseTo(0.000001, 9);
    expect(usd30StrToNumber(b)).toBe(va);                              // micro 미만은 절사(위장 없음)
    // 1e18 차이는 double ulp(≈2.2e20) 미만 — Number 조기 변환이면 a/b 구분 불가
    expect(Number(a) === Number(b)).toBe(true);
  });

  it('합산은 BigInt로 수행 후 1회 변환 (부분 실패 = null)', () => {
    expect(usd30SumToNumber('1000000000000000000000000000000', '2000000000000000000000000000000')).toBe(3);
    expect(usd30SumToNumber('1000000000000000000000000000000', 'not-a-number')).toBeNull();
    expect(usd30SumToNumber('1000000000000000000000000000000', '1.5e30')).toBeNull();    // 지수 표기 거부
  });

  it('경계 초과·비정상 = null (clamp/0 위장 금지)', () => {
    expect(usd30StrToNumber('1' + '0'.repeat(45))).toBeNull();   // 1e15 USD 초과
    expect(usd30StrToNumber('-1000000000000000000000000000000')).toBeNull(); // 음수 유동성 거부
    expect(parseBigIntStr('12.5')).toBeNull();
    expect(parseBigIntStr('1e30')).toBeNull();
    expect(parseBigIntStr('')).toBeNull();
    expect(usd30ToNumber(null)).toBeNull();
  });

  it('rate 변환 — 음수 funding 허용, |rate/h|≥1 거부', () => {
    // 1e22 per-sec/1e30 = 1e-8/s → 3.6e-5/h
    expect(rate30PerSecToPerHour('10000000000000000000000')).toBeCloseTo(3.6e-5, 12);
    expect(rate30PerSecToPerHour('-10000000000000000000000')).toBeCloseTo(-3.6e-5, 12);
    expect(rate30PerSecToPerHour('1000000000000000000000000000000')).toBeNull(); // 3600/h — 비정상
    expect(rate30PerSecToPerHour('abc')).toBeNull();
  });
});

// ── 4. outcome·counterfactual·성숙도 ────────────────────────────────────────
describe('6I-2 §7·§8·§10 outcome·counterfactual·성숙도', () => {
  const row = (over?: Partial<ShadowOutcomeRow>): ShadowOutcomeRow => ({
    candidateId: 'x', direction: 'LONG', regime: 'STRONG_BULL', decision: 'SHADOW_ONLY',
    selected: false, rank: 1, calibratedProbability: null, expectedRMultiple: 1.5,
    outcome1hNetUsd: 2, outcome4hNetUsd: 5, hypotheticalGrossPnlUsd: 8, hypotheticalTotalCostUsd: 3,
    maxFavorableExcursionPct: 1, maxAdverseExcursionPct: 0.5, complete: true,
    outcomeStatus4h: 'COMPLETE', firstTouch: 'TARGET', ...over,
  });

  it('outcome 증거 필드 — coverage/horizonEnd/source 캔들 범위 기록', () => {
    const decidedAtMs = 1_787_000_000_000;
    const candles = Array.from({ length: 8 }, (_, i) => ({
      t: decidedAtMs + (i + 1) * 900_000, o: 100, h: 100.5, l: 99.8, c: 100.1, v: 1,
    }));
    const r = computeShadowOutcome({
      direction: 'LONG', entryPrice: 100, stopPrice: 99, takeProfitPrice: 102,
      notionalUsd: 1000, totalCostUsd: 1, decidedAtMs, horizonMs: 3_600_000,
      candlesAfter: candles, nowMs: decidedAtMs + 5 * 3_600_000,
    });
    expect(r.status).toBe('COMPLETE');
    expect(r.horizonEndMs).toBe(decidedAtMs + 3_600_000);
    expect(r.dataCoverage).toBeCloseTo(1, 5);
    expect(r.sourceCandleFromMs).toBe(decidedAtMs + 900_000);
    expect(r.sourceCandleToMs).toBeLessThanOrEqual(decidedAtMs + 3_600_000 - 900_000);
  });

  it('counterfactual 분류 — 우선순위와 라벨', () => {
    expect(classifyCounterfactual(row({ outcomeStatus4h: 'DATA_UNAVAILABLE', complete: false }))).toBe('DATA_UNAVAILABLE');
    expect(classifyCounterfactual(row({ outcomeStatus4h: 'AMBIGUOUS_INTRABAR', complete: false }))).toBe('AMBIGUOUS');
    expect(classifyCounterfactual(row({ complete: false, outcomeStatus4h: 'INCOMPLETE' }))).toBe('INCOMPLETE');
    expect(classifyCounterfactual(row({ firstTouch: 'STOP', outcome4hNetUsd: -12 }))).toBe('RISK_AVOIDED');
    expect(classifyCounterfactual(row({ outcome4hNetUsd: 7 }))).toBe('MISSED_OPPORTUNITY');
    expect(classifyCounterfactual(row({ outcome4hNetUsd: -1, hypotheticalGrossPnlUsd: 2 }))).toBe('COST_AVOIDED');
    expect(classifyCounterfactual(row({ outcome4hNetUsd: -5, hypotheticalGrossPnlUsd: -2 }))).toBe('CORRECT_REJECTION');
    // net 미상 + gross>0 — 이익 단정 금지
    expect(classifyCounterfactual(row({ outcome4hNetUsd: null, hypotheticalGrossPnlUsd: 4 }))).toBe('INCOMPLETE');
  });

  it('counterfactual 집계는 비선택 rank=1 후보만 대상', () => {
    const rows = [
      row({ rank: 1, selected: false, outcome4hNetUsd: 7 }),
      row({ rank: 2, selected: false, outcome4hNetUsd: 7 }),      // 대상 아님
      row({ rank: 1, selected: true, outcome4hNetUsd: 7 }),       // 대상 아님(선택됨)
    ];
    const s = summarizeCounterfactuals(rows);
    expect(s.evaluated).toBe(1);
    expect(s.byLabel.MISSED_OPPORTUNITY).toBe(1);
  });

  it('성숙도 — 표본 미달·편중 시 eligible=false, 승격 플래그는 구조적으로 항상 false', () => {
    const few = Array.from({ length: RESEARCH_PREVIEW_MIN - 1 }, (_, i) => row({ candidateId: `c${i}` }));
    let m = computeShadowMaturity(few);
    expect(m.researchPreviewEligible).toBe(false);
    expect(m.manualReviewSampleEligible).toBe(false);
    expect(m.autoPromotionAllowed).toBe(false);
    expect(m.autonomousLiveEligible).toBe(false);
    expect(m.blockedReasons.length).toBeGreaterThan(0);

    // 100건 이상이지만 전부 LONG·단일 regime → 보정 검토 불가
    const skewed = Array.from({ length: MANUAL_REVIEW_MIN }, (_, i) => row({ candidateId: `s${i}`, direction: 'LONG' }));
    m = computeShadowMaturity(skewed);
    expect(m.manualReviewSampleEligible).toBe(true);
    expect(m.calibrationEligible).toBe(false);
    expect(m.blockedReasons.some(r => r.includes('편중'))).toBe(true);

    // 혼합 표본 → 보정 검토 가능 (그래도 승격은 항상 false)
    const mixed = Array.from({ length: MANUAL_REVIEW_MIN }, (_, i) => row({
      candidateId: `m${i}`,
      direction: i % 2 === 0 ? 'LONG' : 'SHORT',
      regime: i % 3 === 0 ? 'STRONG_BULL' : i % 3 === 1 ? 'RANGE' : 'STRONG_BEAR',
    }));
    m = computeShadowMaturity(mixed);
    expect(m.calibrationEligible).toBe(true);
    expect(m.autoPromotionAllowed).toBe(false);
    expect(m.autonomousLiveEligible).toBe(false);
  });

  it('AMBIGUOUS_INTRABAR는 4h COMPLETE 표본으로 세지 않는다 (1h 혼합 부풀리기 금지)', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row({ candidateId: `ok${i}` })),
      ...Array.from({ length: 5 }, (_, i) => row({ candidateId: `amb${i}`, complete: false, outcomeStatus4h: 'AMBIGUOUS_INTRABAR' })),
    ];
    const m = computeShadowMaturity(rows);
    expect(m.sampleCount4h).toBe(10);
    expect(m.ambiguousCount).toBe(5);
  });
});

// ── 5. Shadow/실행 분리 (정적 검사) ──────────────────────────────────────────
describe('6I-2 §9 Shadow/실행 경로 분리', () => {
  it('intel 모듈은 실행·서명·relay 경로를 import하지 않는다', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'intel');
    const forbidden = [
      /from\s+['"].*executor/i, /from\s+['"].*relay/i, /from\s+['"].*delegatedSigner/i,
      /from\s+['"].*vps/i, /forwardToVps/, /placeOrder/, /executeOrder/, /gelato/i,
      /from\s+['"].*gmxApi/i, /submitOrder/,
    ];
    for (const f of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const re of forbidden) {
        expect(src, `${f}에 실행 경로 참조(${re}) 금지`).not.toMatch(re);
      }
    }
  });
});
