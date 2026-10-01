export const SCREENSHOT_PATTERN_REVIEW_VERSION = 'manual-screenshot-pattern-review/v1' as const;
export const SCREENSHOT_PATTERN_TIMEFRAMES = ['15m', '1h', '4h'] as const;
export type ScreenshotPatternTimeframe = (typeof SCREENSHOT_PATTERN_TIMEFRAMES)[number];

export const SCREENSHOT_PATTERN_MAX_BYTES = 8 * 1024 * 1024;
export const SCREENSHOT_PATTERN_MIN_WIDTH = 640;
export const SCREENSHOT_PATTERN_MIN_HEIGHT = 360;
export const SCREENSHOT_PATTERN_MIN_CANDLES = 60;
export const SCREENSHOT_PATTERN_MIN_EXTRACTION_CONFIDENCE = 0.9;

export type ScreenshotPatternRejectReason =
  | 'EMPTY_FILE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'INVALID_TIMEFRAME'
  | 'IMAGE_TOO_SMALL'
  | 'INSUFFICIENT_COMPLETED_CANDLES'
  | 'LOW_EXTRACTION_CONFIDENCE'
  | 'LAST_CANDLE_NOT_CONFIRMED_CLOSED';

export interface ScreenshotPatternReviewInput {
  file: { name: string; type: string; size: number };
  timeframe: string;
  image: { width: number; height: number };
  extraction?: {
    completedCandles: number;
    confidence: number;
    lastCandleConfirmedClosed: boolean;
  };
}

export type ScreenshotPatternReviewGate =
  | {
      version: typeof SCREENSHOT_PATTERN_REVIEW_VERSION;
      status: 'REJECTED';
      reason: ScreenshotPatternRejectReason;
      analysisAllowed: false;
    }
  | {
      version: typeof SCREENSHOT_PATTERN_REVIEW_VERSION;
      status: 'READY_FOR_EXTRACTION';
      timeframe: ScreenshotPatternTimeframe;
      analysisAllowed: false;
    }
  | {
      version: typeof SCREENSHOT_PATTERN_REVIEW_VERSION;
      status: 'READY_FOR_PATTERN_ANALYSIS';
      timeframe: ScreenshotPatternTimeframe;
      analysisAllowed: true;
      completedCandles: number;
      extractionConfidence: number;
      purpose: 'MANUAL_GUIDANCE_ONLY';
    };

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const reject = (reason: ScreenshotPatternRejectReason): ScreenshotPatternReviewGate => ({
  version: SCREENSHOT_PATTERN_REVIEW_VERSION,
  status: 'REJECTED',
  reason,
  analysisAllowed: false,
});

/**
 * Fail-closed boundary for the manual screenshot helper. This gate never
 * creates a trade, order, probability or pattern match. It only decides
 * whether a future deterministic image extractor may call the existing
 * 38-rule analyzer. Uploaded images remain manual-guidance inputs.
 */
export function evaluateScreenshotPatternReview(input: ScreenshotPatternReviewInput): ScreenshotPatternReviewGate {
  if (!Number.isFinite(input.file.size) || input.file.size <= 0) return reject('EMPTY_FILE');
  if (!ALLOWED_TYPES.has(input.file.type.toLowerCase())) return reject('UNSUPPORTED_FILE_TYPE');
  if (input.file.size > SCREENSHOT_PATTERN_MAX_BYTES) return reject('FILE_TOO_LARGE');
  if (!SCREENSHOT_PATTERN_TIMEFRAMES.includes(input.timeframe as ScreenshotPatternTimeframe)) return reject('INVALID_TIMEFRAME');
  if (!Number.isFinite(input.image.width) || !Number.isFinite(input.image.height)
    || input.image.width < SCREENSHOT_PATTERN_MIN_WIDTH || input.image.height < SCREENSHOT_PATTERN_MIN_HEIGHT) {
    return reject('IMAGE_TOO_SMALL');
  }
  const timeframe = input.timeframe as ScreenshotPatternTimeframe;
  if (!input.extraction) {
    return { version: SCREENSHOT_PATTERN_REVIEW_VERSION, status: 'READY_FOR_EXTRACTION', timeframe, analysisAllowed: false };
  }
  if (!Number.isInteger(input.extraction.completedCandles)
    || input.extraction.completedCandles < SCREENSHOT_PATTERN_MIN_CANDLES) {
    return reject('INSUFFICIENT_COMPLETED_CANDLES');
  }
  if (!Number.isFinite(input.extraction.confidence)
    || input.extraction.confidence < SCREENSHOT_PATTERN_MIN_EXTRACTION_CONFIDENCE
    || input.extraction.confidence > 1) {
    return reject('LOW_EXTRACTION_CONFIDENCE');
  }
  if (!input.extraction.lastCandleConfirmedClosed) return reject('LAST_CANDLE_NOT_CONFIRMED_CLOSED');
  return {
    version: SCREENSHOT_PATTERN_REVIEW_VERSION,
    status: 'READY_FOR_PATTERN_ANALYSIS',
    timeframe,
    analysisAllowed: true,
    completedCandles: input.extraction.completedCandles,
    extractionConfidence: input.extraction.confidence,
    purpose: 'MANUAL_GUIDANCE_ONLY',
  };
}
