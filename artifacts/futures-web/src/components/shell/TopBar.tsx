import { useLocation } from 'wouter';

export function TopBar() {
  const [location] = useLocation();

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
        <div className="px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-bold tracking-widest uppercase">
          PAPER TRADING
        </div>
      </div>
    </div>
  );
}
