import { createHash } from 'node:crypto';
import {
  EMPTY_LOCKS,
  type PersistedLocks,
} from '../lib/riskStateMachine';
import type { PersistedRiskEngineState } from '../lib/riskEngineState';
import { FIXED_BETA_REFERENCE_CONTEXT } from './fixedBetaReferenceContract';
import { WORKER_FIXED_BETA_CONTEXT } from './workerCapitalPolicy';

/**
 * The alpha ledger is deliberately a different durable record from
 * riskEngineStateV1.  It is not an initializer: a missing or malformed record
 * is evidence failure and must block entries.
 */
export const FIXED_BETA_ACCOUNTING_STATE_KEY = 'fixed_beta_accounting_state_v1';
export const FIXED_BETA_ACCOUNTING_SCHEMA_VERSION = 1 as const;
export const FIXED_BETA_TRADE_STRATEGY = 'SERVER_WORKER_AI::FIXED_BETA_400_V1';

export interface FixedBetaLedgerBinding {
  version: 1;
  sha256: string;
  rowCount: number;
  openTradeIds: string[];
}

/** Canonical FULL-row proof, not a day/week aggregate. Includes all risk fields,
 * settlement/cost provenance, closed history and open inventory. Never persisted
 * or renewed by this function: only compare against explicitly provisioned proof. */
export function fixedBetaLedgerBinding(rows: readonly Record<string, unknown>[]): FixedBetaLedgerBinding {
  const canonical = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().filter(key =>
        (value as Record<string, unknown>)[key] !== undefined,
      ).map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('FIXED_BETA_NONFINITE_LEDGER_FIELD');
    return value;
  };
  const sorted = [...rows].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  return {
    version: 1,
    sha256: createHash('sha256').update(JSON.stringify(canonical(sorted))).digest('hex'),
    rowCount: rows.length,
    openTradeIds: sorted.filter(row => row.action === 'OPEN' && row.closeTime === 0).map(row => String(row.id)),
  };
}

/** Unlike parseFloat, rejects empty, missing and partially numeric evidence. */
export function fixedBetaNumber(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) {
    throw new Error('FIXED_BETA_NUMERIC_EVIDENCE_INVALID');
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('FIXED_BETA_NUMERIC_EVIDENCE_INVALID');
  return number;
}

export interface FixedBetaAccountingStateV1 {
  schemaVersion: typeof FIXED_BETA_ACCOUNTING_SCHEMA_VERSION;
  policyContext: typeof WORKER_FIXED_BETA_CONTEXT;
  referenceContext: typeof FIXED_BETA_REFERENCE_CONTEXT;
  referenceCapitalUsd: 400;
  /** Fresh authoritative observation; missing is never interpreted as false. */
  authoritativeHistoricalHardStopPresent: boolean;
  provenance: {
    tradeStrategy: typeof FIXED_BETA_TRADE_STRATEGY;
    checkpointId: string;
    checkpointedAt: string;
    ledgerBinding: FixedBetaLedgerBinding;
  };
  state: PersistedRiskEngineState;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

function validLocks(value: unknown): value is PersistedLocks {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const locks = value as Record<string, unknown>;
  return Object.keys(EMPTY_LOCKS).every(key => key in locks)
    && nullableString(locks.dailyLockReason)
    && nullableString(locks.dailyLockState)
    && nullableString(locks.weeklyLockReason)
    && nullableString(locks.hardStopReason)
    && nullableString(locks.unresolvedReason)
    && (locks.protectedProfitFloorUsd === null || (finite(locks.protectedProfitFloorUsd) && locks.protectedProfitFloorUsd >= 0))
    && typeof locks.profitReductionDone === 'boolean'
    && typeof locks.defensiveActive === 'boolean'
    && nonnegativeInteger(locks.defensiveEntriesUsed)
    && (locks.dailyLockState === null
      || locks.dailyLockState === 'PROFIT_PROTECTED'
      || locks.dailyLockState === 'PROFIT_TARGET_LOCKED'
      || locks.dailyLockState === 'PROFIT_CAP_LOCKED'
      || locks.dailyLockState === 'DAILY_LOSS_LOCKED'
      || locks.dailyLockState === 'CONSECUTIVE_LOSS_LOCKED')
    && ((locks.dailyLockState === null) === (locks.dailyLockReason === null));
}

function validRiskState(value: unknown): value is PersistedRiskEngineState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return iso(state.dayPeriodStart)
    && iso(state.weekPeriodStart)
    && iso(state.lastUpdatedAt)
    && finite(state.startOfDayEquityUsd)
    && state.startOfDayEquityUsd > 0
    && finite(state.startOfWeekEquityUsd)
    && state.startOfWeekEquityUsd > 0
    && finite(state.dailyRealizedNetPnlUsd)
    && finite(state.dailyLossAwareNetPnlUsd)
    && finite(state.weeklyRealizedNetPnlUsd)
    && nonnegativeInteger(state.dailyEntryCount)
    && nonnegativeInteger(state.consecutiveLossCount)
    && (state.riskOperatingState === 'NORMAL'
      || state.riskOperatingState === 'DEFENSIVE'
      || state.riskOperatingState === 'PROFIT_PROTECTED'
      || state.riskOperatingState === 'PROFIT_TARGET_LOCKED'
      || state.riskOperatingState === 'PROFIT_CAP_LOCKED'
      || state.riskOperatingState === 'DAILY_LOSS_LOCKED'
      || state.riskOperatingState === 'WEEKLY_LOSS_LOCKED'
      || state.riskOperatingState === 'CONSECUTIVE_LOSS_LOCKED'
      || state.riskOperatingState === 'HARD_STOPPED'
      || state.riskOperatingState === 'UNRESOLVED')
    && validLocks(state.locks);
}

/** Strictly parse an already-provisioned alpha record; never synthesize zeros. */
export function parseFixedBetaAccountingStateV1(raw: string | null | undefined): FixedBetaAccountingStateV1 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<FixedBetaAccountingStateV1>;
    const state = value.state;
    if (
      value.schemaVersion !== FIXED_BETA_ACCOUNTING_SCHEMA_VERSION
      || value.policyContext !== WORKER_FIXED_BETA_CONTEXT
      || value.referenceContext !== FIXED_BETA_REFERENCE_CONTEXT
      || value.referenceCapitalUsd !== 400
      || typeof value.authoritativeHistoricalHardStopPresent !== 'boolean'
      || !value.provenance
      || value.provenance.tradeStrategy !== FIXED_BETA_TRADE_STRATEGY
      || typeof value.provenance.checkpointId !== 'string'
      || value.provenance.checkpointId.length === 0
      || !iso(value.provenance.checkpointedAt)
      || value.provenance.ledgerBinding?.version !== 1
      || !/^[a-f0-9]{64}$/.test(value.provenance.ledgerBinding.sha256)
      || !nonnegativeInteger(value.provenance.ledgerBinding.rowCount)
      || !Array.isArray(value.provenance.ledgerBinding.openTradeIds)
      || value.provenance.ledgerBinding.openTradeIds.some(id => typeof id !== 'string' || !id.trim())
      || new Set(value.provenance.ledgerBinding.openTradeIds).size !== value.provenance.ledgerBinding.openTradeIds.length
      || value.provenance.ledgerBinding.openTradeIds.length > value.provenance.ledgerBinding.rowCount
      || !validRiskState(state)
    ) return null;
    if (
      (value.authoritativeHistoricalHardStopPresent === true && !state.locks.hardStopReason)
      || (state.riskOperatingState === 'HARD_STOPPED' && !state.locks.hardStopReason)
      || (state.riskOperatingState === 'WEEKLY_LOSS_LOCKED' && !state.locks.weeklyLockReason)
      || (state.riskOperatingState === 'DEFENSIVE' && !state.locks.defensiveActive)
      || (state.riskOperatingState === 'UNRESOLVED' && !state.locks.unresolvedReason)
      || (['PROFIT_PROTECTED', 'PROFIT_TARGET_LOCKED', 'PROFIT_CAP_LOCKED',
        'DAILY_LOSS_LOCKED', 'CONSECUTIVE_LOSS_LOCKED'].includes(state.riskOperatingState)
        && state.locks.dailyLockState !== state.riskOperatingState)
    ) return null;
    return value as FixedBetaAccountingStateV1;
  } catch {
    return null;
  }
}

/** Freshness is checked at read time so a stopped worker cannot resume on stale proof. */
export function isFixedBetaAccountingStateFresh(
  state: FixedBetaAccountingStateV1,
  nowMs = Date.now(),
  maxAgeMs = 8 * 24 * 60 * 60 * 1000,
): boolean {
  const checkpointMs = Date.parse(state.provenance.checkpointedAt);
  return Number.isFinite(checkpointMs)
    && checkpointMs <= nowMs
    && nowMs - checkpointMs <= maxAgeMs;
}
