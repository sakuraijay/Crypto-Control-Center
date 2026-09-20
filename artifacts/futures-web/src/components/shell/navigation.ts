import { LayoutDashboard, Radar, SlidersHorizontal, History, FlaskConical, HeartPulse, Settings2, PanelsTopLeft, Layers3, BrainCircuit } from 'lucide-react';
export const NAV_GROUPS = [
  { label: 'WORKSPACE', items: [
    { href: '/', label: '오버뷰', english: 'Overview', icon: LayoutDashboard, testId: 'dashboard' },
    { href: '/watchlist', label: '시장 탐색', english: 'Markets', icon: Radar, testId: 'watchlist' },
    { href: '/activity', label: '거래 기록', english: 'Activity', icon: History, testId: 'activity' },
  ] },
  { label: 'RESEARCH & CONTROL', items: [
    { href: '/strategy', label: 'Standard 전략', english: 'Strategy · Standard', icon: SlidersHorizontal, testId: 'strategy' },
    { href: '/backtest', label: '백테스트', english: 'Backtest', icon: FlaskConical, testId: 'backtest' },
    { href: '/system', label: '시스템 진단', english: 'System', icon: HeartPulse, testId: 'system' },
  ] },
];
export const EXTRA_NAV = [
  { href: '/standard', label: 'Standard 계정', english: 'Separate paper workspace', icon: PanelsTopLeft, testId: 'standard' },
  { href: '/positions', label: 'Standard 포지션', english: 'Positions', icon: Layers3, testId: 'positions' },
  { href: '/history', label: 'Standard 기록', english: 'History', icon: History, testId: 'history' },
  { href: '/ai-log', label: '기존 AI 결정 이력', english: 'AI Decisions', icon: BrainCircuit, testId: 'ai-log' },
  { href: '/settings', label: '설정', english: 'Settings', icon: Settings2, testId: 'advanced-settings' },
];
