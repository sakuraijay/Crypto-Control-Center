import { ReactNode } from 'react';
import { AppProvider } from './AppContext';
import { TradingProvider } from './TradingContext';
import { WatchlistProvider } from './WatchlistContext';
import { StrategyProvider } from './StrategyContext';
import { AuthProvider } from './AuthContext';
import { AiEngineProvider } from './AiEngineContext';
import { WalletProvider } from './WalletContext';

export function GlobalProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AppProvider>
        <TradingProvider>
          <WatchlistProvider>
            <StrategyProvider>
              {/* AiEngineProvider must be inside Trading + Watchlist + Strategy */}
              <AiEngineProvider>
                {/* WalletProvider: read-only EIP-1193 browser wallet, no signing */}
                <WalletProvider>
                  {children}
                </WalletProvider>
              </AiEngineProvider>
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
export * from './AiEngineContext';
export * from './WalletContext';
