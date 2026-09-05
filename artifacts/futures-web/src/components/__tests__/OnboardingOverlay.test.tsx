// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticated: true,
  wallet: {
    status: 'disconnected',
    address: null as string | null,
    ethBalance: null as string | null,
    usdcBalance: null as string | null,
    chainId: null as number | null,
    isArbitrum: false,
    error: null as string | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    refreshBalances: vi.fn(),
    refreshChainStatus: vi.fn(),
  },
  gmx: {
    positions: [] as unknown[],
    status: 'ok',
    apiConsistency: 'matched',
  },
  executor: {
    isOffline: false,
    isStale: false,
    consecutiveFailures: 0,
    lastSuccessAt: new Date('2026-09-05T00:00:00Z') as Date | null,
    activeRevoke: false,
    snapshot: {
      ready: true,
      engineMode: 'PAPER',
      gmxConnected: true,
      rpcConfigured: true,
      networkChainId: 42161,
      operationalDiagnostics: {
        flags: {
          autoWorkerLiveEnabled: { effective: false, status: 'MATCH' },
          relaySubmissionEnabled: { effective: false, status: 'MATCH' },
          relaySubmitNetworkEnabled: { effective: false, status: 'MATCH' },
          relayMode: { effective: 'DISABLED', status: 'MATCH' },
        },
      },
    },
  },
}));

vi.mock('@/lib/context/AuthContext', () => ({
  useAuthContext: () => ({ isAuthenticated: mocks.authenticated }),
}));
vi.mock('@/lib/context/WalletContext', () => ({
  useWallet: () => mocks.wallet,
}));
vi.mock('@/lib/context/GmxAccountContext', () => ({
  useGmxAccount: () => mocks.gmx,
}));
vi.mock('@/hooks/useExecutorHealth', () => ({
  useExecutorOnlineStatus: () => mocks.executor,
}));
vi.mock('@/lib/context/StrategyContext', () => ({
  useStrategyContext: () => ({
    limits: {
      tradingCapital: 1_000,
      reserveCashPct: 20,
      maxLeverage: 3,
      maxSimultaneousPositions: 1,
    },
    indicators: [{ id: 'ema', enabled: true }, { id: 'rsi', enabled: true }],
  }),
}));

import { OnboardingOverlay } from '@/components/onboarding/OnboardingOverlay';

describe('OnboardingOverlay', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.authenticated = true;
    mocks.wallet.status = 'disconnected';
    mocks.wallet.address = null;
    mocks.wallet.ethBalance = null;
    mocks.wallet.usdcBalance = null;
    mocks.wallet.chainId = null;
    mocks.wallet.isArbitrum = false;
    mocks.wallet.connect.mockClear();
  });

  it('shows only the explicit wallet connection action before setup', () => {
    render(<OnboardingOverlay />);

    fireEvent.click(screen.getByTestId('button-connect-wallet'));

    expect(mocks.wallet.connect).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('button-enter-paper')).toBeNull();
    expect(screen.getByText(/서명, 승인, 주문, 자금 이동은 요청하지 않습니다/)).toBeTruthy();
  });

  it('hides the onboarding behind the PIN gate', () => {
    mocks.authenticated = false;
    const { container } = render(<OnboardingOverlay />);

    expect(container.innerHTML).toBe('');
  });

  it('enters PAPER only after authoritative readiness and binds acknowledgement to the wallet', () => {
    mocks.wallet.status = 'connected';
    mocks.wallet.address = '0x1234567890abcdef1234567890abcdef12345678';
    mocks.wallet.ethBalance = '0.01';
    mocks.wallet.usdcBalance = '100.00';
    mocks.wallet.chainId = 42161;
    mocks.wallet.isArbitrum = true;

    const { container } = render(<OnboardingOverlay />);
    fireEvent.click(screen.getByTestId('button-enter-paper'));

    expect(localStorage.getItem('ccc_zero_config_onboarding_v1'))
      .toBe(mocks.wallet.address.toLowerCase());
    expect(container.innerHTML).toBe('');
  });
});