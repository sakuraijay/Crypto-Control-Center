import {describe,it,expect,vi} from 'vitest';
import {analyzePatternFrame,confirmedPivots,patternReferenceAdjustment,PATTERN_VERSION,TIMEFRAMES,type PatternAnalysis,type RawCandles} from '../intel/patterns/chartPatterns';
import {readPatternCandles} from '../intel/patterns/patternReader';
const step=TIMEFRAMES['15m'];
const start=Math.floor(1_790_000_000_000/step)*step;
const now=start+80*step+3000;
function raw(prices:number[]):NonNullable<RawCandles> {
  return {source:'gmx-official-api',prices:prices.map((c,i)=>[start+i*step,c-.1,c+.3,c-.3,c])};
}
function shape(points:[number,number][]) {
  return raw(Array.from({length:80},(_,i)=>{
    const k=points.findIndex(p=>p[0]>=i);
    if(k<=0)return points[0][1];
    const [x0,y0]=points[k-1],[x1,y1]=points[k];
    return y0+(y1-y0)*(i-x0)/(x1-x0);
  }));
}
describe('unvalidated chart references',()=>{
  it('excludes unfinished and future candles, preserving prefix evidence',()=>{
    const data=raw(Array.from({length:80},(_,i)=>120-i*.2));
    const before=analyzePatternFrame(data,'15m',now);
    data.prices.push([start+80*step,1,1000,1,999],[start+81*step,1,1000,1,999]);
    expect(analyzePatternFrame(data,'15m',now)).toEqual(before);
  });
  it('requires correct source, continuity, freshness and valid OHLC',()=>{
    const data=raw(Array(80).fill(100));
    expect(analyzePatternFrame({...data,source:'community'},'15m',now).status).toBe('UNAVAILABLE');
    expect(analyzePatternFrame({...data,prices:data.prices.slice(0,50)},'15m',now).status).toBe('UNAVAILABLE');
    expect(analyzePatternFrame({...data,prices:data.prices.filter((_,i)=>i!==50)},'15m',now).status).toBe('INVALID');
    expect(analyzePatternFrame(data,'15m',now+2*step).status).toBe('STALE');
    data.prices[79][2]=1;
    expect(analyzePatternFrame(data,'15m',now).status).toBe('INVALID');
  });
  it('recognizes engulfing only with prior trend and exposes no volume or probability',()=>{
    const data=raw(Array.from({length:80},(_,i)=>120-i*.2));
    data.prices[78]=[start+78*step,105,105.1,103.9,104];
    data.prices[79]=[start+79*step,103.8,105.3,103.7,105.2];
    const result=analyzePatternFrame(data,'15m',now);
    expect(result.findings.some(p=>p.id==='BULLISH_ENGULFING'&&p.direction==='LONG')).toBe(true);
    expect(result.volumeConfirmation).toBe('UNAVAILABLE');
    expect(result.findings.every(p=>p.availableAt===start+80*step)).toBe(true);
    for(let i=71;i<=77;i++)data.prices[i]=[start+i*step,104.5,104.6,104.4,104.5];
    expect(analyzePatternFrame(data,'15m',now).findings.some(p=>p.id==='BULLISH_ENGULFING')).toBe(false);
  });
  it.each([1,-1])('recognizes newly confirmed double top/bottom with mirror %s',sign=>{
    const data=shape([[0,90],[35,90],[45,110],[55,100],[65,110],[77,101],[78,101],[79,98]]);
    if(sign===-1)data.prices=data.prices.map(([t,o,h,l,c])=>[t,200-o,200-l,200-h,200-c]);
    const expected=sign===1?'DOUBLE_TOP':'DOUBLE_BOTTOM';
    const found=analyzePatternFrame(data,'15m',now).findings.find(p=>p.id===expected);
    expect(found?.state).toBe('BREAKOUT');
    expect(found?.direction).toBe(sign===1?'SHORT':'LONG');
    data.prices[79]=[start+79*step,101,101.3,100.7,101];
    if(sign===1)expect(analyzePatternFrame(data,'15m',now).findings.some(p=>p.id===expected)).toBe(false);
  });
  it.each([1,-1])('recognizes head and shoulders with mirror %s',sign=>{
    const data=shape([[0,90],[28,90],[38,110],[46,100],[54,116],[62,100],[70,110],[78,101],[79,98]]);
    if(sign===-1)data.prices=data.prices.map(([t,o,h,l,c])=>[t,220-o,220-l,220-h,220-c]);
    expect(analyzePatternFrame(data,'15m',now).findings.some(p=>p.id===(sign===1?'HEAD_SHOULDERS':'INVERSE_HEAD_SHOULDERS'))).toBe(true);
  });
  it('does not confirm a pivot until two right-side candles close',()=>{
    const rows=[1,2,5,3,2].map((c,i)=>({t:start+i*step,o:c,h:c+.1,l:c-.1,c}));
    expect(confirmedPivots(rows.slice(0,4),step)).toEqual([]);
    expect(confirmedPivots(rows,step)[0]).toMatchObject({i:2,availableAt:start+5*step});
  });
  it('distinguishes rectangular and ascending boundaries using three touches',()=>{
    const rectangle=shape([[0,95],[25,95],[35,110],[40,100],[45,110],[50,100],[63,110],[68,100],[78,105],[79,112]]);
    expect(analyzePatternFrame(rectangle,'15m',now).findings.some(p=>p.id==='RECTANGLE'&&p.direction==='LONG')).toBe(true);
    const triangle=shape([[0,95],[25,95],[35,110],[40,90],[45,110],[50,94],[63,110],[68,101.2],[78,108],[79,112]]);
    expect(analyzePatternFrame(triangle,'15m',now).findings.some(p=>p.id==='ASCENDING_TRIANGLE')).toBe(true);
  });
  it.each([1,-1])('detects impulse-backed flag continuation with mirror %s',sign=>{
    const data=shape([[0,95],[42,95],[50,112],[54,108],[58,111.2],[62,107.2],[66,110.4],[70,106.4],[78,108],[79,110.5]]);
    if(sign===-1)data.prices=data.prices.map(([t,o,h,l,c])=>[t,220-o,220-l,220-h,220-c]);
    expect(analyzePatternFrame(data,'15m',now).findings.some(p=>p.id===(sign===1?'BULL_FLAG':'BEAR_FLAG'))).toBe(true);
  });
  it('caps correlated evidence, neutralizes conflicts, and rejects stale analysis',()=>{
    const frame=analyzePatternFrame(raw(Array(80).fill(100)),'15m',now);
    frame.findings=Array.from({length:100},()=>({id:'TEST',family:'CANDLE' as const,direction:'LONG' as const,state:'SHAPE' as const,timeframe:'15m' as const,availableAt:frame.closedAt!,trigger:null,invalidation:null,basis:'test'}));
    const analysis:PatternAnalysis={version:PATTERN_VERSION,purpose:'REFERENCE_ONLY_UNVALIDATED',evaluatedAt:now,frames:[frame,frame,frame]};
    expect(patternReferenceAdjustment(analysis,'LONG',now)).toBeCloseTo(.1/3);
    expect(patternReferenceAdjustment(analysis,'SHORT',now)).toBeCloseTo(-.1/3);
    frame.findings.push({...frame.findings[0],direction:'SHORT'});
    expect(patternReferenceAdjustment(analysis,'LONG',now)).toBe(0);
    expect(patternReferenceAdjustment(analysis,'LONG',now+61_000)).toBe(0);
    expect(patternReferenceAdjustment(undefined,'LONG',now)).toBe(0);
  });
});
describe('bounded candle cache',()=>{
  it('persists cache and refreshes only timeframes with newly closed bars',async()=>{
    const state=new Map<string,string>();let clock=now;
    const fetch=vi.fn(async()=>raw(Array(80).fill(100)));
    const deps={read:async(k:string)=>state.get(k)??null,write:async(k:string,v:unknown)=>{state.set(k,JSON.stringify(v));},fetch,now:()=>clock};
    await readPatternCandles('BTC',deps);expect(fetch).toHaveBeenCalledTimes(3);
    await readPatternCandles('BTC',{...deps});expect(fetch).toHaveBeenCalledTimes(3);
    clock+=step;await readPatternCandles('BTC',deps);
    expect(fetch.mock.calls.length).toBeGreaterThan(3);expect(fetch.mock.calls.length).toBeLessThanOrEqual(6);
    expect(state.size).toBe(3);
  });
  it('recovers malformed cache and limits network failure retries',async()=>{
    let clock=now;const state=new Map<string,string>();state.set('paper_chart_reference_v1:BTC:15m','broken');
    const fetch=vi.fn(async()=>{throw Error('unavailable');});
    const deps={read:async(k:string)=>state.get(k)??null,write:async(k:string,v:unknown)=>{state.set(k,JSON.stringify(v));},fetch,now:()=>clock};
    const result=await readPatternCandles('BTC',deps);
    expect(result.analysis.frames.every(f=>f.status==='UNAVAILABLE')).toBe(true);
    await readPatternCandles('BTC',deps);expect(fetch).toHaveBeenCalledTimes(3);
    clock+=61_000;await readPatternCandles('BTC',deps);expect(fetch).toHaveBeenCalledTimes(6);
  });
});
