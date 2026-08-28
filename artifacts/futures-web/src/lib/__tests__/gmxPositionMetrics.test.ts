import { describe, expect, it } from 'vitest';

import {
  computeUnrealizedPnlUsd,
  isNearLiquidation,
  summarizeGmxRisk,
  type GmxRiskMetricPosition,
} from '../gmxPositionMetrics';

const oneToken = '1000000000000000000';

describe('computeUnrealizedPnlUsd', () => {
  it('marks LONG and SHORT positions in opposite directions', () => {
    expect(computeUnrealizedPnlUsd({
      sizeUsd: 100,
      sizeInTokens: oneToken,
      markPriceUsd: 110,
      isLong: true,
    })).toBe(10);
    expect(computeUnrealizedPnlUsd({
      sizeUsd: 100,
      sizeInTokens: oneToken,
      markPriceUsd: 110,
      isLong: false,
    })).toBe(-10);
  });

  it('tracks mark-price changes without changing the entry basis', () => {
    const base = {
      sizeUsd: 200,
      sizeInTokens: '2000000000000000000',
      isLong: true,
    };
    expect(computeUnrealizedPnlUsd({ ...base, markPriceUsd: 95 })).toBe(-10);
    expect(computeUnrealizedPnlUsd({ ...base, markPriceUsd: 105 })).toBe(10);
  });

  it('fails closed when token size, mark price, or numeric evidence is unavailable', () => {
    expect(computeUnrealizedPnlUsd({
      sizeUsd: 100,
      sizeInTokens: null,
      markPriceUsd: 110,
      isLong: true,
    })).toBeNull();
    expect(computeUnrealizedPnlUsd({
      sizeUsd: 100,
      sizeInTokens: oneToken,
      markPriceUsd: null,
      isLong: true,
    })).toBeNull();
    expect(computeUnrealizedPnlUsd({
      sizeUsd: 100,
      sizeInTokens: 'invalid',
      markPriceUsd: 110,
      isLong: true,
    })).toBeNull();
  });
});

describe('isNearLiquidation', () => {
  it('includes the exact 5% boundary and excludes values immediately beyond it', () => {
    expect(isNearLiquidation(95, 100)).toBe(true);
    expect(isNearLiquidation(105, 100)).toBe(true);
    expect(isNearLiquidation(94.999, 100)).toBe(false);
    expect(isNearLiquidation(105.001, 100)).toBe(false);
  });

  it('never warns without both authoritative positive prices', () => {
    expect(isNearLiquidation(null, 100)).toBe(false);
    expect(isNearLiquidation(95, null)).toBe(false);
    expect(isNearLiquidation(0, 0)).toBe(false);
  });
});

describe('summarizeGmxRisk', () => {
  const positions: GmxRiskMetricPosition[] = [
    {
      symbol: 'BTC',
      direction: 'LONG',
      sizeUsd: 600,
      leverage: 3,
      liquidationPrice: 95,
      markPriceUsd: 100,
    },
    {
      symbol: 'ETH',
      direction: 'SHORT',
      sizeUsd: 400,
      leverage: 5,
      liquidationPrice: 190,
      markPriceUsd: 200,
    },
  ];

  it('aggregates exposure, average leverage, and nearest liquidation', () => {
    expect(summarizeGmxRisk(positions)).toEqual({
      totalExposureUsd: 1000,
      averageLeverage: 4,
      validLeverageCount: 2,
      nearestLiquidationGapFraction: 0.05,
      nearestLiquidationLabel: 'BTC LONG',
    });
  });

  it('uses only positions with valid leverage and price evidence', () => {
    const summary = summarizeGmxRisk([
      positions[0],
      {
        symbol: 'SOL',
        direction: 'LONG',
        sizeUsd: 250,
        leverage: null,
        liquidationPrice: null,
        markPriceUsd: null,
      },
    ]);
    expect(summary.totalExposureUsd).toBe(850);
    expect(summary.averageLeverage).toBe(3);
    expect(summary.validLeverageCount).toBe(1);
    expect(summary.nearestLiquidationLabel).toBe('BTC LONG');
  });

  it('returns explicit unavailable values for empty or incomplete evidence', () => {
    expect(summarizeGmxRisk([])).toEqual({
      totalExposureUsd: 0,
      averageLeverage: null,
      validLeverageCount: 0,
      nearestLiquidationGapFraction: null,
      nearestLiquidationLabel: null,
    });
    expect(summarizeGmxRisk([{
      symbol: 'BTC',
      direction: 'LONG',
      sizeUsd: 20,
      leverage: null,
      liquidationPrice: null,
      markPriceUsd: 100,
    }])).toMatchObject({
      totalExposureUsd: 20,
      averageLeverage: null,
      nearestLiquidationGapFraction: null,
      nearestLiquidationLabel: null,
    });
  });
});