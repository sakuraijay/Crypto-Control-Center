import { describe, it, expect } from 'vitest';
import { deriveOnboardingReadiness } from '../../lib/onboardingReadiness';

describe('onboardingReadiness', () => {
  const readyExecutor = {
    observed: true,
    offline: false,
    ready: true,
    engineMode: 'PAPER' as const,
    rpcConfigured: true,
    gmxConnected: true,
    networkChainId: 42161,
    autoWorkerLiveEnabled: false,
    relaySubmissionEnabled: false,
    relaySubmitNetworkEnabled: false,
    relayMode: 'DISABLED',
  };

  it('shows onboarding when disconnected, ignoring dismissed flag', () => {
    const state = deriveOnboardingReadiness({
      walletStatus: 'disconnected',
      isArbitrum: false,
      gmxStatus: 'idle',
      gmxApiConsistency: null,
      balancesLoaded: false,
      executor: readyExecutor,
      dismissedInStorage: true,
    });
    expect(state.shouldShowOnboarding).toBe(true);
    expect(state.isFullyReady).toBe(false);
  });

  it('shows onboarding when not dismissed, even if fully ready', () => {
    const state = deriveOnboardingReadiness({
      walletStatus: 'connected',
      isArbitrum: true,
      gmxStatus: 'ok',
      gmxApiConsistency: 'matched',
      balancesLoaded: true,
      executor: readyExecutor,
      dismissedInStorage: false,
    });
    expect(state.shouldShowOnboarding).toBe(true);
    expect(state.isFullyReady).toBe(true);
  });

  it('hides onboarding when fully ready and dismissed', () => {
    const state = deriveOnboardingReadiness({
      walletStatus: 'connected',
      isArbitrum: true,
      gmxStatus: 'ok',
      gmxApiConsistency: 'matched',
      balancesLoaded: true,
      executor: readyExecutor,
      dismissedInStorage: true,
    });
    expect(state.shouldShowOnboarding).toBe(false);
    expect(state.isFullyReady).toBe(true);
  });

  it('does not let a stale acknowledgement manufacture readiness', () => {
    const state = deriveOnboardingReadiness({
      walletStatus: 'connected',
      isArbitrum: true,
      gmxStatus: 'unavailable',
      gmxApiConsistency: 'rpc-unavailable',
      balancesLoaded: true,
      executor: { ...readyExecutor, observed: false },
      dismissedInStorage: true,
    });

    expect(state.shouldShowOnboarding).toBe(true);
    expect(state.phase).toBe('checking');
    expect(state.isFullyReady).toBe(false);
    expect(state.isDataReady).toBe(false);
    expect(state.isEngineReady).toBe(false);
  });

  it('blocks readiness if a required safety flag is not fail-closed', () => {
    const state = deriveOnboardingReadiness({
      walletStatus: 'connected',
      isArbitrum: true,
      gmxStatus: 'ok',
      gmxApiConsistency: 'matched',
      balancesLoaded: true,
      executor: { ...readyExecutor, autoWorkerLiveEnabled: true },
      dismissedInStorage: false,
    });

    expect(state.phase).toBe('blocked');
    expect(state.areSafetyDefaultsReady).toBe(false);
    expect(state.isFullyReady).toBe(false);
  });

  it('withdraws Ready on the first failed executor poll', () => {
    const state = deriveOnboardingReadiness({
      walletStatus: 'connected',
      isArbitrum: true,
      gmxStatus: 'ok',
      gmxApiConsistency: 'matched',
      balancesLoaded: true,
      executor: { ...readyExecutor, offline: true },
      dismissedInStorage: true,
    });

    expect(state.shouldShowOnboarding).toBe(true);
    expect(state.phase).toBe('blocked');
    expect(state.isEngineReady).toBe(false);
    expect(state.isFullyReady).toBe(false);
  });
});
