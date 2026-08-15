import { Link, useLocation } from 'wouter';
import { LayoutDashboard, List, Activity, Settings, History, Layers, FlaskConical, Brain } from 'lucide-react';
import { useAppContext } from '@/lib/context';
import { useAiEngine, type OperatingMode } from '@/lib/context/AiEngineContext';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/',          label: 'Dashboard', icon: LayoutDashboard },
  { href: '/positions', label: 'Positions', icon: Layers },
  { href: '/watchlist', label: 'Watchlist', icon: List },
  { href: '/strategy',  label: 'Strategy',  icon: Activity },
  { href: '/ai-log',    label: 'AI Log',    icon: Brain },
  { href: '/history',   label: 'History',   icon: History },
  { href: '/backtest',  label: 'Backtest',  icon: FlaskConical },
  { href: '/settings',  label: 'Settings',  icon: Settings },
];

const MODE_DOT: Record<OperatingMode, string> = {
  AUTONOMOUS_AI:   'bg-[var(--color-long)] shadow-[0_0_6px_rgba(0,200,83,0.6)]',
  MANUAL_OVERRIDE: 'bg-amber-400',
  RISK_LOCKED:     'bg-[var(--color-short)] animate-pulse shadow-[0_0_6px_rgba(246,70,93,0.7)]',
};
const MODE_LABEL: Record<OperatingMode, string> = {
  AUTONOMOUS_AI:   'AUTONOMOUS AI',
  MANUAL_OVERRIDE: 'MANUAL OVERRIDE',
  RISK_LOCKED:     'RISK LOCKED',
};
const MODE_CLS: Record<OperatingMode, string> = {
  AUTONOMOUS_AI:   'bg-[var(--color-long)]/10 text-[var(--color-long)] border-[var(--color-long)]/20',
  MANUAL_OVERRIDE: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  RISK_LOCKED:     'bg-[var(--color-short)]/10 text-[var(--color-short)] border-[var(--color-short)]/30',
};

export function Sidebar() {
  const [location] = useLocation();
  const { engineState } = useAppContext();
  const { operatingMode } = useAiEngine();

  const getEngineColor = () => {
    switch (engineState) {
      case 'OFFLINE':         return 'bg-muted text-muted-foreground border-transparent';
      case 'MONITORING':      return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      case 'PAPER_TRADING':   return 'bg-accent/10 text-accent border-accent/20';
      case 'LIVE_READY':      return 'bg-transparent text-green-400 border-green-500';
      case 'LIVE_TRADING':    return 'bg-green-500 text-white border-green-500';
      case 'RISK_LOCKED':     return 'bg-orange-500/10 text-orange-400 border-orange-500/20';
      case 'EMERGENCY_STOP':  return 'bg-destructive text-destructive-foreground border-destructive';
      default:                return 'bg-muted';
    }
  };

  const getEngineText = () => engineState.replaceAll('_', ' ');

  return (
    <div className="w-[220px] shrink-0 border-r border-border bg-sidebar flex flex-col h-[100dvh] fixed left-0 top-0 z-40">
      <div className="h-16 flex items-center px-6 border-b border-border">
        <span className="font-bold text-lg tracking-wider text-sidebar-foreground">
          CRYPTO <span className="text-primary">CTL</span>
        </span>
      </div>

      <nav className="flex-1 py-6 px-3 flex flex-col gap-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location === item.href;
          const isAiLog = item.href === '/ai-log';
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50'
              }`}
              data-testid={`nav-${item.label.toLowerCase().replace(' ', '-')}`}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              <span className="text-sm">{item.label}</span>
              {isAiLog && operatingMode === 'AUTONOMOUS_AI' && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--color-long)] shadow-[0_0_4px_rgba(0,200,83,0.7)]" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border flex flex-col gap-2">
        {/* Operating mode indicator */}
        <div className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[9px] font-bold tracking-wider uppercase',
          MODE_CLS[operatingMode],
        )}>
          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', MODE_DOT[operatingMode])} />
          {MODE_LABEL[operatingMode]}
        </div>
        {/* Engine state */}
        <div className={`px-3 py-1.5 rounded-md border text-[9px] font-bold tracking-widest text-center uppercase ${getEngineColor()}`}>
          {getEngineText()}
        </div>
      </div>
    </div>
  );
}
