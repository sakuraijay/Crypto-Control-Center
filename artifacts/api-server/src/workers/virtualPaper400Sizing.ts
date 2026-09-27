import { enforceOrderSizing, MIN_ORDER_COLLATERAL_USD, type EnforcementInput, type EnforcementResult } from '../lib/orderSizingEnforcement';
import { VIRTUAL_ACTIVE_POLICY } from './virtualPaper400Policy';

/** PAPER collateral buffer, not a claim about a live exchange liquidation price.
 * Keep twice the modeled stop loss + costs in collateral; never tighten the stop. */
export function virtualLeverageCeiling(notional: number, modeledRiskUsd: number): number {
  if (!Number.isFinite(notional) || notional <= 0 || !Number.isFinite(modeledRiskUsd) || modeledRiskUsd <= 0) return 0;
  return Math.floor(Math.min(VIRTUAL_ACTIVE_POLICY.maxLeverage,
    notional / MIN_ORDER_COLLATERAL_USD, notional / (2 * modeledRiskUsd)) + 1e-10);
}

/** Virtual400-only collateral allocation. Reuse the unchanged risk/cost sizing
 * at 1x to derive notional independently of leverage, then allocate collateral.
 * Standard, Canary and LIVE continue using enforceOrderSizing without this path. */
export function enforceVirtualPaper400Sizing(input: EnforcementInput): EnforcementResult {
  if (input.liveMode || input.canaryActive || input.costSnapshot?.source !== 'PAPER_GMX_ESTIMATE'
    || !Number.isFinite(input.positionSizingCapitalUsd) || input.positionSizingCapitalUsd > 400
    || !Number.isFinite(input.riskBudgetPct) || input.riskBudgetPct! <= 0 || input.riskBudgetPct! > VIRTUAL_ACTIVE_POLICY.riskPerTradePct
    || input.requestedSizeUsd > VIRTUAL_ACTIVE_POLICY.maxNotionalUsd
    || !Number.isFinite(input.requestedLeverage) || input.requestedLeverage < VIRTUAL_ACTIVE_POLICY.minLeverage
    || input.requestedLeverage > VIRTUAL_ACTIVE_POLICY.maxLeverage) return { ok: false, reason: 'VIRTUAL_LEVERAGE_SCOPE_OR_POLICY' };
  const sized = enforceOrderSizing({ ...input, requestedLeverage: 1, requestedCollateralUsd: input.requestedSizeUsd });
  if (!sized.ok) return sized;
  if (sized.estimatedRoundTripCostUsd > VIRTUAL_ACTIVE_POLICY.maxRoundTripCostUsd) return { ok: false, reason: 'VIRTUAL_COST_CAP' };
  const risk = sized.finalNotionalUsd * input.stopDistanceFraction! + sized.estimatedRoundTripCostUsd;
  const bufferedRisk = sized.finalNotionalUsd * input.stopDistanceFraction! + VIRTUAL_ACTIVE_POLICY.maxRoundTripCostUsd;
  const leverage = Math.min(input.requestedLeverage, virtualLeverageCeiling(sized.finalNotionalUsd, bufferedRisk));
  if (leverage < VIRTUAL_ACTIVE_POLICY.minLeverage) return { ok: false, reason: 'VIRTUAL_MIN_LEVERAGE_COLLATERAL_BUFFER' };
  const collateral = sized.finalNotionalUsd / leverage;
  if (collateral > VIRTUAL_ACTIVE_POLICY.maxMarginUsd || risk > sized.allowedRiskUsd + 1e-8) return { ok: false, reason: 'VIRTUAL_MARGIN_OR_RISK_CAP' };
  return { ...sized, finalLeverage: leverage, finalCollateralUsd: collateral,
    clamped: sized.clamped || leverage < input.requestedLeverage,
    clampDetails: [...sized.clampDetails, ...(leverage < input.requestedLeverage
      ? [`Virtual collateral buffer: ${input.requestedLeverage}x → ${leverage}x`] : [])] };
}
