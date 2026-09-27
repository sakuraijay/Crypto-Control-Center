/**
 * 6I-1 §16 — Market Intelligence·Opportunity·Shadow 순수 모듈 테스트.
 * 전부 fixture — 외부 호출 0회, DB 0회.
 */
import { describe, it, expect } from 'vitest';
import { validateScalarPoint, availablePoint, unavailablePoint, Candle } from '../intel/types';
import { validateCandleSeries, computeAtrPct, computeTrendScore } from '../intel/candles';
import { classifyRegime, RegimeFeatures, REGIME_ALLOWED_STRATEGIES } from '../intel/regime';
import { scanUniverse, selectShortlist, RawMarketRow, MIN_LIQUIDITY_USD } from '../intel/universe';
import {
  deriveCalibrationStatus, totalCostUsd, computeExpectedNetValueUsd,
  computeUncalibratedRankingScore, computeExpectedRMultiple, CostBreakdownUsd,
  MIN_CALIBRATION_SAMPLES, MIN_CALIBRATING_SAMPLES, OpportunityCandidate,
} from '../intel/candidate';
import { rankAndSelect, RANKING_THRESHOLDS, RankingGates, regimeAllowsDirection } from '../intel/ranking';
import { computeShadowOutcome } from '../intel/shadowOutcome';
import { boundedNum } from '../intel/serialize';
import { computeShadowMetrics, MIN_METRIC_SAMPLES, ShadowOutcomeRow } from '../intel/shadowMetrics';
import { runIntelCycle, __resetIntelCycleLockForTests, CANDIDATE_ASSUMPTIONS } from '../intel/intelCycle';
import { IntelFetchers, pricesToCandles } from '../intel/dataSource';

const NOW = 1_800_000_000_000;

// ── fixture 헬퍼 ──────────────────────────────────────────────────────────────
const ADDR = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

function mkCandles(count: number, opts?: { stepMs?: number; start?: number; drift?: number; base?: number }): Candle[] {
  const step = opts?.stepMs ?? 900_000; // 15m
  const start = opts?.start ?? NOW - count * step;
  const drift = opts?.drift ?? 0;
  const base = opts?.base ?? 100;
  const out: Candle[] = [];
  let p = base;
  for (let i = 0; i < count; i++) {
    const o = p;
    p = p * (1 + drift);
    const c = p;
    out.push({ t: start + i * step, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1000 });
  }
  return out;
}

const scalarMeta = (over?: Partial<Parameters<typeof availablePoint>[1]>) => ({
  source: 'test', symbol: 'ETH', marketAddress: ADDR(1), observedAtMs: NOW - 1000,
  sourceTimestampMs: NOW - 1000, receivedAtMs: NOW, timeframe: null, completeness: 1, stale: false,
  ...over,
});

// ── §3 데이터 계약 ────────────────────────────────────────────────────────────
describe('6I-1 §3 데이터 계약', () => {
  it('NaN 값은 UNAVAILABLE로 강등되고 0으로 대체되지 않는다', () => {
    const p = validateScalarPoint(availablePoint(NaN, scalarMeta()), { nowMs: NOW });
    expect(p.value).toBeNull();
    expect(p.meta.unavailableReason).toContain('NaN');
  });

  it('Infinity 값 거부', () => {
    const p = validateScalarPoint(availablePoint(Infinity, scalarMeta()), { nowMs: NOW });
    expect(p.value).toBeNull();
  });

  it('미래 sourceTimestamp 거부', () => {
    const p = validateScalarPoint(
      availablePoint(1.23, scalarMeta({ sourceTimestampMs: NOW + 60_000 })), { nowMs: NOW });
    expect(p.value).toBeNull();
    expect(p.meta.unavailableReason).toContain('미래');
  });

  it('비음수 필드의 음수 값 거부, allowNegative면 허용', () => {
    expect(validateScalarPoint(availablePoint(-5, scalarMeta()), { nowMs: NOW }).value).toBeNull();
    expect(validateScalarPoint(availablePoint(-5, scalarMeta()), { nowMs: NOW, allowNegative: true }).value).toBe(-5);
  });

  it('maxAge 초과 시 stale 표시(값은 유지 — 위장 갱신 금지)', () => {
    const p = validateScalarPoint(
      availablePoint(1, scalarMeta({ observedAtMs: NOW - 300_000 })), { nowMs: NOW, maxAgeMs: 60_000 });
    expect(p.value).toBe(1);
    expect(p.meta.stale).toBe(true);
  });

  it('unavailablePoint는 reason 필수 + value null', () => {
    const p = unavailablePoint<number>('테스트 사유', { source: 's', symbol: 'ETH', nowMs: NOW });
    expect(p.value).toBeNull();
    expect(p.meta.unavailableReason).toBe('테스트 사유');
  });

  it('캔들: 정상 시리즈 통과 + completeness 산정', () => {
    const v = validateCandleSeries(mkCandles(48), '15m', { nowMs: NOW, expectedCount: 96, minCount: 40 });
    expect(v.ok).toBe(true);
    expect(v.completeness).toBeCloseTo(0.5);
  });

  it('캔들: gap 검출 → 실패 (억지 생성 금지)', () => {
    const c = mkCandles(48);
    c.splice(20, 1); // gap
    const v = validateCandleSeries(c, '15m', { nowMs: NOW, expectedCount: 96, minCount: 40 });
    expect(v.ok).toBe(false);
    expect(v.issues.join()).toContain('gap');
  });

  it('캔들: 중복/역순/미래 시각/NaN 거부', () => {
    const dup = mkCandles(48); dup[10] = { ...dup[9] };
    expect(validateCandleSeries(dup, '15m', { nowMs: NOW, expectedCount: 96, minCount: 40 }).ok).toBe(false);
    const rev = mkCandles(48).reverse();
    expect(validateCandleSeries(rev, '15m', { nowMs: NOW, expectedCount: 96, minCount: 40 }).ok).toBe(false);
    const fut = mkCandles(48, { start: NOW });
    expect(validateCandleSeries(fut, '15m', { nowMs: NOW, expectedCount: 96, minCount: 40 }).ok).toBe(false);
    const nan = mkCandles(48); nan[5].c = NaN;
    expect(validateCandleSeries(nan, '15m', { nowMs: NOW, expectedCount: 96, minCount: 40 }).ok).toBe(false);
  });

  it('캔들 부족 시 실패 — RSI 중립값 같은 대체 없음', () => {
    const v = validateCandleSeries(mkCandles(10), '15m', { nowMs: NOW, expectedCount: 96, minCount: 40 });
    expect(v.ok).toBe(false);
    expect(computeAtrPct(mkCandles(5))).toBeNull();       // 부족=null, 0 아님
    expect(computeTrendScore(mkCandles(3), 8)).toBeNull();
  });

  it('pricesToCandles: 거래량 누락은 null (0 위장 금지)', () => {
    const cs = pricesToCandles([[1, 10, 11, 9, 10.5]]);
    expect(cs[0].v).toBeNull();
    expect(cs[0].t).toBe(1000);
  });
});

// ── §5 Regime ─────────────────────────────────────────────────────────────────
describe('6I-1 §5 Market Regime Engine', () => {
  const feat = (over?: Partial<RegimeFeatures>): RegimeFeatures => ({
    trendShort: 0, trendMedium: 0, momentum: 0, atrPct: 1, change24hPct: 0,
    rsi: 50, sourceDivergencePct: 0, latencyMs: 100, observedAtMs: NOW, ...over,
  });

  it('결정적 — 동일 입력 동일 결과', () => {
    const f = feat({ trendShort: 0.6, trendMedium: 0.6 });
    expect(classifyRegime(f)).toEqual(classifyRegime(f));
  });

  it('강한 상승/하락, 약세 구간 분류', () => {
    expect(classifyRegime(feat({ trendShort: 0.7, trendMedium: 0.7 })).regime).toBe('STRONG_BULL');
    expect(classifyRegime(feat({ trendShort: 0.3, trendMedium: 0.3 })).regime).toBe('WEAK_BULL');
    expect(classifyRegime(feat({ trendShort: -0.7, trendMedium: -0.7 })).regime).toBe('STRONG_BEAR');
    expect(classifyRegime(feat({ trendShort: -0.3, trendMedium: -0.3 })).regime).toBe('WEAK_BEAR');
    expect(classifyRegime(feat()).regime).toBe('RANGE');
  });

  it('필수 feature 누락 = UNAVAILABLE + 진입 차단', () => {
    const r = classifyRegime(feat({ atrPct: null }));
    expect(r.regime).toBe('UNAVAILABLE');
    expect(r.tradeAllowed).toBe(false);
    expect(r.missingFeatures).toContain('atrPct');
  });

  it('소스 괴리/지연 이상 = ABNORMAL + 진입 차단', () => {
    expect(classifyRegime(feat({ sourceDivergencePct: 2 })).regime).toBe('ABNORMAL');
    const r = classifyRegime(feat({ latencyMs: 20_000 }));
    expect(r.regime).toBe('ABNORMAL');
    expect(r.tradeAllowed).toBe(false);
  });

  it('고변동성 = HIGH_VOLATILITY, 전략 NONE', () => {
    const r = classifyRegime(feat({ atrPct: 5 }));
    expect(r.regime).toBe('HIGH_VOLATILITY');
    expect(r.allowedStrategies).toEqual(['NONE']);
  });

  it('OVERHEATED/OVERSOLD (RSI 극단)', () => {
    expect(classifyRegime(feat({ rsi: 85 })).regime).toBe('OVERHEATED');
    expect(classifyRegime(feat({ rsi: 10 })).regime).toBe('OVERSOLD');
  });

  it('RANGE에서 추세 전략 비허용 (regimeAllowsDirection)', () => {
    const r = classifyRegime(feat());
    expect(regimeAllowsDirection(r, 'LONG')).toBe(false);
    expect(regimeAllowsDirection(r, 'SHORT')).toBe(false);
    const bull = classifyRegime(feat({ trendShort: 0.7, trendMedium: 0.7 }));
    expect(regimeAllowsDirection(bull, 'LONG')).toBe(true);
    expect(regimeAllowsDirection(bull, 'SHORT')).toBe(false);
  });

  it('allowedStrategies 매핑은 모든 regime에 대해 정의됨', () => {
    for (const v of Object.values(REGIME_ALLOWED_STRATEGIES)) expect(Array.isArray(v)).toBe(true);
  });
});

// ── §4 Universe ───────────────────────────────────────────────────────────────
describe('6I-1 §4 Universe 2단계 선정', () => {
  const row = (n: number, over?: Partial<RawMarketRow>): RawMarketRow => ({
    marketToken: ADDR(n), indexToken: ADDR(n + 1000), symbol: `SYM${n}`,
    isListed: true, isDisabled: false, liquidityUsd: 10_000_000, openInterestUsd: 5_000_000,
    lastPriceAtMs: NOW - 10_000, impactDataAvailable: true, ...over,
  });

  it('저유동성·미상장·freshness 미달·주소 형식 오류 제외 + 사유 기록', () => {
    const scan = scanUniverse([
      row(1),
      row(2, { liquidityUsd: MIN_LIQUIDITY_USD - 1 }),
      row(3, { isListed: false }),
      row(4, { lastPriceAtMs: NOW - 300_000 }),
      row(5, { marketToken: 'not-an-address' }),
      row(6, { liquidityUsd: null }),
    ], { nowMs: NOW, listComplete: true });
    expect(scan.universeCount).toBe(6);
    expect(scan.passedStage1.map(m => m.symbol)).toEqual(['SYM1']);
    expect(scan.excluded).toHaveLength(5);
    expect(scan.excluded.find(e => e.symbol === 'SYM6')?.reason).toContain('0 위장 금지');
  });

  it('목록 불완전 시 degraded=true (정상 위장 금지)', () => {
    const scan = scanUniverse([row(1)], { nowMs: NOW, listComplete: false, listFailureReason: '부분 실패' });
    expect(scan.degraded).toBe(true);
    expect(scan.degradedReason).toBe('부분 실패');
    const empty = scanUniverse(null, { nowMs: NOW, listComplete: false });
    expect(empty.degraded).toBe(true);
  });

  it('shortlist는 bounded + BTC/ETH 기준시장 항상 포함', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, { liquidityUsd: (i + 2) * 1_000_000 }));
    rows.push(row(100, { symbol: 'BTC', liquidityUsd: 2_000_000 }));
    rows.push(row(101, { symbol: 'ETH', liquidityUsd: 2_000_000 }));
    const sl = selectShortlist(scanUniverse(rows, { nowMs: NOW, listComplete: true }), {});
    expect(sl.shortlistCount).toBeLessThanOrEqual(8);
    expect(sl.benchmarksIncluded).toEqual(expect.arrayContaining(['BTC', 'ETH']));
  });

  it('7종 하드코딩 아님 — 입력 목록 전체 평가', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1));
    const scan = scanUniverse(rows, { nowMs: NOW, listComplete: true });
    expect(scan.passedStage1).toHaveLength(30);
  });
});

// ── §7·§8 확률 정직성·비용 ────────────────────────────────────────────────────
describe('6I-1 §7·§8 확률·순기대값·비용 정직성', () => {
  const fullCost: CostBreakdownUsd = {
    entryFeeUsd: 1, estimatedExitFeeUsd: 1, fundingCostUsd: 0.5, borrowingCostUsd: 0.5,
    priceImpactUsd: 0.5, slippageUsd: 0.5, gasExecutionFeeUsd: 0.2,
    latencyRiskReserveUsd: 0.2, failureRiskReserveUsd: 0.1,
    holdingHoursAssumed: 4, costBasis: 'test', costSource: 'PAPER_GMX_ESTIMATE', costSnapshotFetchedAtMs: NOW,
  };

  it('보정 상태: 표본 수·최신성 기반', () => {
    expect(deriveCalibrationStatus({ completedSamples: 0, lastSampleAtMs: null, nowMs: NOW })).toBe('UNCALIBRATED');
    expect(deriveCalibrationStatus({ completedSamples: MIN_CALIBRATING_SAMPLES, lastSampleAtMs: NOW, nowMs: NOW })).toBe('CALIBRATING');
    expect(deriveCalibrationStatus({ completedSamples: MIN_CALIBRATION_SAMPLES, lastSampleAtMs: NOW, nowMs: NOW })).toBe('CALIBRATED');
    expect(deriveCalibrationStatus({ completedSamples: MIN_CALIBRATION_SAMPLES, lastSampleAtMs: NOW - 15 * 24 * 3_600_000, nowMs: NOW })).toBe('STALE');
  });

  it('보정 확률 null → expectedNetValueUsd null (가짜 50% 금지)', () => {
    expect(computeExpectedNetValueUsd({
      calibratedWinProbability: null, calibrationStatus: 'UNCALIBRATED',
      expectedGrossWinUsd: 20, expectedGrossLossUsd: 10, cost: fullCost,
    })).toBeNull();
  });

  it('CALIBRATED가 아니면 확률이 있어도 null (STALE/CALIBRATING 사용 금지)', () => {
    expect(computeExpectedNetValueUsd({
      calibratedWinProbability: 0.6, calibrationStatus: 'STALE',
      expectedGrossWinUsd: 20, expectedGrossLossUsd: 10, cost: fullCost,
    })).toBeNull();
  });

  it('순기대값 공식: p×win − (1−p)×loss − 비용합', () => {
    const v = computeExpectedNetValueUsd({
      calibratedWinProbability: 0.6, calibrationStatus: 'CALIBRATED',
      expectedGrossWinUsd: 20, expectedGrossLossUsd: 10, cost: fullCost,
    });
    const cost = totalCostUsd(fullCost)!;
    expect(v).toBeCloseTo(0.6 * 20 - 0.4 * 10 - cost);
  });

  it('비용 항목 하나라도 null → 비용합 null → 순기대값 null (0 대체 금지)', () => {
    const c = { ...fullCost, fundingCostUsd: null };
    expect(totalCostUsd(c)).toBeNull();
    expect(computeExpectedNetValueUsd({
      calibratedWinProbability: 0.6, calibrationStatus: 'CALIBRATED',
      expectedGrossWinUsd: 20, expectedGrossLossUsd: 10, cost: c,
    })).toBeNull();
  });

  it('uncalibratedRankingScore는 별도 이름의 연구 점수 — 비용비 없으면 null', () => {
    expect(computeUncalibratedRankingScore({ rawSignalScore: 80, costToGrossEdgeRatio: null, volatilityRisk: 0.2, executionRisk: 0.2 })).toBeNull();
    const s = computeUncalibratedRankingScore({ rawSignalScore: 80, costToGrossEdgeRatio: 0.25, volatilityRisk: 0.2, executionRisk: 0.2 });
    expect(s).toBeCloseTo(80 * 0.75 * 0.8);
  });

  it('expected R: 비용 반영, 입력 누락=null', () => {
    expect(computeExpectedRMultiple({ expectedGrossWinUsd: 20, expectedGrossLossUsd: 10, totalCostUsd: null })).toBeNull();
    expect(computeExpectedRMultiple({ expectedGrossWinUsd: 20, expectedGrossLossUsd: 10, totalCostUsd: 2 })).toBeCloseTo(18 / 12);
  });
});

// ── §9·§10 Ranking·NO_TRADE·목표 추격 금지 ────────────────────────────────────
describe('6I-1 §9·§10 Ranking·NO_TRADE·목표 추격 금지', () => {
  const gates = (over?: Partial<RankingGates>): RankingGates => ({
    riskEngineAllowsEntry: true, riskEngineBlockReason: null,
    openPositionExists: false, dailyEntryLimitReached: false, nowMs: NOW, ...over,
  });

  const bullRegime = classifyRegime({
    trendShort: 0.7, trendMedium: 0.7, momentum: 0.5, atrPct: 1, change24hPct: 3,
    rsi: 60, sourceDivergencePct: 0, latencyMs: 100, observedAtMs: NOW,
  });

  const cand = (over?: Partial<OpportunityCandidate>): OpportunityCandidate => ({
    symbol: 'ETH', market: ADDR(1), indexToken: ADDR(2), direction: 'LONG',
    regime: 'STRONG_BULL', dataQuality: 'GOOD', rawSignalScore: 80,
    trendScore: 0.7, momentumScore: 0.5, volumeScore: null, multiTimeframeAlignment: 0.6,
    btcAlignment: null, fundingScore: null, borrowingScore: null, liquidityScore: 0.8,
    volatilityRisk: 0.2, executionRisk: 0.2,
    expectedEntryPrice: 100, stopPrice: 99, takeProfitPrice: 103, finalNotionalUsd: 1000,
    expectedGrossWinUsd: 30, expectedGrossLossUsd: 10,
    winProbability: 0.6, probabilityCalibrationStatus: 'CALIBRATED',
    cost: {
      entryFeeUsd: 1, estimatedExitFeeUsd: 1, fundingCostUsd: 0.5, borrowingCostUsd: 0.5,
      priceImpactUsd: 0.5, slippageUsd: 0.5, gasExecutionFeeUsd: 0.2,
      latencyRiskReserveUsd: 0.2, failureRiskReserveUsd: 0.1,
      holdingHoursAssumed: 4, costBasis: 'test', costSource: 'GMX_API', costSnapshotFetchedAtMs: NOW - 5_000,
    },
    totalExpectedCostUsd: 4.5, expectedNetValueUsd: 0.6 * 30 - 0.4 * 10 - 4.5,
    expectedNetValuePct: null, expectedRMultiple: (30 - 4.5) / (10 + 4.5),
    costToGrossEdgeRatio: 4.5 / 30, uncalibratedRankingScore: 60,
    rejectionReasons: [], decision: 'ELIGIBLE', ...over,
  });
  const regimes = new Map([[ADDR(1), bullRegime]]);

  it('정상 후보 1개 → SELECTED, rank=1', () => {
    const r = rankAndSelect([cand()], regimes, gates());
    expect(r.decision).toBe('SELECTED');
    expect(r.selected?.symbol).toBe('ETH');
    expect(r.evaluated[0].rank).toBe(1);
  });

  it('후보 0개 = NO_TRADE 정상 결과', () => {
    const r = rankAndSelect([], regimes, gates());
    expect(r.decision).toBe('NO_TRADE');
    expect(r.noTradeReasons.join()).toContain('후보 없음');
  });

  it('최고 confidence 후보가 비용으로 탈락하면 선택 금지', () => {
    const expensive = cand({
      rawSignalScore: 95,
      totalExpectedCostUsd: 15, costToGrossEdgeRatio: 15 / 20,
      expectedNetValueUsd: 0.6 * 20 - 0.4 * 10 - 15,
      expectedRMultiple: (20 - 15) / (10 + 15),
    });
    const modest = cand({ symbol: 'BTC', market: ADDR(9), rawSignalScore: 70 });
    const regs = new Map([[ADDR(1), bullRegime], [ADDR(9), bullRegime]]);
    const r = rankAndSelect([expensive, modest], regs, gates());
    expect(r.selected?.symbol).toBe('BTC');
    const rejected = r.evaluated.find(c => c.symbol === 'ETH');
    expect(rejected?.decision).toBe('REJECTED');
    expect(rejected?.rejectionReasons.join()).toContain('잠식비');
  });

  it('낮은 신호·높은 순기대값 후보가 높은 신호·낮은 순기대값보다 우선', () => {
    const highSignalLowEv = cand({ symbol: 'A', market: ADDR(11), rawSignalScore: 90, expectedNetValueUsd: 5.5 });
    const lowSignalHighEv = cand({ symbol: 'B', market: ADDR(12), rawSignalScore: 60, expectedNetValueUsd: 9 });
    const regs = new Map([[ADDR(11), bullRegime], [ADDR(12), bullRegime]]);
    const r = rankAndSelect([highSignalLowEv, lowSignalHighEv], regs, gates());
    expect(r.selected?.symbol).toBe('B');
  });

  it('regime 비허용 방향은 거부 (RANGE에서 LONG 등)', () => {
    const rangeRegime = classifyRegime({
      trendShort: 0, trendMedium: 0, momentum: 0, atrPct: 1, change24hPct: 0,
      rsi: 50, sourceDivergencePct: 0, latencyMs: 100, observedAtMs: NOW,
    });
    const r = rankAndSelect([cand()], new Map([[ADDR(1), rangeRegime]]), gates());
    expect(r.decision).toBe('NO_TRADE');
    expect(r.evaluated[0].rejectionReasons.join()).toContain('비허용');
  });

  it('비용 snapshot 30초 초과 = 실행 적격 탈락', () => {
    const staleCost = cand({ cost: { ...cand().cost, costSnapshotFetchedAtMs: NOW - 31_000 } });
    const r = rankAndSelect([staleCost], regimes, gates());
    expect(r.decision).toBe('NO_TRADE');
    expect(r.evaluated[0].rejectionReasons.join()).toContain('실행 적격 초과');
  });

  it('비용 데이터 누락 = DATA_UNAVAILABLE (0 대체 금지)', () => {
    const noCost = cand({ totalExpectedCostUsd: null, expectedNetValueUsd: null, expectedRMultiple: null });
    const r = rankAndSelect([noCost], regimes, gates());
    expect(r.decision).toBe('NO_TRADE');
    expect(r.evaluated[0].decision).toBe('DATA_UNAVAILABLE');
  });

  it('보정 확률 없음(순기대값 null) → SHADOW_ONLY 강등, 자율 선택 금지', () => {
    const uncal = cand({ winProbability: null, probabilityCalibrationStatus: 'UNCALIBRATED', expectedNetValueUsd: null });
    const r = rankAndSelect([uncal], regimes, gates());
    expect(r.decision).toBe('NO_TRADE');
    expect(['SHADOW_ONLY', 'REJECTED']).toContain(r.evaluated[0].decision);
    expect(r.evaluated[0].decision).toBe('SHADOW_ONLY');
  });

  it('RiskEngine 차단 = 전 후보 거부', () => {
    const r = rankAndSelect([cand()], regimes, gates({ riskEngineAllowsEntry: false, riskEngineBlockReason: 'RISK_LOCKED' }));
    expect(r.decision).toBe('NO_TRADE');
    expect(r.noTradeReasons.join()).toContain('RISK_LOCKED');
  });

  it('열린 포지션 존재/일일 한도 도달 시 신규 후보 차단', () => {
    expect(rankAndSelect([cand()], regimes, gates({ openPositionExists: true })).decision).toBe('NO_TRADE');
    expect(rankAndSelect([cand()], regimes, gates({ dailyEntryLimitReached: true })).decision).toBe('NO_TRADE');
  });

  it('통과 후보 여러 개 → 최상위 1개만 SELECTED', () => {
    const a = cand({ symbol: 'A', market: ADDR(21), expectedNetValueUsd: 6 });
    const b = cand({ symbol: 'B', market: ADDR(22), expectedNetValueUsd: 9 });
    const c = cand({ symbol: 'C', market: ADDR(23), expectedNetValueUsd: 7 });
    const regs = new Map([[ADDR(21), bullRegime], [ADDR(22), bullRegime], [ADDR(23), bullRegime]]);
    const r = rankAndSelect([a, b, c], regs, gates());
    expect(r.selected?.symbol).toBe('B');
    expect(r.evaluated.filter(x => x.rank === 1)).toHaveLength(1);
  });

  it('§10 임계값은 frozen — 런타임 변경 불가 (목표 추격 금지)', () => {
    expect(Object.isFrozen(RANKING_THRESHOLDS)).toBe(true);
    expect(() => {
      (RANKING_THRESHOLDS as { minRawSignalScore: number }).minRawSignalScore = 1;
    }).toThrow();
    expect(Object.isFrozen(CANDIDATE_ASSUMPTIONS)).toBe(true);
  });

  it('§10 ranking 입력에 일일 PnL/목표/시간/거래횟수 기반 완화 변수 없음 — 동일 입력 동일 결과', () => {
    // RankingGates에는 완화 방향 필드가 없다 (차단 방향만 존재).
    const g = gates();
    expect('dailyPnlUsd' in g).toBe(false);
    expect('dailyTargetUsd' in g).toBe(false);
    expect('hoursSinceLastTrade' in g).toBe(false);
    const r1 = rankAndSelect([cand()], regimes, g);
    const r2 = rankAndSelect([cand()], regimes, g);
    expect(r1.selected?.symbol).toEqual(r2.selected?.symbol);
    expect(r1.evaluated).toEqual(r2.evaluated);
  });
});

// ── §12 Shadow outcome (lookahead 금지) ──────────────────────────────────────
describe('6I-1 §12 Shadow outcome', () => {
  const H1 = 3_600_000;
  const base = {
    direction: 'LONG' as const, entryPrice: 100, stopPrice: 99, takeProfitPrice: 102,
    notionalUsd: 1000, totalCostUsd: 3, decidedAtMs: NOW - 2 * H1, horizonMs: H1, nowMs: NOW,
  };

  it('horizon 미경과 = incomplete (미래 결과 기록 금지)', () => {
    const r = computeShadowOutcome({ ...base, decidedAtMs: NOW - H1 / 2, candlesAfter: mkCandles(10) });
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toContain('horizon 미경과');
    expect(r.hypotheticalNetPnlUsd).toBeNull();
  });

  it('lookahead 방지 — 결정 이전 캔들은 무시된다', () => {
    // 결정 이전 폭등 캔들 + 결정 이후 소폭 상승만
    const beforeSpike = mkCandles(4, { start: NOW - 4 * H1, stepMs: 900_000, base: 100, drift: 0.5 });
    const after = mkCandles(8, { start: base.decidedAtMs + 900_000, stepMs: 900_000, base: 100, drift: 0.001 });
    const r = computeShadowOutcome({ ...base, candlesAfter: [...beforeSpike, ...after] });
    expect(r.complete).toBe(true);
    // before spike가 반영됐다면 MFE가 매우 컸을 것 — after만 반영됨을 확인
    expect(r.maxFavorableExcursionPct!).toBeLessThan(5);
  });

  it('미래 데이터 미확보 = incomplete + 0 기록 금지', () => {
    const r = computeShadowOutcome({ ...base, candlesAfter: [] });
    expect(r.complete).toBe(false);
    expect(r.hypotheticalGrossPnlUsd).toBeNull();
    expect(r.maxAdverseExcursionPct).toBeNull();
  });

  it('6I-2 §7 — 같은 캔들에서 stop/target 모두 닿으면 AMBIGUOUS_INTRABAR (임의 선택 금지)', () => {
    const wild: Candle = { t: base.decidedAtMs + 900_000, o: 100, h: 103, l: 98, c: 100, v: 1 };
    const rest = mkCandles(6, { start: base.decidedAtMs + 2 * 900_000, stepMs: 900_000, base: 100 });
    const r = computeShadowOutcome({ ...base, candlesAfter: [wild, ...rest] });
    expect(r.firstTouch).toBe('AMBIGUOUS_INTRABAR');
    expect(r.status).toBe('AMBIGUOUS_INTRABAR');
    expect(r.complete).toBe(false);                  // 보정 표본으로 세지 않음
    expect(r.exitPrice).toBe(99);                    // 참고 exit은 보수적 stop
    expect(r.hypotheticalGrossPnlUsd).toBeCloseTo(-10); // 1% × $1000 (참고값)
  });

  it('stop만 닿으면 STOP first-touch 유지', () => {
    const stopOnly: Candle = { t: base.decidedAtMs + 900_000, o: 100, h: 100.5, l: 98, c: 99.5, v: 1 };
    const rest = mkCandles(6, { start: base.decidedAtMs + 2 * 900_000, stepMs: 900_000, base: 99.5 });
    const r = computeShadowOutcome({ ...base, candlesAfter: [stopOnly, ...rest] });
    expect(r.firstTouch).toBe('STOP');
    expect(r.status).toBe('COMPLETE');
    expect(r.complete).toBe(true);
  });

  it('lookahead 방지 — horizon 경계에 걸친/미폐쇄 캔들은 제외된다', () => {
    const horizonEnd = base.decidedAtMs + H1;
    const closed = mkCandles(3, { start: base.decidedAtMs + 900_000, stepMs: 900_000, base: 100, drift: 0.001 });
    // open time은 horizonEnd 이내지만 close time이 horizonEnd를 넘는 폭등 캔들 — 반영 금지
    const straddling: Candle = { t: horizonEnd - 300_000, o: 100, h: 150, l: 100, c: 150, v: 1 };
    const r = computeShadowOutcome({ ...base, candlesAfter: [...closed, straddling] });
    expect(r.complete).toBe(true);
    expect(r.maxFavorableExcursionPct!).toBeLessThan(5); // straddling h=150 미반영
    expect(r.firstTouch).toBe('NONE');
  });

  it('lookahead 방지 — nowMs 기준 진행 중(미폐쇄) 캔들은 제외된다', () => {
    const decidedAt = NOW - H1 - 900_000;
    const closed = mkCandles(3, { start: decidedAt + 900_000, stepMs: 900_000, base: 100, drift: 0.001 });
    // close time이 nowMs를 넘는 진행 중 캔들
    const inProgress: Candle = { t: NOW - 300_000, o: 100, h: 150, l: 50, c: 150, v: 1 };
    const r = computeShadowOutcome({ ...base, decidedAtMs: decidedAt, candlesAfter: [...closed, inProgress] });
    if (r.complete) {
      expect(r.maxFavorableExcursionPct!).toBeLessThan(5);
      expect(r.maxAdverseExcursionPct!).toBeLessThan(5);
    } else {
      expect(r.hypotheticalNetPnlUsd).toBeNull();
    }
  });

  it('비용 미상이면 net PnL도 null (0 대체 금지)', () => {
    const after = mkCandles(8, { start: base.decidedAtMs + 900_000, stepMs: 900_000, base: 100 });
    const r = computeShadowOutcome({ ...base, totalCostUsd: null, candlesAfter: after });
    expect(r.complete).toBe(true);
    expect(r.hypotheticalGrossPnlUsd).not.toBeNull();
    expect(r.hypotheticalNetPnlUsd).toBeNull();
  });
});

describe('6I-1 §12 boundedNum 영속화 직렬화', () => {
  it('경계값 반올림 overflow — 반올림 결과가 상한을 넘으면 null 강등', () => {
    // 999999999999.9999995 → toFixed(6) 반올림 시 1e12 도달 → null (pg overflow 방지)
    expect(boundedNum(999999999999.9999995, 1e12, 6)).toBeNull();
    expect(boundedNum(1e12, 1e12, 6)).toBeNull();
    expect(boundedNum(-1e12, 1e12, 6)).toBeNull();
  });
  it('정상 범위 값은 고정 소수 표기로 직렬화 (지수 표기 금지)', () => {
    expect(boundedNum(1.05e-7, 1e10, 8)).toBe('0.00000011');
    expect(boundedNum(1906.46, 1e10, 8)).toBe('1906.46000000');
  });
  it('NaN/Infinity/null = null', () => {
    expect(boundedNum(NaN, 1e12, 6)).toBeNull();
    expect(boundedNum(Infinity, 1e12, 6)).toBeNull();
    expect(boundedNum(null, 1e12, 6)).toBeNull();
  });
});

// ── §13 Metrics ───────────────────────────────────────────────────────────────
describe('6I-1 §13 Shadow metrics', () => {
  const row = (over?: Partial<ShadowOutcomeRow>): ShadowOutcomeRow => ({
    candidateId: 'x', direction: 'LONG', regime: 'STRONG_BULL', decision: 'SHADOW_ONLY',
    selected: false, rank: null, calibratedProbability: null, expectedRMultiple: 1.5,
    outcome1hNetUsd: 2, outcome4hNetUsd: 5, hypotheticalGrossPnlUsd: 8, hypotheticalTotalCostUsd: 3,
    maxFavorableExcursionPct: 1, maxAdverseExcursionPct: 0.5, complete: true,
    outcomeStatus4h: 'COMPLETE', firstTouch: 'TARGET', ...over,
  });

  it('표본 부족 = INSUFFICIENT_SAMPLE (0/정상 위장 금지)', () => {
    const m = computeShadowMetrics([row(), row()]);
    expect(m.status).toBe('INSUFFICIENT_SAMPLE');
    if (m.status === 'INSUFFICIENT_SAMPLE') {
      expect(m.sampleCount).toBe(2);
      expect(m.required).toBe(MIN_METRIC_SAMPLES);
    }
    expect(m.autoPromotionAllowed).toBe(false);
  });

  it('충분 표본 → 지표 산출, Brier는 보정 확률 표본만, 자동 승격 항상 false', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ candidateId: `c${i}`, outcome4hNetUsd: i % 2 === 0 ? 5 : -3 }));
    rows[0] = { ...rows[0], calibratedProbability: 0.7 };
    const m = computeShadowMetrics(rows, { cycleCount: 100, noTradeCycles: 90 });
    expect(m.status).toBe('OK');
    if (m.status === 'OK') {
      expect(m.sampleCount).toBe(40);
      expect(m.noTradeRatio).toBeCloseTo(0.9);
      expect(m.brierSampleCount).toBe(1);
      expect(m.netExpectancy4hUsd).not.toBeNull();
      expect(m.autoPromotionAllowed).toBe(false);
    }
  });

  it('incomplete 행은 표본에서 제외 (가짜 완료 금지)', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ candidateId: `c${i}`, complete: false }));
    expect(computeShadowMetrics(rows).status).toBe('INSUFFICIENT_SAMPLE');
  });
});

// ── §14 intelCycle 오케스트레이터 (mock fetcher — 외부 호출 0회) ─────────────
describe('6I-1 §14 intelCycle', () => {
  const mkFetchers = (over?: Partial<IntelFetchers>): IntelFetchers => ({
    fetchMarketRows: async () => ({
      rows: [
        {
          marketToken: ADDR(1), indexToken: ADDR(2), symbol: 'ETH', isListed: true, isDisabled: false,
          liquidityUsd: 50_000_000, openInterestUsd: 10_000_000, lastPriceAtMs: NOW - 5_000, impactDataAvailable: true,
        },
        {
          marketToken: ADDR(3), indexToken: ADDR(4), symbol: 'BTC', isListed: true, isDisabled: false,
          liquidityUsd: 80_000_000, openInterestUsd: 20_000_000, lastPriceAtMs: NOW - 5_000, impactDataAvailable: true,
        },
      ], complete: true, failureReason: null,
    }),
    fetchCandles: async () => mkCandles(96, { drift: 0.002 }),
    fetchPrice: async () => ({ price: 100, observedAtMs: NOW - 3_000 }),
    fetch24hChange: async () => 2.5,
    fetchFundingBorrowing: async () => null,
    ...over,
  });

  const gates: RankingGates = {
    riskEngineAllowsEntry: true, riskEngineBlockReason: null,
    openPositionExists: false, dailyEntryLimitReached: false, nowMs: NOW,
  };

  it('전체 파이프라인 — 후보 시장당 LONG/SHORT 생성, 미보정이므로 자율 선택 없음(NO_TRADE)', async () => {
    __resetIntelCycleLockForTests();
    let persisted = false;
    const rec = await runIntelCycle({
      fetchers: mkFetchers(),
      getCompletedSampleCount: async () => ({ count: 0, lastAtMs: null }),
      persist: async () => { persisted = true; },
      gates, nowMs: NOW, cycleId: 'test-1',
    });
    expect(rec).not.toBeNull();
    expect(persisted).toBe(true);
    expect(rec!.universeCount).toBe(2);
    expect(rec!.candidates).toHaveLength(4); // 2 시장 × LONG/SHORT
    expect(rec!.decision).toBe('NO_TRADE'); // 비용/보정 확률 없음 → 자율 선택 불가
    expect(rec!.selected).toBeNull();
    // 모든 후보의 확률은 null — 가짜 50% 없음
    for (const c of rec!.candidates) {
      expect(c.winProbability).toBeNull();
      expect(c.expectedNetValueUsd).toBeNull();
    }
  });

  it('저장 실패 = BLOCKED (기록 없는 결정 채택 금지)', async () => {
    __resetIntelCycleLockForTests();
    const rec = await runIntelCycle({
      fetchers: mkFetchers(),
      getCompletedSampleCount: async () => ({ count: 0, lastAtMs: null }),
      persist: async () => { throw new Error('DB down'); },
      gates, nowMs: NOW, cycleId: 'test-2',
    });
    expect(rec!.decision).toBe('BLOCKED');
    expect(rec!.selected).toBeNull();
    expect(rec!.blockedReason).toContain('DB down');
  });

  it('데이터 소스 실패 시 UNAVAILABLE/DEGRADED 정직 표기 (가짜 정상 금지)', async () => {
    __resetIntelCycleLockForTests();
    const rec = await runIntelCycle({
      fetchers: mkFetchers({
        fetchCandles: async () => null,
        fetchMarketRows: async () => ({ rows: [], complete: false, failureReason: 'markets 실패' }),
      }),
      getCompletedSampleCount: async () => ({ count: 0, lastAtMs: null }),
      persist: async () => {},
      gates, nowMs: NOW, cycleId: 'test-3',
    });
    expect(rec!.dataQuality).toBe('UNAVAILABLE');
    expect(rec!.degraded).toBe(true);
    expect(rec!.degradedReason).toBe('markets 실패');
    expect(rec!.decision).toBe('NO_TRADE');
  });

  it('overlap 방지 — 동시 실행 시 두 번째는 null', async () => {
    __resetIntelCycleLockForTests();
    let release: () => void = () => {};
    const blocker = new Promise<void>(r => { release = r; });
    const slow = runIntelCycle({
      fetchers: mkFetchers({ fetchMarketRows: async () => { await blocker; return { rows: [], complete: true, failureReason: null }; } }),
      getCompletedSampleCount: async () => ({ count: 0, lastAtMs: null }),
      persist: async () => {},
      gates, nowMs: NOW, cycleId: 'slow',
    });
    const second = await runIntelCycle({
      fetchers: mkFetchers(),
      getCompletedSampleCount: async () => ({ count: 0, lastAtMs: null }),
      persist: async () => {},
      gates, nowMs: NOW, cycleId: 'second',
    });
    expect(second).toBeNull();
    release();
    await slow;
  });
});
