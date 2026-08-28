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
  signerInitialized: boolean;
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
  const configuredMode = env.WORKER_ENGINE_MODE === 'LIVE' ? 'LIVE' : 'PAPER';
  const configuredLock = env.LIVE_TEST_EXECUTION_LOCKED !== 'false';
  const configuredSigner = bool(env.DELEGATED_SIGNER_ENABLED);
  const configuredOrderSubmission = bool(env.GMX_API_ORDER_SUBMISSION_ENABLED);
  const relaySubmission = bool(env.GMX_RELAY_SUBMISSION_ENABLED);
  const relayNetwork = bool(env.GMX_RELAY_NETWORK_ENABLED);
  const modeRaw = env.GMX_RELAY_MODE;
  const configuredRelayMode = modeRaw === 'LIVE' || modeRaw === 'DRY_RUN' ? modeRaw : 'DISABLED';

  const effectiveOrderSubmission = configuredOrderSubmission
    && !runtime.liveExecutionLocked
    && runtime.signerInitialized;
  const effectiveRelaySubmission = runtime.relayFlags === null ? null
    : runtime.relayFlags.relaySubmissionEnabled
      && runtime.relayFlags.relaySubmitNetworkEnabled
      && runtime.relayFlags.relayMode === 'LIVE'
      && runtime.signerInitialized;

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
      engineMode: item(configuredMode, runtime.engineMode, 'configured engine mode와 runtime mode 불일치'),
      autoWorkerLiveEnabled: item(
        bool(env.AUTO_WORKER_LIVE_ENABLED),
        bool(env.AUTO_WORKER_LIVE_ENABLED),
        'AUTO Worker LIVE configured/effective 불일치',
      ),
      liveTestExecutionLocked: item(
        configuredLock,
        runtime.liveExecutionLocked,
        'configured execution lock과 runtime lock 불일치',
      ),
      delegatedSignerEnabled: item(
        configuredSigner,
        configuredSigner && runtime.signerInitialized,
        configuredSigner
          ? 'delegated signer는 enabled지만 runtime signer가 미초기화'
          : 'delegated signer runtime 상태가 configured disabled와 불일치',
      ),
      gmxOrderSubmissionEnabled: item(
        configuredOrderSubmission,
        effectiveOrderSubmission,
        configuredOrderSubmission
          ? 'order submission configured지만 execution lock 또는 signer 초기화 조건 미충족'
          : 'order submission runtime 상태가 configured disabled와 불일치',
      ),
      relaySubmissionEnabled: item(
        relaySubmission,
        effectiveRelaySubmission,
        relaySubmission
          ? 'Relay submission configured지만 mode/network/signer 조건 미충족'
          : 'Relay submission runtime 상태가 configured disabled와 불일치',
      ),
      relaySubmitNetworkEnabled: item(
        relayNetwork,
        runtime.relayFlags?.relaySubmitNetworkEnabled ?? null,
        'Relay submit network configured/effective 불일치',
      ),
      relayMode: item(
        configuredRelayMode,
        runtime.relayFlags?.relayMode ?? null,
        'Relay mode configured/effective 불일치',
      ),
    },
    provenance,
  };
}