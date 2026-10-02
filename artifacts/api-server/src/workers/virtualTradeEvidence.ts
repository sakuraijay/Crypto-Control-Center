/** Public, bounded projection of the immutable entry audit. Never infer past signals
 * from current candles and never expose the complete internal audit. */
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
const text=(v:unknown)=>typeof v==='string'?v.slice(0,240):null;
const patternEntry=(raw:unknown,symbol:string,side:string,openedAt:number)=>{
  const p=object(raw),auxiliary=object(p.auxiliary);
  if(p.symbol!==symbol||p.direction!==side||typeof p.eventId!=='string'||p.eventId!==p.durableFormationId
    ||!['15m','1h','4h','1d'].includes(String(p.timeframe))
    ||!['LONG','SHORT'].includes(String(p.direction))
    ||!['eventId','formationAt','confirmedAt','triggerPrice','referencePrice','stopPrice','expiresAt','maxHoldMs']
      .every(k=>number(p[k])!==null)
    ||typeof p.patternId!=='string'||!Array.isArray(p.supportingPatternIds)||!Array.isArray(p.conflictingPatternIds)
    ||p.formationAt as number>openedAt||p.confirmedAt as number>openedAt)return null;
  const observedTarget=text(auxiliary.observedTarget);
  return {eventId:p.eventId,durableFormationId:p.durableFormationId,symbol:p.symbol,patternId:p.patternId,
    timeframe:p.timeframe,direction:p.direction,formationAt:p.formationAt,confirmedAt:p.confirmedAt,
    triggerPrice:p.triggerPrice,referencePrice:p.referencePrice,stopPrice:p.stopPrice,
    targetPrice:number(p.targetPrice),targetBasis:text(p.targetBasis),expiresAt:p.expiresAt,maxHoldMs:p.maxHoldMs,
    supportingPatternIds:(p.supportingPatternIds as unknown[]).filter(x=>typeof x==='string').slice(0,50),
    conflictingPatternIds:(p.conflictingPatternIds as unknown[]).filter(x=>typeof x==='string').slice(0,50),
    auxiliary:{formation:text(auxiliary.formation),confirmation:text(auxiliary.confirmation),entry:text(auxiliary.entry),
      invalidation:text(auxiliary.invalidation),exit:text(auxiliary.exit),observedTarget}};
};
const auxiliaryConditions=(raw:unknown)=>{
  if(!Array.isArray(raw))return [];
  return raw.slice(0,64).flatMap(value=>{
    const c=object(value);
    if(typeof c.name!=='string'||c.role!=='AUXILIARY'||typeof c.operator!=='string'
      ||(c.passed!==null&&typeof c.passed!=='boolean'))return [];
    return [{name:c.name.slice(0,120),value:number(c.value),operator:c.operator.slice(0,80),
      threshold:number(c.threshold),passed:c.passed,role:'AUXILIARY' as const}];
  });
};
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
  const entryPattern=patternEntry(audit.patternEntry??c.patternEntry,symbol,side,openedAt);
  return {source:'ENTRY_AUDIT',evaluatedAt,closedAt,momentumPct:number(c.momentum)!==null?Number(c.momentum)*100:null,
    quality:{regime:text(quality.regime),eligible:typeof quality.eligible==='boolean'?quality.eligible:null,
      reason:text(quality.reason),efficiency:number(quality.efficiency),atrPct:number(quality.atrFraction)!==null?Number(quality.atrFraction)*100:null},
    patternStatus:valid?'RECORDED':'NOT_RECORDED',patternVersion:valid?String(p.version):null,
     patternAdjustment:valid&&adjustment!==null&&Math.abs(adjustment)<=.100001?adjustment:null,frames,
     patternEntry:entryPattern,patternEntryVersion:entryPattern&&audit.patternEntryVersion==='paper-pattern-entry/v10'
       ?'paper-pattern-entry/v10':null,
     auxiliaryConditions:auxiliaryConditions(audit.auxiliaryConditions??c.auxiliaryConditions)};
}
