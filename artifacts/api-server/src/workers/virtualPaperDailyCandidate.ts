const BAR_MS = 15 * 60_000;
const INPUT_CANDLES = 16;
const V7_MIN_ATR_FRACTION = 0.002;
const V7_MAX_ATR_FRACTION = 0.008;
export const ADAPTIVE_SIGNAL_VERSION = 'paper-entry-signals/v8' as const;
export type DailyRegime = 'TREND' | 'BREAKOUT' | 'RANGE' | 'TRANSITION';
export type DailySetup = 'TREND_PULLBACK' | 'VOLATILITY_BREAKOUT' | 'RANGE_MEAN_REVERSION';
export interface SignalEvidence {
  kind: DailySetup;
  side: 'LONG' | 'SHORT' | null;
  score: number;
  threshold: number;
  eligible: boolean;
  reason: string;
  targetPrice: number | null;
  targetBasis: 'OBSERVED_SWING' | 'OBSERVED_RANGE_PROJECTION' | null;
}
export interface DailyCandidateEvaluation {
  version: typeof ADAPTIVE_SIGNAL_VERSION;
  regime: DailyRegime;
  atrFraction: number;
  symbolMedianTrueRangeFraction: number;
  adaptiveVolatilityMin: number;
  adaptiveVolatilityMax: number;
  efficiency: number;
  momentumFraction: number;
  stopPrice: number | null;
  stopFraction: number | null;
  /** Maximum historically observed favorable excursion in matching 15m bar windows; evidence, not a forecast. */
  observedHorizonMoveFraction: { INTRADAY: number; SWING: number };
  signals: SignalEvidence[];
  selectedSetup: DailySetup | null;
  selectedScore: number;
  scoreThreshold: number;
  eligible: boolean;
  reason: string;
}
export interface DailyPaperCandidate {
  symbol: string;
  source: 'gmx-official-api';
  closedAt: number;
  patternAnalysis?: import('../intel/patterns/chartPatterns').PatternAnalysis;
  evaluatedAt: number;
  side: 'LONG' | 'SHORT';
  referencePrice: number;
  stopFraction: number;
  /** Legacy 1h close momentum; retained for v7 replay/display compatibility only. */
  momentum: number;
  purpose: 'AGGRESSIVE_PAPER_EXPERIMENT';
  /** v7 exact quality gate. Never rewritten using v8 rules; absent only on older fixtures/serialized inputs. */
  legacyQuality?: { eligible: boolean; reason: string; regime: 'TREND' | 'RANGE' | 'TRANSITION'; efficiency: number; atrFraction: number };
  /** Original v7 direction and ATR stop are retained for exact paired assessment. */
  legacySide?: 'LONG' | 'SHORT';
  legacyStopFraction?: number;
  /** v8 explainable score; signal permission, not a probability or profit estimate. */
  quality: { eligible: boolean; reason: string; regime: DailyRegime; efficiency: number; atrFraction: number; score?: number };
  evaluation?: DailyCandidateEvaluation;
}
type Bar = [time: number, open: number, high: number, low: number, close: number];

const trueRange = (current: Bar, previous: Bar): number =>
  Math.max(current[2] - current[3], Math.abs(current[2] - previous[4]), Math.abs(current[3] - previous[4]));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const sideFor = (direction: number): 'LONG' | 'SHORT' => direction >= 0 ? 'LONG' : 'SHORT';

/**
 * Preserves the exact v7 gate for paired retrospective comparison. The v8
 * candidate path does not call this value to decide eligibility.
 */
export function evaluateLegacyDailyQuality(input: {
  momentum: number;
  earlierMomentum: number;
  efficiency: number;
  atrFraction: number;
  candleBodyFractionOfAtr: number;
  candleDirection: number;
  location: number;
  bullishWickFractionOfBody: number;
  bearishWickFractionOfBody: number;
}): NonNullable<DailyPaperCandidate['legacyQuality']> {
  const trend = input.efficiency >= .35 && input.momentum * input.earlierMomentum > 0;
  const range = input.efficiency < .25;
  const regime = trend ? 'TREND' : range ? 'RANGE' : 'TRANSITION';
  const weak = Math.abs(input.momentum) < input.atrFraction * .5;
  const chased = input.candleBodyFractionOfAtr > 1.5;
  const rangeRejection = range && (
    (input.location < .25 && input.candleDirection > 0 && input.bullishWickFractionOfBody > 1)
    || (input.location > .75 && input.candleDirection < 0 && input.bearishWickFractionOfBody > 1)
  );
  const eligible = input.atrFraction >= V7_MIN_ATR_FRACTION && input.atrFraction <= V7_MAX_ATR_FRACTION
    && !chased && ((trend && !weak) || rangeRejection);
  const reason = eligible ? 'MARKET_QUALITY_ACCEPTED'
    : chased ? 'CHASE_CANDLE'
      : input.atrFraction < V7_MIN_ATR_FRACTION || input.atrFraction > V7_MAX_ATR_FRACTION
        ? 'VOLATILITY_OUTSIDE_STOP_RANGE'
        : weak ? 'WEAK_MOMENTUM' : 'REGIME_OR_CONFIRMATION_MISSING';
  return { eligible, reason, regime, efficiency: input.efficiency, atrFraction: input.atrFraction };
}

/** Metadata-only companion for same-candle old/new comparison; never opens positions. */
export interface DailyCandidateComparison {
  candidateId: string;
  symbol: string;
  closedAt: number;
  legacy: { version: 'virtual400-daily/v7'; eligible: boolean; reason: string; atrFraction: number };
  adaptive: { version: typeof ADAPTIVE_SIGNAL_VERSION; eligible: boolean; reason: string; selectedSetup: DailySetup | null; score: number };
}
export function dailyCandidateComparison(candidate: DailyPaperCandidate): DailyCandidateComparison {
  const legacyQuality=candidate.legacyQuality??candidate.quality;
  return {
    candidateId: `${candidate.symbol}:${candidate.closedAt}`,
    symbol: candidate.symbol,
    closedAt: candidate.closedAt,
    legacy: { version: 'virtual400-daily/v7', eligible: !!legacyQuality?.eligible,
      reason: legacyQuality?.reason??'V7_QUALITY_EVIDENCE_MISSING', atrFraction: legacyQuality?.atrFraction??0 },
    adaptive: { version: ADAPTIVE_SIGNAL_VERSION, eligible: candidate.evaluation?.eligible??false,
      reason: candidate.evaluation?.reason??'V8_SIGNAL_EVIDENCE_MISSING',
      selectedSetup: candidate.evaluation?.selectedSetup??null, score: candidate.evaluation?.selectedScore??0 },
  };
}

export function dailyPaperCandidate(symbol: string, raw: { prices: number[][]; source: string } | null, now: number): DailyPaperCandidate | null {
  if (!raw || raw.source !== 'gmx-official-api' || !/^[A-Z0-9_]{1,24}$/.test(symbol)) return null;
  const rows = raw.prices.map(row => [row[0] < 1e12 ? row[0] * 1000 : row[0], ...row.slice(1, 5)] as Bar)
    .filter(row => row[0] + BAR_MS <= now - 2000).sort((a, b) => a[0] - b[0]).slice(-INPUT_CANDLES);
  if (rows.length !== INPUT_CANDLES || rows.some((row, index) =>
    row.length !== 5 || row[0] % BAR_MS !== 0 || row.some(value => !Number.isFinite(value) || value <= 0)
    || row[2] < Math.max(row[1], row[3], row[4]) || row[3] > Math.min(row[1], row[2], row[4])
    || (index > 0 && row[0] - rows[index - 1][0] !== BAR_MS))) return null;
  const last = rows.at(-1)!;
  const closedAt = last[0] + BAR_MS;
  if (now - closedAt > BAR_MS + 60_000) return null;

  const ranges = rows.slice(1).map((row, index) => trueRange(row, rows[index]));
  const rangeFractions = ranges.map((value, index) => value / rows[index + 1][4]);
  const atr = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  const atrFraction = atr / last[4];
  // A per-symbol median of its own completed-candle true ranges adapts the
  // signal screen to that symbol's current regime; it is not a future forecast.
  const symbolMedianTrueRangeFraction = median(rangeFractions);
  const adaptiveVolatilityMin = Math.max(.0002, symbolMedianTrueRangeFraction * .45);
  const adaptiveVolatilityMax = Math.min(.02, symbolMedianTrueRangeFraction * 3);
  const observedHorizonMoveFraction = (side: 'LONG' | 'SHORT', barCount: number): number => {
    const completedBeforeSignal = rows.slice(0, -1);
    let best = 0;
    for (let start = 0; start + 1 < completedBeforeSignal.length; start++) {
      const from = completedBeforeSignal[start][4];
      const window = completedBeforeSignal.slice(start + 1, Math.min(completedBeforeSignal.length, start + barCount + 1));
      if (!window.length) continue;
      const favorable = side === 'LONG' ? Math.max(...window.map(bar => bar[2])) / from - 1
        : 1 - Math.min(...window.map(bar => bar[3])) / from;
      best = Math.max(best, favorable);
    }
    return Math.max(0, best);
  };
  const changes = rows.slice(1).map((row, index) => Math.abs(row[4] - rows[index][4]));
  const travel = changes.reduce((sum, value) => sum + value, 0);
  const efficiency = travel > 0 ? Math.abs(last[4] - rows[0][4]) / travel : 0;
  const momentum = last[4] / rows[11][4] - 1;
  const earlierMomentum = rows[11][4] / rows[7][4] - 1;
  const previous = rows.slice(0, -1);
  const priorHigh = Math.max(...previous.map(row => row[2]));
  const priorLow = Math.min(...previous.map(row => row[3]));
  const span = priorHigh - priorLow;
  const location = span > 0 ? (last[4] - priorLow) / span : .5;
  const body = Math.abs(last[4] - last[1]);
  const candleRange = last[2] - last[3];
  const lowerWick = Math.min(last[1], last[4]) - last[3];
  const upperWick = last[2] - Math.max(last[1], last[4]);
  const recentSwingBars = rows.slice(-5, -1);
  const recentSupport = Math.min(...recentSwingBars.map(row => row[3]));
  const recentResistance = Math.max(...recentSwingBars.map(row => row[2]));
  const supportBelow = Math.min(...recentSwingBars.filter(row => row[3] < last[4]).map(row => row[3]));
  const resistanceAbove = Math.max(...recentSwingBars.filter(row => row[2] > last[4]).map(row => row[2]));
  const direction = momentum >= 0 ? 'LONG' : 'SHORT';
  const adaptiveVolatilityOk = atrFraction >= adaptiveVolatilityMin && atrFraction <= adaptiveVolatilityMax
    && atrFraction <= .02 && symbolMedianTrueRangeFraction > 0;
  const candleShapeOk = candleRange > 0;
  const regime: DailyRegime = efficiency >= .45 && momentum * earlierMomentum > 0 ? 'TREND'
    : efficiency <= .30 ? 'RANGE' : 'TRANSITION';
  const scoreThreshold = 45;

  const targetFor = (side: 'LONG' | 'SHORT', setup: DailySetup): { price: number | null; basis: SignalEvidence['targetBasis'] } => {
    // Targets are pre-existing, actually printed swing prices. We deliberately
    // do not add ATR or 2R to invent a price level beyond observed structure.
    if (setup === 'RANGE_MEAN_REVERSION') {
      const target = side === 'LONG' ? recentResistance : recentSupport;
      return { price: side === 'LONG' ? target > last[4] ? target : null : target < last[4] ? target : null,
        basis: 'OBSERVED_SWING' };
    }
    if (setup === 'VOLATILITY_BREAKOUT') {
      // Classical measured move: use a printed prior range boundary plus one
      // *observed prior range width*. No ATR multiple or imposed 2R target.
      const projected = side === 'LONG' ? priorHigh + span : priorLow - span;
      return { price: side === 'LONG' ? projected > last[4] ? projected : null
        : projected < last[4] ? projected : null,
      basis: projected > 0 ? 'OBSERVED_RANGE_PROJECTION' : null };
    }
    const swings: number[] = [];
    for (let index = 1; index + 1 < previous.length; index++) {
      const bar = previous[index];
      const isSwing = side === 'LONG'
        ? bar[2] >= previous[index - 1][2] && bar[2] > previous[index + 1][2] && bar[2] > last[4]
        : bar[3] <= previous[index - 1][3] && bar[3] < previous[index + 1][3] && bar[3] < last[4];
      if (isSwing) swings.push(side === 'LONG' ? bar[2] : bar[3]);
    }
    swings.sort((a, b) => side === 'LONG' ? a - b : b - a);
    return { price: swings[0] ?? null, basis: swings.length ? 'OBSERVED_SWING' : null };
  };
  const result = (kind: DailySetup, side: 'LONG' | 'SHORT' | null, score: number, threshold: number,
    reason: string, target: { price: number | null; basis: SignalEvidence['targetBasis'] }): SignalEvidence =>
    ({ kind, side, score, threshold, eligible: side !== null && score >= threshold && adaptiveVolatilityOk
      && target.price !== null && Number.isFinite(target.price) && (side === 'LONG' ? target.price > last[4] : target.price < last[4]),
    reason, targetPrice: target.price, targetBasis: target.basis });

  const normalizedTrendStrength = Math.min(1, Math.abs(momentum) / Math.max(symbolMedianTrueRangeFraction * 4, .0001));
  const trendSide = momentum === 0 ? null : sideFor(momentum);
  const trendScore = Math.round(20 + Math.min(30, efficiency * 30) + normalizedTrendStrength * 30
    + (momentum * earlierMomentum > 0 ? 10 : 0) + (Math.sign(last[4] - last[1]) === Math.sign(momentum) ? 10 : 0));
  const trendSignal = result('TREND_PULLBACK', regime === 'TREND' && Math.abs(momentum) >= symbolMedianTrueRangeFraction * .35 ? trendSide : null,
    Math.min(100, trendScore), scoreThreshold,
    regime !== 'TREND' ? 'REGIME_NOT_TREND' : Math.abs(momentum) < symbolMedianTrueRangeFraction * .35 ? 'TREND_MOMENTUM_BELOW_SYMBOL_THRESHOLD' : 'MEASURED_TREND_SCORE',
    trendSide ? targetFor(trendSide, 'TREND_PULLBACK') : { price: null, basis: null });

  const breakoutSide: 'LONG' | 'SHORT' | null = last[4] > priorHigh && last[4] > last[1] ? 'LONG'
    : last[4] < priorLow && last[4] < last[1] ? 'SHORT' : null;
  const breakoutExcess = breakoutSide === 'LONG' ? (last[4] - priorHigh) / last[4]
    : breakoutSide === 'SHORT' ? (priorLow - last[4]) / last[4] : 0;
  const breakoutScore = Math.round(40 + Math.min(30, breakoutExcess / Math.max(symbolMedianTrueRangeFraction, .0001) * 20)
    + (candleShapeOk ? Math.min(20, body / candleRange * 20) : 0) + (momentum * earlierMomentum > 0 ? 10 : 0));
  const breakoutSignal = result('VOLATILITY_BREAKOUT', breakoutSide, Math.min(100, breakoutScore), 50,
    breakoutSide ? 'CLOSED_BAR_RANGE_BREAK' : 'NO_CLOSED_BAR_RANGE_BREAK',
    breakoutSide ? targetFor(breakoutSide, 'VOLATILITY_BREAKOUT') : { price: null, basis: null });

  const rangeSide: 'LONG' | 'SHORT' | null = regime === 'RANGE' && location <= .30 && last[4] > last[1]
    && lowerWick > body * .5 ? 'LONG'
    : regime === 'RANGE' && location >= .70 && last[4] < last[1] && upperWick > body * .5 ? 'SHORT' : null;
  const edgeProximity = rangeSide === 'LONG' ? Math.max(0, .30 - location) / .30
    : rangeSide === 'SHORT' ? Math.max(0, location - .70) / .30 : 0;
  const wickRatio = rangeSide === 'LONG' ? lowerWick / Math.max(candleRange, Number.EPSILON)
    : rangeSide === 'SHORT' ? upperWick / Math.max(candleRange, Number.EPSILON) : 0;
  const rangeScore = Math.round(35 + edgeProximity * 25 + Math.min(.8, wickRatio) * 25
    + (momentum * (rangeSide === 'LONG' ? 1 : -1) >= 0 ? 15 : 0));
  const rangeSignal = result('RANGE_MEAN_REVERSION', rangeSide, Math.min(100, rangeScore), 45,
    rangeSide ? 'CLOSED_BAR_RANGE_EDGE_REJECTION' : 'NO_CLOSED_BAR_RANGE_REJECTION',
    rangeSide ? targetFor(rangeSide, 'RANGE_MEAN_REVERSION') : { price: null, basis: null });

  const signals = [trendSignal, breakoutSignal, rangeSignal];
  for (const signal of signals) {
    if (!adaptiveVolatilityOk) signal.reason = 'VOLATILITY_OUTSIDE_SYMBOL_ADAPTIVE_RANGE';
    else if (signal.side && signal.targetPrice === null) signal.reason = 'NO_OBSERVED_STRUCTURE_TARGET';
  }
  const selected = signals.filter(signal => signal.eligible).sort((a, b) => b.score - a.score)[0] ?? null;
  const pivot = selected?.side === 'LONG' ? supportBelow : selected?.side === 'SHORT' ? resistanceAbove : NaN;
  const structuralStop = selected?.side === 'LONG' ? pivot : selected?.side === 'SHORT' ? pivot : NaN;
  const stopFraction = selected && Number.isFinite(structuralStop) && structuralStop > 0
    ? Math.abs(last[4] - structuralStop) / last[4] : NaN;
  // These are unchanged PAPER executor stop bounds; no target-distance is
  // used to tighten the stop or manufacture a better net-R/R.
  const stopOk = Number.isFinite(stopFraction) && stopFraction >= .002 && stopFraction <= .008;
  const eligible = selected !== null && stopOk;
  const reason = selected === null ? !adaptiveVolatilityOk ? 'VOLATILITY_OUTSIDE_SYMBOL_ADAPTIVE_RANGE'
    : signals.every(signal => signal.side === null) ? 'NO_EXPLAINABLE_PATTERN_SCORE'
      : signals.some(signal => signal.side !== null && signal.targetPrice === null) ? 'NO_OBSERVED_STRUCTURE_TARGET'
        : signals.find(signal => signal.side !== null && signal.score < signal.threshold)?.reason ?? 'NO_PATTERN_PASSED_SCORE_THRESHOLD'
    : !stopOk ? 'OBSERVED_STRUCTURAL_STOP_OUTSIDE_EXECUTOR_BOUNDS' : 'ADAPTIVE_SIGNAL_SCORE_ACCEPTED';
  const side = selected?.side ?? direction;
  const evaluation: DailyCandidateEvaluation = {
    version: ADAPTIVE_SIGNAL_VERSION, regime, atrFraction, symbolMedianTrueRangeFraction,
    adaptiveVolatilityMin, adaptiveVolatilityMax, efficiency, momentumFraction: momentum,
    stopPrice: eligible ? structuralStop : null, stopFraction: eligible ? stopFraction : null,
    observedHorizonMoveFraction: {
      INTRADAY: observedHorizonMoveFraction(selected?.side ?? direction, 4),
      SWING: observedHorizonMoveFraction(selected?.side ?? direction, 15),
    },
    signals, selectedSetup: selected?.kind ?? null, selectedScore: selected?.score ?? 0,
    scoreThreshold: selected?.threshold ?? scoreThreshold, eligible, reason,
  };
  const legacyQuality = evaluateLegacyDailyQuality({
    momentum, earlierMomentum, efficiency, atrFraction,
    candleBodyFractionOfAtr: body / atr,
    candleDirection:last[4]-last[1],
    location,
    bullishWickFractionOfBody: lowerWick / Math.max(body, Number.EPSILON),
    bearishWickFractionOfBody: upperWick / Math.max(body, Number.EPSILON),
  });
  const legacyRangeRejection=legacyQuality.regime==='RANGE'&&(
    (location<.25&&last[4]>last[1]&&lowerWick>body)
    ||(location>.75&&last[4]<last[1]&&upperWick>body));
  const legacyDirection=legacyRangeRejection?(location<.25?'LONG':'SHORT')
    :momentum!==0?sideFor(momentum):sideFor(last[4]-last[1]);
  return {
    symbol, source: 'gmx-official-api', closedAt, evaluatedAt: now, side,
    referencePrice: last[4], stopFraction: eligible ? stopFraction : Math.max(.002, Math.min(.008, atrFraction)),
    legacySide:legacyDirection,legacyStopFraction:Math.max(.002,Math.min(.008,atrFraction)),
    momentum, purpose: 'AGGRESSIVE_PAPER_EXPERIMENT', legacyQuality,
    quality: { eligible, reason, regime, efficiency, atrFraction, score: evaluation.selectedScore }, evaluation,
  };
}