import { ReactNode } from 'react';
import { AppProvider } from './AppContext';
import { TradingProvider } from './TradingContext';
import { WatchlistProvider } from './WatchlistContext';
import { StrategyProvider } from './StrategyContext';
import { AuthProvider } from './AuthContext';
import { VpsProvider } from './VpsContext';
import { AiEngineProvider } from './AiEngineContext';

export function GlobalProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AppProvider>
        <TradingProvider>
          <WatchlistProvider>
            <StrategyProvider>
              <VpsProvider>
                {/* AiEngineProvider must be inside Trading + Watchlist + Strategy */}
                <AiEngineProvider>
                  {children}
                </AiEngineProvider>
              </VpsProvider>
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
export * from './VpsContext';
export * from './AiEngineContext';
