import type {
  ActiveCapitalPolicyContext,
  HardStopThresholdBindingCapability,
} from '../lib/activeCapitalSemantics';
import {
  FIXED_BETA_RISK_CAPITAL_SCOPE,
  type RiskCapitalScope,
} from '../lib/riskCapital';

/**
 * Pure, non-persistent worker policy selection.
 *
 * This module deliberately accepts only an explicit caller-provided policy token.
 * It does not inspect dates, wallet balance, runtime capital, Planned Seed, DB/HWM,
 * process.env, signer state, Relay state, or execution authorization.
 *
 * Selecting FIXED_BETA_400 describes capital semantics only. It never authorizes
 * a real order and does not mutate Production state.
 */

export const WORKER_STANDARD_ACTIVE_CONTEXT =
  'STANDARD_ACTIVE' as const satisfies ActiveCapitalPolicyContext;
export const WORKER_FIXED_BETA_CONTEXT =
  'FIXED_BETA_400' as const satisfies ActiveCapitalPolicyContext;
export const FIXED_BETA_HARD_STOP_BINDING_CAPABILITY =
  'RISK_STATE_MACHINE_EXPLICIT_PAIR_V1' as const satisfies HardStopThresholdBindingCapability;

export type WorkerCapitalPolicySelection =
  | {
      ok: true;
      policyContext: typeof WORKER_STANDARD_ACTIVE_CONTEXT;
      betaRequested: false;
      riskCapitalScope: null;
      effectiveTradingCapitalUsd: null;
      hardStopThresholdBindingCapability?: never;
      blockNewEntries: false;
    }
  | {
      ok: true;
      policyContext: typeof WORKER_FIXED_BETA_CONTEXT;
      betaRequested: true;
      riskCapitalScope: Readonly<RiskCapitalScope>;
      effectiveTradingCapitalUsd: number;
      hardStopThresholdBindingCapability: HardStopThresholdBindingCapability;
      blockNewEntries: false;
    }
  | {
      ok: false;
      reason: 'WORKER_CAPITAL_POLICY_CONTEXT_INVALID';
      blockNewEntries: true;
    };

/**
 * Default is the existing Standard Active path only when no selector was supplied.
 * Any supplied but unknown/blank/malformed token is fail-closed rather than silently
 * falling back to the larger Standard Active capital domain.
 */
export function resolveWorkerCapitalPolicySelection(
  rawPolicyContext: unknown,
): WorkerCapitalPolicySelection {
  if (rawPolicyContext === undefined || rawPolicyContext === null) {
    return {
      ok: true,
      policyContext: WORKER_STANDARD_ACTIVE_CONTEXT,
      betaRequested: false,
      riskCapitalScope: null,
      effectiveTradingCapitalUsd: null,
      blockNewEntries: false,
    };
  }

  if (rawPolicyContext === WORKER_STANDARD_ACTIVE_CONTEXT) {
    return {
      ok: true,
      policyContext: WORKER_STANDARD_ACTIVE_CONTEXT,
      betaRequested: false,
      riskCapitalScope: null,
      effectiveTradingCapitalUsd: null,
      blockNewEntries: false,
    };
  }

  if (rawPolicyContext === WORKER_FIXED_BETA_CONTEXT) {
    return {
      ok: true,
      policyContext: WORKER_FIXED_BETA_CONTEXT,
      betaRequested: true,
      riskCapitalScope: FIXED_BETA_RISK_CAPITAL_SCOPE,
      effectiveTradingCapitalUsd: FIXED_BETA_RISK_CAPITAL_SCOPE.maxRiskCapitalUsd,
      hardStopThresholdBindingCapability: FIXED_BETA_HARD_STOP_BINDING_CAPABILITY,
      blockNewEntries: false,
    };
  }

  return {
    ok: false,
    reason: 'WORKER_CAPITAL_POLICY_CONTEXT_INVALID',
    blockNewEntries: true,
  };
}
