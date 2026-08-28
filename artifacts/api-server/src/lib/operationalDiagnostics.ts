import type { ReleaseIdentity } from './releaseIdentity';

export type DiagnosticStatus = 'MATCH' | 'DRIFT' | 'UNAVAILABLE';

export interface ConfiguredEffectiveDiagnostic<T extends boolean | string> {
  configured: T | null;
  effective: T | null;
  status: DiagnosticStatus;
  driftReason: string | null;
}

export interface OperationalDiagnostics {
  schemaVersion: 1;
  flags: {
    engineMode: ConfiguredEffectiveDiagnostic<'PAPER' | 'LIVE'>;
    autoWorkerLiveEnabled: ConfiguredEffectiveDiagnostic<boolean>;
    liveTestExecutionLocked: ConfiguredEffectiveDiagnostic<boolean>;
    delegatedSignerEnabled: ConfiguredEffectiveDiagnostic<boolean>;
    gmxOrderSubmissionEnabled: ConfiguredEffectiveDiagnostic<boolean>;
    relaySubmissionEnabled: ConfiguredEffectiveDiagnostic<boolean>;
    relaySubmitNetworkEnabled: ConfiguredEffectiveDiagnostic<boolean>;
    relayMode: ConfiguredEffectiveDiagnostic<'DISABLED' | 'DRY_RUN' | 'LIVE'>;
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
  configured: T | null,
  effective: T | null,
  driftReason: string,
): ConfiguredEffectiveDiagnostic<T> {
  if (configured === null || effective === null) {
    return { configured, effective, status: 'UNAVAILABLE', driftReason: 'configured 또는 effective 증거 없음' };
  }
  return configured === effective
    ? { configured, effective, status: 'MATCH', driftReason: null }
    : { configured, effective, status: 'DRIFT', driftReason };
}

export function deriveOperationalDiagnostics(
  env: NodeJS.ProcessEnv,
  runtime: RuntimeObservation,
  identity: ReleaseIdentity | null,
): OperationalDiagnostics {
  const configured = identity?.configuredSafetyFlags;
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
    schemaVersion: 1,
    flags: {
      engineMode: item(
        configured?.engineMode ?? null,
        runtime.engineMode === effectiveMode ? runtime.engineMode : effectiveMode,
        'build configured engine mode와 current process mode 불일치',
      ),
      autoWorkerLiveEnabled: item(
        configured?.autoWorkerLiveEnabled ?? null,
        bool(env.AUTO_WORKER_LIVE_ENABLED),
        'build configured AUTO Worker LIVE와 current process flag 불일치',
      ),
      liveTestExecutionLocked: item(
        configured?.liveTestExecutionLocked ?? null,
        effectiveLock,
        'build configured execution lock과 current runtime lock 불일치',
      ),
      delegatedSignerEnabled: item(
        configured?.delegatedSignerEnabled ?? null,
        effectiveSigner,
        'build configured delegated signer flag와 current process flag 불일치',
      ),
      gmxOrderSubmissionEnabled: item(
        configured?.gmxOrderSubmissionEnabled ?? null,
        effectiveOrderSubmission,
        'build configured GMX submission flag와 current process flag 불일치',
      ),
      relaySubmissionEnabled: item(
        configured?.relaySubmissionEnabled ?? null,
        runtime.relayFlags === null ? null : effectiveRelaySubmission,
        'build configured Relay submission flag와 current process flag 불일치',
      ),
      relaySubmitNetworkEnabled: item(
        configured?.relaySubmitNetworkEnabled ?? null,
        runtime.relayFlags === null ? null : effectiveRelayNetwork,
        'build configured Relay network flag와 current process flag 불일치',
      ),
      relayMode: item(
        configured?.relayMode ?? null,
        runtime.relayFlags === null ? null : effectiveRelayMode,
        'build configured Relay mode와 current process mode 불일치',
      ),
    },
    provenance,
  };
}