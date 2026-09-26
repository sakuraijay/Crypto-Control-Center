/**
 * Pure Candle Signal → Risk evidence contract.
 *
 * This file intentionally owns only serializable types and strict configuration
 * parsing. It must remain free of DB, RPC, worker, signer, and execution imports.
 */

export const CANDLE_SIGNAL_SCHEMA_VERSION = 'candle-signal/v1' as const;
export type CandleSignalSchemaVersion = typeof CANDLE_SIGNAL_SCHEMA_VERSION;

export const CANDLE_SIGNAL_WEIGHT_KEYS = [
  'trend4hMa',
  'trend4hRsi',
  'trend4hStructure',
  'structure1hMa',
  'structure1hSwings',
  'structure1hProximity',
  'confirmation15mMa',
  'confirmation15mRsi',
  'confirmation15mCandle',
  'confirmation15mVolume',
] as const;

export type CandleSignalWeightKey = typeof CANDLE_SIGNAL_WEIGHT_KEYS[number];
export type CandleSignalDirection = 'LONG' | 'SHORT' | 'NO_TRADE';
export type CandleSignalDataQuality = 'GOOD' | 'DEGRADED' | 'INVALID';
export type HigherTimeframeTrend = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNAVAILABLE';
export type SwingHighPattern = 'HH' | 'LH' | 'EQUAL' | 'UNAVAILABLE';
export type SwingLowPattern = 'HL' | 'LL' | 'EQUAL' | 'UNAVAILABLE';
export type VolumeQuality = 'AVAILABLE' | 'UNAVAILABLE' | 'UNRELIABLE';
export type CandleSignalReasonCode =
  | 'CONFIG_INVALID'
  | 'FOUNDATION_CONFIG_INVALID'
  | 'EVALUATION_TIME_INVALID'
  | 'CANDLE_DATA_INVALID'
  | 'LATEST_CANDLE_MISSING_OR_STALE'
  | 'FEATURE_UNAVAILABLE'
  | 'SCORE_COVERAGE_LOW'
  | 'SCORE_TIE'
  | 'CONFIDENCE_BELOW_MIN'
  | 'HTF_TREND_MISMATCH'
  | 'STRUCTURAL_STOP_UNAVAILABLE'
  | 'GROSS_RR_UNAVAILABLE'
  | 'TARGET_R_MULTIPLE_FALLBACK'
  | 'VOLUME_UNAVAILABLE'
  | 'OPEN_CANDLE_EXCLUDED'
  | 'LONG_SIGNAL'
  | 'SHORT_SIGNAL';

export interface CandleSignalPeriods {
  maFast: number;
  maMedium: number;
  maLong: number;
  rsi: number;
  atr: number;
  volumeAverage: number;
  swingLookback: number;
  swingWindow: number;
}

export interface CandleSignalThresholds {
  minConfidence: number;
  tieTolerance: number;
  minScoreCoveragePct: number;
  supportResistanceTolerancePct: number;
  wickToBodyMin: number;
  volumeRatioMin: number;
  longRsiMin: number;
  longRsiMax: number;
  shortRsiMin: number;
  shortRsiMax: number;
  structureBreakTolerancePct: number;
  stopBufferAtrMultiplier: number;
  minStopBufferPct: number;
  targetRiskMultiple: number;
}

export type CandleSignalWeights = Record<CandleSignalWeightKey, number>;

export interface CandleSignalConfig {
  version: CandleSignalSchemaVersion;
  periods: CandleSignalPeriods;
  thresholds: CandleSignalThresholds;
  weights: CandleSignalWeights;
}

export const DEFAULT_CANDLE_SIGNAL_CONFIG: CandleSignalConfig = Object.freeze({
  version: CANDLE_SIGNAL_SCHEMA_VERSION,
  periods: Object.freeze({
    maFast: 7,
    maMedium: 25,
    maLong: 50,
    rsi: 14,
    atr: 14,
    volumeAverage: 20,
    swingLookback: 30,
    swingWindow: 2,
  }),
  thresholds: Object.freeze({
    minConfidence: 67,
    tieTolerance: 5,
    minScoreCoveragePct: 90,
    supportResistanceTolerancePct: 0.75,
    wickToBodyMin: 1.2,
    volumeRatioMin: 1.15,
    longRsiMin: 50,
    longRsiMax: 78,
    shortRsiMin: 22,
    shortRsiMax: 50,
    structureBreakTolerancePct: 0.05,
    stopBufferAtrMultiplier: 0.25,
    minStopBufferPct: 0.1,
    targetRiskMultiple: 2,
  }),
  weights: Object.freeze({
    trend4hMa: 18,
    trend4hRsi: 7,
    trend4hStructure: 15,
    structure1hMa: 15,
    structure1hSwings: 15,
    structure1hProximity: 5,
    confirmation15mMa: 8,
    confirmation15mRsi: 5,
    confirmation15mCandle: 7,
    confirmation15mVolume: 5,
  }),
});

export interface CandleSignalConfigParseResult {
  ok: boolean;
  config: CandleSignalConfig | null;
  issues: string[];
}

const PERIOD_KEYS = [
  'maFast', 'maMedium', 'maLong', 'rsi', 'atr',
  'volumeAverage', 'swingLookback', 'swingWindow',
] as const;

const THRESHOLD_KEYS = [
  'minConfidence', 'tieTolerance', 'minScoreCoveragePct',
  'supportResistanceTolerancePct', 'wickToBodyMin', 'volumeRatioMin',
  'longRsiMin', 'longRsiMax', 'shortRsiMin', 'shortRsiMax',
  'structureBreakTolerancePct', 'stopBufferAtrMultiplier',
  'minStopBufferPct', 'targetRiskMultiple',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: string[],
): void => {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) issues.push(`${path}.${key} 알 수 없는 필드`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) issues.push(`${path}.${key} 누락`);
  }
};

const finiteInRange = (
  value: unknown,
  min: number,
  max: number,
  path: string,
  issues: string[],
): value is number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    issues.push(`${path} 범위 오류 (${min}..${max})`);
    return false;
  }
  return true;
};

const integerInRange = (
  value: unknown,
  min: number,
  max: number,
  path: string,
  issues: string[],
): value is number => {
  if (!finiteInRange(value, min, max, path, issues)) return false;
  if (!Number.isInteger(value)) {
    issues.push(`${path} 정수 필요`);
    return false;
  }
  return true;
};

/**
 * Strict parser: unknown fields, missing fields, unsupported versions, unsafe
 * periods/thresholds, and malformed weights are all rejected.
 */
export function parseCandleSignalConfig(value: unknown): CandleSignalConfigParseResult {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, config: null, issues: ['config 객체 필요'] };
  exactKeys(value, ['version', 'periods', 'thresholds', 'weights'], 'config', issues);

  if (value.version !== CANDLE_SIGNAL_SCHEMA_VERSION) {
    issues.push(`지원하지 않는 config version: ${String(value.version)}`);
  }

  const periods = value.periods;
  if (!isRecord(periods)) {
    issues.push('config.periods 객체 필요');
  } else {
    exactKeys(periods, PERIOD_KEYS, 'config.periods', issues);
    integerInRange(periods.maFast, 2, 50, 'config.periods.maFast', issues);
    integerInRange(periods.maMedium, 3, 100, 'config.periods.maMedium', issues);
    integerInRange(periods.maLong, 4, 400, 'config.periods.maLong', issues);
    integerInRange(periods.rsi, 2, 100, 'config.periods.rsi', issues);
    integerInRange(periods.atr, 2, 100, 'config.periods.atr', issues);
    integerInRange(periods.volumeAverage, 2, 100, 'config.periods.volumeAverage', issues);
    integerInRange(periods.swingLookback, 5, 200, 'config.periods.swingLookback', issues);
    integerInRange(periods.swingWindow, 1, 10, 'config.periods.swingWindow', issues);
    if (typeof periods.maFast === 'number' && typeof periods.maMedium === 'number'
      && typeof periods.maLong === 'number'
      && !(periods.maFast < periods.maMedium && periods.maMedium < periods.maLong)) {
      issues.push('MA 기간은 maFast < maMedium < maLong 이어야 함');
    }
    if (typeof periods.swingLookback === 'number' && typeof periods.swingWindow === 'number'
      && periods.swingLookback < periods.swingWindow * 2 + 3) {
      issues.push('swingLookback이 swingWindow 대비 부족');
    }
  }

  const thresholds = value.thresholds;
  if (!isRecord(thresholds)) {
    issues.push('config.thresholds 객체 필요');
  } else {
    exactKeys(thresholds, THRESHOLD_KEYS, 'config.thresholds', issues);
    finiteInRange(thresholds.minConfidence, 50, 100, 'config.thresholds.minConfidence', issues);
    finiteInRange(thresholds.tieTolerance, 0, 25, 'config.thresholds.tieTolerance', issues);
    finiteInRange(thresholds.minScoreCoveragePct, 50, 100, 'config.thresholds.minScoreCoveragePct', issues);
    finiteInRange(thresholds.supportResistanceTolerancePct, 0.01, 5, 'config.thresholds.supportResistanceTolerancePct', issues);
    finiteInRange(thresholds.wickToBodyMin, 0, 10, 'config.thresholds.wickToBodyMin', issues);
    finiteInRange(thresholds.volumeRatioMin, 0.01, 10, 'config.thresholds.volumeRatioMin', issues);
    finiteInRange(thresholds.longRsiMin, 0, 100, 'config.thresholds.longRsiMin', issues);
    finiteInRange(thresholds.longRsiMax, 0, 100, 'config.thresholds.longRsiMax', issues);
    finiteInRange(thresholds.shortRsiMin, 0, 100, 'config.thresholds.shortRsiMin', issues);
    finiteInRange(thresholds.shortRsiMax, 0, 100, 'config.thresholds.shortRsiMax', issues);
    finiteInRange(thresholds.structureBreakTolerancePct, 0, 2, 'config.thresholds.structureBreakTolerancePct', issues);
    finiteInRange(thresholds.stopBufferAtrMultiplier, 0, 5, 'config.thresholds.stopBufferAtrMultiplier', issues);
    finiteInRange(thresholds.minStopBufferPct, 0.01, 5, 'config.thresholds.minStopBufferPct', issues);
    finiteInRange(thresholds.targetRiskMultiple, 1, 10, 'config.thresholds.targetRiskMultiple', issues);
    if (typeof thresholds.longRsiMin === 'number' && typeof thresholds.longRsiMax === 'number'
      && thresholds.longRsiMin >= thresholds.longRsiMax) {
      issues.push('LONG RSI 범위 역전');
    }
    if (typeof thresholds.shortRsiMin === 'number' && typeof thresholds.shortRsiMax === 'number'
      && thresholds.shortRsiMin >= thresholds.shortRsiMax) {
      issues.push('SHORT RSI 범위 역전');
    }
  }

  const weights = value.weights;
  if (!isRecord(weights)) {
    issues.push('config.weights 객체 필요');
  } else {
    exactKeys(weights, CANDLE_SIGNAL_WEIGHT_KEYS, 'config.weights', issues);
    let total = 0;
    for (const key of CANDLE_SIGNAL_WEIGHT_KEYS) {
      if (finiteInRange(weights[key], 0, 100, `config.weights.${key}`, issues)) {
        total += weights[key] as number;
      }
    }
    if (Math.abs(total - 100) > 1e-9) issues.push(`config.weights 합계는 100이어야 함 (현재 ${total})`);
  }

  if (issues.length > 0 || !isRecord(periods) || !isRecord(thresholds) || !isRecord(weights)) {
    return { ok: false, config: null, issues };
  }
  return {
    ok: true,
    config: value as unknown as CandleSignalConfig,
    issues: [],
  };
}

export interface CandleAnatomy {
  bodyAbs: number;
  rangeAbs: number;
  upperWickAbs: number;
  lowerWickAbs: number;
  bodyToRangeRatio: number;
  upperWickToRangeRatio: number;
  lowerWickToRangeRatio: number;
  upperWickToBodyRatio: number | null;
  lowerWickToBodyRatio: number | null;
  bullish: boolean;
  bearish: boolean;
}

export interface VolumeConfirmation {
  quality: VolumeQuality;
  current: number | null;
  recentAverage: number | null;
  ratio: number | null;
  confirmed: boolean | null;
  reason: string | null;
}

export interface SwingStructure {
  recentSwingHigh: number | null;
  previousSwingHigh: number | null;
  recentSwingLow: number | null;
  previousSwingLow: number | null;
  highPattern: SwingHighPattern;
  lowPattern: SwingLowPattern;
}

export interface SupportResistanceEvidence {
  support: number | null;
  resistance: number | null;
  supportDistancePct: number | null;
  resistanceDistancePct: number | null;
  nearSupport: boolean | null;
  nearResistance: boolean | null;
}

export interface CandleFrameFeatures {
  timeframe: '15m' | '1h' | '4h';
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  anatomy: CandleAnatomy;
  maFast: number | null;
  maMedium: number | null;
  maLong: number | null;
  rsi: number | null;
  atrPct: number | null;
  atrAbs: number | null;
  volume: VolumeConfirmation;
  swings: SwingStructure;
  supportResistance: SupportResistanceEvidence;
  issues: string[];
}

export interface CandleSignalScoreComponent {
  id: CandleSignalWeightKey;
  timeframe: '15m' | '1h' | '4h';
  label: string;
  weight: number;
  available: boolean;
  rawValue: number | string | null;
  longMatch: number | null;
  shortMatch: number | null;
  longContribution: number | null;
  shortContribution: number | null;
}

export interface StructuralStopCandidate {
  direction: 'LONG' | 'SHORT';
  referencePrice: number;
  referenceBasis: 'SIGNAL_AND_STRUCTURE_LOW' | 'SIGNAL_AND_STRUCTURE_HIGH';
  buffer: number;
  bufferBasis: 'MAX_ATR_OR_MIN_PCT';
  stopPrice: number;
  stopDistance: number;
  stopDistancePct: number;
}

export interface GrossRiskRewardEvidence {
  riskDistance: number;
  rewardDistance: number;
  ratio: number;
  targetPriceCandidate: number;
  targetBasis: 'NEAREST_STRUCTURE' | 'CONFIGURED_R_MULTIPLE';
}

export interface CandleSignalDataQualityEvidence {
  status: CandleSignalDataQuality;
  flags: string[];
  frameCloseTimesMs: Record<'15m' | '1h' | '4h', number | null>;
  excludedOpenCandles: Record<'15m' | '1h' | '4h', number>;
  scoreCoveragePct: number;
}

/** Advisory signal evidence only. It never authorizes risk or execution. */
export interface CandleSignalToRisk {
  schemaVersion: CandleSignalSchemaVersion;
  configVersion: CandleSignalSchemaVersion;
  symbol: string;
  evaluatedAtMs: number;
  direction: CandleSignalDirection;
  confidence: number;
  longConfidence: number;
  shortConfidence: number;
  entryCandidate: number | null;
  structuralStopCandidate: StructuralStopCandidate | null;
  grossExpectedRiskReward: GrossRiskRewardEvidence | null;
  supportResistance: SupportResistanceEvidence | null;
  volatility: { timeframe: '15m'; atrPct: number | null; atrAbs: number | null };
  volumeConfirmation: VolumeConfirmation;
  higherTimeframeTrend: HigherTimeframeTrend;
  frameFeatures: Record<'15m' | '1h' | '4h', CandleFrameFeatures> | null;
  dataQuality: CandleSignalDataQualityEvidence;
  scoreComponents: CandleSignalScoreComponent[];
  reasonCodes: CandleSignalReasonCode[];
  reasons: string[];
}