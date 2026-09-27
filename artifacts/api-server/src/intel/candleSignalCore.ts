/**
 * Asset-independent, pure multi-timeframe Candle Signal core.
 *
 * Boundary:
 *  - accepts closed 4H/1H/15m OHLCV series only
 *  - emits advisory Signal → Risk evidence only
 *  - never sizes, authorizes, persists, signs, submits, or executes an order
 */
import {
  buildMultiTimeframeCandleSet,
  CandleFoundationConfig,
  CandleFrameInput,
  DEFAULT_CANDLE_FOUNDATION_CONFIG,
  StrategyTimeframe,
  STRATEGY_TIMEFRAMES,
  validateCandleFoundationConfig,
} from './candleFoundationV2';
import {
  CANDLE_SIGNAL_SCHEMA_VERSION,
  CandleFrameFeatures,
  CandleSignalConfig,
  CandleSignalDirection,
  CandleSignalReasonCode,
  CandleSignalScoreComponent,
  CandleSignalToRisk,
  CandleSignalWeightKey,
  DEFAULT_CANDLE_SIGNAL_CONFIG,
  GrossRiskRewardEvidence,
  HigherTimeframeTrend,
  parseCandleSignalConfig,
  StructuralStopCandidate,
} from './candleSignalContract';
import { extractCandleFrameFeatures } from './candleSignalFeatures';
import { TIMEFRAME_MS } from './types';

export interface CandleSignalInput {
  symbol: string;
  frames: Partial<Record<StrategyTimeframe, CandleFrameInput>>;
  evaluatedAtMs: number;
}

/** Significant-digit serialization preserves geometry for sub-micro priced assets. */
const round = (value: number, significantDigits = 12): number =>
  Number(value.toPrecision(significantDigits));

const emptyResult = (
  input: CandleSignalInput,
  flags: string[],
  reasonCodes: CandleSignalReasonCode[],
): CandleSignalToRisk => ({
  schemaVersion: CANDLE_SIGNAL_SCHEMA_VERSION,
  configVersion: CANDLE_SIGNAL_SCHEMA_VERSION,
  symbol: input.symbol,
  evaluatedAtMs: input.evaluatedAtMs,
  direction: 'NO_TRADE',
  confidence: 0,
  longConfidence: 0,
  shortConfidence: 0,
  entryCandidate: null,
  structuralStopCandidate: null,
  grossExpectedRiskReward: null,
  supportResistance: null,
  volatility: { timeframe: '15m', atrPct: null, atrAbs: null },
  volumeConfirmation: {
    quality: 'UNAVAILABLE',
    current: null,
    recentAverage: null,
    ratio: null,
    confirmed: null,
    reason: 'signal data unavailable',
  },
  higherTimeframeTrend: 'UNAVAILABLE',
  frameFeatures: null,
  dataQuality: {
    status: 'INVALID',
    flags,
    frameCloseTimesMs: { '15m': null, '1h': null, '4h': null },
    excludedOpenCandles: { '15m': 0, '1h': 0, '4h': 0 },
    scoreCoveragePct: 0,
  },
  scoreComponents: [],
  reasonCodes,
  reasons: ['데이터/설정 품질 미달 — NO_TRADE', ...flags],
});

function expectedLatestCloseMs(
  nowMs: number,
  timeframe: StrategyTimeframe,
  closeGraceMs: number,
): number {
  const step = TIMEFRAME_MS[timeframe];
  return Math.floor((nowMs - closeGraceMs) / step) * step;
}

const maMatch = (features: CandleFrameFeatures, direction: 'LONG' | 'SHORT'): number | null => {
  const { close, maFast, maMedium, maLong } = features;
  if (maFast === null || maMedium === null || maLong === null) return null;
  if (direction === 'LONG') {
    if (close > maFast && maFast > maMedium && maMedium > maLong) return 1;
    if (close > maFast && maFast > maMedium) return 0.5;
    return 0;
  }
  if (close < maFast && maFast < maMedium && maMedium < maLong) return 1;
  if (close < maFast && maFast < maMedium) return 0.5;
  return 0;
};

const rsiMatch = (
  features: CandleFrameFeatures,
  config: CandleSignalConfig,
  direction: 'LONG' | 'SHORT',
): number | null => {
  if (features.rsi === null) return null;
  if (direction === 'LONG') {
    return features.rsi >= config.thresholds.longRsiMin
      && features.rsi <= config.thresholds.longRsiMax ? 1 : 0;
  }
  return features.rsi >= config.thresholds.shortRsiMin
    && features.rsi <= config.thresholds.shortRsiMax ? 1 : 0;
};

const structureMatch = (
  features: CandleFrameFeatures,
  direction: 'LONG' | 'SHORT',
): number | null => {
  const { highPattern, lowPattern } = features.swings;
  if (highPattern === 'UNAVAILABLE' && lowPattern === 'UNAVAILABLE') return null;
  if (direction === 'LONG') {
    return Number(highPattern === 'HH') * 0.5 + Number(lowPattern === 'HL') * 0.5;
  }
  return Number(highPattern === 'LH') * 0.5 + Number(lowPattern === 'LL') * 0.5;
};

const proximityMatch = (
  features: CandleFrameFeatures,
  direction: 'LONG' | 'SHORT',
): number | null => {
  const evidence = features.supportResistance;
  return direction === 'LONG'
    ? (evidence.nearSupport === null ? null : Number(evidence.nearSupport))
    : (evidence.nearResistance === null ? null : Number(evidence.nearResistance));
};

const candleMatch = (
  features: CandleFrameFeatures,
  config: CandleSignalConfig,
  direction: 'LONG' | 'SHORT',
): number | null => {
  const anatomy = features.anatomy;
  if (direction === 'LONG') {
    const wick = anatomy.lowerWickToBodyRatio;
    return Number(anatomy.bullish) * 0.5
      + Number(wick !== null && wick >= config.thresholds.wickToBodyMin) * 0.5;
  }
  const wick = anatomy.upperWickToBodyRatio;
  return Number(anatomy.bearish) * 0.5
    + Number(wick !== null && wick >= config.thresholds.wickToBodyMin) * 0.5;
};

const volumeMatch = (features: CandleFrameFeatures): number | null =>
  features.volume.confirmed === null ? null : Number(features.volume.confirmed);

interface ComponentSpec {
  id: CandleSignalWeightKey;
  timeframe: StrategyTimeframe;
  label: string;
  rawValue: number | string | null;
  longMatch: number | null;
  shortMatch: number | null;
}

function buildScoreComponents(
  features: Record<StrategyTimeframe, CandleFrameFeatures>,
  config: CandleSignalConfig,
): CandleSignalScoreComponent[] {
  const specs: ComponentSpec[] = [
    {
      id: 'trend4hMa', timeframe: '4h', label: '4H MA 방향',
      rawValue: features['4h'].close,
      longMatch: maMatch(features['4h'], 'LONG'), shortMatch: maMatch(features['4h'], 'SHORT'),
    },
    {
      id: 'trend4hRsi', timeframe: '4h', label: '4H RSI',
      rawValue: features['4h'].rsi,
      longMatch: rsiMatch(features['4h'], config, 'LONG'), shortMatch: rsiMatch(features['4h'], config, 'SHORT'),
    },
    {
      id: 'trend4hStructure', timeframe: '4h', label: '4H swing 구조',
      rawValue: `${features['4h'].swings.highPattern}/${features['4h'].swings.lowPattern}`,
      longMatch: structureMatch(features['4h'], 'LONG'), shortMatch: structureMatch(features['4h'], 'SHORT'),
    },
    {
      id: 'structure1hMa', timeframe: '1h', label: '1H MA 구조',
      rawValue: features['1h'].close,
      longMatch: maMatch(features['1h'], 'LONG'), shortMatch: maMatch(features['1h'], 'SHORT'),
    },
    {
      id: 'structure1hSwings', timeframe: '1h', label: '1H HH/HL/LH/LL',
      rawValue: `${features['1h'].swings.highPattern}/${features['1h'].swings.lowPattern}`,
      longMatch: structureMatch(features['1h'], 'LONG'), shortMatch: structureMatch(features['1h'], 'SHORT'),
    },
    {
      id: 'structure1hProximity', timeframe: '1h', label: '1H 지지/저항 근접',
      rawValue: features['1h'].supportResistance.supportDistancePct,
      longMatch: proximityMatch(features['1h'], 'LONG'), shortMatch: proximityMatch(features['1h'], 'SHORT'),
    },
    {
      id: 'confirmation15mMa', timeframe: '15m', label: '15m MA confirmation',
      rawValue: features['15m'].close,
      longMatch: maMatch(features['15m'], 'LONG'), shortMatch: maMatch(features['15m'], 'SHORT'),
    },
    {
      id: 'confirmation15mRsi', timeframe: '15m', label: '15m RSI confirmation',
      rawValue: features['15m'].rsi,
      longMatch: rsiMatch(features['15m'], config, 'LONG'), shortMatch: rsiMatch(features['15m'], config, 'SHORT'),
    },
    {
      id: 'confirmation15mCandle', timeframe: '15m', label: '15m body/wick confirmation',
      rawValue: features['15m'].anatomy.bullish ? 'BULLISH' : features['15m'].anatomy.bearish ? 'BEARISH' : 'DOJI',
      longMatch: candleMatch(features['15m'], config, 'LONG'), shortMatch: candleMatch(features['15m'], config, 'SHORT'),
    },
    {
      id: 'confirmation15mVolume', timeframe: '15m', label: '15m volume confirmation',
      rawValue: features['15m'].volume.ratio,
      longMatch: volumeMatch(features['15m']), shortMatch: volumeMatch(features['15m']),
    },
  ];
  return specs.map(spec => {
    const weight = config.weights[spec.id];
    const available = spec.longMatch !== null && spec.shortMatch !== null;
    return {
      ...spec,
      weight,
      available,
      longContribution: spec.longMatch === null ? null : round(weight * spec.longMatch),
      shortContribution: spec.shortMatch === null ? null : round(weight * spec.shortMatch),
    };
  });
}

function score(
  components: CandleSignalScoreComponent[],
  direction: 'LONG' | 'SHORT',
): { confidence: number; coveragePct: number } {
  const available = components.filter(component => component.available);
  const availableWeight = available.reduce((sum, component) => sum + component.weight, 0);
  const contribution = available.reduce((sum, component) => sum + (
    direction === 'LONG'
      ? (component.longContribution ?? 0)
      : (component.shortContribution ?? 0)
  ), 0);
  return {
    confidence: availableWeight > 0 ? round(contribution / availableWeight * 100, 2) : 0,
    coveragePct: round(availableWeight, 2),
  };
}

function deriveHigherTimeframeTrend(
  features: Record<StrategyTimeframe, CandleFrameFeatures>,
): HigherTimeframeTrend {
  const longMa = maMatch(features['4h'], 'LONG');
  const shortMa = maMatch(features['4h'], 'SHORT');
  const longStructure = structureMatch(features['4h'], 'LONG');
  const shortStructure = structureMatch(features['4h'], 'SHORT');
  if (longMa === null || shortMa === null) return 'UNAVAILABLE';
  if (longMa >= 0.5 && (longStructure ?? 0) >= 0.5) return 'BULLISH';
  if (shortMa >= 0.5 && (shortStructure ?? 0) >= 0.5) return 'BEARISH';
  return 'NEUTRAL';
}

function selectDirection(
  longConfidence: number,
  shortConfidence: number,
  higherTimeframeTrend: HigherTimeframeTrend,
  coveragePct: number,
  config: CandleSignalConfig,
  reasonCodes: CandleSignalReasonCode[],
  reasons: string[],
): CandleSignalDirection {
  if (coveragePct < config.thresholds.minScoreCoveragePct) {
    reasonCodes.push('SCORE_COVERAGE_LOW');
    reasons.push(`score coverage ${coveragePct}% < 최소 ${config.thresholds.minScoreCoveragePct}%`);
    return 'NO_TRADE';
  }
  if (Math.abs(longConfidence - shortConfidence) <= config.thresholds.tieTolerance) {
    reasonCodes.push('SCORE_TIE');
    reasons.push(`LONG/SHORT 점수 동률 허용범위 이내 (${longConfidence}/${shortConfidence})`);
    return 'NO_TRADE';
  }
  const direction = longConfidence > shortConfidence ? 'LONG' : 'SHORT';
  const confidence = Math.max(longConfidence, shortConfidence);
  if (confidence < config.thresholds.minConfidence) {
    reasonCodes.push('CONFIDENCE_BELOW_MIN');
    reasons.push(`최고 confidence ${confidence} < 최소 ${config.thresholds.minConfidence}`);
    return 'NO_TRADE';
  }
  if ((direction === 'LONG' && higherTimeframeTrend !== 'BULLISH')
    || (direction === 'SHORT' && higherTimeframeTrend !== 'BEARISH')) {
    reasonCodes.push('HTF_TREND_MISMATCH');
    reasons.push(`${direction} 후보와 4H 추세(${higherTimeframeTrend}) 불일치`);
    return 'NO_TRADE';
  }
  return direction;
}

function buildStop(
  direction: 'LONG' | 'SHORT',
  features: Record<StrategyTimeframe, CandleFrameFeatures>,
  config: CandleSignalConfig,
): StructuralStopCandidate | null {
  const entry = features['15m'].close;
  const rawSignal = features['15m'];
  const inputLow = rawSignal.low;
  const inputHigh = rawSignal.high;
  const structureLow = features['1h'].swings.recentSwingLow;
  const structureHigh = features['1h'].swings.recentSwingHigh;
  const atrAbs = features['15m'].atrAbs;
  if (atrAbs === null) return null;
  const buffer = Math.max(
    atrAbs * config.thresholds.stopBufferAtrMultiplier,
    entry * config.thresholds.minStopBufferPct / 100,
  );
  const referencePrice = direction === 'LONG'
    ? Math.min(inputLow, structureLow ?? inputLow)
    : Math.max(inputHigh, structureHigh ?? inputHigh);
  const stopPrice = round(direction === 'LONG' ? referencePrice - buffer : referencePrice + buffer);
  const stopDistance = round(Math.abs(entry - stopPrice));
  if (!Number.isFinite(stopPrice) || !Number.isFinite(stopDistance)
    || stopPrice <= 0 || stopDistance <= 0
    || (direction === 'LONG' && stopPrice >= entry)
    || (direction === 'SHORT' && stopPrice <= entry)) return null;
  return {
    direction,
    referencePrice: round(referencePrice),
    referenceBasis: direction === 'LONG'
      ? 'SIGNAL_AND_STRUCTURE_LOW'
      : 'SIGNAL_AND_STRUCTURE_HIGH',
    buffer: round(buffer),
    bufferBasis: 'MAX_ATR_OR_MIN_PCT',
    stopPrice,
    stopDistance,
    stopDistancePct: round(stopDistance / entry * 100),
  };
}

function buildRiskReward(
  direction: 'LONG' | 'SHORT',
  features: Record<StrategyTimeframe, CandleFrameFeatures>,
  stop: StructuralStopCandidate,
  config: CandleSignalConfig,
): GrossRiskRewardEvidence | null {
  const entry = features['15m'].close;
  const structuralTarget = direction === 'LONG'
    ? features['1h'].supportResistance.resistance
    : features['1h'].supportResistance.support;
  const structuralReward = structuralTarget === null ? null : Math.abs(structuralTarget - entry);
  const structuralIsValid = structuralTarget !== null && (
    direction === 'LONG' ? structuralTarget > entry : structuralTarget < entry
  ) && structuralReward !== null && structuralReward >= stop.stopDistance;
  const rewardDistance = structuralIsValid
    ? structuralReward!
    : stop.stopDistance * config.thresholds.targetRiskMultiple;
  const targetPriceCandidate = round(direction === 'LONG'
    ? entry + rewardDistance
    : entry - rewardDistance);
  const serializedRiskDistance = round(stop.stopDistance);
  const serializedRewardDistance = round(Math.abs(targetPriceCandidate - entry));
  if (!Number.isFinite(targetPriceCandidate)
    || targetPriceCandidate <= 0
    || serializedRiskDistance <= 0
    || serializedRewardDistance <= 0
    || (direction === 'LONG' && targetPriceCandidate <= entry)
    || (direction === 'SHORT' && targetPriceCandidate >= entry)) {
    return null;
  }
  return {
    riskDistance: serializedRiskDistance,
    rewardDistance: serializedRewardDistance,
    ratio: round(serializedRewardDistance / serializedRiskDistance),
    targetPriceCandidate,
    targetBasis: structuralIsValid ? 'NEAREST_STRUCTURE' : 'CONFIGURED_R_MULTIPLE',
  };
}

export function evaluateCandleSignal(
  input: CandleSignalInput,
  configInput: unknown = DEFAULT_CANDLE_SIGNAL_CONFIG,
  foundationConfig: CandleFoundationConfig = DEFAULT_CANDLE_FOUNDATION_CONFIG,
): CandleSignalToRisk {
  const parsed = parseCandleSignalConfig(configInput);
  if (!parsed.ok || !parsed.config) return emptyResult(input, parsed.issues, ['CONFIG_INVALID']);
  const config = parsed.config;
  if (!Number.isFinite(input.evaluatedAtMs)) {
    return emptyResult(input, ['판정 시각 오류'], ['EVALUATION_TIME_INVALID']);
  }
  const foundationConfigIssues = validateCandleFoundationConfig(foundationConfig);
  if (foundationConfigIssues.length > 0) {
    return emptyResult(input, foundationConfigIssues, ['FOUNDATION_CONFIG_INVALID']);
  }

  const foundation = buildMultiTimeframeCandleSet(
    input.symbol,
    input.frames,
    input.evaluatedAtMs,
    foundationConfig,
  );
  const closeTimes = {
    '15m': foundation.frames['15m']?.latestCloseTimeMs ?? null,
    '1h': foundation.frames['1h']?.latestCloseTimeMs ?? null,
    '4h': foundation.frames['4h']?.latestCloseTimeMs ?? null,
  };
  const excludedOpenCandles = {
    '15m': foundation.frames['15m']?.excludedOpenCandles ?? 0,
    '1h': foundation.frames['1h']?.excludedOpenCandles ?? 0,
    '4h': foundation.frames['4h']?.excludedOpenCandles ?? 0,
  };
  const alignmentIssues: string[] = [];
  for (const timeframe of STRATEGY_TIMEFRAMES) {
    const closeTime = closeTimes[timeframe];
    const expected = expectedLatestCloseMs(
      input.evaluatedAtMs,
      timeframe,
      foundationConfig.closeGraceMs,
    );
    if (closeTime !== expected) {
      alignmentIssues.push(`${timeframe} 최신 완료봉 누락/stale: ${String(closeTime)} != ${expected}`);
    }
  }
  if (!foundation.tradeAllowed || foundation.quality === 'INVALID' || alignmentIssues.length > 0) {
    const reasonCodes: CandleSignalReasonCode[] = [];
    if (!foundation.tradeAllowed || foundation.quality === 'INVALID') reasonCodes.push('CANDLE_DATA_INVALID');
    if (alignmentIssues.length > 0) reasonCodes.push('LATEST_CANDLE_MISSING_OR_STALE');
    const result = emptyResult(input, [...foundation.issues, ...alignmentIssues], reasonCodes);
    result.dataQuality.frameCloseTimesMs = closeTimes;
    result.dataQuality.excludedOpenCandles = excludedOpenCandles;
    return result;
  }

  const features = Object.fromEntries(STRATEGY_TIMEFRAMES.map(timeframe => [
    timeframe,
    extractCandleFrameFeatures(foundation.frames[timeframe]!, config),
  ])) as Record<StrategyTimeframe, CandleFrameFeatures>;
  const criticalFeatureIssues = STRATEGY_TIMEFRAMES.flatMap(timeframe => {
    const frame = features[timeframe];
    return [
      frame.maFast === null || frame.maMedium === null || frame.maLong === null ? `${timeframe} MA unavailable` : null,
      frame.rsi === null ? `${timeframe} RSI unavailable` : null,
      frame.atrPct === null ? `${timeframe} ATR unavailable` : null,
    ].filter((issue): issue is string => issue !== null);
  });
  if (criticalFeatureIssues.length > 0) {
    const result = emptyResult(input, criticalFeatureIssues, ['FEATURE_UNAVAILABLE']);
    result.frameFeatures = features;
    result.dataQuality.frameCloseTimesMs = closeTimes;
    result.dataQuality.excludedOpenCandles = excludedOpenCandles;
    return result;
  }

  const components = buildScoreComponents(features, config);
  const long = score(components, 'LONG');
  const short = score(components, 'SHORT');
  const coveragePct = Math.min(long.coveragePct, short.coveragePct);
  const higherTimeframeTrend = deriveHigherTimeframeTrend(features);
  const reasonCodes: CandleSignalReasonCode[] = [];
  const reasons: string[] = [];
  const direction = selectDirection(
    long.confidence,
    short.confidence,
    higherTimeframeTrend,
    coveragePct,
    config,
    reasonCodes,
    reasons,
  );
  const selectedConfidence = Math.max(long.confidence, short.confidence);
  const tradeDirection = direction === 'NO_TRADE' ? null : direction;
  const stop = tradeDirection === null ? null : buildStop(tradeDirection, features, config);
  if (tradeDirection !== null && stop === null) {
    reasonCodes.push('STRUCTURAL_STOP_UNAVAILABLE');
    reasons.push('구조적 stop 후보 계산 불가');
  }
  let finalDirection: CandleSignalDirection =
    tradeDirection !== null && stop !== null ? tradeDirection : 'NO_TRADE';
  const riskReward = finalDirection === 'NO_TRADE' || stop === null
    ? null
    : buildRiskReward(finalDirection, features, stop, config);
  if (finalDirection !== 'NO_TRADE' && riskReward === null) {
    reasonCodes.push('GROSS_RR_UNAVAILABLE');
    reasons.push('gross R/R 후보 계산 불가');
    finalDirection = 'NO_TRADE';
  } else if (riskReward?.targetBasis === 'CONFIGURED_R_MULTIPLE') {
    reasonCodes.push('TARGET_R_MULTIPLE_FALLBACK');
  }

  for (const component of components) {
    const match = finalDirection === 'SHORT' ? component.shortMatch : component.longMatch;
    if (finalDirection !== 'NO_TRADE' && match !== null && match > 0) {
      reasons.push(`${component.label} ${Math.round(match * 100)}% 일치`);
    }
  }
  if (features['15m'].volume.quality !== 'AVAILABLE') {
    reasonCodes.push('VOLUME_UNAVAILABLE');
    reasons.push(features['15m'].volume.reason ?? '거래량 unavailable');
  }
  if (Object.values(excludedOpenCandles).some(count => count > 0)) {
    reasonCodes.push('OPEN_CANDLE_EXCLUDED');
  }
  if (finalDirection !== 'NO_TRADE') {
    reasonCodes.push(finalDirection === 'LONG' ? 'LONG_SIGNAL' : 'SHORT_SIGNAL');
    reasons.unshift(`${finalDirection} confidence ${selectedConfidence}`);
  }

  const qualityFlags = [
    ...foundation.issues,
    ...STRATEGY_TIMEFRAMES.flatMap(timeframe =>
      features[timeframe].issues.map(issue => `${timeframe}: ${issue}`)),
  ];
  const dataQuality = foundation.quality === 'DEGRADED'
    || features['15m'].volume.quality !== 'AVAILABLE'
    ? 'DEGRADED'
    : 'GOOD';
  return {
    schemaVersion: CANDLE_SIGNAL_SCHEMA_VERSION,
    configVersion: config.version,
    symbol: input.symbol,
    evaluatedAtMs: input.evaluatedAtMs,
    direction: finalDirection,
    confidence: selectedConfidence,
    longConfidence: long.confidence,
    shortConfidence: short.confidence,
    entryCandidate: finalDirection === 'NO_TRADE' ? null : features['15m'].close,
    structuralStopCandidate: finalDirection === 'NO_TRADE' ? null : stop,
    grossExpectedRiskReward: finalDirection === 'NO_TRADE' ? null : riskReward,
    supportResistance: features['1h'].supportResistance,
    volatility: {
      timeframe: '15m',
      atrPct: features['15m'].atrPct,
      atrAbs: features['15m'].atrAbs,
    },
    volumeConfirmation: features['15m'].volume,
    higherTimeframeTrend,
    frameFeatures: features,
    dataQuality: {
      status: dataQuality,
      flags: qualityFlags,
      frameCloseTimesMs: closeTimes,
      excludedOpenCandles,
      scoreCoveragePct: coveragePct,
    },
    scoreComponents: components,
    reasonCodes,
    reasons,
  };
}