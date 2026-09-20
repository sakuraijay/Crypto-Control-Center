import { type ReactNode, useState } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { GlobalOfflineBanner } from './GlobalOfflineBanner';
const KEY = 'ccc_sidebar_collapsed_v1';
export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(()=>{try{return localStorage.getItem(KEY)==='true';}catch{return false;}});
  function toggle() { setCollapsed(value=>{try{localStorage.setItem(KEY,String(!value));}catch{}return !value;}); }
  return <div className={`ccc-shell ${collapsed?'ccc-shell-compact':''}`}><a className="ccc-skip-link" href="#ccc-main">본문으로 이동</a><Sidebar collapsed={collapsed} onToggle={toggle} />
    <div className="ccc-shell-body"><TopBar /><GlobalOfflineBanner /><main id="ccc-main" className="ccc-main" tabIndex={-1}>{children}</main></div>
  </div>;
}
