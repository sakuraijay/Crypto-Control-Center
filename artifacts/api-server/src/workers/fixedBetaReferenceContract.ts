import { FIXED_BETA_RISK_CAPITAL_SCOPE } from '../lib/riskCapital';
import {
  WORKER_FIXED_BETA_CONTEXT,
  resolveWorkerCapitalExecutionDomain,
  type WorkerCapitalExecutionDomain,
} from './workerCapitalPolicy';

/**
 * Fixed Beta reference identity for worker-side equity/PnL calculations.
 *
 * This module is deliberately pure and non-persistent. It does not read or write
 * worker_state, HWM, PAPER epoch state, runtime config, secrets, signer state, or
 * execution state. It only makes the isolation contract explicit so a later worker
 * binding cannot silently reuse the legacy 1,000-USDC PAPER baselines/HWM when the
 * Fixed Beta calculation domain is 400 USDC.
 */

export const FIXED_BETA_REFERENCE_CONTEXT = 'FIXED_BETA_REFERENCE_V1' as const;
export const FIXED_BETA_REFERENCE_SCHEMA_VERSION = 1 as const;

export const FIXED_BETA_REFERENCE_STATE_KEYS = Object.freeze({
  active: 'fixed_beta_reference_active_v1',
  dailyBaseline: 'fixed_beta_equity_baseline_daily_v1',
  weeklyBaseline: 'fixed_beta_equity_baseline_weekly_v1',
  highWaterMark: 'fixed_beta_equity_hwm_v1',
});

export type FixedBetaReferenceStateKey =
  (typeof FIXED_BETA_REFERENCE_STATE_KEYS)[keyof typeof FIXED_BETA_REFERENCE_STATE_KEYS];

type FailedWorkerCapitalExecutionDomain = Extract<
  WorkerCapitalExecutionDomain,
  { ok: false }
>;

export type FixedBetaReferenceContractResolution =
  | {
      ok: true;
      referenceContext: typeof FIXED_BETA_REFERENCE_CONTEXT;
      schemaVersion: typeof FIXED_BETA_REFERENCE_SCHEMA_VERSION;
      policyContext: typeof WORKER_FIXED_BETA_CONTEXT;
      referenceCapitalUsd: number;
      stateKeys: typeof FIXED_BETA_REFERENCE_STATE_KEYS;
      reuseLegacyDailyWeeklyBaselines: false;
      reuseLegacyPaperEpoch: false;
      reuseLegacyHighWaterMark: false;
      historicalHardStopSticky: true;
      productionStateMutationAuthorized: false;
      betaExecutionAuthorized: false;
      blockNewEntries: false;
    }
  | {
      ok: false;
      reason:
        | 'FIXED_BETA_REFERENCE_CONTEXT_INVALID'
        | 'FIXED_BETA_REFERENCE_POLICY_MISMATCH'
        | FailedWorkerCapitalExecutionDomain['reason'];
      blockNewEntries: true;
    };

/**
 * Resolve the Fixed Beta reference contract only from two explicit inputs:
 * - FIXED_BETA_REFERENCE_V1 reference identity, and
 * - FIXED_BETA_400 worker capital policy.
 *
 * Missing/malformed identity, Standard Active policy, undersized capital, or invalid
 * capital all fail closed. No date, wallet balance, Planned Seed, DB/HWM state, or
 * runtime execution flag can infer this contract.
 *
 * A successful result still authorizes neither Production persistence nor Beta/LIVE
 * execution. It only establishes a distinct 400-USDC reference namespace that later
 * persistence/binding work must use instead of the legacy PAPER baseline/HWM identity.
 */
export function resolveFixedBetaReferenceContract(
  rawReferenceContext: unknown,
  rawPolicyContext: unknown,
  configuredTradingCapitalUsd: unknown,
): FixedBetaReferenceContractResolution {
  if (rawReferenceContext !== FIXED_BETA_REFERENCE_CONTEXT) {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_CONTEXT_INVALID',
      blockNewEntries: true,
    };
  }

  const domain = resolveWorkerCapitalExecutionDomain(
    rawPolicyContext,
    configuredTradingCapitalUsd,
  );
  if (!domain.ok) return domain;

  if (
    !domain.selection.betaRequested
    || domain.selection.policyContext !== WORKER_FIXED_BETA_CONTEXT
    || domain.effectiveTradingCapitalUsd !== FIXED_BETA_RISK_CAPITAL_SCOPE.maxRiskCapitalUsd
  ) {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_POLICY_MISMATCH',
      blockNewEntries: true,
    };
  }

  return {
    ok: true,
    referenceContext: FIXED_BETA_REFERENCE_CONTEXT,
    schemaVersion: FIXED_BETA_REFERENCE_SCHEMA_VERSION,
    policyContext: WORKER_FIXED_BETA_CONTEXT,
    referenceCapitalUsd: domain.effectiveTradingCapitalUsd,
    stateKeys: FIXED_BETA_REFERENCE_STATE_KEYS,
    reuseLegacyDailyWeeklyBaselines: false,
    reuseLegacyPaperEpoch: false,
    reuseLegacyHighWaterMark: false,
    historicalHardStopSticky: true,
    productionStateMutationAuthorized: false,
    betaExecutionAuthorized: false,
    blockNewEntries: false,
  };
}
