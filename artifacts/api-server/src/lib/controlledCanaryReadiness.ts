import { MANUAL_CANARY_CAPS } from './manualCanaryCaps';

export const CONTROLLED_CANARY_STOP_CAPABILITY_MAX_AGE_MS = 30_000;

export interface ControlledCanaryReadinessInput {
  readonlyEnabled: boolean;
  submissionEnabled: boolean;
  signerEnabled: boolean;
  signerInitialized: boolean;
  liveLocked: boolean;
  emergencyStop: boolean;
  reconciled: boolean;
  dbOk: boolean;
  canonicalAuthorizationReady: boolean;
  ownerApprovalReady: boolean;
  blockingIntents: number | null;
  unresolvedCount: number | null;
  activeRevoke: boolean | null;
  manualCanaryPostureAllowed: boolean;
  deploymentVerified: boolean;
  executionCostEvidence: {
    fresh: boolean;
    effectiveRoundTripCostUsd: number | null;
  };
  decimalsReady: boolean;
  stopCapability: {
    available: boolean;
    evaluatedAt: string | null;
  };
  nowMs: number;
  uncoveredStopCount: number | null;
  settlementComplete: boolean;
  legacyZeroFeeCount: number | null;
  unsettledLiveTradeCount: number | null;
  blockingProtectionCount: number | null;
  staleStopCount: number | null;
  actionBudgetSufficient: boolean;
  priceConversionVerified: boolean;
  protectionReconciliationComplete: boolean;
  protectionReconciliationBlocksNewOpens: boolean;
  protectionReconciliationAmbiguousCount: number;
  requiredActions: number;
}

export function isFreshControlledCanaryStopCapability(
  capability: ControlledCanaryReadinessInput['stopCapability'],
  nowMs: number,
): boolean {
  if (!capability.available || !Number.isFinite(nowMs) || nowMs <= 0) return false;
  if (typeof capability.evaluatedAt !== 'string') return false;
  const evaluatedAtMs = Date.parse(capability.evaluatedAt);
  return Number.isFinite(evaluatedAtMs)
    && evaluatedAtMs <= nowMs
    && nowMs - evaluatedAtMs <= CONTROLLED_CANARY_STOP_CAPABILITY_MAX_AGE_MS;
}

/**
 * Pure status/readiness composition. It owns no callback and cannot prepare,
 * sign, submit, create a Relay/order, mutate durable state, or move funds.
 */
export function deriveControlledCanaryReadiness(
  input: ControlledCanaryReadinessInput,
): boolean {
  const cost = input.executionCostEvidence;
  const immutableCostCapSatisfied =
    cost.fresh
    && typeof cost.effectiveRoundTripCostUsd === 'number'
    && Number.isFinite(cost.effectiveRoundTripCostUsd)
    && cost.effectiveRoundTripCostUsd >= 0
    && cost.effectiveRoundTripCostUsd <= MANUAL_CANARY_CAPS.maxRoundTripCostUsd;
  const freshStopCapability =
    isFreshControlledCanaryStopCapability(input.stopCapability, input.nowMs);

  return input.readonlyEnabled
    && input.submissionEnabled
    && input.signerEnabled
    && input.signerInitialized
    && !input.liveLocked
    && !input.emergencyStop
    && input.reconciled
    && input.dbOk
    && input.canonicalAuthorizationReady
    && input.ownerApprovalReady
    && input.blockingIntents === 0
    && input.unresolvedCount === 0
    && input.activeRevoke === false
    && input.manualCanaryPostureAllowed
    && input.deploymentVerified
    && immutableCostCapSatisfied
    && input.decimalsReady
    && freshStopCapability
    && input.uncoveredStopCount === 0
    && input.settlementComplete
    && input.legacyZeroFeeCount === 0
    && input.unsettledLiveTradeCount === 0
    && input.blockingProtectionCount === 0
    && input.staleStopCount === 0
    && input.actionBudgetSufficient
    && input.priceConversionVerified
    && input.protectionReconciliationComplete
    && !input.protectionReconciliationBlocksNewOpens
    && input.protectionReconciliationAmbiguousCount === 0
    && input.requiredActions <= 10;
}