import { FIXED_BETA_RISK_CAPITAL_SCOPE } from '../lib/riskCapital';
import {
  FIXED_BETA_REFERENCE_CONTEXT,
  FIXED_BETA_REFERENCE_SCHEMA_VERSION,
  FIXED_BETA_REFERENCE_STATE_KEYS,
  resolveFixedBetaReferenceContract,
} from './fixedBetaReferenceContract';
import { WORKER_FIXED_BETA_CONTEXT } from './workerCapitalPolicy';

/**
 * Restart-safe calculation state for the isolated 400-USDC Fixed Beta domain.
 *
 * This module is deliberately pure. It defines and validates the snapshot that a
 * later worker adapter may persist under FIXED_BETA_REFERENCE_STATE_KEYS. It does
 * not read/write worker_state, reset legacy PAPER baselines/HWM, mutate Production
 * state, or authorize Beta/LIVE execution.
 */

const PERIOD_KEY_RE = /^[A-Za-z0-9._:+-]{1,128}$/;

export interface FixedBetaReferenceSnapshotV1 {
  schemaVersion: typeof FIXED_BETA_REFERENCE_SCHEMA_VERSION;
  referenceContext: typeof FIXED_BETA_REFERENCE_CONTEXT;
  policyContext: typeof WORKER_FIXED_BETA_CONTEXT;
  activeStateKey: string;
  dailyBaselineStateKey: string;
  weeklyBaselineStateKey: string;
  highWaterMarkStateKey: string;
  referenceCapitalUsd: number;
  dailyPeriodKey: string;
  weeklyPeriodKey: string;
  dailyStartEquityUsd: number;
  weeklyStartEquityUsd: number;
  referenceHwmUsd: number;
  currentRiskEquityUsd: number;
  historicalHardStopPresent: boolean;
  productionStateMutationAuthorized: false;
  betaExecutionAuthorized: false;
}

export interface FixedBetaReferenceMetricsV1 {
  dailyPnlUsd: number;
  weeklyPnlUsd: number;
  drawdownPercent: number;
}

type FixedBetaStateFailureReason =
  | 'FIXED_BETA_REFERENCE_CONTRACT_INVALID'
  | 'FIXED_BETA_REFERENCE_PERIOD_KEY_INVALID'
  | 'FIXED_BETA_REFERENCE_EQUITY_INVALID'
  | 'FIXED_BETA_REFERENCE_STATE_JSON_INVALID'
  | 'FIXED_BETA_REFERENCE_STATE_SHAPE_INVALID'
  | 'FIXED_BETA_REFERENCE_STATE_KEYS_INVALID'
  | 'FIXED_BETA_REFERENCE_STATE_VALUES_INVALID';

export type FixedBetaReferenceStateResult =
  | { ok: true; snapshot: FixedBetaReferenceSnapshotV1; metrics: FixedBetaReferenceMetricsV1 }
  | { ok: false; reason: FixedBetaStateFailureReason; blockNewEntries: true };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validPeriodKey(value: unknown): value is string {
  return typeof value === 'string' && PERIOD_KEY_RE.test(value);
}

function validEquity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function metricsFor(snapshot: FixedBetaReferenceSnapshotV1): FixedBetaReferenceMetricsV1 {
  const hwm = snapshot.referenceHwmUsd;
  return {
    dailyPnlUsd: snapshot.currentRiskEquityUsd - snapshot.dailyStartEquityUsd,
    weeklyPnlUsd: snapshot.currentRiskEquityUsd - snapshot.weeklyStartEquityUsd,
    drawdownPercent: hwm > 0
      ? Math.max(0, (hwm - snapshot.currentRiskEquityUsd) / hwm * 100)
      : 0,
  };
}

export function createFixedBetaReferenceSnapshotV1(input: {
  rawReferenceContext: unknown;
  rawPolicyContext: unknown;
  configuredTradingCapitalUsd: unknown;
  currentRiskEquityUsd: unknown;
  dailyPeriodKey: unknown;
  weeklyPeriodKey: unknown;
  historicalHardStopPresent: boolean;
}): FixedBetaReferenceStateResult {
  const contract = resolveFixedBetaReferenceContract(
    input.rawReferenceContext,
    input.rawPolicyContext,
    input.configuredTradingCapitalUsd,
  );
  if (!contract.ok) {
    return { ok: false, reason: 'FIXED_BETA_REFERENCE_CONTRACT_INVALID', blockNewEntries: true };
  }
  if (!validPeriodKey(input.dailyPeriodKey) || !validPeriodKey(input.weeklyPeriodKey)) {
    return { ok: false, reason: 'FIXED_BETA_REFERENCE_PERIOD_KEY_INVALID', blockNewEntries: true };
  }
  if (!validEquity(input.currentRiskEquityUsd)) {
    return { ok: false, reason: 'FIXED_BETA_REFERENCE_EQUITY_INVALID', blockNewEntries: true };
  }

  const snapshot: FixedBetaReferenceSnapshotV1 = {
    schemaVersion: FIXED_BETA_REFERENCE_SCHEMA_VERSION,
    referenceContext: FIXED_BETA_REFERENCE_CONTEXT,
    policyContext: WORKER_FIXED_BETA_CONTEXT,
    activeStateKey: FIXED_BETA_REFERENCE_STATE_KEYS.active,
    dailyBaselineStateKey: FIXED_BETA_REFERENCE_STATE_KEYS.dailyBaseline,
    weeklyBaselineStateKey: FIXED_BETA_REFERENCE_STATE_KEYS.weeklyBaseline,
    highWaterMarkStateKey: FIXED_BETA_REFERENCE_STATE_KEYS.highWaterMark,
    referenceCapitalUsd: FIXED_BETA_RISK_CAPITAL_SCOPE.maxRiskCapitalUsd,
    dailyPeriodKey: input.dailyPeriodKey,
    weeklyPeriodKey: input.weeklyPeriodKey,
    dailyStartEquityUsd: input.currentRiskEquityUsd,
    weeklyStartEquityUsd: input.currentRiskEquityUsd,
    referenceHwmUsd: Math.max(FIXED_BETA_RISK_CAPITAL_SCOPE.maxRiskCapitalUsd, input.currentRiskEquityUsd),
    currentRiskEquityUsd: input.currentRiskEquityUsd,
    historicalHardStopPresent: input.historicalHardStopPresent,
    productionStateMutationAuthorized: false,
    betaExecutionAuthorized: false,
  };
  return { ok: true, snapshot, metrics: metricsFor(snapshot) };
}

export function restoreFixedBetaReferenceSnapshotV1(raw: unknown): FixedBetaReferenceStateResult {
  let value: unknown = raw;
  try {
    if (typeof raw === 'string') value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'FIXED_BETA_REFERENCE_STATE_JSON_INVALID', blockNewEntries: true };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'FIXED_BETA_REFERENCE_STATE_SHAPE_INVALID', blockNewEntries: true };
  }

  const keys = [
    'schemaVersion', 'referenceContext', 'policyContext', 'activeStateKey',
    'dailyBaselineStateKey', 'weeklyBaselineStateKey', 'highWaterMarkStateKey',
    'referenceCapitalUsd', 'dailyPeriodKey', 'weeklyPeriodKey', 'dailyStartEquityUsd',
    'weeklyStartEquityUsd', 'referenceHwmUsd', 'currentRiskEquityUsd',
    'historicalHardStopPresent', 'productionStateMutationAuthorized', 'betaExecutionAuthorized',
  ] as const;
  if (!hasExactKeys(value, keys)) {
    return { ok: false, reason: 'FIXED_BETA_REFERENCE_STATE_KEYS_INVALID', blockNewEntries: true };
  }

  if (
    value.schemaVersion !== FIXED_BETA_REFERENCE_SCHEMA_VERSION
    || value.referenceContext !== FIXED_BETA_REFERENCE_CONTEXT
    || value.policyContext !== WORKER_FIXED_BETA_CONTEXT
    || value.activeStateKey !== FIXED_BETA_REFERENCE_STATE_KEYS.active
    || value.dailyBaselineStateKey !== FIXED_BETA_REFERENCE_STATE_KEYS.dailyBaseline
    || value.weeklyBaselineStateKey !== FIXED_BETA_REFERENCE_STATE_KEYS.weeklyBaseline
    || value.highWaterMarkStateKey !== FIXED_BETA_REFERENCE_STATE_KEYS.highWaterMark
    || value.referenceCapitalUsd !== FIXED_BETA_RISK_CAPITAL_SCOPE.maxRiskCapitalUsd
    || !validPeriodKey(value.dailyPeriodKey)
    || !validPeriodKey(value.weeklyPeriodKey)
    || !validEquity(value.dailyStartEquityUsd)
    || !validEquity(value.weeklyStartEquityUsd)
    || !validEquity(value.referenceHwmUsd)
    || !validEquity(value.currentRiskEquityUsd)
    || value.referenceHwmUsd < FIXED_BETA_RISK_CAPITAL_SCOPE.maxRiskCapitalUsd
    || value.referenceHwmUsd < value.currentRiskEquityUsd
    || typeof value.historicalHardStopPresent !== 'boolean'
    || value.productionStateMutationAuthorized !== false
    || value.betaExecutionAuthorized !== false
  ) {
    return { ok: false, reason: 'FIXED_BETA_REFERENCE_STATE_VALUES_INVALID', blockNewEntries: true };
  }

  const snapshot = value as unknown as FixedBetaReferenceSnapshotV1;
  return { ok: true, snapshot, metrics: metricsFor(snapshot) };
}

export function advanceFixedBetaReferenceSnapshotV1(
  rawSnapshot: unknown,
  input: {
    currentRiskEquityUsd: unknown;
    dailyPeriodKey: unknown;
    weeklyPeriodKey: unknown;
    historicalHardStopPresent: boolean;
  },
): FixedBetaReferenceStateResult {
  const restored = restoreFixedBetaReferenceSnapshotV1(rawSnapshot);
  if (!restored.ok) return restored;
  if (!validPeriodKey(input.dailyPeriodKey) || !validPeriodKey(input.weeklyPeriodKey)) {
    return { ok: false, reason: 'FIXED_BETA_REFERENCE_PERIOD_KEY_INVALID', blockNewEntries: true };
  }
  if (!validEquity(input.currentRiskEquityUsd)) {
    return { ok: false, reason: 'FIXED_BETA_REFERENCE_EQUITY_INVALID', blockNewEntries: true };
  }

  const previous = restored.snapshot;
  const snapshot: FixedBetaReferenceSnapshotV1 = {
    ...previous,
    dailyPeriodKey: input.dailyPeriodKey,
    weeklyPeriodKey: input.weeklyPeriodKey,
    dailyStartEquityUsd: input.dailyPeriodKey === previous.dailyPeriodKey
      ? previous.dailyStartEquityUsd
      : input.currentRiskEquityUsd,
    weeklyStartEquityUsd: input.weeklyPeriodKey === previous.weeklyPeriodKey
      ? previous.weeklyStartEquityUsd
      : input.currentRiskEquityUsd,
    referenceHwmUsd: Math.max(previous.referenceHwmUsd, input.currentRiskEquityUsd),
    currentRiskEquityUsd: input.currentRiskEquityUsd,
    historicalHardStopPresent:
      previous.historicalHardStopPresent || input.historicalHardStopPresent,
    productionStateMutationAuthorized: false,
    betaExecutionAuthorized: false,
  };
  return { ok: true, snapshot, metrics: metricsFor(snapshot) };
}
