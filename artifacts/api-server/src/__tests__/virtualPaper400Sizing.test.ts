import { describe, it, expect } from 'vitest';
import { enforceVirtualPaper400Sizing } from '../workers/virtualPaper400Sizing';
import { isVirtualActiveProfile, virtualActiveProfile } from '../workers/virtualPaper400Policy';
import { isAppliedRiskProfileSnapshot } from '../lib/riskProfiles';
import { enforceOrderSizing, type EnforcementInput } from '../lib/orderSizingEnforcement';
import { virtualReplayCost } from './helpers/virtualPaper400Replay';

const now = new Date('2026-09-21T00:00:00.000Z');
function input(size = 80, stop = 0.02): EnforcementInput {
  const cost = virtualReplayCost(now.getTime(), size);
  return { requestedSizeUsd: size, requestedCollateralUsd: size / 10, requestedLeverage: 10,
    positionSizingCapitalUsd: 400, stopDistanceFraction: stop, costSnapshot: cost,
    liquidityCapUsd: 200, tierNotionalCapUsd: 200, defensiveMode: false, liveMode: false,
    canaryActive: false, riskBudgetPct: 0.5, now,
    expected: { market: cost.market, isLong: true, orderType: 'MarketIncrease' } };
}
describe('Virtual400 isolated 5–10x collateral allocation', () => {
  it.each([[80, 10], [10, 8], [6, 5]])('allocates $%s at %sx with unchanged notional and cost-inclusive risk', (size, leverage) => {
    const r = enforceVirtualPaper400Sizing(input(size));
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.finalNotionalUsd).toBe(size); expect(r.finalLeverage).toBe(leverage);
    expect(r.finalCollateralUsd).toBe(size / leverage);
    expect(r.finalCollateralUsd).toBeGreaterThanOrEqual(1.1);
    expect(r.finalCollateralUsd).toBeGreaterThanOrEqual(2 * (size * .02 + .4));
    expect(size * .02 + r.estimatedRoundTripCostUsd).toBeLessThanOrEqual(2);
  });
  it('rejects an incompatible minimum leverage instead of widening size or tightening stops', () => {
    expect(enforceVirtualPaper400Sizing(input(5))).toMatchObject({ ok: false, reason: 'VIRTUAL_MIN_LEVERAGE_COLLATERAL_BUFFER' });
    expect(enforceVirtualPaper400Sizing(input(10, .12))).toMatchObject({ ok: false, reason: 'VIRTUAL_MIN_LEVERAGE_COLLATERAL_BUFFER' });
  });
  it.each([{ liveMode: true }, { canaryActive: true }, { requestedLeverage: 4 }, { requestedLeverage: 11 },
    { requestedLeverage: NaN }, { riskBudgetPct: 1 }, { positionSizingCapitalUsd: 401 }, { requestedSizeUsd: 201 }])('rejects invalid scope or widened limits %j', change => {
    expect(enforceVirtualPaper400Sizing({ ...input(), ...change }).ok).toBe(false);
  });
  it('retains missing/stale costs, stop, exposure and defensive risk checks', () => {
    expect(enforceVirtualPaper400Sizing({ ...input(), costSnapshot: null }).ok).toBe(false);
    expect(enforceVirtualPaper400Sizing({ ...input(), stopDistanceFraction: null }).ok).toBe(false);
    expect(enforceVirtualPaper400Sizing({ ...input(), now: new Date(now.getTime() + 120_000) }).ok).toBe(false);
    const smaller = enforceVirtualPaper400Sizing({ ...input(40), riskBudgetPct: .25 });
    expect(smaller.ok).toBe(true); if (smaller.ok) expect(smaller.finalNotionalUsd * .02 + smaller.estimatedRoundTripCostUsd).toBeLessThanOrEqual(1);
  });
  it('keeps Standard/Canary/LIVE validators and historical 2x profile support intact', () => {
    const active = virtualActiveProfile(400, now.toISOString());
    expect(isVirtualActiveProfile(active)).toBe(true);
    expect(isVirtualActiveProfile(virtualActiveProfile(400, now.toISOString(), true))).toBe(true);
    expect(isAppliedRiskProfileSnapshot(active)).toBe(false);
    for (const maxLeverage of [4, 5, 9, 11, NaN]) expect(isVirtualActiveProfile({ ...active, derivedLimits: { ...active.derivedLimits, maxLeverage } })).toBe(false);
    for (const options of [{}, { liveMode: true }, { canaryActive: true }]) expect(enforceOrderSizing({ ...input(), ...options }).ok).toBe(false);
  });
});
