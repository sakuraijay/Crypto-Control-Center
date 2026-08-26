export type PaperRelayEvidenceStatus =
  | 'verified'
  | 'failed'
  | 'not_evaluated';

export interface PaperRelayEvidenceEntry {
  id: string;
  status: PaperRelayEvidenceStatus;
  fresh: boolean;
  observedAtMs: number | null;
  ageMs: number | null;
  failureId: string | null;
}

export interface PaperRelayEvidence {
  scope: 'PAPER_READ_ONLY_RELAY_EVIDENCE';
  boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION';
  executionAuthorized: false;
  evaluatedAtMs: number;
  fresh: true;
  safe: boolean;
  failureIds: string[];
  executionOnly: PaperRelayEvidenceEntry[];
  storedSafety: PaperRelayEvidenceEntry[];
}

export interface BuildPaperRelayEvidenceInput {
  nowMs: number;
  dbOk: boolean;
  blockingIntentCount: number | null;
  openRelayTaskCount: number | null;
  unresolvedTaskCount: number | null;
  activeRevokeInProgress: boolean | null;
  prepareStageCounts: Record<string, number> | null;
  blockingProtectionCount: number | null;
  uncoveredStopCount: number | null;
  legacyZeroFeeCount: number | null;
  unsettledLiveTradeCount: number | null;
  protectionReconciliation: {
    lastRunAtMs: number | null;
    complete: boolean;
    blockNewOpens: boolean;
    ambiguousCount: number;
  };
}

const executionOnlyIds = [
  ['canonicalAuthorization', 'CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER'],
  ['actionBudget', 'ACTION_BUDGET_NOT_EVALUATED_IN_PAPER'],
  ['prepareReconciliation', 'PREPARE_RECONCILIATION_NOT_EVALUATED_IN_PAPER'],
  ['protectionReconciliation', 'PROTECTION_RECONCILIATION_NOT_EVALUATED_IN_PAPER'],
  ['settlementReconciliation', 'SETTLEMENT_RECONCILIATION_NOT_EVALUATED_IN_PAPER'],
] as const;

function executionOnlyEntry(
  id: string,
  failureId: string,
): PaperRelayEvidenceEntry {
  return {
    id,
    status: 'not_evaluated',
    fresh: false,
    observedAtMs: null,
    ageMs: null,
    failureId,
  };
}

function currentSafetyEntry(
  id: string,
  count: number | null,
  readFailureId: string,
  defectFailureId: string,
  nowMs: number,
): PaperRelayEvidenceEntry {
  if (count === null) {
    return {
      id,
      status: 'failed',
      fresh: false,
      observedAtMs: null,
      ageMs: null,
      failureId: readFailureId,
    };
  }
  return {
    id,
    status: count === 0 ? 'verified' : 'failed',
    fresh: true,
    observedAtMs: nowMs,
    ageMs: 0,
    failureId: count === 0 ? null : defectFailureId,
  };
}

function booleanSafetyEntry(
  id: string,
  value: boolean | null,
  readFailureId: string,
  defectFailureId: string,
  nowMs: number,
): PaperRelayEvidenceEntry {
  if (value === null) {
    return {
      id,
      status: 'failed',
      fresh: false,
      observedAtMs: null,
      ageMs: null,
      failureId: readFailureId,
    };
  }
  return {
    id,
    status: value ? 'failed' : 'verified',
    fresh: true,
    observedAtMs: nowMs,
    ageMs: 0,
    failureId: value ? defectFailureId : null,
  };
}

export function buildPaperRelayEvidence(
  input: BuildPaperRelayEvidenceInput,
): PaperRelayEvidence {
  const prepareBlockingCount = input.prepareStageCounts === null
    ? null
    : Object.values(input.prepareStageCounts).reduce((sum, count) => sum + count, 0);

  let protectionStoredEvidence: PaperRelayEvidenceEntry;
  if (input.protectionReconciliation.ambiguousCount > 0) {
    protectionStoredEvidence = {
      id: 'storedProtectionEvidence',
      status: 'failed',
      fresh: input.protectionReconciliation.lastRunAtMs !== null,
      observedAtMs: input.protectionReconciliation.lastRunAtMs,
      ageMs: input.protectionReconciliation.lastRunAtMs === null
        ? null
        : Math.max(0, input.nowMs - input.protectionReconciliation.lastRunAtMs),
      failureId: 'STORED_PROTECTION_EVIDENCE_AMBIGUOUS',
    };
  } else if (input.protectionReconciliation.blockNewOpens) {
    protectionStoredEvidence = {
      id: 'storedProtectionEvidence',
      status: 'failed',
      fresh: input.protectionReconciliation.lastRunAtMs !== null,
      observedAtMs: input.protectionReconciliation.lastRunAtMs,
      ageMs: input.protectionReconciliation.lastRunAtMs === null
        ? null
        : Math.max(0, input.nowMs - input.protectionReconciliation.lastRunAtMs),
      failureId: 'STORED_PROTECTION_EVIDENCE_MISMATCH',
    };
  } else if (
    input.protectionReconciliation.complete
    && input.protectionReconciliation.lastRunAtMs !== null
  ) {
    protectionStoredEvidence = {
      id: 'storedProtectionEvidence',
      status: 'verified',
      fresh: true,
      observedAtMs: input.protectionReconciliation.lastRunAtMs,
      ageMs: Math.max(0, input.nowMs - input.protectionReconciliation.lastRunAtMs),
      failureId: null,
    };
  } else {
    protectionStoredEvidence = executionOnlyEntry(
      'storedProtectionEvidence',
      'STORED_PROTECTION_EVIDENCE_NOT_EVALUATED_IN_PAPER',
    );
  }

  const storedSafety: PaperRelayEvidenceEntry[] = [
    {
      id: 'statusDatabaseReads',
      status: input.dbOk ? 'verified' : 'failed',
      fresh: input.dbOk,
      observedAtMs: input.dbOk ? input.nowMs : null,
      ageMs: input.dbOk ? 0 : null,
      failureId: input.dbOk ? null : 'PAPER_RELAY_STATUS_DB_READ_FAILED',
    },
    currentSafetyEntry(
      'blockingIntents',
      input.blockingIntentCount,
      'BLOCKING_INTENT_READ_FAILED',
      'BLOCKING_INTENT_PRESENT',
      input.nowMs,
    ),
    currentSafetyEntry(
      'openRelayTasks',
      input.openRelayTaskCount,
      'OPEN_RELAY_TASK_READ_FAILED',
      'OPEN_RELAY_TASK_PRESENT',
      input.nowMs,
    ),
    currentSafetyEntry(
      'unresolvedRelayTasks',
      input.unresolvedTaskCount,
      'UNRESOLVED_RELAY_TASK_READ_FAILED',
      'UNRESOLVED_RELAY_TASK_PRESENT',
      input.nowMs,
    ),
    booleanSafetyEntry(
      'activeRevokeSession',
      input.activeRevokeInProgress,
      'ACTIVE_REVOKE_READ_FAILED',
      'ACTIVE_REVOKE_PRESENT',
      input.nowMs,
    ),
    currentSafetyEntry(
      'nonTerminalPrepareTasks',
      prepareBlockingCount,
      'PREPARE_TASK_READ_FAILED',
      'NON_TERMINAL_PREPARE_TASK_PRESENT',
      input.nowMs,
    ),
    currentSafetyEntry(
      'blockingProtectionOrders',
      input.blockingProtectionCount,
      'PROTECTION_ORDER_READ_FAILED',
      'BLOCKING_PROTECTION_ORDER_PRESENT',
      input.nowMs,
    ),
    currentSafetyEntry(
      'uncoveredStopPositions',
      input.uncoveredStopCount,
      'STOP_COVERAGE_READ_FAILED',
      'STOP_UNCOVERED_POSITION_PRESENT',
      input.nowMs,
    ),
    currentSafetyEntry(
      'legacyZeroFeeTrades',
      input.legacyZeroFeeCount,
      'SETTLEMENT_STATUS_READ_FAILED',
      'LEGACY_ZERO_FEE_TRADE_PRESENT',
      input.nowMs,
    ),
    currentSafetyEntry(
      'unsettledLiveTrades',
      input.unsettledLiveTradeCount,
      'SETTLEMENT_STATUS_READ_FAILED',
      'UNSETTLED_LIVE_TRADE_PRESENT',
      input.nowMs,
    ),
    protectionStoredEvidence,
  ];
  const failureIds = storedSafety
    .filter((entry) => entry.status === 'failed' && entry.failureId !== null)
    .map((entry) => entry.failureId as string);

  return {
    scope: 'PAPER_READ_ONLY_RELAY_EVIDENCE',
    boundary: 'READ_ONLY_NOT_EXECUTION_AUTHORIZATION',
    executionAuthorized: false,
    evaluatedAtMs: input.nowMs,
    fresh: true,
    safe: failureIds.length === 0,
    failureIds,
    executionOnly: executionOnlyIds.map(([id, failureId]) =>
      executionOnlyEntry(id, failureId)),
    storedSafety,
  };
}