// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const accountState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('@/lib/context/GmxAccountContext', () => ({
  useGmxAccount: () => accountState.current,
}));

import { GmxOnchainCard } from '../dashboard/GmxOnchainCard';

const nearPosition = {
  id: 'btc-long',
  symbol: 'BTC',
  direction: 'LONG',
  sizeUsd: 1_000,
  collateralUsd: 250,
  realisedPnlUsd: 0,
  market: '0xmarket',
  openedAt: null,
  leverage: 4,
  liquidationPrice: 95,
  unrealizedPnlUsd: null,
  markPriceUsd: 100,
  nearLiquidation: true,
};

function setAccount(overrides: Record<string, unknown> = {}) {
  accountState.current = {
    positions: [nearPosition],
    status: 'ok',
    error: null,
    lastSuccessUpdated: new Date(),
    lastUpdated: new Date(),
    lastFetchMs: 12,
    ethBalance: '0.1',
    usdcBalance: '100',
    apiConsistency: 'matched',
    refresh: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('GmxOnchainCard risk visibility', () => {
  it('shows the summary and urgent in-app warning for fresh authoritative evidence', () => {
    setAccount();
    render(<GmxOnchainCard />);

    expect(screen.getByTestId('gmx-risk-summary').getAttribute('data-risk-state')).toBe('available');
    expect(screen.getByTestId('gmx-risk-exposure').textContent).toBe('$1,000');
    expect(screen.getByTestId('gmx-risk-leverage').textContent).toBe('4.0×');
    expect(screen.getByTestId('gmx-risk-liquidation').textContent).toBe('5.0%');
    expect(screen.getByText('청산가 위험 근접 경고')).toBeTruthy();
  });

  it('hides retained-cache risk values and warning after a failed refresh', () => {
    setAccount({ error: 'latest RPC refresh failed' });
    render(<GmxOnchainCard />);

    expect(screen.getByTestId('gmx-risk-summary').getAttribute('data-risk-state')).toBe('unavailable');
    expect(screen.getByTestId('gmx-risk-exposure').textContent).toBe('Unavailable');
    expect(screen.getByTestId('gmx-risk-leverage').textContent).toBe('Unavailable');
    expect(screen.getByTestId('gmx-risk-liquidation').textContent).toBe('Unavailable');
    expect(screen.queryByText('청산가 위험 근접 경고')).toBeNull();
  });

  it('shows an explicit empty state instead of optimistic zero risk', () => {
    setAccount({ positions: [] });
    render(<GmxOnchainCard />);

    expect(screen.getByTestId('gmx-risk-summary').getAttribute('data-risk-state')).toBe('empty');
    expect(screen.getByTestId('gmx-risk-exposure').textContent).toBe('N/A');
    expect(screen.getAllByText('열린 포지션 없음').length).toBeGreaterThan(0);
  });
});