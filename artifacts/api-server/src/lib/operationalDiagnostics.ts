import type { ReleaseIdentity } from './releaseIdentity';

export type DiagnosticStatus = 'MATCH' | 'DRIFT' | 'UNAVAILABLE';

export interface ConfiguredEffectiveDiagnostic<T extends boolean | string> {
  configured: T | null;
  effective: T | null;
  status: DiagnosticStatus;
  driftReason: string | null;
}

export interface SafetyFlagDiagnostic<T extends boolean | string>
  extends ConfiguredEffectiveDiagnostic<T> {
  buildObserved: T | null;
  approvedTarget: T;
  buildObservationStatus: DiagnosticStatus;
  buildObservationReason: string | null;
}

export interface OperationalDiagnostics {
  schemaVersion: 2;
  flags: {
    engineMode: SafetyFlagDiagnostic<'PAPER' | 'LIVE'>;
    autoWorkerLiveEnabled: SafetyFlagDiagnostic<boolean>;
    liveTestExecutionLocked: SafetyFlagDiagnostic<boolean>;
    delegatedSignerEnabled: SafetyFlagDiagnostic<boolean>;
    gmxOrderSubmissionEnabled: SafetyFlagDiagnostic<boolean>;
    relaySubmissionEnabled: SafetyFlagDiagnostic<boolean>;
    relaySubmitNetworkEnabled: SafetyFlagDiagnostic<boolean>;
    relayMode: SafetyFlagDiagnostic<'DISABLED' | 'DRY_RUN' | 'LIVE'>;
  };
  provenance: {
    status: DiagnosticStatus;
    driftReason: string | null;
    workspaceSourceAvailable: boolean;
    releaseSourceAvailable: boolean;
    sameCommit: boolean | null;
    sameProductTree: boolean | null;
  };
}

export const APPROVED_PRODUCTION_SAFETY_TARGET = {
  engineMode: 'PAPER',
  autoWorkerLiveEnabled: false,
  liveTestExecutionLocked: false,
  delegatedSignerEnabled: true,
  gmxOrderSubmissionEnabled: true,
  relaySubmissionEnabled: false,
  relaySubmitNetworkEnabled: false,
  relayMode: 'DISABLED',
} as const;

interface RuntimeObservation {
  engineMode: 'PAPER' | 'LIVE';
  liveExecutionLocked: boolean;
  relayFlags: {
    relaySubmitNetworkEnabled: boolean;
    relaySubmissionEnabled: boolean;
    relayMode: 'DISABLED' | 'DRY_RUN' | 'LIVE';
  } | null;
}

function bool(raw: string | undefined, defaultValue = false): boolean {
  return raw === undefined ? defaultValue : raw === 'true';
}

function item<T extends boolean | string>(
  buildObserved: T | null,
  approvedTarget: T,
  effective: T | null,
  driftReason: string,
): SafetyFlagDiagnostic<T> {
  const runtimeComparison = effective === null
    ? { status: 'UNAVAILABLE' as const, driftReason: 'approved target 또는 effective runtime 증거 없음' }
    : approvedTarget === effective
      ? { status: 'MATCH' as const, driftReason: null }
      : { status: 'DRIFT' as const, driftReason };
  const buildComparison = buildObserved === null
    ? {
        buildObservationStatus: 'UNAVAILABLE' as const,
        buildObservationReason: 'build-time 관측 증거 없음',
      }
    : buildObserved === approvedTarget
      ? { buildObservationStatus: 'MATCH' as const, buildObservationReason: null }
      : {
          buildObservationStatus: 'DRIFT' as const,
          buildObservationReason: 'build-time 관측값과 승인된 Production 목표가 다름',
        };
  return {
    configured: buildObserved,
    buildObserved,
    approvedTarget,
    effective,
    ...runtimeComparison,
    ...buildComparison,
  };
}

export function deriveOperationalDiagnostics(
  env: NodeJS.ProcessEnv,
  runtime: RuntimeObservation,
  identity: ReleaseIdentity | null,
): OperationalDiagnostics {
  const buildObserved = identity?.configuredSafetyFlags;
  const approved = APPROVED_PRODUCTION_SAFETY_TARGET;
  const effectiveMode = env.WORKER_ENGINE_MODE === 'LIVE' ? 'LIVE' : 'PAPER';
  const effectiveLock = runtime.liveExecutionLocked;
  const effectiveSigner = bool(env.DELEGATED_SIGNER_ENABLED);
  const effectiveOrderSubmission = bool(env.GMX_API_ORDER_SUBMISSION_ENABLED);
  const effectiveRelaySubmission = bool(env.GMX_RELAY_SUBMISSION_ENABLED);
  const effectiveRelayNetwork = bool(env.GMX_RELAY_NETWORK_ENABLED);
  const modeRaw = env.GMX_RELAY_MODE;
  const effectiveRelayMode = modeRaw === 'LIVE' || modeRaw === 'DRY_RUN' ? modeRaw : 'DISABLED';

  const workspace = identity?.workspaceSource;
  const releaseAvailable = identity !== null;
  const workspaceAvailable = workspace !== undefined;
  const sameCommit = workspace ? workspace.headSha === identity?.releaseSha : null;
  const sameProductTree = workspace ? workspace.productTree === identity?.productTree : null;
  const provenance = !releaseAvailable || !workspaceAvailable
    ? {
        status: 'UNAVAILABLE' as const,
        driftReason: 'workspace 또는 release source 증거 없음',
        workspaceSourceAvailable: workspaceAvailable,
        releaseSourceAvailable: releaseAvailable,
        sameCommit,
        sameProductTree,
      }
    : sameProductTree
      ? {
          status: 'MATCH' as const,
          driftReason: null,
          workspaceSourceAvailable: true,
          releaseSourceAvailable: true,
          sameCommit,
          sameProductTree,
        }
      : {
          status: 'DRIFT' as const,
          driftReason: 'build workspace product tree와 배포 release product tree 불일치',
          workspaceSourceAvailable: true,
          releaseSourceAvailable: true,
          sameCommit,
          sameProductTree,
        };

  return {
    schemaVersion: 2,
    flags: {
      engineMode: item(
        buildObserved?.engineMode ?? null,
        approved.engineMode,
        runtime.engineMode === effectiveMode ? runtime.engineMode : effectiveMode,
        '승인된 Production engine mode와 current process mode 불일치',
      ),
      autoWorkerLiveEnabled: item(
        buildObserved?.autoWorkerLiveEnabled ?? null,
        approved.autoWorkerLiveEnabled,
        bool(env.AUTO_WORKER_LIVE_ENABLED),
        '승인된 Production AUTO Worker LIVE와 current process flag 불일치',
      ),
      liveTestExecutionLocked: item(
        buildObserved?.liveTestExecutionLocked ?? null,
        approved.liveTestExecutionLocked,
        effectiveLock,
        '승인된 Production execution lock과 current runtime lock 불일치',
      ),
      delegatedSignerEnabled: item(
        buildObserved?.delegatedSignerEnabled ?? null,
        approved.delegatedSignerEnabled,
        effectiveSigner,
        '승인된 Production delegated signer flag와 current process flag 불일치',
      ),
      gmxOrderSubmissionEnabled: item(
        buildObserved?.gmxOrderSubmissionEnabled ?? null,
        approved.gmxOrderSubmissionEnabled,
        effectiveOrderSubmission,
        '승인된 Production GMX submission flag와 current process flag 불일치',
      ),
      relaySubmissionEnabled: item(
        buildObserved?.relaySubmissionEnabled ?? null,
        approved.relaySubmissionEnabled,
        runtime.relayFlags === null ? null : effectiveRelaySubmission,
        '승인된 Production Relay submission flag와 current process flag 불일치',
      ),
      relaySubmitNetworkEnabled: item(
        buildObserved?.relaySubmitNetworkEnabled ?? null,
        approved.relaySubmitNetworkEnabled,
        runtime.relayFlags === null ? null : effectiveRelayNetwork,
        '승인된 Production Relay network flag와 current process flag 불일치',
      ),
      relayMode: item(
        buildObserved?.relayMode ?? null,
        approved.relayMode,
        runtime.relayFlags === null ? null : effectiveRelayMode,
        '승인된 Production Relay mode와 current process mode 불일치',
      ),
    },
    provenance,
  };
}