import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowUpRight, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { NAV_GROUPS, EXTRA_NAV } from './navigation';
const items = [...NAV_GROUPS.flatMap(group=>group.items), ...EXTRA_NAV];
export function QuickNavigation() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  useEffect(()=>{const listener=(event: KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();setOpen(value=>!value);}};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);},[]);
  const results = items.filter(item=>(item.label+' '+item.english).toLowerCase().includes(query.toLowerCase()));
  const go=(href:string)=>{setOpen(false);setQuery('');navigate(href);};
  return <><button className="ccc-search-trigger" onClick={()=>setOpen(true)}><Search size={15} /><span>빠른 이동</span><kbd>Ctrl K</kbd></button>
    <Dialog open={open} onOpenChange={value=>{setOpen(value);if(!value)setQuery('');}}><DialogContent className="ccc-dialog ccc-search-dialog"><DialogHeader><DialogTitle>어디로 이동할까요?</DialogTitle><DialogDescription>메뉴를 검색하거나 Tab 키로 선택하세요.</DialogDescription></DialogHeader>
      <label className="sr-only" htmlFor="ccc-nav-search">메뉴 검색</label><input id="ccc-nav-search" autoFocus className="ccc-input" placeholder="오버뷰, 시장, 거래 기록…" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&results[0])go(results[0].href);}} />
      <div className="ccc-search-results">{results.map(item=><button key={item.href} onClick={()=>go(item.href)}><item.icon size={18} /><span>{item.label}<small>{item.english}</small></span><ArrowUpRight size={15} /></button>)}{!results.length&&<p className="ccc-muted p-4">일치하는 메뉴가 없습니다.</p>}</div>
    </DialogContent></Dialog></>;
}
