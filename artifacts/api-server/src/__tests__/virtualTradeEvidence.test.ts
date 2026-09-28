import {describe,it,expect} from 'vitest';
import {virtualTradeEvidence} from '../workers/virtualTradeEvidence';
const now=Date.parse('2026-09-29T00:00:05Z');
const audit=()=>({secret:'MUST_NOT_LEAK',candidate:{symbol:'BTC',side:'LONG',source:'gmx-official-api',evaluatedAt:now,closedAt:now-5000,momentum:.003,
  quality:{regime:'TREND',eligible:true,efficiency:.5,atrFraction:.003},patternAnalysis:{version:'paper-chart-reference/v1',purpose:'REFERENCE_ONLY_UNVALIDATED',evaluatedAt:now,
    frames:[{timeframe:'1h',status:'OK',closedAt:now-5000,bars:240,findings:[{id:'DOUBLE_BOTTOM',direction:'LONG',timeframe:'1h',state:'BREAKOUT',availableAt:now-5000,trigger:100,invalidation:95,basis:'recorded'},
      {id:'DOUBLE_TOP',direction:'SHORT',timeframe:'1h',state:'BREAKOUT',availableAt:now-5000,trigger:100,invalidation:105,basis:'opposing'}]}]}},selection:{patternReferenceAdjustment:0}});
describe('immutable entry evidence projection',()=>{
  it('preserves supporting and opposing patterns, actual adjustment, and strips private audit fields',()=>{
    const r=virtualTradeEvidence(audit(),'BTC','LONG',now+1000)!;
    expect(r.patternStatus).toBe('RECORDED');expect(r.patternAdjustment).toBe(0);
    expect(r.frames[0].findings.map(p=>p.alignment)).toEqual(['SUPPORTS','OPPOSES']);
    expect(JSON.stringify(r)).not.toContain('MUST_NOT_LEAK');expect(r.momentumPct).toBeCloseTo(.3);
  });
  it('does not reconstruct missing, wrong-symbol or future entry evidence',()=>{
    for(const raw of [null,{},'broken',[],{candidate:null}])expect(virtualTradeEvidence(raw,'BTC','LONG',now)).toBeNull();
    expect(virtualTradeEvidence(audit(),'ETH','LONG',now)).toBeNull();
    expect(virtualTradeEvidence(audit(),'BTC','SHORT',now)).toBeNull();
    expect(virtualTradeEvidence(audit(),'BTC','LONG',now-1)).toBeNull();
    const a=audit();delete (a.candidate as any).patternAnalysis;
    expect(virtualTradeEvidence(a,'BTC','LONG',now)).toMatchObject({patternStatus:'NOT_RECORDED',frames:[],patternAdjustment:null});
  });
  it('rejects future pattern results and out-of-range selection adjustments',()=>{
    const a=audit();a.candidate.patternAnalysis.frames[0].findings[0].availableAt=now+1000;
    a.selection.patternReferenceAdjustment=50;
    const r=virtualTradeEvidence(a,'BTC','LONG',now)!;
    expect(r.frames[0].findings).toHaveLength(1);expect(r.patternAdjustment).toBeNull();
    a.candidate.patternAnalysis.evaluatedAt=now+1;
    expect(virtualTradeEvidence(a,'BTC','LONG',now)?.patternStatus).toBe('NOT_RECORDED');
  });
});
