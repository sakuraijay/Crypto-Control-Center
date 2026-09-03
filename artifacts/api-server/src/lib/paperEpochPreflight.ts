import type { OperationalDiagnostics } from './operationalDiagnostics';

export const PAPER_PLANNED_SEED_CAPITAL_USD = 10_000;
export const PAPER_ACTIVE_CAPITAL_STAGES_USD = [1_000, 2_500, 5_000, 10_000] as const;
export const PAPER_EPOCH_PROPOSED_START_USD = 1_000;

export interface PaperEpochPreflightInput {
  observedAtMs: number;
  counts: {
    openPositionCount: number | null;
    pendingApprovalCount: number | null;
    pendingCloseCount: number | null;
    blockingIntentCount: number | null;
    blockingProtectionCount: number | null;
    paperExecutorUnresolvedCount: number | null;
    unresolvedRelayTaskCount: number | null;
    unsettledTradeCount: number | null;
    openRelayTaskCount: number | null;
  };
  current: {
    activeTradingCapitalUsd: number | null;
    equityHwmUsd: number | null;
    dailyRiskBaselineUsd: number | null;
    weeklyRiskBaselineUsd: number | null;
    currentEquityUsd: number | null;
    reserveCashPct: number | null;
    riskOperatingState: string | null;
    riskEntryAllowed: boolean;
  };
  operationalDiagnostics: OperationalDiagnostics;
  gates: {
    readyForControlledCanary: boolean;
    stopExecutionAvailable: boolean;
    hardStopReason: string | null;
  };
}

export interface PaperEpochPreflightView {
  scope: 'PAPER_EPOCH_READINESS_PREFLIGHT';
  boundary: 'READ_ONLY_CALCULATION_NOT_STATE_CHANGE';
  executionAuthorized: false;
  stateChangePerformed: false;
  observedAtMs: number;
  readyForPaperEpochProposal: boolean;
  blockerIds: string[];
  counts: PaperEpochPreflightInput['counts'];
  current: PaperEpochPreflightInput['current'];
  planned: {
    seedCapitalUsd: 10_000;
    activeCapitalStagesUsd: readonly [1_000, 2_500, 5_000, 10_000];
    separation: 'PLANNED_SEED_IS_NOT_ACTIVE_OR_RESERVE_CAPITAL';
  };
  proposedNewEpoch: {
    activeTradingCapitalUsd: 1_000;
    equityHwmUsd: 1_000;
    dailyRiskBaselineUsd: 1_000;
    weeklyRiskBaselineUsd: 1_000;
    applied: false;
    persistenceId: null;
  };
  boundaries: {
    engineMode: 'PAPER' | 'LIVE' | null;
    autoWorkerLiveEnabled: boolean | null;
    liveTestExecutionLocked: boolean | null;
    delegatedSignerEnabled: boolean | null;
    gmxOrderSubmissionEnabled: boolean | null;
    relaySubmissionEnabled: boolean | null;
    relaySubmitNetworkEnabled: boolean | null;
    relayMode: 'DISABLED' | 'DRY_RUN' | 'LIVE' | null;
  };
  preservedExecutionGates: PaperEpochPreflightInput['gates'] & {
    riskOperatingState: string | null;
    riskEntryAllowed: boolean;
    unchanged: true;
  };
  notices: string[];
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

export function buildPaperEpochPreflight(
  input: PaperEpochPreflightInput,
): PaperEpochPreflightView {
  const blockers: string[] = [];
  const countEntries = Object.entries(input.counts) as Array<
    [keyof PaperEpochPreflightInput['counts'], number | null]
  >;
  for (const [key, value] of countEntries) {
    if (value === null || !Number.isInteger(value) || value < 0) {
      blockers.push(`${key.toUpperCase()}_UNAVAILABLE`);
    } else if (value !== 0) {
      blockers.push(`${key.toUpperCase()}_NON_ZERO`);
    }
  }

  const flags = input.operationalDiagnostics.flags;
  const requiredBoundaries = [
    ['ENGINE_MODE_NOT_PAPER', flags.engineMode.effective === 'PAPER' && flags.engineMode.status === 'MATCH'],
    ['AUTO_WORKER_LIVE_NOT_DISABLED', flags.autoWorkerLiveEnabled.effective === false && flags.autoWorkerLiveEnabled.status === 'MATCH'],
    ['RELAY_SUBMISSION_NOT_DISABLED', flags.relaySubmissionEnabled.effective === false && flags.relaySubmissionEnabled.status === 'MATCH'],
    ['RELAY_SUBMIT_NETWORK_NOT_DISABLED', flags.relaySubmitNetworkEnabled.effective === false && flags.relaySubmitNetworkEnabled.status === 'MATCH'],
    ['RELAY_MODE_NOT_DISABLED', flags.relayMode.effective === 'DISABLED' && flags.relayMode.status === 'MATCH'],
  ] as const;
  for (const [id, ok] of requiredBoundaries) {
    if (!ok) blockers.push(id);
  }

  const current = {
    activeTradingCapitalUsd: finiteOrNull(input.current.activeTradingCapitalUsd),
    equityHwmUsd: finiteOrNull(input.current.equityHwmUsd),
    dailyRiskBaselineUsd: finiteOrNull(input.current.dailyRiskBaselineUsd),
    weeklyRiskBaselineUsd: finiteOrNull(input.current.weeklyRiskBaselineUsd),
    currentEquityUsd: finiteOrNull(input.current.currentEquityUsd),
    reserveCashPct: finiteOrNull(input.current.reserveCashPct),
    riskOperatingState: input.current.riskOperatingState,
    riskEntryAllowed: input.current.riskEntryAllowed,
  };
  for (const [key, value] of Object.entries(current)) {
    if (key === 'riskOperatingState' || key === 'riskEntryAllowed') continue;
    if (value === null) blockers.push(`CURRENT_${key.toUpperCase()}_UNAVAILABLE`);
  }
  if (current.riskOperatingState === null) blockers.push('CURRENT_RISK_OPERATING_STATE_UNAVAILABLE');

  return {
    scope: 'PAPER_EPOCH_READINESS_PREFLIGHT',
    boundary: 'READ_ONLY_CALCULATION_NOT_STATE_CHANGE',
    executionAuthorized: false,
    stateChangePerformed: false,
    observedAtMs: input.observedAtMs,
    readyForPaperEpochProposal: blockers.length === 0,
    blockerIds: blockers,
    counts: { ...input.counts },
    current,
    planned: {
      seedCapitalUsd: PAPER_PLANNED_SEED_CAPITAL_USD,
      activeCapitalStagesUsd: [...PAPER_ACTIVE_CAPITAL_STAGES_USD],
      separation: 'PLANNED_SEED_IS_NOT_ACTIVE_OR_RESERVE_CAPITAL',
    },
    proposedNewEpoch: {
      activeTradingCapitalUsd: PAPER_EPOCH_PROPOSED_START_USD,
      equityHwmUsd: PAPER_EPOCH_PROPOSED_START_USD,
      dailyRiskBaselineUsd: PAPER_EPOCH_PROPOSED_START_USD,
      weeklyRiskBaselineUsd: PAPER_EPOCH_PROPOSED_START_USD,
      applied: false,
      persistenceId: null,
    },
    boundaries: {
      engineMode: flags.engineMode.effective,
      autoWorkerLiveEnabled: flags.autoWorkerLiveEnabled.effective,
      liveTestExecutionLocked: flags.liveTestExecutionLocked.effective,
      delegatedSignerEnabled: flags.delegatedSignerEnabled.effective,
      gmxOrderSubmissionEnabled: flags.gmxOrderSubmissionEnabled.effective,
      relaySubmissionEnabled: flags.relaySubmissionEnabled.effective,
      relaySubmitNetworkEnabled: flags.relaySubmitNetworkEnabled.effective,
      relayMode: flags.relayMode.effective,
    },
    preservedExecutionGates: {
      ...input.gates,
      riskOperatingState: current.riskOperatingState,
      riskEntryAllowed: current.riskEntryAllowed,
      unchanged: true,
    },
    notices: [
      '계산 전용 — epoch, DB, HWM, Active Trading Capital, Risk baseline을 변경하지 않습니다.',
      'Planned Seed는 Active Capital 또는 Reserve Capital이 아닙니다.',
      '제안값은 Canary, LIVE, cost, Stop, HARD_STOP gate를 대체하거나 완화하지 않습니다.',
    ],
  };
}