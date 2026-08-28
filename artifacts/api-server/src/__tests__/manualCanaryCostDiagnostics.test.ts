import { describe, expect, it } from 'vitest';

import {
  classifyCostReadinessComponent,
  oldestRequiredImpactObservedAtMs,
} from '../lib/manualCanaryCostFetcher';

const NOW = 1_777_000_000_000;

describe('manual Canary cost component diagnostics', () => {
  it.each([
    ['success', true, NOW - 1_000, undefined, 'SUCCESS', 'COST_TICKERS_SUCCESS', true],
    ['missing', false, null, undefined, 'MISSING', 'COST_TICKERS_MISSING', false],
    ['stale', true, NOW - 30_001, undefined, 'STALE', 'COST_TICKERS_STALE', false],
    ['future timestamp', true, NOW + 1, undefined, 'STALE', 'COST_TICKERS_STALE', false],
  ] as const)('classifies %s evidence deterministically', (
    _name,
    available,
    observedAtMs,
    apiResult,
    state,
    code,
    fresh,
  ) => {
    expect(classifyCostReadinessComponent({
      componentId: 'TICKERS',
      sourceId: 'GMX_API_MARKETS_TICKERS',
      available,
      observedAtMs,
      apiResult,
      nowMs: NOW,
    })).toEqual({
      componentId: 'TICKERS',
      sourceId: 'GMX_API_MARKETS_TICKERS',
      state,
      code,
      observedAtMs,
      ageMs: observedAtMs === null ? null : NOW - observedAtMs,
      fresh,
    });
  });

  it('reduces transport errors to a fixed safe code without retaining raw text', () => {
    const result = classifyCostReadinessComponent({
      componentId: 'MARKETS_INFO',
      sourceId: 'GMX_API_MARKETS_INFO',
      available: false,
      observedAtMs: null,
      nowMs: NOW,
      apiResult: {
        ok: false,
        kind: 'http_5xx',
        httpStatus: 503,
        ambiguous: false,
        message: 'safe fixed transport message',
        peerHost: 'arbitrum.gmxapi.ai',
      },
    });

    expect(result).toEqual({
      componentId: 'MARKETS_INFO',
      sourceId: 'GMX_API_MARKETS_INFO',
      state: 'FAILED',
      code: 'COST_MARKETS_INFO_5XX',
      observedAtMs: null,
      ageMs: null,
      fresh: false,
    });
    expect(JSON.stringify(result)).not.toContain('transport message');
    expect(JSON.stringify(result)).not.toContain('gmxapi.ai');
  });

  it('binds SDK impact freshness to the oldest markets-info/index-price input', () => {
    expect(oldestRequiredImpactObservedAtMs(NOW - 1_000, NOW - 31_000))
      .toBe(NOW - 31_000);
    expect(oldestRequiredImpactObservedAtMs(NOW - 1_000, null)).toBeNull();

    const result = classifyCostReadinessComponent({
      componentId: 'SDK_PRICE_IMPACT',
      sourceId: 'GMX_SDK_PRICE_IMPACT',
      available: true,
      observedAtMs: oldestRequiredImpactObservedAtMs(NOW - 1_000, NOW - 31_000),
      nowMs: NOW,
    });
    expect(result).toMatchObject({
      state: 'STALE',
      code: 'COST_SDK_PRICE_IMPACT_STALE',
      fresh: false,
    });
  });
});