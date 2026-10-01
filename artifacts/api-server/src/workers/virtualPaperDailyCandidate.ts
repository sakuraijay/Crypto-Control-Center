/** Transparent experimental turnover rule, NOT an ensemble signal or confidence estimate. */
export interface DailyPaperCandidate { symbol:string; source:'gmx-official-api'; closedAt:number;
  patternAnalysis?:import('../intel/patterns/chartPatterns').PatternAnalysis;
  evaluatedAt:number; side:'LONG'|'SHORT'; referencePrice:number; stopFraction:number; momentum:number;
  purpose:'AGGRESSIVE_PAPER_EXPERIMENT';
  quality?: { eligible:boolean; reason:string; regime:'TREND'|'RANGE'|'TRANSITION'; efficiency:number; atrFraction:number };  }
export function dailyPaperCandidate(symbol:string,raw:{prices:number[][];source:string}|null,now:number):DailyPaperCandidate|null {
  if(!raw || raw.source!=='gmx-official-api' || !/^[A-Z0-9_]{1,24}$/.test(symbol))return null;
  const step=900_000;
  const rows=raw.prices.map(r=>[r[0]<1e12?r[0]*1000:r[0],...r.slice(1,5)])
    .filter(r=>r[0]+step<=now-2000).sort((a,b)=>a[0]-b[0]).slice(-16);
  if(rows.length!==16 || rows.some((r,i)=>r.length!==5||r[0]%step!==0||r.some(v=>!Number.isFinite(v)||v<=0)
    ||r[2]<Math.max(r[1],r[3],r[4])||r[3]>Math.min(r[1],r[2],r[4])
    ||(i>0&&r[0]-rows[i-1][0]!==step)))return null;
  const last=rows.at(-1)!;const closedAt=last[0]+step;
  if(now-closedAt>step+60_000)return null;
  const atr=rows.slice(1).reduce((sum,r,i)=>sum+Math.max(r[2]-r[3],Math.abs(r[2]-rows[i][4]),Math.abs(r[3]-rows[i][4])),0)/15;
  const momentum=last[4]/rows.at(-5)![4]-1;
  const direction=momentum || last[4]-last[1];
  const changes=rows.slice(1).map((r,i)=>Math.abs(r[4]-rows[i][4]));
  const travel=changes.reduce((a,b)=>a+b,0);
  const efficiency=travel>0?Math.abs(last[4]-rows[0][4])/travel:0;
  const earlier=rows[11][4]/rows[7][4]-1;
  const atrFraction=atr/last[4];
  const rangeHigh=Math.max(...rows.slice(0,-1).map(r=>r[2]));
  const rangeLow=Math.min(...rows.slice(0,-1).map(r=>r[3]));
  const span=rangeHigh-rangeLow;
  const location=span>0?(last[4]-rangeLow)/span:.5;
  const trend=efficiency>=.35 && momentum*earlier>0;
  const range=efficiency<.25;
  const regime=trend?'TREND':range?'RANGE':'TRANSITION';
  const weak=Math.abs(momentum)<atrFraction*.5;
  const chased=Math.abs(last[4]-last[1])>atr*1.5;
  const rangeRejection=range && ((location<.25&&last[4]>last[1]&&(Math.min(last[1],last[4])-last[3])>Math.abs(last[4]-last[1]))
    ||(location>.75&&last[4]<last[1]&&(last[2]-Math.max(last[1],last[4]))>Math.abs(last[4]-last[1])));
  const eligible=atrFraction>=.002&&atrFraction<=.008&&!chased&&((trend&&!weak)||rangeRejection);
  const reason=eligible?'MARKET_QUALITY_ACCEPTED':chased?'CHASE_CANDLE':atrFraction<.002||atrFraction>.008?'VOLATILITY_OUTSIDE_STOP_RANGE':weak?'WEAK_MOMENTUM':'REGIME_OR_CONFIRMATION_MISSING';
  // Range entries fade a confirmed edge rejection; transition regimes abstain.
  const selectedDirection=rangeRejection?(location<.25?1:-1):direction;
  return {symbol,source:'gmx-official-api',closedAt,evaluatedAt:now,side:selectedDirection>=0?'LONG':'SHORT',
    referencePrice:last[4],stopFraction:Math.max(.002,Math.min(.008,atr/last[4])),momentum,
    purpose:'AGGRESSIVE_PAPER_EXPERIMENT',quality:{eligible,reason,regime,efficiency,atrFraction}};
}
