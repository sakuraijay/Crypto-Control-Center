import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { GlobalOfflineBanner } from './GlobalOfflineBanner';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] w-full overflow-hidden bg-[#070b12]">
      <Sidebar />
      <div className="ml-[220px] flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* Global Executor offline indicator — visible on every page */}
        <GlobalOfflineBanner />
        <main className="flex-1 overflow-y-auto bg-[#070b12] p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
