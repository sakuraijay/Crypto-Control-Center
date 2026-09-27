import {
  WORKER_FIXED_BETA_CONTEXT,
} from './workerCapitalPolicy';
import {
  parseWorkerPolicyContextV1,
} from './workerPolicyContext';

/**
 * Durable operator intent for the ALPHA control plane.
 *
 * This state is deliberately NOT execution authorization.  It never derives from
 * dates, restart, Owner Approval, wallet state, accounting mode, or any trading
 * signal.  A consumer must still independently pass every execution/risk gate.
 */
export const ALPHA_START_INTENT_KEY = 'alpha_start_intent_v1';
export const ALPHA_START_INTENT_SCHEMA_VERSION = 1 as const;
export const ALPHA_START_INTENT_SCOPE = 'CONTROL_PLANE_INTENT_ONLY' as const;

export type AlphaStartIntentStatus = 'ACTIVE' | 'STOPPED';

export interface PersistedAlphaStartIntentV1 {
  schemaVersion: typeof ALPHA_START_INTENT_SCHEMA_VERSION;
  status: AlphaStartIntentStatus;
  issuedAt: string;
  expiresAt: string | null;
  stoppedAt?: string;
  stopReason?: string;
}

export type AlphaStartIntentEvaluation = {
  status: 'ACTIVE' | 'STOPPED' | 'MISSING' | 'INVALID' | 'EXPIRED';
  active: boolean;
  executionAuthorized: false;
  reason:
    | 'ACTIVE_OPERATOR_INTENT'
    | 'STOPPED_BY_OPERATOR'
    | 'START_INTENT_MISSING'
    | 'START_INTENT_INVALID'
    | 'START_INTENT_EXPIRED';
  state?: PersistedAlphaStartIntentV1;
};

export type AlphaStartPolicyGate =
  | { ok: true }
  | { ok: false; reason: 'WORKER_POLICY_CONTEXT_INVALID' | 'FIXED_BETA_REQUIRED' };

const MAX_STOP_REASON_LENGTH = 160;

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

function isPersistedAlphaStartIntentV1(value: unknown): value is PersistedAlphaStartIntentV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedAlphaStartIntentV1>;
  if (candidate.schemaVersion !== ALPHA_START_INTENT_SCHEMA_VERSION) return false;
  if (candidate.status !== 'ACTIVE' && candidate.status !== 'STOPPED') return false;
  if (!isCanonicalIsoTimestamp(candidate.issuedAt)) return false;
  if (candidate.stopReason !== undefined) {
    if (typeof candidate.stopReason !== 'string') return false;
    if (candidate.stopReason.length === 0 || candidate.stopReason.length > MAX_STOP_REASON_LENGTH) return false;
  }

  if (candidate.status === 'ACTIVE') {
    if (!isCanonicalIsoTimestamp(candidate.expiresAt)) return false;
    if (candidate.stoppedAt !== undefined || candidate.stopReason !== undefined) return false;
    return true;
  }

  if (candidate.expiresAt !== null) return false;
  if (!isCanonicalIsoTimestamp(candidate.stoppedAt)) return false;
  return true;
}

/**
 * Evaluate persisted intent without mutating or bootstrapping anything.
 * Missing, malformed, stopped, and expired state are all inactive/fail-closed.
 */
export function evaluateAlphaStartIntent(
  raw: unknown,
  now: Date = new Date(),
): AlphaStartIntentEvaluation {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return {
      status: 'MISSING',
      active: false,
      executionAuthorized: false,
      reason: 'START_INTENT_MISSING',
    };
  }

  if (typeof raw !== 'string' || !Number.isFinite(now.getTime())) {
    return {
      status: 'INVALID',
      active: false,
      executionAuthorized: false,
      reason: 'START_INTENT_INVALID',
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      status: 'INVALID',
      active: false,
      executionAuthorized: false,
      reason: 'START_INTENT_INVALID',
    };
  }

  if (!isPersistedAlphaStartIntentV1(value)) {
    return {
      status: 'INVALID',
      active: false,
      executionAuthorized: false,
      reason: 'START_INTENT_INVALID',
    };
  }

  if (value.status === 'STOPPED') {
    return {
      status: 'STOPPED',
      active: false,
      executionAuthorized: false,
      reason: 'STOPPED_BY_OPERATOR',
      state: value,
    };
  }

  if (Date.parse(value.expiresAt as string) <= now.getTime()) {
    return {
      status: 'EXPIRED',
      active: false,
      executionAuthorized: false,
      reason: 'START_INTENT_EXPIRED',
      state: value,
    };
  }

  return {
    status: 'ACTIVE',
    active: true,
    executionAuthorized: false,
    reason: 'ACTIVE_OPERATOR_INTENT',
    state: value,
  };
}

/**
 * START is valid only while the already-persisted accounting policy is explicitly
 * FIXED_BETA_400.  This helper never changes that policy.
 */
export function evaluateAlphaStartPolicy(
  rawPolicyContext: string | null | undefined,
): AlphaStartPolicyGate {
  const parsed = parseWorkerPolicyContextV1(rawPolicyContext);
  if (!parsed.ok) return { ok: false, reason: 'WORKER_POLICY_CONTEXT_INVALID' };
  if (parsed.context?.policyContext !== WORKER_FIXED_BETA_CONTEXT) {
    return { ok: false, reason: 'FIXED_BETA_REQUIRED' };
  }
  return { ok: true };
}

export function buildActiveAlphaStartIntent(
  expiresAt: string,
  now: Date = new Date(),
): PersistedAlphaStartIntentV1 {
  if (!Number.isFinite(now.getTime())) throw new Error('CURRENT_TIME_INVALID');
  if (typeof expiresAt !== 'string') throw new Error('EXPIRES_AT_INVALID');
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) throw new Error('EXPIRES_AT_INVALID');
  if (expiresAtMs <= now.getTime()) throw new Error('EXPIRES_AT_NOT_FUTURE');

  return {
    schemaVersion: ALPHA_START_INTENT_SCHEMA_VERSION,
    status: 'ACTIVE',
    issuedAt: now.toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function buildStoppedAlphaStartIntent(
  reason: string | undefined,
  now: Date = new Date(),
): PersistedAlphaStartIntentV1 {
  if (!Number.isFinite(now.getTime())) throw new Error('CURRENT_TIME_INVALID');
  if (reason !== undefined && typeof reason !== 'string') throw new Error('STOP_REASON_INVALID');
  const normalizedReason = reason?.trim();
  if (normalizedReason && normalizedReason.length > MAX_STOP_REASON_LENGTH) {
    throw new Error('STOP_REASON_TOO_LONG');
  }

  const at = now.toISOString();
  return {
    schemaVersion: ALPHA_START_INTENT_SCHEMA_VERSION,
    status: 'STOPPED',
    issuedAt: at,
    expiresAt: null,
    stoppedAt: at,
    ...(normalizedReason ? { stopReason: normalizedReason } : {}),
  };
}

export function serializeAlphaStartIntentV1(state: PersistedAlphaStartIntentV1): string {
  if (!isPersistedAlphaStartIntentV1(state)) throw new Error('START_INTENT_INVALID');
  return JSON.stringify(state);
}
