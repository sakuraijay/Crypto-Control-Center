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

export type StopExecutionCapabilitySnapshot = StopCapabilityResult & {
  evaluatedAt: string | null;
};

const UNEVALUATED_REASON =
  'stop 실행 능력 미평가 — refreshStopExecutionCapability 필요 (fail-closed)';

let stopCapability: StopExecutionCapabilitySnapshot = {
  available: false,
  reasons: [UNEVALUATED_REASON],
  evaluatedAt: null,
};

/** Test-only availability override. null means use the cached derived value. */
let stopCapabilityTestOverride: boolean | null = null;

export function getStopExecutionCapability(): StopExecutionCapabilitySnapshot {
  return stopCapability;
}

export function isStopExecutionAvailable(): boolean {
  return stopCapabilityTestOverride ?? stopCapability.available;
}

/** Store a freshly derived result together with the time at which it was evaluated. */
export function setStopExecutionCapability(
  result: StopCapabilityResult,
  evaluatedAt = new Date().toISOString(),
): StopExecutionCapabilitySnapshot {
  stopCapability = {
    available: result.available,
    reasons: [...result.reasons],
    evaluatedAt,
  };
  return stopCapability;
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
