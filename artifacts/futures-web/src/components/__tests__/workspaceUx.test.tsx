// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualTradeJournal } from '@/components/dashboard/VirtualTradeJournal';
import { QuickNavigation } from '@/components/shell/QuickNavigation';
import { VirtualPerformanceChart } from '@/components/dashboard/VirtualPerformanceChart';
const state = vi.hoisted(()=>({fresh:true,data:{runtime:{journal:[] as any[]}}}));
vi.mock('@/lib/context/VirtualPaper400Context',()=>({useVirtualPaper400:()=>state}));
afterEach(()=>{cleanup();state.fresh=true;state.data.runtime.journal=[];});
const row=(symbol:string)=>({id:symbol,symbol,side:'LONG',openedAt:null,closedAt:'2026-09-20T14:00:00Z',entryPrice:null,exitPrice:'99',stopPrice:null,targetPrice:null,strategy:'test fixture',reasons:['TEST EVIDENCE'],closeReason:'STOP',grossPnlUsd:'-2',netPnlUsd:'-2.3',entryCostUsd:'0.1',exitCostUsd:'0.2',holdingCostUsd:null,plannedRiskUsd:2,netR:-1.15,closeKind:'PROTECTION'});
describe('operator journeys',()=>{
 it('filters actual settlements and opens cost/entry evidence',()=>{state.data.runtime.journal=[row('BTC'),row('ETH')];render(<VirtualTradeJournal/>);fireEvent.change(screen.getByLabelText('거래 종목 필터'),{target:{value:'ETH'}});expect(screen.queryByRole('button',{name:'BTC 거래 상세 BTC'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'ETH 거래 상세 ETH'}));const dialog=screen.getByRole('dialog');expect(within(dialog).getByText('TEST EVIDENCE')).toBeTruthy();expect(within(dialog).getAllByText('미확인').length).toBeGreaterThan(0);});
 it('never exports or shows stale settlements',()=>{state.data.runtime.journal=[row('BTC')];state.fresh=false;render(<VirtualTradeJournal/>);expect(screen.queryByRole('button',{name:'BTC 거래 상세 BTC'})).toBeNull();expect((screen.getByRole('button',{name:'CSV'}) as HTMLButtonElement).disabled).toBe(true);});
 it('shows an honest empty chart before the first settlement',()=>{render(<VirtualPerformanceChart runtime={null} fresh={false}/>);expect(screen.queryByRole('img')).toBeNull();expect(screen.getByText('서버 데이터를 확인하고 있습니다')).toBeTruthy();});
 it('opens keyboard navigation, filters and closes without requiring mouse navigation',()=>{render(<QuickNavigation/>);fireEvent.keyDown(window,{key:'k',ctrlKey:true});expect(screen.getByRole('dialog')).toBeTruthy();fireEvent.change(screen.getByLabelText('메뉴 검색'),{target:{value:'시스템'}});expect(screen.getByRole('button',{name:/시스템 진단/})).toBeTruthy();expect(screen.queryByRole('button',{name:/Standard 계정/})).toBeNull();fireEvent.keyDown(screen.getByLabelText('메뉴 검색'),{key:'Enter'});expect(screen.queryByRole('dialog')).toBeNull();});
});
