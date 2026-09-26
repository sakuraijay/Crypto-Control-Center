import {
  buildVirtualPaper400Session,
  parseVirtualPaper400Session,
  type VirtualPaper400SessionV1,
} from './virtualPaper400Ledger';

/**
 * Durable control-plane state for the VIRTUAL/PAPER 400 test session.
 *
 * This state is intentionally separate from FIXED_BETA_400 and from real-wallet
 * accounting. ACTIVE only makes the session eligible for PAPER routing; existing
 * strategy, Risk, sizing, Stop, exposure and execution gates still decide whether
 * any simulated OPEN may occur.
 */
export const VIRTUAL_PAPER_400_SESSION_STATE_KEY = 'virtual_paper_400_session_state_v1';
export const VIRTUAL_PAPER_400_SESSION_STATE_SCHEMA_VERSION = 1 as const;
export const VIRTUAL_PAPER_400_LOCK_ID = 4000920;

export type VirtualPaper400SessionStatus = 'ACTIVE' | 'STOPPED';

export interface PersistedVirtualPaper400SessionStateV1 {
  schemaVersion: typeof VIRTUAL_PAPER_400_SESSION_STATE_SCHEMA_VERSION;
  status: VirtualPaper400SessionStatus;
  session: VirtualPaper400SessionV1;
  updatedAt: string;
  stoppedAt?: string;
  stopReason?: string;
}

export type VirtualPaper400SessionEvaluation = {
  status: VirtualPaper400SessionStatus | 'MISSING' | 'INVALID';
  active: boolean;
  paperRoutingEligible: boolean;
  reason:
    | 'VIRTUAL_SESSION_ACTIVE'
    | 'VIRTUAL_SESSION_STOPPED'
    | 'VIRTUAL_SESSION_MISSING'
    | 'VIRTUAL_SESSION_INVALID';
  state?: PersistedVirtualPaper400SessionStateV1;
};

const MAX_STOP_REASON_LENGTH = 160;

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function isPersistedVirtualPaper400SessionStateV1(
  value: unknown,
): value is PersistedVirtualPaper400SessionStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== VIRTUAL_PAPER_400_SESSION_STATE_SCHEMA_VERSION) return false;
  if (candidate.status !== 'ACTIVE' && candidate.status !== 'STOPPED') return false;
  if (!isCanonicalIsoTimestamp(candidate.updatedAt)) return false;
  const parsedSession = parseVirtualPaper400Session(candidate.session);
  if (!parsedSession.ok) return false;

  if (candidate.status === 'ACTIVE') {
    if (!exactKeys(candidate, ['schemaVersion', 'status', 'session', 'updatedAt'])) return false;
    return true;
  }

  if (!isCanonicalIsoTimestamp(candidate.stoppedAt)) return false;
  if (candidate.stopReason !== undefined) {
    if (typeof candidate.stopReason !== 'string') return false;
    if (candidate.stopReason.length === 0 || candidate.stopReason.length > MAX_STOP_REASON_LENGTH) return false;
  }
  const keys = candidate.stopReason === undefined
    ? ['schemaVersion', 'status', 'session', 'updatedAt', 'stoppedAt']
    : ['schemaVersion', 'status', 'session', 'updatedAt', 'stoppedAt', 'stopReason'];
  return exactKeys(candidate, keys);
}

/**
 * Observational evaluation only. Missing/malformed durable state never bootstraps
 * a session and is ineligible for PAPER routing.
 */
export function evaluateVirtualPaper400SessionState(
  raw: unknown,
): VirtualPaper400SessionEvaluation {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return {
      status: 'MISSING',
      active: false,
      paperRoutingEligible: false,
      reason: 'VIRTUAL_SESSION_MISSING',
    };
  }
  if (typeof raw !== 'string') {
    return {
      status: 'INVALID',
      active: false,
      paperRoutingEligible: false,
      reason: 'VIRTUAL_SESSION_INVALID',
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      status: 'INVALID',
      active: false,
      paperRoutingEligible: false,
      reason: 'VIRTUAL_SESSION_INVALID',
    };
  }
  if (!isPersistedVirtualPaper400SessionStateV1(value)) {
    return {
      status: 'INVALID',
      active: false,
      paperRoutingEligible: false,
      reason: 'VIRTUAL_SESSION_INVALID',
    };
  }
  if (value.status === 'STOPPED') {
    return {
      status: 'STOPPED',
      active: false,
      paperRoutingEligible: false,
      reason: 'VIRTUAL_SESSION_STOPPED',
      state: value,
    };
  }
  return {
    status: 'ACTIVE',
    active: true,
    paperRoutingEligible: true,
    reason: 'VIRTUAL_SESSION_ACTIVE',
    state: value,
  };
}

export function buildActiveVirtualPaper400SessionState(
  sessionId: string,
  now: Date = new Date(),
): PersistedVirtualPaper400SessionStateV1 {
  if (!Number.isFinite(now.getTime())) throw new Error('CURRENT_TIME_INVALID');
  const session = buildVirtualPaper400Session(sessionId, now);
  return {
    schemaVersion: VIRTUAL_PAPER_400_SESSION_STATE_SCHEMA_VERSION,
    status: 'ACTIVE',
    session,
    updatedAt: now.toISOString(),
  };
}

/**
 * STOP preserves the exact session identity/namespace so restart/readback can
 * never silently turn a stopped session into a fresh 400-USDC ledger.
 */
export function buildStoppedVirtualPaper400SessionState(
  activeState: PersistedVirtualPaper400SessionStateV1,
  reason: string | undefined,
  now: Date = new Date(),
): PersistedVirtualPaper400SessionStateV1 {
  if (!Number.isFinite(now.getTime())) throw new Error('CURRENT_TIME_INVALID');
  if (!isPersistedVirtualPaper400SessionStateV1(activeState) || activeState.status !== 'ACTIVE') {
    throw new Error('ACTIVE_VIRTUAL_SESSION_REQUIRED');
  }
  if (reason !== undefined && typeof reason !== 'string') throw new Error('STOP_REASON_INVALID');
  const normalizedReason = reason?.trim();
  if (normalizedReason && normalizedReason.length > MAX_STOP_REASON_LENGTH) {
    throw new Error('STOP_REASON_TOO_LONG');
  }
  const stoppedAt = now.toISOString();
  return {
    schemaVersion: VIRTUAL_PAPER_400_SESSION_STATE_SCHEMA_VERSION,
    status: 'STOPPED',
    session: activeState.session,
    updatedAt: stoppedAt,
    stoppedAt,
    ...(normalizedReason ? { stopReason: normalizedReason } : {}),
  };
}

export function serializeVirtualPaper400SessionState(
  state: PersistedVirtualPaper400SessionStateV1,
): string {
  if (!isPersistedVirtualPaper400SessionStateV1(state)) {
    throw new Error('VIRTUAL_SESSION_STATE_INVALID');
  }
  return JSON.stringify(state);
}
