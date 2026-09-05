export type ReadinessInput = {
  walletStatus: 'disconnected' | 'connecting' | 'connected' | 'wrong_network' | 'no_provider' | 'error';
  isArbitrum: boolean;
  gmxStatus: 'idle' | 'loading' | 'ok' | 'error' | 'unavailable';
  gmxApiConsistency: 'matched' | 'mismatch' | 'unavailable' | 'rpc-unavailable' | null;
  balancesLoaded: boolean;
  executor: {
    observed: boolean;
    offline: boolean;
    ready: boolean;
    engineMode: 'PAPER' | 'LIVE' | null;
    rpcConfigured: boolean;
    gmxConnected: boolean;
    networkChainId: number | null;
    autoWorkerLiveEnabled: boolean | null;
    relaySubmissionEnabled: boolean | null;
    relaySubmitNetworkEnabled: boolean | null;
    relayMode: string | null;
  };
  dismissedInStorage: boolean;
};

export type ReadinessOutput = {
  isWalletReady: boolean;
  isChainReady: boolean;
  isDataReady: boolean;
  isEngineReady: boolean;
  areBalancesReady: boolean;
  areSafetyDefaultsReady: boolean;
  isFullyReady: boolean;
  shouldShowOnboarding: boolean;
  phase: 'connect_wallet' | 'switch_network' | 'checking' | 'blocked' | 'ready';
};

export function deriveOnboardingReadiness(input: ReadinessInput): ReadinessOutput {
  const isWalletConnected = input.walletStatus === 'connected' || input.walletStatus === 'wrong_network';
  const isWalletReady = input.walletStatus === 'connected';
  const isChainReady = input.isArbitrum;
  const areBalancesReady = isWalletReady && input.balancesLoaded;
  const isDataReady = input.gmxStatus === 'ok'
    && input.gmxApiConsistency === 'matched';
  const isEngineReady = input.executor.observed
    && !input.executor.offline
    && input.executor.ready
    && input.executor.engineMode === 'PAPER'
    && input.executor.rpcConfigured
    && input.executor.gmxConnected
    && input.executor.networkChainId === 42161;
  const areSafetyDefaultsReady = input.executor.observed
    && input.executor.engineMode === 'PAPER'
    && input.executor.autoWorkerLiveEnabled === false
    && input.executor.relaySubmissionEnabled === false
    && input.executor.relaySubmitNetworkEnabled === false
    && input.executor.relayMode === 'DISABLED';

  const isFullyReady = isWalletReady
    && isChainReady
    && areBalancesReady
    && isDataReady
    && isEngineReady
    && areSafetyDefaultsReady;

  const shouldShowOnboarding = !input.dismissedInStorage || !isFullyReady;
  const phase = !isWalletConnected
    ? 'connect_wallet'
    : !isChainReady
      ? 'switch_network'
      : !input.executor.observed || input.gmxStatus === 'idle' || input.gmxStatus === 'loading'
        ? 'checking'
        : isFullyReady
          ? 'ready'
          : 'blocked';

  return {
    isWalletReady,
    isChainReady,
    isDataReady,
    isEngineReady,
    areBalancesReady,
    areSafetyDefaultsReady,
    isFullyReady,
    shouldShowOnboarding,
    phase,
  };
}
