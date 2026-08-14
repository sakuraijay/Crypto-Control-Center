import { ReactNode } from 'react';
import { AppProvider } from './AppContext';
import { TradingProvider } from './TradingContext';
import { WatchlistProvider } from './WatchlistContext';
import { StrategyProvider } from './StrategyContext';
import { AuthProvider } from './AuthContext';

export function GlobalProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AppProvider>
        <TradingProvider>
          <WatchlistProvider>
            <StrategyProvider>
              {children}
            </StrategyProvider>
          </WatchlistProvider>
        </TradingProvider>
      </AppProvider>
    </AuthProvider>
  );
}

export * from './AppContext';
export * from './TradingContext';
export * from './WatchlistContext';
export * from './StrategyContext';
export * from './AuthContext';
