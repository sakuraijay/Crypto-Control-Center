// @vitest-environment jsdom
import {afterEach,describe,it,expect} from 'vitest';
import {cleanup,render,screen,fireEvent,within} from '@testing-library/react';
import PatternsPage from '@/pages/patterns';
import {TradeEntryEvidence} from '@/components/dashboard/TradeEntryEvidence';
import {PATTERN_CATALOG} from '@/lib/patternCatalog';
import {patternName,entryPatternSummary,type TradeEntryEvidence as Evidence} from '@/lib/virtualTradeEvidencePresentation';
import {NAV_GROUPS} from '@/components/shell/navigation';
afterEach(cleanup);
describe('pattern library and historical evidence',()=>{
  it('places the new destination immediately above calendar',()=>{
    const items=NAV_GROUPS[0].items;expect(items[items.findIndex(x=>x.href==='/calendar')-1].href).toBe('/patterns');
  });
  it('shows every preview and opens every distinct explanation without changing trading settings',()=>{
    render(<PatternsPage/>);expect(new Set(PATTERN_CATALOG.map(p=>p.id)).size).toBe(38);
    expect(screen.getAllByRole('img')).toHaveLength(38);
    for(const p of PATTERN_CATALOG){
      expect(p.candles?.length||p.line?.length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole('button',{name:`${patternName(p.id)} 상세 설명`}));
      const dialog=screen.getByRole('dialog');expect(within(dialog).getByText(p.rule)).toBeTruthy();
      expect(within(dialog).getByText(p.meaning)).toBeTruthy();
      fireEvent.keyDown(dialog,{key:'Escape'});
    }
  },30_000);
  it('distinguishes absent historic evidence from analyzed-but-no-pattern',()=>{
    expect(entryPatternSummary(null)).toBe('패턴 기록 없음');
    render(<TradeEntryEvidence/>);expect(screen.getByText(/현재 차트로 과거 진입 근거를 추정하지 않습니다/)).toBeTruthy();cleanup();
    const e:Evidence={source:'ENTRY_AUDIT',evaluatedAt:1790611200000,closedAt:1790610300000,momentumPct:.3,
      quality:{regime:'TREND',eligible:true,reason:'OK',efficiency:.5,atrPct:.3},patternStatus:'RECORDED',patternVersion:'paper-chart-reference/v1',patternAdjustment:0,
      frames:[{timeframe:'1h',status:'OK',closedAt:1790610300000,bars:240,volumeConfirmation:'UNAVAILABLE',findings:[]}]};
    expect(entryPatternSummary(e)).toBe('분석 완료 · 감지 패턴 없음');
    render(<TradeEntryEvidence evidence={e}/>);expect(screen.getByText('탐지된 패턴 없음')).toBeTruthy();
  });
});
