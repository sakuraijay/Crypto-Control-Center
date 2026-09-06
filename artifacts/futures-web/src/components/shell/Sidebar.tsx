import { Link, useLocation } from 'wouter';
import {
  Activity, Brain, FlaskConical, History, Layers, List, Settings,
  ShieldCheck, SlidersHorizontal,
} from 'lucide-react';
import { useAppContext } from '@/lib/context';
import { useAiEngine, type OperatingMode } from '@/lib/context/AiEngineContext';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/',          label: 'Overview',      testId: 'dashboard', icon: Activity },
  { href: '/positions', label: 'Positions',     testId: 'positions', icon: Layers },
  { href: '/watchlist', label: 'Market Watch',  testId: 'watchlist', icon: List },
  { href: '/strategy',  label: 'Strategy',      testId: 'strategy', icon: SlidersHorizontal },
  { href: '/ai-log',    label: 'AI Decisions',  testId: 'ai-log', icon: Brain },
  { href: '/history',   label: 'History',       testId: 'history', icon: History },
  { href: '/backtest',  label: 'Backtest',      testId: 'backtest', icon: FlaskConical },
];

const bottomNavItems = [
  { href: '/settings', label: 'Settings', testId: 'advanced-settings', icon: Settings },
];

const MODE_DOT: Record<OperatingMode, string> = {
  AUTONOMOUS_AI:   'bg-[#37d99a] shadow-[0_0_6px_rgba(55,217,154,0.55)]',
  MANUAL_OVERRIDE: 'bg-[#ffb648]',
  RISK_LOCKED:     'bg-[#ff5c76] animate-pulse shadow-[0_0_6px_rgba(255,92,118,0.55)]',
};

const MODE_LABEL: Record<OperatingMode, string> = {
  AUTONOMOUS_AI:   'AUTONOMOUS AI',
  MANUAL_OVERRIDE: 'MANUAL',
  RISK_LOCKED:     'RISK LOCKED',
};

const MODE_CLS: Record<OperatingMode, string> = {
  AUTONOMOUS_AI:   'bg-[#0d1d19] text-[#37d99a] border-[#1b2636]',
  MANUAL_OVERRIDE: 'bg-[#241c0e] text-[#ffb648] border-[#1b2636]',
  RISK_LOCKED:     'bg-[#251218] text-[#ff5c76] border-[#1b2636]',
};

export function Sidebar() {
  const [location] = useLocation();
  const { engineState } = useAppContext();
  const { operatingMode } = useAiEngine();

  const engineTone = () => {
    switch (engineState) {
      case 'OFFLINE':         return 'text-[#5f6b7a]';
      case 'MONITORING':      return 'text-[#37d0ff]';
      case 'PAPER_TRADING':   return 'text-[#37d99a]';
      case 'LIVE_READY':      return 'text-[#37d99a]';
      case 'LIVE_TRADING':    return 'text-[#ff5c76]';
      case 'RISK_LOCKED':     return 'text-[#ffb648]';
      case 'EMERGENCY_STOP':  return 'text-[#ff5c76]';
      default:                return 'text-[#8e9aaf]';
    }
  };

  const engineText = engineState.replaceAll('_', ' ');

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-[100dvh] w-[220px] shrink-0 flex-col border-r border-[#1b2636] bg-[#090e17] px-4 pb-5 pt-5">
      <div className="mb-2 flex items-center gap-2.5 px-1 pb-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[#101e2c] text-[#37d0ff]">
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div className="min-w-0 leading-none">
          <div className="truncate text-[11px] font-semibold tracking-[0.04em] text-[#f4f7fb]">CRYPTO CONTROL</div>
          <div className="mt-1 text-[9px] font-medium tracking-[0.12em] text-[#5f6b7a]">CENTER</div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto py-1">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'group flex h-[42px] items-center gap-3 rounded-[10px] px-3 transition-colors',
                isActive
                  ? 'bg-[#101e2c] text-[#f4f7fb]'
                  : 'text-[#8e9aaf] hover:bg-[#0d131e] hover:text-[#f4f7fb]',
              )}
              data-testid={`nav-${item.testId}`}
            >
              <div className={cn(
                'flex h-[18px] w-[18px] items-center justify-center rounded-[5px] transition-colors',
                isActive ? 'bg-[#37d0ff] text-[#070b12]' : 'bg-[#263346] text-[#8e9aaf] group-hover:text-[#f4f7fb]',
              )}>
                <item.icon className="h-3 w-3" />
              </div>
              <span className={cn('text-[12px]', isActive ? 'font-semibold' : 'font-medium')}>{item.label}</span>
              {item.href === '/ai-log' && operatingMode === 'AUTONOMOUS_AI' && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#37d99a] shadow-[0_0_4px_rgba(55,217,154,0.7)]" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mb-2 flex flex-col gap-1">
        {bottomNavItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'group flex h-[42px] items-center gap-3 rounded-[10px] px-3 transition-colors',
                isActive
                  ? 'bg-[#101e2c] text-[#f4f7fb]'
                  : 'text-[#8e9aaf] hover:bg-[#0d131e] hover:text-[#f4f7fb]',
              )}
              data-testid={`nav-${item.testId}`}
            >
              <div className={cn(
                'flex h-[18px] w-[18px] items-center justify-center rounded-[5px]',
                isActive ? 'bg-[#37d0ff] text-[#070b12]' : 'bg-[#263346] text-[#8e9aaf]',
              )}>
                <item.icon className="h-3 w-3" />
              </div>
              <span className={cn('text-[12px]', isActive ? 'font-semibold' : 'font-medium')}>{item.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="rounded-[10px] border border-[#1b2636] bg-[#0b111c] p-3">
        <div className="mb-2 text-[9px] font-semibold tracking-[0.12em] text-[#5f6b7a]">RUNTIME</div>
        <div className="flex flex-wrap gap-2">
          <div className={cn(
            'flex items-center gap-1.5 rounded-full border px-2 py-1 text-[9px] font-bold tracking-[0.05em]',
            MODE_CLS[operatingMode],
          )}>
            <span className={cn('h-1.5 w-1.5 rounded-full', MODE_DOT[operatingMode])} />
            {MODE_LABEL[operatingMode]}
          </div>
          <div className="rounded-full border border-[#1b2636] bg-[#0f1b28] px-2 py-1 text-[9px] font-semibold text-[#37d0ff]">
            {engineText}
          </div>
        </div>
        <div className={cn('mt-2 text-[9px]', engineTone())}>
          Server-derived safety state
        </div>
      </div>
    </aside>
  );
}
