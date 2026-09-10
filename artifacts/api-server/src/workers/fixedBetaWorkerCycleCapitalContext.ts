import type { RiskCapitalScope } from '../lib/riskCapital';
import {
  loadFixedBetaReferenceWorkerStateReadOnlyV1,
  type FixedBetaReferenceWorkerStateReaderV1,
} from './fixedBetaReferenceReadOnlyLoader';
import type {
  FixedBetaReferenceMetricsV1,
  FixedBetaReferenceSnapshotV1,
} from './fixedBetaReferenceState';
import {
  WORKER_FIXED_BETA_CONTEXT,
  WORKER_STANDARD_ACTIVE_CONTEXT,
  resolveWorkerCapitalExecutionDomain,
  type WorkerCapitalExecutionDomain,
} from './workerCapitalPolicy';
import type { HardStopThresholdBindingCapability } from '../lib/activeCapitalSemantics';

/**
 * Narrow cycle-level capital context for the 24/7 worker.
 *
 * The existing configured Active Trading Capital is never rewritten. Standard mode
 * preserves it unchanged and never touches Fixed Beta state. FIXED_BETA_400 scopes
 * calculations down to 400 USDC only after the isolated reference row and fresh
 * authoritative HARD_STOP evidence both validate.
 *
 * This module has no DB import and exposes no write/bootstrap API. A successful
 * Fixed Beta context still grants neither Production mutation nor execution authority.
 */

export type FixedBetaWorkerCycleCapitalContextV1 =
  | {
      ok: true;
      betaRequested: false;
      policyContext: typeof WORKER_STANDARD_ACTIVE_CONTEXT;
      configuredTradingCapitalUsd: number;
      effectiveTradingCapitalUsd: number;
      riskCapitalScope: null;
      hardStopThresholdBindingCapability: null;
      fixedBetaReference: null;
      productionStateMutationAuthorized: false;
      betaExecutionAuthorized: false;
      blockNewEntries: false;
    }
  | {
      ok: true;
      betaRequested: true;
      policyContext: typeof WORKER_FIXED_BETA_CONTEXT;
      configuredTradingCapitalUsd: number;
      effectiveTradingCapitalUsd: number;
      riskCapitalScope: Readonly<RiskCapitalScope>;
      hardStopThresholdBindingCapability: HardStopThresholdBindingCapability;
      fixedBetaReference: {
        snapshot: FixedBetaReferenceSnapshotV1;
        metrics: FixedBetaReferenceMetricsV1;
      };
      productionStateMutationAuthorized: false;
      betaExecutionAuthorized: false;
      blockNewEntries: false;
    }
  | {
      ok: false;
      reason:
        | Extract<WorkerCapitalExecutionDomain, { ok: false }>['reason']
        | 'FIXED_BETA_REFERENCE_READER_UNAVAILABLE'
        | 'FIXED_BETA_REFERENCE_CAPITAL_MISMATCH'
        | 'FIXED_BETA_REFERENCE_AUTHORITATIVE_HARD_STOP_INVALID'
        | 'FIXED_BETA_REFERENCE_WORKER_STATE_NOT_FOUND'
        | 'FIXED_BETA_REFERENCE_WORKER_STATE_READ_FAILED'
        | 'FIXED_BETA_REFERENCE_WORKER_STATE_KEY_INVALID'
        | 'FIXED_BETA_REFERENCE_WORKER_STATE_VALUE_INVALID'
        | 'FIXED_BETA_REFERENCE_PERSISTED_STATE_INVALID';
      productionStateMutationAuthorized: false;
      betaExecutionAuthorized: false;
      blockNewEntries: true;
    };

export async function resolveFixedBetaWorkerCycleCapitalContextV1(input: {
  rawPolicyContext: unknown;
  configuredTradingCapitalUsd: unknown;
  authoritativeHistoricalHardStopPresent: unknown;
  readWorkerStateRow?: FixedBetaReferenceWorkerStateReaderV1 | null;
}): Promise<FixedBetaWorkerCycleCapitalContextV1> {
  const domain = resolveWorkerCapitalExecutionDomain(
    input.rawPolicyContext,
    input.configuredTradingCapitalUsd,
  );
  if (!domain.ok) {
    return {
      ...domain,
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
    };
  }

  if (!domain.selection.betaRequested) {
    return {
      ok: true,
      betaRequested: false,
      policyContext: WORKER_STANDARD_ACTIVE_CONTEXT,
      configuredTradingCapitalUsd: domain.configuredTradingCapitalUsd,
      effectiveTradingCapitalUsd: domain.effectiveTradingCapitalUsd,
      riskCapitalScope: null,
      hardStopThresholdBindingCapability: null,
      fixedBetaReference: null,
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
      blockNewEntries: false,
    };
  }

  if (!input.readWorkerStateRow) {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_READER_UNAVAILABLE',
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
      blockNewEntries: true,
    };
  }

  const reference = await loadFixedBetaReferenceWorkerStateReadOnlyV1(
    input.readWorkerStateRow,
    input.authoritativeHistoricalHardStopPresent,
  );
  if (!reference.ok) {
    return {
      ...reference,
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
    };
  }

  if (reference.snapshot.referenceCapitalUsd !== domain.effectiveTradingCapitalUsd) {
    return {
      ok: false,
      reason: 'FIXED_BETA_REFERENCE_CAPITAL_MISMATCH',
      productionStateMutationAuthorized: false,
      betaExecutionAuthorized: false,
      blockNewEntries: true,
    };
  }

  return {
    ok: true,
    betaRequested: true,
    policyContext: WORKER_FIXED_BETA_CONTEXT,
    configuredTradingCapitalUsd: domain.configuredTradingCapitalUsd,
    effectiveTradingCapitalUsd: domain.effectiveTradingCapitalUsd,
    riskCapitalScope: domain.selection.riskCapitalScope,
    hardStopThresholdBindingCapability:
      domain.selection.hardStopThresholdBindingCapability,
    fixedBetaReference: {
      snapshot: reference.snapshot,
      metrics: reference.metrics,
    },
    productionStateMutationAuthorized: false,
    betaExecutionAuthorized: false,
    blockNewEntries: false,
  };
}
