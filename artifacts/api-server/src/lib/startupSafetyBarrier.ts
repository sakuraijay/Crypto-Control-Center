export interface StartupSafetyBarrierDependencies {
  loadEmergencyStop: () => Promise<boolean>;
  reconcileOnRestart: () => Promise<boolean>;
  refreshStopCapability: () => Promise<void>;
  shouldRefreshStopCapability: () => boolean;
  shouldAbort: () => boolean;
  startWorker: () => Promise<void>;
  stopWorker: () => void;
}

export type StartupSafetyBarrierResult =
  | { ready: true }
  | { ready: false; error: unknown };

/**
 * Worker startup barrier and boundary.
 *
 * Emergency-stop restoration and restart reconciliation must both complete
 * before the worker is started. A failure at any step is returned as a closed
 * barrier and the worker is never started.
 */
export async function completeStartupSafetyBarrier(
  dependencies: StartupSafetyBarrierDependencies,
): Promise<StartupSafetyBarrierResult> {
  let workerStartEntered = false;
  try {
    if (await dependencies.loadEmergencyStop() !== true) {
      throw new Error('Emergency-stop state could not be restored');
    }
    if (await dependencies.reconcileOnRestart() !== true) {
      throw new Error('Restart reconciliation did not reach a safe completed state');
    }
    if (dependencies.shouldRefreshStopCapability()) {
      await dependencies.refreshStopCapability();
    }
    if (dependencies.shouldAbort()) {
      throw new Error('Shutdown started before Worker startup');
    }
    workerStartEntered = true;
    await dependencies.startWorker();
    if (dependencies.shouldAbort()) {
      throw new Error('Shutdown started during Worker startup');
    }
    return { ready: true };
  } catch (error) {
    if (workerStartEntered) {
      dependencies.stopWorker();
    }
    return { ready: false, error };
  }
}