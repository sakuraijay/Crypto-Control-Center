/**
 * Technical indicator computations for the AI engine.
 *
 * Inputs: rolling arrays of prices (from GMX oracle stream, ~3-second ticks).
 * Outputs: simplified indicator values used for state selection.
 *
 * Note: These are short-term oracle-price indicators — not OHLCV-based.
 * They give a probabilistic signal, not a guarantee.
 */

import type { IndicatorValues } from './types';

// ── EMA ──────────────────────────────────────────────────────────────────────

export function computeEma(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  if (prices.length < period) {
    // Not enough data — use simple average
    return prices.reduce((a, b) => a + b, 0) / prices.length;
  }
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── RSI ──────────────────────────────────────────────────────────────────────

export function computeRsi(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50; // neutral fallback
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta > 0) gains += delta;
    else losses += Math.abs(delta);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── ATR (approximate, from oracle ticks) ─────────────────────────────────────

export function computeAtrPct(prices: number[], period = 14): number {
  if (prices.length < 2) return 0;
  const recent = prices.slice(-Math.min(period + 1, prices.length));
  const ranges: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    ranges.push(Math.abs(recent[i] - recent[i - 1]));
  }
  const atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const currentPrice = prices[prices.length - 1];
  return currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
}

// ── Momentum ──────────────────────────────────────────────────────────────────

export function computeMomentum(prices: number[]): number {
  if (prices.length < 10) return 0;
  const half = Math.floor(prices.length / 2);
  const firstHalfAvg = prices.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const secondHalfAvg = prices.slice(half).reduce((a, b) => a + b, 0) / (prices.length - half);
  if (firstHalfAvg === 0) return 0;
  return ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 10000; // in basis points
}

// ── Price change ─────────────────────────────────────────────────────────────

export function computePriceChangePct(prices: number[], fromIndex: number): number {
  if (prices.length < 2) return 0;
  const from = prices[Math.max(0, fromIndex)];
  const to = prices[prices.length - 1];
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

// ── Full indicator set ────────────────────────────────────────────────────────

export function computeIndicators(
  prices: number[],
  priceChange24h: number,
): IndicatorValues {
  const rsi14 = computeRsi(prices, 14);
  const ema9  = computeEma(prices, Math.min(9, prices.length));
  const ema21 = computeEma(prices, Math.min(21, prices.length));
  const atrPct = computeAtrPct(prices, 14);
  const momentum = computeMomentum(prices);

  // 1-hour change: use last ~1200 prices (at 3-second ticks = 60 min)
  const h1Index = Math.max(0, prices.length - 1200);
  const priceChange1h = computePriceChangePct(prices, h1Index);

  const emaCross: IndicatorValues['emaCross'] =
    ema9 > ema21 * 1.0005 ? 'bullish' :
    ema9 < ema21 * 0.9995 ? 'bearish' :
    'neutral';

  const trend: IndicatorValues['trend'] =
    priceChange1h > 0.3 ? 'up' :
    priceChange1h < -0.3 ? 'down' :
    'sideways';

  return { rsi14, ema9, ema21, emaCross, atrPct, priceChange24h, priceChange1h, momentum, trend };
}

// ── Composite scores ──────────────────────────────────────────────────────────

export function computeScores(
  ind: IndicatorValues,
): { bullishScore: number; bearishScore: number; directionalBias: number; opportunityScore: number } {
  let bullishScore = 0;
  let bearishScore = 0;

  // RSI contribution (30 pts)
  if (ind.rsi14 < 30) bullishScore += 30;          // oversold → reversal
  else if (ind.rsi14 < 45) bullishScore += 15;
  else if (ind.rsi14 > 70) bearishScore += 30;      // overbought → reversal
  else if (ind.rsi14 > 55) bearishScore += 15;

  // EMA cross contribution (25 pts)
  if (ind.emaCross === 'bullish') bullishScore += 25;
  else if (ind.emaCross === 'bearish') bearishScore += 25;

  // Trend contribution (20 pts)
  if (ind.trend === 'up') bullishScore += 20;
  else if (ind.trend === 'down') bearishScore += 20;

  // Momentum contribution (15 pts)
  const momNorm = Math.max(-1, Math.min(1, ind.momentum / 50)); // normalize
  if (momNorm > 0) bullishScore += momNorm * 15;
  else bearishScore += Math.abs(momNorm) * 15;

  // 24h trend (10 pts)
  if (ind.priceChange24h > 2) bullishScore += 10;
  else if (ind.priceChange24h > 0.5) bullishScore += 5;
  else if (ind.priceChange24h < -2) bearishScore += 10;
  else if (ind.priceChange24h < -0.5) bearishScore += 5;

  bullishScore = Math.min(100, Math.round(bullishScore));
  bearishScore = Math.min(100, Math.round(bearishScore));

  const directionalBias = bullishScore - bearishScore;

  // Opportunity quality: high score when strong directional signal AND not too volatile
  const signalStrength = Math.max(bullishScore, bearishScore);
  const volPenalty = Math.min(30, ind.atrPct * 3);
  const opportunityScore = Math.max(0, Math.round(signalStrength - volPenalty));

  return { bullishScore, bearishScore, directionalBias, opportunityScore };
}
