import { deriveRiskProfileLimits, isAppliedRiskProfileSnapshot, PROFILE_FALLBACK_LIMITS,
  type AppliedRiskProfileSnapshot } from '../lib/riskProfiles';

export const VIRTUAL_ACTIVE_POLICY = Object.freeze({
  version: 'virtual400-active/v1', symbols: ['BTC', 'ETH', 'SOL'] as readonly string[],
  riskPerTradePct: 0.5, maxLeverage: 2, maxMarginUsd: 100, maxNotionalUsd: 200,
  cooldownMinutes: 15, confidence: 80, maxRoundTripCostUsd: 0.40,
});
export function virtualActiveProfile(capital: number, appliedAt: string): AppliedRiskProfileSnapshot {
  const capped = Math.max(0, Math.min(400, capital));
  const limits = deriveRiskProfileLimits('aggressive', { ...PROFILE_FALLBACK_LIMITS, tradingCapital: capped });
  return { name: 'aggressive', version: 'risk-profile/v1', appliedAt, derivedLimits: {
    ...limits, maxLeverage: 2, cooldownMinutes: 15, maxMarginPerTradeUsd: Math.min(100, capped * 0.8),
    maxTotalExposureUsd: Math.min(200, capped * 0.8),
  } };
}
/** Dedicated namespace only. Does not widen the Standard/LIVE profile validator. */
export function isVirtualActiveProfile(value: unknown): value is AppliedRiskProfileSnapshot {
  if (!value || typeof value !== 'object') return false;
  const p = value as AppliedRiskProfileSnapshot;
  if (p.name !== 'aggressive' || !p.derivedLimits || p.derivedLimits.cooldownMinutes !== 15) return false;
  if (!isAppliedRiskProfileSnapshot({ ...p, derivedLimits: { ...p.derivedLimits, cooldownMinutes: 30 } })) return false;
  const expected = virtualActiveProfile(p.derivedLimits.allocatedTradingCapitalUsd, p.appliedAt);
  return Object.entries(expected.derivedLimits).every(([key, val]) =>
    p.derivedLimits[key as keyof typeof p.derivedLimits] === val);
}
