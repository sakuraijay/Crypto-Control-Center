import { useLocation } from 'wouter';
import { useAiEngine } from '@/lib/context/AiEngineContext';
import { FlaskConical } from 'lucide-react';

export function TopBar() {
  const [location] = useLocation();
  const { liveTestMode } = useAiEngine();

  const getPageTitle = () => {
    switch (location) {
      case '/': return 'Dashboard';
      case '/positions': return 'Positions';
      case '/watchlist': return 'Watchlist';
      case '/strategy': return 'Strategy Controls';
      case '/history': return 'History & Logs';
      case '/settings': return 'Settings';
      default: return '';
    }
  };

  return (
    <div className="h-16 flex items-center justify-between px-8 border-b border-border bg-background sticky top-0 z-30">
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        {getPageTitle()}
      </h1>
      <div className="flex items-center gap-4">
        {liveTestMode ? (
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-bold tracking-widest uppercase">
            <FlaskConical className="w-3 h-3" />
            LIVE TEST
          </div>
        ) : (
          <div className="px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-bold tracking-widest uppercase">
            PAPER TRADING
          </div>
        )}
      </div>
    </div>
  );
}
