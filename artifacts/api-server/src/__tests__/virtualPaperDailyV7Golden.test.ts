import { describe, it, expect } from 'vitest';
import { dailyPaperCandidate } from '../workers/virtualPaperDailyCandidate';

const step=900_000,now=Date.parse('2026-10-01T20:00:10Z');
/** Frozen v7 oracle: body direction, not hourly momentum, confirms range edges. */
function originalV7(rows:number[][]){
  const last=rows.at(-1)!;
  const atr=rows.slice(1).reduce((sum,r,i)=>sum+Math.max(r[2]-r[3],
    Math.abs(r[2]-rows[i][4]),Math.abs(r[3]-rows[i][4])),0)/15;
  const momentum=last[4]/rows.at(-5)![4]-1;
  const travel=rows.slice(1).reduce((sum,r,i)=>sum+Math.abs(r[4]-rows[i][4]),0);
  const efficiency=travel>0?Math.abs(last[4]-rows[0][4])/travel:0;
  const earlier=rows[11][4]/rows[7][4]-1;
  const atrFraction=atr/last[4];
  const high=Math.max(...rows.slice(0,-1).map(r=>r[2]));
  const low=Math.min(...rows.slice(0,-1).map(r=>r[3]));
  const location=high>low?(last[4]-low)/(high-low):.5;
  const trend=efficiency>=.35&&momentum*earlier>0;
  const range=efficiency<.25;
  const weak=Math.abs(momentum)<atrFraction*.5;
  const chased=Math.abs(last[4]-last[1])>atr*1.5;
  const rejectedEdge=range&&(
    (location<.25&&last[4]>last[1]&&Math.min(last[1],last[4])-last[3]>Math.abs(last[4]-last[1]))
    ||(location>.75&&last[4]<last[1]&&last[2]-Math.max(last[1],last[4])>Math.abs(last[4]-last[1])));
  const eligible=atrFraction>=.002&&atrFraction<=.008&&!chased&&((trend&&!weak)||rejectedEdge);
  const direction=rejectedEdge?(location<.25?1:-1):(momentum||last[4]-last[1]);
  return {side:direction>=0?'LONG':'SHORT',stop:Math.max(.002,Math.min(.008,atrFraction)),
    quality:{eligible,reason:eligible?'MARKET_QUALITY_ACCEPTED':chased?'CHASE_CANDLE'
      :atrFraction<.002||atrFraction>.008?'VOLATILITY_OUTSIDE_STOP_RANGE':weak?'WEAK_MOMENTUM'
        :'REGIME_OR_CONFIRMATION_MISSING',regime:trend?'TREND':range?'RANGE':'TRANSITION',efficiency,atrFraction}};
}
describe('unchanged v7 comparison golden semantics',()=>{
  it.each([
    {edge:'LOW',body:'BULL',zeroMomentum:false,accepted:true,side:'LONG'},
    {edge:'HIGH',body:'BEAR',zeroMomentum:false,accepted:true,side:'SHORT'},
    {edge:'LOW',body:'BEAR',zeroMomentum:false,accepted:false,side:'SHORT'},
    {edge:'HIGH',body:'BULL',zeroMomentum:false,accepted:false,side:'LONG'},
    {edge:'LOW',body:'BULL',zeroMomentum:true,accepted:true,side:'LONG'},
    {edge:'HIGH',body:'BEAR',zeroMomentum:true,accepted:true,side:'SHORT'},
    {edge:'LOW',body:'DOJI',zeroMomentum:true,accepted:false,side:'LONG'},
  ])('preserves $edge/$body with zero momentum=$zeroMomentum',({edge,body,zeroMomentum,accepted,side})=>{
    const rows=Array.from({length:16},(_,i)=>{
      const close=i%2?100.2:99.8;
      return [(Math.floor(now/step)-16+i)*step/1000,close,100.3,99.7,close];
    });
    const close=edge==='LOW'?99.8:100.2;
    rows[11]=[rows[11][0],zeroMomentum?close:edge==='LOW'?100.2:99.8,100.3,99.7,
      zeroMomentum?close:edge==='LOW'?100.2:99.8];
    rows[15]=[rows[15][0],body==='BULL'?close-.02:body==='BEAR'?close+.02:close,
      edge==='HIGH'?100.5:100.3,edge==='LOW'?99.5:99.7,close];
    const golden=originalV7(rows);
    const result=dailyPaperCandidate('ETH',{source:'gmx-official-api',prices:rows},now);
    expect(golden.quality.eligible).toBe(accepted);
    expect(golden.side).toBe(side);
    expect(result?.legacyQuality).toEqual(golden.quality);
    expect(result?.legacySide).toBe(golden.side);
    expect(result?.legacyStopFraction).toBe(golden.stop);
  });
});