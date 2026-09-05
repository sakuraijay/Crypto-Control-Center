import { renderToStaticMarkup } from 'react-dom/server';
import { Router as WouterRouter } from 'wouter';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ authenticated: false }));

vi.mock('@/components/auth/AuthOverlay', () => ({
  AuthOverlay: () => authState.authenticated
    ? null
    : <div data-route-test="pin-gate">Set Master PIN</div>,
}));

vi.mock('@/components/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/shell', () => ({
  Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/components/trading/RiskAlertMonitor', () => ({
  RiskAlertMonitor: () => null,
}));

vi.mock('@/lib/context', () => ({
  GlobalProviders: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAppContext: () => ({
    engineState: 'PAPER',
    resetFromEmergency: vi.fn(),
  }),
}));

vi.mock('@/pages/dashboard', () => ({
  default: () => <div data-route-test="dashboard">Dashboard route</div>,
}));
vi.mock('@/pages/positions', () => ({ default: () => <div>Positions route</div> }));
vi.mock('@/pages/watchlist', () => ({ default: () => <div>Watchlist route</div> }));
vi.mock('@/pages/strategy', () => ({ default: () => <div>Strategy route</div> }));
vi.mock('@/pages/history', () => ({ default: () => <div>History route</div> }));
vi.mock('@/pages/settings', () => ({ default: () => <div>Settings route</div> }));
vi.mock('@/pages/backtest', () => ({ default: () => <div>Backtest route</div> }));
vi.mock('@/pages/ai-log', () => ({ default: () => <div>AI log route</div> }));
vi.mock('@/pages/not-found', () => ({
  default: () => <div data-route-test="not-found">404 Page Not Found</div>,
}));

vi.mock('@/components/onboarding/OnboardingOverlay', () => ({
  OnboardingOverlay: () => null,
}));

import { APP_ROUTER_BASE, AppContent } from '@/App';

const PUBLISHED_ROUTER_BASE = '/futures-web';

function renderPath(path: string): string {
  return renderToStaticMarkup(
    <WouterRouter base={PUBLISHED_ROUTER_BASE} ssrPath={path}>
      <AppContent />
    </WouterRouter>,
  );
}

describe('published futures-web routing behind the Master PIN gate', () => {
  beforeEach(() => {
    authState.authenticated = false;
  });

  it('binds the production router to the published /futures-web path', () => {
    expect(APP_ROUTER_BASE).toBe(PUBLISHED_ROUTER_BASE);
  });

  it('mounts Dashboard at /futures-web/ while the PIN gate is visible', () => {
    const html = renderPath('/futures-web/');

    expect(html).toContain('Set Master PIN');
    expect(html).toContain('Dashboard route');
    expect(html).not.toContain('404 Page Not Found');
  });

  it('also mounts Dashboard when the published path has no trailing slash', () => {
    const html = renderPath('/futures-web');

    expect(html).toContain('Set Master PIN');
    expect(html).toContain('Dashboard route');
    expect(html).not.toContain('404 Page Not Found');
  });

  it('keeps Dashboard selected after the PIN gate is unlocked', () => {
    authState.authenticated = true;

    const html = renderPath('/futures-web/');

    expect(html).not.toContain('Set Master PIN');
    expect(html).toContain('Dashboard route');
    expect(html).not.toContain('404 Page Not Found');
  });

  it('keeps the fail-safe 404 route mounted for unknown paths', () => {
    const html = renderPath('/futures-web/definitely-not-a-route');

    expect(html).toContain('Set Master PIN');
    expect(html).toContain('404 Page Not Found');
    expect(html).not.toContain('Dashboard route');
  });

  it('keeps the fail-safe 404 route selected after the PIN gate is unlocked', () => {
    authState.authenticated = true;

    const html = renderPath('/futures-web/definitely-not-a-route');

    expect(html).not.toContain('Set Master PIN');
    expect(html).toContain('404 Page Not Found');
    expect(html).not.toContain('Dashboard route');
  });
});