/**
 * Manual Controlled Canary hard caps.
 *
 * This module is intentionally DB-free so read-only diagnostics and CI import
 * tests can consume the immutable limits without loading execution dependencies.
 */
export const MANUAL_CANARY_CAPS = Object.freeze({
  maxCollateralUsd: 10,
  maxLeverage: 2,
  maxNotionalUsd: 20,
  maxOpenPositions: 1,
  maxAccumLossUsd: 3,
  maxOrdersPerDay: 1,
  maxRoundTripCostUsd: 0.4,
  maxPriceDriftFraction: 0.005,
  allowedSymbols: ['BTC', 'ETH'] as readonly string[],
  preflightTtlMs: 120_000,
});