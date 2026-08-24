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
  refreshStopExecutionCapability,
} from '../workers/liveTestExecutor';

export interface GmxApiPeerHealth {
  peerHost: string;
  ok: boolean;
  kind?: string;
}

type StopCapability = Awaited<ReturnType<typeof refreshStopExecutionCapability>>;

export interface GmxApiReadinessRefreshResult {
  generation: number;
  readonlyEnabled: boolean;
  peerHealth: GmxApiPeerHealth[] | null;
  canaryEvidence: ManualCanaryReadonlyEvidence;
  paperRuntimeReadiness: PaperRuntimeReadinessView;
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
  refreshStopCapability: refreshStopExecutionCapability,
  getStopCapability: getStopExecutionCapability,
  setCoordinatorInFlight: setPaperRuntimeReadinessCoordinatorInFlight,
};

let injectedDeps: Partial<CoordinatorDeps> | null = null;
let activeRefreshPromise: Promise<GmxApiReadinessRefreshResult> | null = null;
let generation = 0;
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

async function performRefresh(
  options: GmxApiReadinessRefreshOptions,
  deps: CoordinatorDeps,
): Promise<GmxApiReadinessRefreshResult> {
  const currentGeneration = ++generation;
  const transport = options.transport ?? deps.createTransport(deps.env);
  const readonlyEnabled = transport.readonlyEnabled;

  let peerHealth: GmxApiPeerHealth[] | null = null;
  if (readonlyEnabled) {
    peerHealth = [];
    for (const base of transport.peers) {
      const peerTransport = options.peerTransportFactory
        ? options.peerTransportFactory(base)
        : deps.createPeerTransport(deps.env, base);
      const result = await peerTransport.getJson('/markets/tickers');
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

  const canaryEvidence: ManualCanaryReadonlyEvidence = readonlyEnabled
    ? await deps.refreshCanary()
    : { decimals: {}, costs: {} };

  const paperRuntimeReadiness =
    readonlyEnabled && deps.env.WORKER_ENGINE_MODE === 'PAPER'
      ? await deps.runPaperCycle({
        forceDeployment: options.forceDeployment !== false,
        preloadedCanary: canaryEvidence,
      })
      : deps.getPaperSnapshot(Date.now(), deps.env);

  const stopCapability = readonlyEnabled
    ? await deps.refreshStopCapability()
    : deps.getStopCapability();

  return {
    generation: currentGeneration,
    readonlyEnabled,
    peerHealth,
    canaryEvidence,
    paperRuntimeReadiness,
    stopCapability,
  };
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
  deps.setCoordinatorInFlight(true);
  const refreshPromise = performRefresh(options, deps);
  activeRefreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (activeRefreshPromise === refreshPromise) {
      activeRefreshPromise = null;
      deps.setCoordinatorInFlight(false);
    }
  }
}