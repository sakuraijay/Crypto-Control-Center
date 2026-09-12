import {
  getExecutionEligibleCostEvidence,
  recordExecutionEligibleCostEvidence,
  type CostSnapshot,
  type CostSnapshotExpectation,
} from './costSnapshot';
import type { StopCapabilityResult } from './stopExecutionCapability';

export interface ManualCanaryExecutionEvidenceGate {
  refreshStopCapability(): Promise<StopCapabilityResult>;
  isStopCapabilityAvailable(): boolean;
}

/**
 * Execution-only activation of the shared cost evidence and cached stop gate.
 * The caller must already own the durable daily launch reservation.
 */
export async function activateManualCanaryExecutionEvidence(
  snapshot: CostSnapshot,
  expected: CostSnapshotExpectation,
  nowMs: number,
  gate: ManualCanaryExecutionEvidenceGate,
): Promise<boolean> {
  if (!recordExecutionEligibleCostEvidence(snapshot, expected, nowMs)) return false;

  const refreshed = await gate.refreshStopCapability();
  const readback = getExecutionEligibleCostEvidence(nowMs);
  const matchingEvidence = readback.fresh
    && readback.evidence !== null
    && readback.evidence.market.toLowerCase() === expected.market.toLowerCase()
    && readback.evidence.isLong === expected.isLong;

  return refreshed.available
    && gate.isStopCapabilityAvailable()
    && matchingEvidence;
}