/**
 * 6I-1 §14 — Market Intelligence 사이클 오케스트레이터 (SHADOW_ONLY).
 *
 *  - 이 파이프라인은 어떤 주문도 실행하지 않는다 — 후보·NO_TRADE를 기록만 한다.
 *  - LIVE 자율 실행은 구조적으로 불가: 실행 경로 호출 자체가 없다.
 *  - snapshot/candidate 저장 실패 = 해당 사이클 결과 채택 차단 (BLOCKED 기록).
 *  - overlap 방지: 이전 intel 사이클 미완료 시 skip.
 */
import { createHash } from 'node:crypto';
import { MarketSnapshot, DataQuality, Timeframe, availablePoint, unavailablePoint, Candle } from './types';
import { validateCandleSeries, computeAtrPct, computeTrendScore, computeMomentumScore } from './candles';
import { classifyRegime, RegimeResult } from './regime';
import { scanUniverse, selectShortlist, ScannedMarket, ShortlistResult } from './universe';
import {
  OpportunityCandidate, CandidateDirection, deriveCalibrationStatus, totalCostUsd,
  computeExpectedNetValueUsd, computeUncalibratedRankingScore, computeExpectedRMultiple,
  computeCostToGrossEdgeRatio, CostBreakdownUsd, ProbabilityCalibrationStatus,
} from './candidate';
import { rankAndSelect, RankingGates, RankingResult } from './ranking';
import { IntelFetchers, mapBounded } from './dataSource';

export interface IntelCycleDeps {
  fetchers: IntelFetchers;
  /** 완료 shadow 표본 수 조회 (보정 상태 판정용) */
  getCompletedSampleCount(): Promise<{ count: number; lastAtMs: number | null }>;
  /** 저장 — 실패 시 throw (사이클 BLOCKED) */
  persist(result: IntelCycleRecord): Promise<void>;
  gates: RankingGates;
  nowMs: number;
  cycleId: string;
}

export interface IntelCycleRecord {
  cycleId: string;
  nowMs: number;
  universeCount: number;
  shortlistCount: number;
  shortlistSymbols: string[];
  degraded: boolean;
  degradedReason: string | null;
  regimes: Map<string, RegimeResult>;
  candidates: (OpportunityCandidate & { rank: number | null })[];
  decision: 'SELECTED' | 'NO_TRADE' | 'BLOCKED';
  selected: OpportunityCandidate | null;
  noTradeReasons: string[];
  dataQuality: DataQuality;
  snapshotHash: string;
  blockedReason: string | null;
}

/** §7 — 후보 생성 시 사용하는 고정 가정 (목표 추격 변수 없음) */
export const CANDIDATE_ASSUMPTIONS = Object.freeze({
  stopDistanceFraction: 0.01,        // 1% stop
  takeProfitDistanceFraction: 0.02,  // 2% target (R 2:1 구조)
  shadowNotionalUsd: 1_000,          // shadow 시뮬 명목 (실주문 아님)
  candleTimeframe: '15m' as Timeframe,
  candleCount: 96,                   // 24h
  candleMinCount: 40,
  concurrency: 3,
});

function buildSnapshot(m: ScannedMarket, candles: Candle[] | null, price: { price: number; observedAtMs: number } | null, change24h: number | null, nowMs: number): MarketSnapshot {
  const src = { source: 'gmx-stats', symbol: m.symbol, marketAddress: m.marketToken, nowMs };
  const tf = CANDIDATE_ASSUMPTIONS.candleTimeframe;
  const val = candles === null
    ? { ok: false as const, issues: ['캔들 조회 실패'], completeness: 0, candles: null }
    : validateCandleSeries(candles, tf, { nowMs, expectedCount: CANDIDATE_ASSUMPTIONS.candleCount, minCount: CANDIDATE_ASSUMPTIONS.candleMinCount });

  const meta = (source: string, observedAtMs: number, timeframe: Timeframe | null = null, completeness = 1) => ({
    source, symbol: m.symbol, marketAddress: m.marketToken, observedAtMs,
    sourceTimestampMs: observedAtMs, receivedAtMs: nowMs, timeframe, completeness, stale: nowMs - observedAtMs > 120_000,
  });

  const unav = <T,>(reason: string, timeframe: Timeframe | null = null) => unavailablePoint<T>(reason, { ...src, timeframe });
  const good = val.ok ? val.candles! : null;

  const atr = good ? computeAtrPct(good) : null;
  const trendS = good ? computeTrendScore(good, 8) : null;    // 2h
  const trendM = good ? computeTrendScore(good, 48) : null;   // 12h
  const mom = good ? computeMomentumScore(good, 24) : null;   // 6h
  const lastCandleAt = good ? good[good.length - 1].t : nowMs;

  const qualityIssues = [...val.issues];
  const dataQuality: DataQuality =
    price === null ? 'UNAVAILABLE'
      : good === null ? 'DEGRADED'
        : val.completeness < 1 || change24h === null ? 'DEGRADED' : 'GOOD';

  return {
    symbol: m.symbol, marketAddress: m.marketToken, indexTokenAddress: m.indexToken, assembledAtMs: nowMs,
    price: price ? availablePoint(price.price, meta('gmx-oracle', price.observedAtMs)) : unav('가격 없음'),
    candles: { [tf]: good ? availablePoint(good, meta('gmx-stats', lastCandleAt, tf, val.completeness)) : unav<Candle[]>(val.issues.join('; ') || '캔들 없음', tf) },
    volume24hUsd: unav('거래량 실측 미배선'),
    atrPct: atr !== null ? availablePoint(atr, meta('derived:candles', lastCandleAt, tf, val.completeness)) : unav('ATR 산출 불가'),
    trendShort: trendS !== null ? availablePoint(trendS, meta('derived:candles', lastCandleAt, tf, val.completeness)) : unav('단기 추세 산출 불가'),
    trendMedium: trendM !== null ? availablePoint(trendM, meta('derived:candles', lastCandleAt, tf, val.completeness)) : unav('중기 추세 산출 불가'),
    momentum: mom !== null ? availablePoint(mom, meta('derived:candles', lastCandleAt, tf, val.completeness)) : unav('모멘텀 산출 불가'),
    fundingRatePerHour: unav('funding 실측 미배선'),
    borrowingRatePerHour: unav('borrowing 실측 미배선'),
    openInterestLongUsd: m.openInterestUsd !== null ? availablePoint(m.openInterestUsd, meta('gmx-markets', nowMs)) : unav('OI 없음'),
    openInterestShortUsd: unav('방향별 OI 미배선'),
    longShortImbalance: unav('long/short 편중 미배선'),
    liquidityUsd: availablePoint(m.liquidityUsd, meta('gmx-markets', nowMs)),
    expectedPriceImpactPct: unav('impact 견적 미배선 (비용 snapshot에서 별도 확보)'),
    change24hPct: change24h !== null ? availablePoint(change24h, meta('gmx-stats', nowMs)) : unav('24h 변화율 없음'),
    dataQuality, qualityIssues,
  };
}

function buildCandidates(
  snap: MarketSnapshot, regime: RegimeResult, direction: CandidateDirection,
  calibration: { status: ProbabilityCalibrationStatus },
): OpportunityCandidate {
  const A = CANDIDATE_ASSUMPTIONS;
  const trend = snap.trendShort.value !== null && snap.trendMedium.value !== null
    ? (snap.trendShort.value + snap.trendMedium.value) / 2 : null;
  const mom = snap.momentum.value;
  const dirSign = direction === 'LONG' ? 1 : -1;

  // rawSignalScore 0..100 — 방향 정합 추세·모멘텀 기반 상대 점수 (확률 아님)
  const aligned = trend !== null && mom !== null ? (trend * dirSign + mom * dirSign) / 2 : null;
  const rawSignalScore = aligned === null ? 0 : Math.max(0, Math.min(100, 50 + aligned * 50));

  const price = snap.price.value;
  const entry = price;
  const stop = entry !== null ? entry * (1 - dirSign * A.stopDistanceFraction) : null;
  const tp = entry !== null ? entry * (1 + dirSign * A.takeProfitDistanceFraction) : null;
  const grossWin = A.shadowNotionalUsd * A.takeProfitDistanceFraction;
  const grossLoss = A.shadowNotionalUsd * A.stopDistanceFraction;

  // 비용 — 실측 비용 snapshot이 shadow 후보 생성 시점엔 없음 → 명시적 UNAVAILABLE.
  // (0 대체 금지 — decision은 ranking에서 DATA_UNAVAILABLE/SHADOW_ONLY로 강등된다.)
  const cost: CostBreakdownUsd = {
    entryFeeUsd: null, estimatedExitFeeUsd: null, fundingCostUsd: null, borrowingCostUsd: null,
    priceImpactUsd: null, slippageUsd: null, gasExecutionFeeUsd: null,
    latencyRiskReserveUsd: null, failureRiskReserveUsd: null,
    holdingHoursAssumed: 4, costBasis: 'UNAVAILABLE — 실측 비용 snapshot 미확보', costSource: null,
    costSnapshotFetchedAtMs: null,
  };
  const total = totalCostUsd(cost);
  const winProbability = null; // 보정 표본 확보 전 — 가짜 50% 금지
  const env = computeExpectedNetValueUsd({
    calibratedWinProbability: winProbability, calibrationStatus: calibration.status,
    expectedGrossWinUsd: grossWin, expectedGrossLossUsd: grossLoss, cost,
  });
  const costRatio = computeCostToGrossEdgeRatio({ expectedGrossWinUsd: grossWin, totalCostUsd: total });
  const volatilityRisk = snap.atrPct.value !== null ? Math.min(1, snap.atrPct.value / 8) : null;
  const executionRisk = snap.dataQuality === 'GOOD' ? 0.2 : snap.dataQuality === 'DEGRADED' ? 0.6 : 1;

  return {
    symbol: snap.symbol, market: snap.marketAddress ?? '', indexToken: snap.indexTokenAddress,
    direction, regime: regime.regime, dataQuality: snap.dataQuality,
    rawSignalScore,
    trendScore: trend, momentumScore: mom, volumeScore: null,
    multiTimeframeAlignment: trend !== null && mom !== null ? (Math.sign(trend) === Math.sign(mom) ? Math.abs(trend + mom) / 2 : -Math.abs(trend - mom) / 2) : null,
    btcAlignment: null, fundingScore: null, borrowingScore: null,
    liquidityScore: snap.liquidityUsd.value !== null ? Math.min(1, snap.liquidityUsd.value / 50_000_000) : null,
    volatilityRisk, executionRisk,
    expectedEntryPrice: entry, stopPrice: stop, takeProfitPrice: tp,
    finalNotionalUsd: A.shadowNotionalUsd,
    expectedGrossWinUsd: grossWin, expectedGrossLossUsd: grossLoss,
    winProbability, probabilityCalibrationStatus: calibration.status,
    cost, totalExpectedCostUsd: total,
    expectedNetValueUsd: env,
    expectedNetValuePct: env !== null ? (env / A.shadowNotionalUsd) * 100 : null,
    expectedRMultiple: computeExpectedRMultiple({ expectedGrossWinUsd: grossWin, expectedGrossLossUsd: grossLoss, totalCostUsd: total }),
    costToGrossEdgeRatio: costRatio,
    uncalibratedRankingScore: computeUncalibratedRankingScore({ rawSignalScore, costToGrossEdgeRatio: costRatio ?? 1, volatilityRisk, executionRisk }),
    rejectionReasons: [], decision: 'SHADOW_ONLY',
  };
}

let intelCycleRunning = false;

export async function runIntelCycle(deps: IntelCycleDeps): Promise<IntelCycleRecord | null> {
  if (intelCycleRunning) return null; // overlap 방지
  intelCycleRunning = true;
  try {
    const { nowMs, cycleId } = deps;
    // 1·2. universe 스캔 + shortlist
    const marketData = await deps.fetchers.fetchMarketRows(nowMs);
    const scan = scanUniverse(marketData.rows, { nowMs, listComplete: marketData.complete, listFailureReason: marketData.failureReason });
    const shortlist: ShortlistResult = selectShortlist(scan, {});

    // 3. shortlist 정밀 스냅샷 (bounded concurrency)
    const snaps = await mapBounded(shortlist.shortlist, CANDIDATE_ASSUMPTIONS.concurrency, async m => {
      const [candles, price, ch] = await Promise.all([
        deps.fetchers.fetchCandles(m.symbol, CANDIDATE_ASSUMPTIONS.candleTimeframe, CANDIDATE_ASSUMPTIONS.candleCount),
        deps.fetchers.fetchPrice(m.symbol),
        deps.fetchers.fetch24hChange(m.symbol),
      ]);
      return buildSnapshot(m, candles, price, ch, nowMs);
    });

    // 4. regime — 시장별
    const regimes = new Map<string, RegimeResult>();
    for (const s of snaps) {
      regimes.set(s.marketAddress ?? s.symbol, classifyRegime({
        trendShort: s.trendShort.value, trendMedium: s.trendMedium.value, momentum: s.momentum.value,
        atrPct: s.atrPct.value, change24hPct: s.change24hPct.value, rsi: null,
        sourceDivergencePct: null, latencyMs: null, observedAtMs: nowMs,
      }));
    }

    // 5. 후보 — 시장별 LONG/SHORT 독립 평가
    const sample = await deps.getCompletedSampleCount();
    const calStatus = deriveCalibrationStatus({ completedSamples: sample.count, lastSampleAtMs: sample.lastAtMs, nowMs });
    const candidates: OpportunityCandidate[] = [];
    for (const s of snaps) {
      const regime = regimes.get(s.marketAddress ?? s.symbol)!;
      candidates.push(buildCandidates(s, regime, 'LONG', { status: calStatus }));
      candidates.push(buildCandidates(s, regime, 'SHORT', { status: calStatus }));
    }

    // 6·7. ranking + NO_TRADE
    const ranking: RankingResult = rankAndSelect(candidates, regimes, deps.gates);

    const overallQuality: DataQuality =
      snaps.length === 0 ? 'UNAVAILABLE'
        : shortlist.degraded || snaps.some(s => s.dataQuality !== 'GOOD') ? 'DEGRADED' : 'GOOD';

    const record: IntelCycleRecord = {
      cycleId, nowMs,
      universeCount: scan.universeCount, shortlistCount: shortlist.shortlistCount,
      shortlistSymbols: shortlist.shortlist.map(m => m.symbol),
      degraded: shortlist.degraded, degradedReason: scan.degradedReason,
      regimes, candidates: ranking.evaluated,
      decision: ranking.decision, selected: ranking.selected, noTradeReasons: ranking.noTradeReasons,
      dataQuality: overallQuality,
      snapshotHash: createHash('sha256').update(JSON.stringify({
        cycleId, universe: scan.universeCount, shortlist: shortlist.shortlist.map(m => m.marketToken),
        regimes: [...regimes.entries()].map(([k, v]) => [k, v.regime]),
      })).digest('hex').slice(0, 32),
      blockedReason: null,
    };

    // 8. 저장 — 실패 시 결과 채택 차단 (기록 없는 결정 금지)
    try {
      await deps.persist(record);
    } catch (e) {
      return { ...record, decision: 'BLOCKED', selected: null, blockedReason: `저장 실패: ${e instanceof Error ? e.message : 'unknown'}` };
    }
    return record;
  } finally {
    intelCycleRunning = false;
  }
}

/** 테스트 전용 — overlap 플래그 초기화 */
export function __resetIntelCycleLockForTests(): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') intelCycleRunning = false;
}
