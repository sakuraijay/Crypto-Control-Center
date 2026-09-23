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

/** OPEN 제출에 허용되는 process-local Stop capability 증거의 최대 수명. */
export const STOP_EXECUTION_CAPABILITY_MAX_AGE_MS = 30_000;

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

/** Store a freshly derived result together with the time at which it was evaluated. */
export function setStopExecutionCapability(
  result: StopCapabilityResult,
  evaluatedAt: string | null = new Date().toISOString(),
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
