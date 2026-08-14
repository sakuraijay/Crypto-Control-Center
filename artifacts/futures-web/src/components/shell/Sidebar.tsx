import { ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { LayoutDashboard, List, Activity, Settings, History, Layers } from 'lucide-react';
import { useAppContext } from '@/lib/context';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/positions', label: 'Positions', icon: Layers },
  { href: '/watchlist', label: 'Watchlist', icon: List },
  { href: '/strategy', label: 'Strategy', icon: Activity },
  { href: '/history', label: 'History', icon: History },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const [location] = useLocation();
  const { engineState } = useAppContext();

  const getEngineColor = () => {
    switch(engineState) {
      case 'OFFLINE': return 'bg-muted text-muted-foreground border-transparent';
      case 'MONITORING': return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
      case 'PAPER_TRADING': return 'bg-accent/10 text-accent border-accent/20';
      case 'LIVE_READY': return 'bg-transparent text-green-500 border-green-500';
      case 'LIVE_TRADING': return 'bg-green-500 text-white border-green-500';
      case 'RISK_LOCKED': return 'bg-orange-500/10 text-orange-500 border-orange-500/20';
      case 'EMERGENCY_STOP': return 'bg-destructive text-destructive-foreground border-destructive';
      default: return 'bg-muted';
    }
  };

  const getEngineText = () => engineState.replace('_', ' ');

  return (
    <div className="w-[220px] shrink-0 border-r border-border bg-sidebar flex flex-col h-[100dvh] fixed left-0 top-0 z-40">
      <div className="h-16 flex items-center px-6 border-b border-border">
        <span className="font-bold text-lg tracking-wider text-sidebar-foreground">
          FUTURES <span className="text-primary">TERM</span>
        </span>
      </div>
      
      <div className="flex-1 py-6 px-3 flex flex-col gap-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location === item.href;
          return (
            <Link key={item.href} href={item.href} className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors \${isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50'}`}>
              <item.icon className="w-4 h-4" />
              <span className="text-sm">{item.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="p-4 border-t border-border">
        <div className={`px-3 py-2 rounded-md border text-xs font-bold tracking-widest text-center uppercase \${getEngineColor()}`}>
          {getEngineText()}
        </div>
      </div>
    </div>
  );
}
