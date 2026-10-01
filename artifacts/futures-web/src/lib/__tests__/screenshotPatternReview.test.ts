import {describe, expect, it} from 'vitest';
import {
  evaluateScreenshotPatternReview,
  SCREENSHOT_PATTERN_MAX_BYTES,
  SCREENSHOT_PATTERN_REVIEW_VERSION,
} from '../screenshotPatternReview';

const valid = {
  file: {name: 'btc-15m.png', type: 'image/png', size: 512_000},
  timeframe: '15m',
  image: {width: 1440, height: 900},
};

describe('manual screenshot pattern review quality gate', () => {
  it('accepts a supported image only for extraction and never for analysis yet', () => {
    expect(evaluateScreenshotPatternReview(valid)).toEqual({
      version: SCREENSHOT_PATTERN_REVIEW_VERSION,
      status: 'READY_FOR_EXTRACTION',
      timeframe: '15m',
      analysisAllowed: false,
    });
  });

  it.each([
    [{...valid, file: {...valid.file, size: 0}}, 'EMPTY_FILE'],
    [{...valid, file: {...valid.file, type: 'image/svg+xml'}}, 'UNSUPPORTED_FILE_TYPE'],
    [{...valid, file: {...valid.file, size: SCREENSHOT_PATTERN_MAX_BYTES + 1}}, 'FILE_TOO_LARGE'],
    [{...valid, timeframe: '5m'}, 'INVALID_TIMEFRAME'],
    [{...valid, image: {width: 639, height: 900}}, 'IMAGE_TOO_SMALL'],
  ])('rejects invalid upload metadata before extraction', (input, reason) => {
    expect(evaluateScreenshotPatternReview(input)).toMatchObject({status: 'REJECTED', reason, analysisAllowed: false});
  });

  it.each([
    [{completedCandles: 59, confidence: 0.99, lastCandleConfirmedClosed: true}, 'INSUFFICIENT_COMPLETED_CANDLES'],
    [{completedCandles: 60, confidence: 0.899, lastCandleConfirmedClosed: true}, 'LOW_EXTRACTION_CONFIDENCE'],
    [{completedCandles: 60, confidence: 0.99, lastCandleConfirmedClosed: false}, 'LAST_CANDLE_NOT_CONFIRMED_CLOSED'],
  ])('rejects untrustworthy extracted candle evidence', (extraction, reason) => {
    expect(evaluateScreenshotPatternReview({...valid, extraction})).toMatchObject({
      status: 'REJECTED', reason, analysisAllowed: false,
    });
  });

  it('allows deterministic 38-rule analysis only after every quality requirement passes', () => {
    expect(evaluateScreenshotPatternReview({...valid, timeframe: '4h', extraction: {
      completedCandles: 60,
      confidence: 0.94,
      lastCandleConfirmedClosed: true,
    }})).toEqual({
      version: SCREENSHOT_PATTERN_REVIEW_VERSION,
      status: 'READY_FOR_PATTERN_ANALYSIS',
      timeframe: '4h',
      analysisAllowed: true,
      completedCandles: 60,
      extractionConfidence: 0.94,
      purpose: 'MANUAL_GUIDANCE_ONLY',
    });
  });
});
