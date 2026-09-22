/** Transparent experimental turnover rule, NOT an ensemble signal or confidence estimate. */
export interface DailyPaperCandidate { symbol:string; source:'gmx-official-api'; closedAt:number;
  evaluatedAt:number; side:'LONG'|'SHORT'; referencePrice:number; stopFraction:number; momentum:number;
  purpose:'AGGRESSIVE_PAPER_EXPERIMENT'; }
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
  return {symbol,source:'gmx-official-api',closedAt,evaluatedAt:now,side:direction>=0?'LONG':'SHORT',
    referencePrice:last[4],stopFraction:Math.max(.002,Math.min(.008,atr/last[4])),momentum,
    purpose:'AGGRESSIVE_PAPER_EXPERIMENT'};
}
