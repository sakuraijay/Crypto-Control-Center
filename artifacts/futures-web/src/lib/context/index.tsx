import { ReactNode } from 'react';
import { AppProvider } from './AppContext';
import { TradingProvider } from './TradingContext';
import { WatchlistProvider } from './WatchlistContext';
import { StrategyProvider } from './StrategyContext';
import { AuthProvider } from './AuthContext';
import { VirtualPaper400Provider } from './VirtualPaper400Context';
import { AiEngineProvider } from './AiEngineContext';
import { WalletProvider } from './WalletContext';
import { GmxAccountProvider } from './GmxAccountContext';

export function GlobalProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AppProvider>
        <TradingProvider>
          <WatchlistProvider>
            <StrategyProvider>
              {/* History/approval UI depends on Trading + Strategy; Virtual400 is server-derived */}
              <VirtualPaper400Provider>
                <AiEngineProvider>
                  {/* WalletProvider: read-only EIP-1193 browser wallet, no signing */}
                  <WalletProvider>
                    {/* GmxAccountProvider: depends on WalletProvider for address */}
                    <GmxAccountProvider>
                      {children}
                    </GmxAccountProvider>
                  </WalletProvider>
                </AiEngineProvider>
              </VirtualPaper400Provider>
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
export * from './GmxAccountContext';
