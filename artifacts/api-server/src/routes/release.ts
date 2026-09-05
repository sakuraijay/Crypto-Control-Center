import { Router } from 'express';
import { deriveRelayEnvFlags } from '../lib/relayActivationStatus';
import { validateEnvAgainstManifest } from '../lib/gmxDeploymentManifest';
import { getActiveRevokeSession } from '../lib/revokeSession';
import { getReleaseIdentity } from '../lib/releaseIdentity';
import { readRuntimeDbSafetyEvidence } from '../lib/runtimeSafetyEvidence';
import { getStopExecutionCapability } from '../lib/stopExecutionCapabilityState';
import { getExecutorStatus } from '../workers/internalExecutor';
import { deriveOperationalDiagnostics } from '../lib/operationalDiagnostics';

const router = Router();

router.get('/release/identity', (_req, res) => {
  const identity = getReleaseIdentity();
  if (!identity) {
    return res.status(503).json({ ok: false, error: 'Release identity unavailable' });
  }
  return res.json({ ok: true, identity });
});

router.get('/release/safety', async (_req, res) => {
  const identity = getReleaseIdentity();
  if (!identity) {
    return res.status(503).json({ ok: false, error: 'Release identity unavailable' });
  }
  const executor = getExecutorStatus();
  let relayFlags: ReturnType<typeof deriveRelayEnvFlags> | null = null;
  let activeRevoke: boolean | null = null;
  try {
    relayFlags = deriveRelayEnvFlags(process.env, validateEnvAgainstManifest(process.env).ok);
  } catch {
    relayFlags = null;
  }
  try {
    activeRevoke = (await getActiveRevokeSession()) !== null;
  } catch {
    activeRevoke = null;
  }
  const database = await readRuntimeDbSafetyEvidence();
  const operationalDiagnostics = deriveOperationalDiagnostics(process.env, {
    engineMode: executor.engineMode,
    liveExecutionLocked: executor.liveExecutionLocked,
    relayFlags,
  }, identity);
  return res.json({
    ok: true,
    identity,
    runtime: {
      listeningPort: Number(process.env.PORT ?? 0) || null,
      ready: executor.ready,
      engineMode: executor.engineMode,
      liveExecutionLocked: executor.liveExecutionLocked,
      liveTestMode: executor.liveTestMode,
      startedAt: executor.startedAt,
      uptimeSeconds: executor.uptimeSeconds,
      workerRunning: executor.workerRunning,
      cycleCount: executor.cycleCount,
      schedulerHeartbeatAt: executor.schedulerHeartbeatAt,
      lastDecisionAt: executor.lastDecisionAt,
      lastCycleAt: executor.lastCycleAt,
      lastCycleNumber: executor.lastCycleResult?.cycleNumber ?? null,
      lastCycleAnalysisCount: executor.lastCycleResult?.analysesCount ?? null,
      lastCycleOutcome: executor.lastSchedulerCycleOutcome,
      lastCycleHasError: executor.lastSchedulerCycleOutcome === null
        ? null
        : executor.lastSchedulerCycleOutcome === 'ERROR',
      gmxConnected: executor.gmxConnected,
      networkChainId: executor.networkChainId,
      rpcConfigured: executor.rpcConfigured,
      paperRuntime: executor.serverPaperExec ? {
        openPositionCount: executor.serverPaperExec.openPositions.length,
        pendingClosePresent: executor.serverPaperExec.pendingClose !== null,
        unresolvedPresent: executor.serverPaperExec.unresolved !== null,
        lastTickAt: executor.serverPaperExec.lastTickAt,
        lastTickStale: executor.serverPaperExec.lastTickStale,
      } : null,
      settlement: executor.settlementReconcile ? {
        ok: executor.settlementReconcile.ok,
        unsettledCount: executor.settlementReconcile.unsettledCount,
        incomplete: executor.settlementReconcile.incomplete,
      } : null,
      activeRevoke,
      relayFlags,
      stopExecution: {
        available: getStopExecutionCapability().available,
        evaluatedAt: getStopExecutionCapability().evaluatedAt,
      },
    },
    database,
    operationalDiagnostics,
  });
});

export default router;