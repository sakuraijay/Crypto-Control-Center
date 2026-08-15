import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { GlobalOfflineBanner } from './GlobalOfflineBanner';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex w-full bg-background overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col ml-[220px] min-w-0">
        <TopBar />
        {/* Global Executor offline indicator — visible on every page */}
        <GlobalOfflineBanner />
        <main className="flex-1 overflow-y-auto bg-card/30 p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
