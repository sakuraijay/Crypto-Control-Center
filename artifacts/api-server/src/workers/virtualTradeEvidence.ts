/** Public, bounded projection of the immutable entry audit. Never infer past signals
 * from current candles and never expose the complete internal audit. */
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
const text=(v:unknown)=>typeof v==='string'?v.slice(0,240):null;
export function virtualEntryAmounts(raw:unknown) {
  const audit=object(raw),plan=object(audit.tradePlan),sizing=object(audit.sizing);
  const notional=number(plan.notionalUsd)??number(sizing.finalNotionalUsd),collateral=number(plan.collateralUsd);
  return {entryNotionalUsd:notional!==null&&notional>0?String(notional):null,
    collateralUsd:collateral!==null&&collateral>0?String(collateral):null};
}
export function virtualTradeEvidence(raw:unknown,symbol:string,side:string,openedAt:number) {
  const audit=object(raw),c=object(audit.candidate),p=object(c.patternAnalysis),quality=object(c.quality),selection=object(audit.selection);
  const evaluatedAt=number(c.evaluatedAt),closedAt=number(c.closedAt);
  const bound=c.symbol===symbol&&c.side===side&&c.source==='gmx-official-api'&&evaluatedAt!==null
    &&Number.isFinite(openedAt)&&evaluatedAt<=openedAt&&openedAt-evaluatedAt<=60_000
    &&closedAt!==null&&closedAt<=evaluatedAt;
  if(!bound)return null;
  const patternAt=number(p.evaluatedAt);
  const valid=p.version==='paper-chart-reference/v1'&&p.purpose==='REFERENCE_ONLY_UNVALIDATED'
    &&patternAt!==null&&patternAt<=evaluatedAt&&evaluatedAt-patternAt<=60_000&&Array.isArray(p.frames);
  const frames=valid?(p.frames as unknown[]).slice(0,3).flatMap(item=>{
    const f=object(item),at=number(f.closedAt);
    if(!['15m','1h','4h'].includes(String(f.timeframe)))return [];
    const status=['OK','UNAVAILABLE','INVALID','STALE'].includes(String(f.status))?String(f.status):'INVALID';
    const findings=status==='OK'&&at!==null&&at<=patternAt!&&Array.isArray(f.findings)?f.findings.slice(0,38).flatMap(item=>{
      const x=object(item),availableAt=number(x.availableAt);
      if(typeof x.id!=='string'||!/^[A-Z_]{1,50}$/.test(x.id)||x.timeframe!==f.timeframe
        ||!['LONG','SHORT','NEUTRAL'].includes(String(x.direction))||!['SHAPE','BREAKOUT'].includes(String(x.state))
        ||availableAt===null||availableAt>patternAt!||availableAt!==at)return [];
      return [{id:x.id,direction:String(x.direction),state:String(x.state),availableAt,
        alignment:x.direction==='NEUTRAL'?'NEUTRAL':x.direction===side?'SUPPORTS':'OPPOSES',
        trigger:number(x.trigger),invalidation:number(x.invalidation),basis:text(x.basis)}];
    }):[];
    return [{timeframe:String(f.timeframe),status,closedAt:at,bars:number(f.bars),volumeConfirmation:'UNAVAILABLE',findings}];
  }):[];
  const adjustment=number(selection.patternReferenceAdjustment);
  return {source:'ENTRY_AUDIT',evaluatedAt,closedAt,momentumPct:number(c.momentum)!==null?Number(c.momentum)*100:null,
    quality:{regime:text(quality.regime),eligible:typeof quality.eligible==='boolean'?quality.eligible:null,
      reason:text(quality.reason),efficiency:number(quality.efficiency),atrPct:number(quality.atrFraction)!==null?Number(quality.atrFraction)*100:null},
    patternStatus:valid?'RECORDED':'NOT_RECORDED',patternVersion:valid?String(p.version):null,
    patternAdjustment:valid&&adjustment!==null&&Math.abs(adjustment)<=.100001?adjustment:null,frames};
}
