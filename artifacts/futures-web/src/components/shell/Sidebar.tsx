import { Link, useLocation } from 'wouter';
import { ArrowUpRight, ChevronLeft, ChevronRight, Hexagon, PanelsTopLeft, Settings2 } from 'lucide-react';
import { useVirtualPaper400 } from '@/lib/context/VirtualPaper400Context';
import { NAV_GROUPS } from './navigation';

export function Sidebar({ collapsed = false, onToggle }: { collapsed?: boolean; onToggle?: () => void }) {
  const [location] = useLocation();
  const { data, fresh, status } = useVirtualPaper400();
  const active = fresh && data?.session.status==='ACTIVE';
  const blocked = data?.runtime?.status==='BLOCKED';
  return <aside className={`ccc-sidebar ${collapsed?'is-collapsed':''}`} aria-label="주 메뉴">
    <Link href="/" className="ccc-brand" aria-label="CCC 오버뷰"><span className="ccc-brand-mark"><i /><i /><i /></span><span className="ccc-brand-word">CCC<span>CRYPTO CONTROL CENTER</span></span></Link>
    <div className="ccc-workspace-label"><span className="ccc-workspace-avatar"><Hexagon size={18} /></span><div><strong>Personal workspace</strong><span>Virtual trading</span></div></div>
    <nav className="ccc-nav">{NAV_GROUPS.map(group=><div className="ccc-nav-group" key={group.label}><p>{group.label}</p>{group.items.map(item=><Link href={item.href} key={item.href} className={`ccc-nav-item ${location===item.href?'is-selected':''}`} aria-current={location===item.href?'page':undefined} title={collapsed?item.label:undefined} data-testid={`nav-${item.testId}`}><item.icon size={18} /><span>{item.label}</span>{location===item.href && <i className="ccc-nav-current" />}</Link>)}</div>)}</nav>
    <div className="ccc-sidebar-bottom"><div className="ccc-sidebar-session"><div><i className={`ccc-live-dot ${active&&!blocked?'is-active':''}`} /><strong>VIRTUAL 400</strong><span>PAPER</span></div><p>{status}</p><span>서버에 저장된 설정으로 운용</span></div>
      <Link href="/standard" className={`ccc-nav-item ${location==='/standard'?'is-selected':''}`} title="Standard 별도 계정" data-testid="nav-standard"><PanelsTopLeft size={18} /><span>Standard 계정</span><ArrowUpRight size={13} /></Link>
      <Link href="/settings" className={`ccc-nav-item ${location==='/settings'?'is-selected':''}`} title="설정" data-testid="nav-advanced-settings"><Settings2 size={18} /><span>설정</span></Link>
      <button className="ccc-sidebar-collapse" onClick={onToggle} aria-label={collapsed?'메뉴 펼치기':'메뉴 접기'}>{collapsed?<ChevronRight size={16} />:<ChevronLeft size={16} />}<span>메뉴 접기</span></button>
      <div className="ccc-profile"><span>JP</span><div><strong>JayPark</strong><small>Personal account</small></div><i /></div>
    </div>
  </aside>;
}
