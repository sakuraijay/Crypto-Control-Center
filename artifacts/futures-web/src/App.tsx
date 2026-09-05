import { type ReactNode } from 'react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { GlobalProviders, useAppContext } from '@/lib/context';
import { Shell } from '@/components/shell';
import { AuthOverlay } from '@/components/auth/AuthOverlay';
import { OnboardingOverlay } from '@/components/onboarding/OnboardingOverlay';
import { RiskAlertMonitor } from '@/components/trading/RiskAlertMonitor';

import Dashboard from '@/pages/dashboard';
import Positions from '@/pages/positions';
import Watchlist from '@/pages/watchlist';
import Strategy from '@/pages/strategy';
import HistoryPage from '@/pages/history';
import Settings from '@/pages/settings';
import Backtest from '@/pages/backtest';
import AiLog from '@/pages/ai-log';
import { AlertCircle } from 'lucide-react';

export const APP_ROUTER_BASE = '/futures-web';

function EmergencyBanner() {
  const { engineState, resetFromEmergency } = useAppContext();
  if (engineState !== 'EMERGENCY_STOP') return null;
  return (
    <div className="fixed top-0 left-0 right-0 z-[60] bg-destructive text-destructive-foreground px-4 py-3 flex items-center justify-between shadow-lg">
      <div className="flex items-center gap-3">
        <AlertCircle className="w-5 h-5 shrink-0" />
        <div className="flex flex-col">
          <span className="font-bold uppercase tracking-widest text-sm">Emergency Stop Active</span>
          <span className="text-xs opacity-90">All new orders are blocked. Open positions remain until closed.</span>
        </div>
      </div>
      <button
        onClick={resetFromEmergency}
        className="px-4 py-1.5 bg-background text-foreground text-xs font-bold rounded hover:bg-background/90 transition-colors"
      >
        RESET TO PAPER TRADING
      </button>
    </div>
  );
}

export function AppRouter() {
  return (
    <RoutedErrorBoundary>
      <Shell>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/positions" component={Positions} />
          <Route path="/watchlist" component={Watchlist} />
          <Route path="/strategy" component={Strategy} />
          <Route path="/history" component={HistoryPage} />
          <Route path="/settings" component={Settings} />
          <Route path="/backtest" component={Backtest} />
          <Route path="/ai-log" component={AiLog} />
          <Route path="*" component={NotFound} />
        </Switch>
      </Shell>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

export function AppContent() {
  return (
    <>
      <AuthOverlay />
      <OnboardingOverlay />
      <EmergencyBanner />
      <RiskAlertMonitor />
      <AppRouter />
    </>
  );
}

function App() {
  return (
    <GlobalProviders>
      <TooltipProvider>
        <WouterRouter base={APP_ROUTER_BASE}>
          <AppContent />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </GlobalProviders>
  );
}

export default App;
