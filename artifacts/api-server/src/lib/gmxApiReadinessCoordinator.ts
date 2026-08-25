/**
 * GMX API readiness external-read coordinator.
 *
 * Scheduler와 운영자 HTTP refresh가 peer health → BTC/ETH canary evidence →
 * PAPER evidence → Stop capability 순서 전체를 하나의 in-flight promise로
 * 공유한다. 이 coordinator 밖에서 canary evidence를 미리 읽지 않는다.
 *
 * 범위: readiness-origin refresh만 소유한다. startup/periodic execution-safety
 * reconciliation의 Stop 재평가는 기존 fail-closed 실행 안전 경로이며 이
 * coordinator로 재배선하지 않는다.
 */
import {
  createGmxApiTransport,
  type GmxApiTransport,
} from './gmxApiTransport';
import {
  refreshManualCanaryReadonlyEvidence,
  type ManualCanaryReadonlyEvidence,
} from './manualCanaryReadonlyEvidence';
import {
  getPaperRuntimeReadinessSnapshot,
  runPaperRuntimeReadinessCycle,
  setPaperRuntimeReadinessCoordinatorInFlight,
  type PaperRuntimeReadinessView,
} from './paperRuntimeReadiness';
import {
  getStopExecutionCapability,
  type StopExecutionCapabilitySnapshot,
} from './stopExecutionCapabilityState';
import {
  beginPaperStopReadinessEvidenceGeneration,
  getPaperStopReadinessEvidence,
  publishPaperStopReadinessEvidence,
  publishPaperStopReadinessEvidenceUnavailable,
  type PaperStopReadinessEvidence,
} from './paperStopReadinessEvidence';

export interface GmxApiPeerHealth {
  peerHost: string;
  ok: boolean;
  kind?: string;
}

type StopCapability = StopExecutionCapabilitySnapshot;

export interface GmxApiReadinessRefreshResult {
  generation: number;
  readonlyEnabled: boolean;
  peerHealth: GmxApiPeerHealth[] | null;
  canaryEvidence: ManualCanaryReadonlyEvidence;
  paperRuntimeReadiness: PaperRuntimeReadinessView;
  paperStopReadinessEvidence: PaperStopReadinessEvidence;
  stopCapability: StopCapability;
}

export interface CoordinatorDeps {
  env: NodeJS.ProcessEnv;
  createTransport(env: NodeJS.ProcessEnv): GmxApiTransport;
  createPeerTransport(env: NodeJS.ProcessEnv, peer: string): GmxApiTransport;
  refreshCanary(): Promise<ManualCanaryReadonlyEvidence>;
  runPaperCycle(args: {
    forceDeployment: boolean;
    preloadedCanary: ManualCanaryReadonlyEvidence;
  }): Promise<PaperRuntimeReadinessView>;
  getPaperSnapshot(nowMs?: number, env?: NodeJS.ProcessEnv): PaperRuntimeReadinessView;
  refreshStopCapability(): Promise<StopCapability>;
  getStopCapability(): StopCapability;
  setCoordinatorInFlight(value: boolean): void;
}

export interface GmxApiReadinessRefreshOptions {
  transport?: GmxApiTransport;
  peerTransportFactory?: (peer: string) => GmxApiTransport;
  singlePeerOnly?: boolean;
  forceDeployment?: boolean;
  shouldContinue?: () => boolean;
}

const DEFAULT_DEPS: CoordinatorDeps = {
  env: process.env,
  createTransport: (env) => createGmxApiTransport(env),
  createPeerTransport: (env, peer) =>
    createGmxApiTransport(env, { peers: [peer] }),
  refreshCanary: refreshManualCanaryReadonlyEvidence,
  runPaperCycle: ({ forceDeployment, preloadedCanary }) =>
    runPaperRuntimeReadinessCycle({ forceDeployment, preloadedCanary }),
  getPaperSnapshot: getPaperRuntimeReadinessSnapshot,
  refreshStopCapability: async () => {
    const { refreshStopExecutionCapability } =
      await import('../workers/liveTestExecutor');
    await refreshStopExecutionCapability();
    return getStopExecutionCapability();
  },
  getStopCapability: getStopExecutionCapability,
  setCoordinatorInFlight: setPaperRuntimeReadinessCoordinatorInFlight,
};

let injectedDeps: Partial<CoordinatorDeps> | null = null;
let activeRefreshPromise: Promise<GmxApiReadinessRefreshResult> | null = null;
let generation = 0;
let activeGeneration: number | null = null;
let activeJoinCount = 0;

export function __setGmxApiReadinessCoordinatorDepsForTests(
  deps: Partial<CoordinatorDeps> | null,
): void {
  injectedDeps = deps;
}

export function __resetGmxApiReadinessCoordinatorForTests(): void {
  injectedDeps = null;
  activeRefreshPromise = null;
  generation = 0;
  activeGeneration = null;
  activeJoinCount = 0;
  setPaperRuntimeReadinessCoordinatorInFlight(false);
}

export function __getGmxApiReadinessCoordinatorStateForTests(): {
  active: boolean;
  joinCount: number;
} {
  return {
    active: activeRefreshPromise !== null,
    joinCount: activeJoinCount,
  };
}

export function __getGmxApiReadinessCoordinatorGenerationForTests(): number | null {
  return activeGeneration;
}

async function performRefresh(
  options: GmxApiReadinessRefreshOptions,
  deps: CoordinatorDeps,
  currentGeneration: number,
  paperEvidencePublicationToken: number | null,
): Promise<GmxApiReadinessRefreshResult> {
  const transport = options.transport ?? deps.createTransport(deps.env);
  const readonlyEnabled = transport.readonlyEnabled;
  const shouldContinue = options.shouldContinue ?? (() => true);

  let peerHealth: GmxApiPeerHealth[] | null = null;
  let canaryEvidence: ManualCanaryReadonlyEvidence = { decimals: {}, costs: {} };
  let paperRuntimeReadiness = deps.getPaperSnapshot(Date.now(), deps.env);
  let paperStopReadinessEvidence = getPaperStopReadinessEvidence(Date.now(), deps.env);
  let stopCapability = deps.getStopCapability();
  let paperStage: 'peer' | 'canary' | 'paper' = 'peer';
  const snapshot = (): GmxApiReadinessRefreshResult => ({
    generation: currentGeneration,
    readonlyEnabled,
    peerHealth,
    canaryEvidence,
    paperRuntimeReadiness,
    paperStopReadinessEvidence,
    stopCapability,
  });
  const publishUnavailable = (
    failureId: string,
    reason: string,
    failedConditionIds: string[] = [],
  ): void => {
    if (deps.env.WORKER_ENGINE_MODE !== 'PAPER'
      || paperEvidencePublicationToken === null) return;
    paperStopReadinessEvidence = publishPaperStopReadinessEvidenceUnavailable({
      generation: currentGeneration,
      publicationToken: paperEvidencePublicationToken,
      env: deps.env,
      readonlyEnabled,
      peerHealth,
      failureId,
      reason,
      failedConditionIds,
    });
  };
  const cancelledSnapshot = (): GmxApiReadinessRefreshResult => {
    publishUnavailable(
      'PAPER_READINESS_GENERATION_CANCELLED',
      'Current PAPER readiness generation was cancelled (fail-closed).',
    );
    return snapshot();
  };

  try {
    if (!shouldContinue()) return cancelledSnapshot();
    if (readonlyEnabled) {
      peerHealth = [];
      for (const base of transport.peers) {
        if (!shouldContinue()) return cancelledSnapshot();
        const peerTransport = options.peerTransportFactory
          ? options.peerTransportFactory(base)
          : deps.createPeerTransport(deps.env, base);
        const result = await peerTransport.getJson('/markets/tickers');
        if (!shouldContinue()) return cancelledSnapshot();
        peerHealth.push(result.ok
          ? { peerHost: result.peerHost, ok: true }
          : {
            peerHost: new URL(base).host,
            ok: false,
            kind: result.kind,
          });
        if (options.singlePeerOnly) break;
      }
    }

    if (readonlyEnabled) {
      paperStage = 'canary';
      if (!shouldContinue()) return cancelledSnapshot();
      canaryEvidence = await deps.refreshCanary();
      if (!shouldContinue()) return cancelledSnapshot();
    }

    if (readonlyEnabled && deps.env.WORKER_ENGINE_MODE === 'PAPER') {
      paperStage = 'paper';
      if (!shouldContinue()) return cancelledSnapshot();
      paperRuntimeReadiness = await deps.runPaperCycle({
        forceDeployment: options.forceDeployment !== false,
        preloadedCanary: canaryEvidence,
      });
      if (!shouldContinue()) return cancelledSnapshot();
      paperStopReadinessEvidence = publishPaperStopReadinessEvidence({
        generation: currentGeneration,
        publicationToken: paperEvidencePublicationToken!,
        env: deps.env,
        readonlyEnabled,
        peerHealth,
        paperRuntimeReadiness,
      });
    } else if (deps.env.WORKER_ENGINE_MODE === 'PAPER') {
      publishUnavailable(
        'GMX_API_READONLY_REQUIRED',
        'GMX API read-only mode is disabled for the current PAPER generation.',
        ['readonlyEnabled'],
      );
    }

    if (readonlyEnabled && deps.env.WORKER_ENGINE_MODE !== 'PAPER') {
      if (!shouldContinue()) return snapshot();
      stopCapability = await deps.refreshStopCapability();
    }

    return snapshot();
  } catch (error) {
    const failedConditionIds = paperStage === 'peer'
      ? ['healthyPeer']
      : paperStage === 'canary'
        ? ['btcDecimals8', 'ethDecimals18', 'btcCostEvidence', 'ethCostEvidence']
        : ['deploymentVerified'];
    publishUnavailable(
      `PAPER_READINESS_${paperStage.toUpperCase()}_FAILED`,
      `Current PAPER readiness ${paperStage} stage failed (fail-closed).`,
      failedConditionIds,
    );
    throw error;
  }
}

export async function runGmxApiReadinessRefresh(
  options: GmxApiReadinessRefreshOptions = {},
): Promise<GmxApiReadinessRefreshResult> {
  if (activeRefreshPromise) {
    activeJoinCount += 1;
    return activeRefreshPromise;
  }

  const deps: CoordinatorDeps = { ...DEFAULT_DEPS, ...injectedDeps };
  activeJoinCount = 0;
  const currentGeneration = ++generation;
  activeGeneration = currentGeneration;
  const paperEvidencePublicationToken = deps.env.WORKER_ENGINE_MODE === 'PAPER'
    ? beginPaperStopReadinessEvidenceGeneration(currentGeneration)
    : null;
  deps.setCoordinatorInFlight(true);
  // Defer the production work by one microtask so the shared-flight identity is
  // published before even the first peer transport operation can begin.
  const refreshPromise = Promise.resolve().then(() =>
    performRefresh(options, deps, currentGeneration, paperEvidencePublicationToken));
  activeRefreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } catch (error) {
    if (deps.env.WORKER_ENGINE_MODE === 'PAPER'
      && paperEvidencePublicationToken !== null) {
      const currentEvidence = getPaperStopReadinessEvidence(Date.now(), deps.env);
      if (currentEvidence.generation === currentGeneration
        && currentEvidence.evaluatedAtMs === null) {
        publishPaperStopReadinessEvidenceUnavailable({
          generation: currentGeneration,
          publicationToken: paperEvidencePublicationToken,
          env: deps.env,
          readonlyEnabled: deps.env.GMX_API_READONLY_ENABLED === 'true',
          peerHealth: null,
          failureId: 'PAPER_READINESS_COORDINATOR_FAILED',
          reason: 'Current PAPER readiness coordinator generation failed (fail-closed).',
          failedConditionIds: ['healthyPeer'],
        });
      }
    }
    throw error;
  } finally {
    if (activeRefreshPromise === refreshPromise) {
      activeRefreshPromise = null;
      activeGeneration = null;
      activeJoinCount = 0;
      deps.setCoordinatorInFlight(false);
    }
  }
}