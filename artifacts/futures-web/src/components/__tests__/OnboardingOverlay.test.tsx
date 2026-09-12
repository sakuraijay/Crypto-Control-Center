// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { parseObservedUsdcBalance } from '@/lib/paperTestAllocation';

const PAPER_TEST_PLAN_RESPONSE = {
  paperTestAllocationPlan: {
    totalAllocationUsd: 400,
    reservePercent: 20,
    reserveUsd: 80,
    deployableUsd: 320,
    walletEligibilityMinimumUsdc: 400,
    futureActiveCapitalPolicyCandidate: {
      baseRiskPerTradeUsd: 1,
      maxRiskPerTradeUsd: 2,
      hardStopEquityUsd: 368,
      maxLeverage: 3,
      recommendedMaxMarginPerTradeUsd: 100,
    },
    applied: false,
    executionAuthorized: false,
    autoActivationAllowed: false,
    runtimeDbHwmUnchanged: true,
  },
};

describe('OnboardingOverlay', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('shows the authoritative $400 proposed plan for an eligible connected wallet without activating it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => PAPER_TEST_PLAN_RESPONSE,
    })));
    mocks.wallet.status = 'connected';
    mocks.wallet.address = '0x1234567890abcdef1234567890abcdef12345678';
    mocks.wallet.ethBalance = '0.01';
    mocks.wallet.usdcBalance = '420.25';
    mocks.wallet.chainId = 42161;
    mocks.wallet.isArbitrum = true;

    render(<OnboardingOverlay />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-paper-test-allocation')).toBeTruthy();
    });
    expect(screen.getByText(/\$400 total = \$320 deployable/)).toBeTruthy();
    expect(screen.getByText(/Hard Stop \$368/)).toBeTruthy();
    expect(screen.getByText(/runtime\/DB\/HWM unchanged · 자동 activation\/실행 권한 없음/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/risk\/policy$/));
  });

  it('treats exactly $400.00 as eligible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => PAPER_TEST_PLAN_RESPONSE,
    })));
    mocks.wallet.status = 'connected';
    mocks.wallet.address = '0x1234567890abcdef1234567890abcdef12345678';
    mocks.wallet.ethBalance = '0.01';
    mocks.wallet.usdcBalance = '400.00';
    mocks.wallet.chainId = 42161;
    mocks.wallet.isArbitrum = true;

    render(<OnboardingOverlay />);

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-paper-test-allocation')).toBeTruthy();
    });
  });

  it('does not show the $400 proposed plan when observed wallet USDC is below the threshold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => PAPER_TEST_PLAN_RESPONSE,
    })));
    mocks.wallet.status = 'connected';
    mocks.wallet.address = '0x1234567890abcdef1234567890abcdef12345678';
    mocks.wallet.ethBalance = '0.01';
    mocks.wallet.usdcBalance = '399.99';
    mocks.wallet.chainId = 42161;
    mocks.wallet.isArbitrum = true;

    render(<OnboardingOverlay />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(screen.queryByTestId('onboarding-paper-test-allocation')).toBeNull();
  });

  it.each(['400junk', 'NaN', 'Infinity', '4,00', '400e0'])(
    'fails closed for malformed observed USDC balance %s',
    (value) => {
      expect(parseObservedUsdcBalance(value)).toBeNull();
    },
  );

  it('accepts only valid plain or correctly grouped observed USDC values', () => {
    expect(parseObservedUsdcBalance('400.00')).toBe(400);
    expect(parseObservedUsdcBalance('1,234.56')).toBe(1234.56);
    expect(parseObservedUsdcBalance('399.99')).toBe(399.99);
  });
});