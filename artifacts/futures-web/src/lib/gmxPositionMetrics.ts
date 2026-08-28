export interface GmxRiskMetricPosition {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  sizeUsd: number;
  leverage: number | null;
  liquidationPrice: number | null;
  markPriceUsd: number | null;
}

export interface GmxRiskSummary {
  totalExposureUsd: number;
  averageLeverage: number | null;
  validLeverageCount: number;
  nearestLiquidationGapFraction: number | null;
  nearestLiquidationLabel: string | null;
}

export function computeUnrealizedPnlUsd(input: {
  sizeUsd: number;
  sizeInTokens: string | null | undefined;
  markPriceUsd: number | null;
  isLong: boolean;
}): number | null {
  if (!input.sizeInTokens || input.sizeInTokens === '0' || input.markPriceUsd == null) {
    return null;
  }

  try {
    const tokenAmount = Number(BigInt(input.sizeInTokens)) / 1e18;
    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0 || !Number.isFinite(input.sizeUsd) || input.sizeUsd <= 0) {
      return null;
    }

    const averageEntryPrice = input.sizeUsd / tokenAmount;
    const pnlPerToken = input.isLong
      ? input.markPriceUsd - averageEntryPrice
      : averageEntryPrice - input.markPriceUsd;
    const pnl = pnlPerToken * tokenAmount;
    return Number.isFinite(pnl) ? pnl : null;
  } catch {
    return null;
  }
}

export function isNearLiquidation(
  liquidationPrice: number | null,
  markPriceUsd: number | null,
): boolean {
  return liquidationPrice != null
    && markPriceUsd != null
    && markPriceUsd > 0
    && Math.abs(markPriceUsd - liquidationPrice) / markPriceUsd <= 0.05;
}

export function summarizeGmxRisk(
  positions: readonly GmxRiskMetricPosition[],
): GmxRiskSummary {
  const validLeverages = positions
    .map((position) => position.leverage)
    .filter((leverage): leverage is number => leverage != null);

  let nearestLiquidationGapFraction: number | null = null;
  let nearestLiquidationLabel: string | null = null;

  for (const position of positions) {
    if (
      position.liquidationPrice == null
      || position.markPriceUsd == null
      || position.markPriceUsd <= 0
    ) {
      continue;
    }

    const gap = Math.abs(position.markPriceUsd - position.liquidationPrice)
      / position.markPriceUsd;
    if (
      nearestLiquidationGapFraction === null
      || gap < nearestLiquidationGapFraction
    ) {
      nearestLiquidationGapFraction = gap;
      nearestLiquidationLabel = `${position.symbol} ${position.direction}`;
    }
  }

  return {
    totalExposureUsd: positions.reduce((sum, position) => sum + position.sizeUsd, 0),
    averageLeverage: validLeverages.length > 0
      ? validLeverages.reduce((sum, leverage) => sum + leverage, 0) / validLeverages.length
      : null,
    validLeverageCount: validLeverages.length,
    nearestLiquidationGapFraction,
    nearestLiquidationLabel,
  };
}