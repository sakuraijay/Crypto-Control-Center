/**
 * Process-local Stop capability snapshot.
 *
 * This module is deliberately state-only: it must remain safe to import from
 * PAPER/read-only code and therefore has no database, signer, execution, or
 * relay-submission dependencies.
 */
export interface StopCapabilityResult {
  available: boolean;
  reasons: string[];
}

export interface StopCapabilityEvidenceBinding {
  canonicalAtMs: number;
  approvalNonce: string;
  expiresAt: string;
  remaining: string;
  inFlightReservedActions: number;
}

export type StopExecutionCapabilitySnapshot = StopCapabilityResult & {
  evaluatedAt: string | null;
  evidenceBinding: StopCapabilityEvidenceBinding | null;
};

/** OPEN 제출에 허용되는 process-local Stop capability 증거의 최대 수명. */
export const STOP_EXECUTION_CAPABILITY_MAX_AGE_MS = 30_000;

const UNEVALUATED_REASON =
  'stop 실행 능력 미평가 — refreshStopExecutionCapability 필요 (fail-closed)';

let stopCapability: StopExecutionCapabilitySnapshot = {
  available: false,
  reasons: [UNEVALUATED_REASON],
  evaluatedAt: null,
  evidenceBinding: null,
};

/** Test-only availability override. null means use the cached derived value. */
let stopCapabilityTestOverride: boolean | null = null;

export function getStopExecutionCapability(): StopExecutionCapabilitySnapshot {
  return {
    ...stopCapability,
    reasons: [...stopCapability.reasons],
    evidenceBinding: stopCapability.evidenceBinding
      ? { ...stopCapability.evidenceBinding }
      : null,
  };
}

export function isFreshStopExecutionCapability(
  capability: Pick<StopExecutionCapabilitySnapshot, 'available' | 'evaluatedAt'>,
  nowMs: number,
): boolean {
  if (!capability.available || !Number.isSafeInteger(nowMs) || nowMs <= 0) return false;
  if (typeof capability.evaluatedAt !== 'string') return false;
  const evaluatedAtMs = Date.parse(capability.evaluatedAt);
  return Number.isFinite(evaluatedAtMs)
    && evaluatedAtMs <= nowMs
    && nowMs - evaluatedAtMs <= STOP_EXECUTION_CAPABILITY_MAX_AGE_MS;
}

export function isStopExecutionAvailable(nowMs = Date.now()): boolean {
  return stopCapabilityTestOverride
    ?? isFreshStopExecutionCapability(stopCapability, nowMs);
}

export function sameStopCapabilityEvidenceBinding(
  left: StopCapabilityEvidenceBinding | null,
  right: StopCapabilityEvidenceBinding | null,
): boolean {
  return left !== null
    && right !== null
    && left.canonicalAtMs === right.canonicalAtMs
    && left.approvalNonce === right.approvalNonce
    && left.expiresAt === right.expiresAt
    && left.remaining === right.remaining
    && left.inFlightReservedActions === right.inFlightReservedActions;
}

export function isStopExecutionAvailableForEvidence(
  expected: StopCapabilityEvidenceBinding | null,
  nowMs = Date.now(),
): boolean {
  return isStopExecutionAvailable(nowMs)
    && sameStopCapabilityEvidenceBinding(stopCapability.evidenceBinding, expected);
}

/** Store a freshly derived result together with the time at which it was evaluated. */
export function setStopExecutionCapability(
  result: StopCapabilityResult,
  evaluatedAt: string | null = new Date().toISOString(),
  evidenceBinding: StopCapabilityEvidenceBinding | null = null,
): StopExecutionCapabilitySnapshot {
  stopCapability = {
    available: result.available,
    reasons: [...result.reasons],
    evaluatedAt,
    evidenceBinding: evidenceBinding ? { ...evidenceBinding } : null,
  };
  return getStopExecutionCapability();
}

export function __setStopExecutionAvailabilityForTests(
  value: boolean | null,
): void {
  stopCapabilityTestOverride = value;
}

/** Internal test/refresh seam; capability derivation remains in the executor. */
export function getStopExecutionAvailabilityTestOverride(): boolean | null {
  return stopCapabilityTestOverride;
}
