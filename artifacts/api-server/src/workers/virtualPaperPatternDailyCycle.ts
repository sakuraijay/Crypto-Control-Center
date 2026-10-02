import { createHash } from 'node:crypto';
import type { CostSnapshot } from '../lib/costSnapshot';
import { validateExecutionEligibleSnapshot } from '../lib/costSnapshot';
import { isIssuedPatternEntry, PATTERN_ENTRY_VERSION, CANONICAL_PATTERN_ENTRY_REGISTRY,
  type PatternEntryEvidence } from '../intel/patterns/patternEntryStrategies';
import type { VirtualPaper400CycleDeps } from './virtualPaper400Cycle';
import { PATTERN_DAILY_PAPER_POLICY, dailyPaperProfile, dailyPaperRiskPct } from './virtualPaperDailyPolicy';
import { evaluateVirtualPaper400SessionState } from './virtualPaper400SessionState';
import { evaluateVirtualPaper400Account } from './virtualPaper400Accounting';
import { modeHoldingCost, MODE_DECISION_PREFIX, buildPatternDailyTradePlan,
  PATTERN_DAILY_ENTRY_OPTIONS,type VirtualTradePlan } from './virtualPaperTradingMode';

export type PatternAuxiliaryCondition = {
  name:string;value:number|null;operator:string;threshold:number|null;passed:boolean|null;role:'AUXILIARY';
};
export type PatternDailyCandidate = {
  patternEntry:PatternEntryEvidence;
  auxiliaryConditions:PatternAuxiliaryCondition[];
};
export type PatternEntryEvaluation = {
  eventId:string;durableFormationId:string;symbol:string;policyVersion:'virtual400-daily/v10';
  patternEntryVersion:typeof PATTERN_ENTRY_VERSION;evaluatedAt:string;eligible:boolean;reason:string;
  direction:'LONG'|'SHORT';formationAt:number;confirmedAt:number;triggerPrice:number;referencePrice:number;
  observedStopPrice:number;observedTargetPrice:number|null;stopDistanceFraction:number|null;
  auxiliaryConditions:PatternAuxiliaryCondition[];
};
export interface PatternDailyCycleDeps extends VirtualPaper400CycleDeps {
  readPatternCandidates():Promise<PatternDailyCandidate[]>;
}
type Quote=NonNullable<ReturnType<PatternDailyCycleDeps['quote']>>;
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const canonicalPatternIds=new Set(CANONICAL_PATTERN_ENTRY_REGISTRY.map(p=>p.patternId));
const entryTimeframes=new Set(['15m','1h','4h']);
const entryTimeframeMs:Record<string,number>={'15m':900_000,'1h':3_600_000,'4h':14_400_000};
export function isValidPatternEntryAudit(value:unknown):value is PatternEntryEvidence {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const p=value as Partial<PatternEntryEvidence>;
  return p.eventId===p.durableFormationId&&typeof p.eventId==='string'&&p.eventId.length>0&&p.eventId.length<=240
    &&typeof p.symbol==='string'&&/^[A-Z0-9_]{1,24}$/.test(p.symbol)
     &&typeof p.patternId==='string'&&canonicalPatternIds.has(p.patternId)
     &&entryTimeframes.has(String(p.timeframe))
     &&p.formationAt!<=p.confirmedAt!
     &&p.expiresAt===p.confirmedAt!+entryTimeframeMs[String(p.timeframe)]!*3
     &&p.targetPrice===null&&p.targetBasis===null
    &&(p.direction==='LONG'||p.direction==='SHORT')
    &&[p.formationAt,p.confirmedAt,p.triggerPrice,p.referencePrice,p.stopPrice,p.expiresAt,p.maxHoldMs]
      .every(n=>finite(n)&&n>0)
     &&[3_600_000,14_400_000].includes(Number(p.maxHoldMs))
    &&(p.targetPrice===null||finite(p.targetPrice)&&p.targetPrice>0)
     &&Array.isArray(p.supportingPatternIds)&&p.supportingPatternIds.length>0
     &&p.supportingPatternIds.every(id=>typeof id==='string'&&canonicalPatternIds.has(id))
     &&Array.isArray(p.conflictingPatternIds)&&p.conflictingPatternIds.every(id=>typeof id==='string'&&canonicalPatternIds.has(id))
    &&!!p.auxiliary&&typeof p.auxiliary==='object'
    &&['formation','confirmation','entry','invalidation','exit'].every(k=>typeof (p.auxiliary as Record<string,unknown>)[k]==='string')
     &&(p.auxiliary as Record<string,unknown>).observedTarget===null;
}
const aux=(name:string,value:number|null,operator:string,threshold:number|null,passed:boolean|null):PatternAuxiliaryCondition=>
  ({name,value,operator,threshold,passed,role:'AUXILIARY'});
const riskBudgetFor=(account:ReturnType<typeof evaluateVirtualPaper400Account>,profileRisk:number)=>{
  const daily=account.dailyBudget?.remainingLossBudgetUsd??0;
  const weekly=Math.max(0,account.ledger.fundedCapitalUsd*.10+account.next.risk.weeklyRealizedNetPnlUsd);
  const cumulative=Math.max(0,(account.equityUsd??0)-account.ledger.fundedCapitalUsd*.70);
  return Math.min(profileRisk,daily,weekly,cumulative);
};
const roundTrip=(cost:CostSnapshot,holding:number|null)=>holding===null?null:
  cost.positionFeeUsd+cost.estimatedExitFeeUsd+cost.executionFeeUsd+cost.fundingFeeUsd+cost.borrowingFeeUsd
    +Math.max(0,cost.estimatedPriceImpactUsd)+Math.max(0,cost.estimatedExitPriceImpactUsd)+holding;

/** v10 path consumes only same-process engine-issued evidence. It deliberately
 * never runs v7/v8/v9 selection, RR, momentum, regime, ATR, or score admission. */
export async function runVirtualPaperPatternDailyCycle(d:PatternDailyCycleDeps){
  const session=evaluateVirtualPaper400SessionState(d.sessionRaw);
  if(!session.state)throw Error('VIRTUAL_SESSION_INVALID');
  const account=evaluateVirtualPaper400Account({session:session.state.session,previous:d.previous,rows:d.rows,now:d.now,
    quote:d.quote,aggressiveDaily:true,patternDaily:true});
  const diagnostics:{symbol:string;reason:string;details?:string[]}[]=[];
  const entryStages:{symbol:string;stage:string}[]=[];
  const entryEvaluations:PatternEntryEvaluation[]=[];
  const outcome=(status:string,reason:string|null=null)=>({
    status,reason,diagnostics,entryStages,entryEvaluations,policy:{...PATTERN_DAILY_PAPER_POLICY,
      symbols:[...(d.markets?.keys()??[])],appliedAt:d.policyAppliedAt},
    tradingMode:{mode:d.tradingMode??'INTRADAY',...PATTERN_DAILY_ENTRY_OPTIONS[d.tradingMode??'INTRADAY'],
      exitBasis:'OBSERVED_PATTERN_STOP_OR_TIME_EXIT',
      maxHoldMs:d.tradingMode==='SWING'?14_400_000:3_600_000,minimumNetRewardRisk:null,
      purpose:PATTERN_DAILY_PAPER_POLICY.purpose},
    at:d.now.toISOString(),mode:'VIRTUAL_PAPER_400' as const,realFundsUsed:false,
    costBasis:'SIMULATED / ESTIMATED' as const,
    account:{...account,held:account.held.map(r=>({id:r.id,symbol:r.symbol,side:r.side,sizeUsd:r.sizeInUsd,
      entryPrice:r.price,stopPrice:r.stopPriceUsd,takeProfitPrice:r.takeProfitPriceUsd}))},
  });
  if(d.engineMode!=='PAPER'||!d.shouldContinue())return outcome('BLOCKED','PAPER_MODE_REQUIRED');
  await d.persistRisk(account.next);
  if(account.evaluation.actions.includes('CLOSE_ALL_POSITIONS')&&account.held.length){
    for(const row of account.held)if(!d.shouldContinue()||!await d.close(row,`PAPER_EXPERIMENT_${account.evaluation.state}`))
      return outcome('BLOCKED','PAPER_CLOSE_PENDING');
    return outcome('CLOSED');
  }
  if(!session.active)return outcome('STOPPED');
  if(d.policyVersion!==PATTERN_DAILY_PAPER_POLICY.version)return outcome('BLOCKED','PATTERN_POLICY_NOT_APPLIED');
  if(d.entryBlockedReason)return outcome('BLOCKED',d.entryBlockedReason);
  if(!account.evaluation.entryAllowed)return outcome(account.held.length?'NO_TRADE':'BLOCKED',account.evaluation.blockReasons.join('; '));
  if(account.held.length)return outcome('NO_TRADE','PAPER_POSITION_HELD');
  const appliedAt=d.policyAppliedAt;
  if(!appliedAt)return outcome('BLOCKED','PATTERN_POLICY_APPLIED_AT_MISSING');
  const riskPct=dailyPaperRiskPct(account.next.risk.consecutiveLossCount,null,d.now.getTime());
  const profile=dailyPaperProfile(account.equityUsd??0,appliedAt,riskPct);
  const budget=riskBudgetFor(account,profile.derivedLimits.maxRiskPerTradeUsd);
  if(!finite(budget)||budget<=2)return outcome('NO_TRADE','PAPER_RISK_BUDGET_EXHAUSTED');

  let candidates:PatternDailyCandidate[];
  try{candidates=await d.readPatternCandidates();}
  catch{return outcome('NO_TRADE','PATTERN_ENTRY_EVIDENCE_UNAVAILABLE');}
  const ranked=[...candidates].sort((a,b)=>a.patternEntry.confirmedAt-b.patternEntry.confirmedAt
    ||a.patternEntry.timeframe.localeCompare(b.patternEntry.timeframe)
    ||a.patternEntry.eventId.localeCompare(b.patternEntry.eventId));
  for(const item of ranked){
    const evidence=item?.patternEntry;
    if(!evidence||!isIssuedPatternEntry(evidence)||!isValidPatternEntryAudit(evidence)
       ||!d.markets?.has(evidence.symbol)||evidence.conflictingPatternIds.length>0){
      if(evidence?.symbol)diagnostics.push({symbol:evidence.symbol,reason:'PATTERN_EVIDENCE_UNISSUED_OR_CONFLICTED'});
      continue;
    }
    const at=d.clock?.()??d.now;
    const record:PatternEntryEvaluation={eventId:evidence.eventId,durableFormationId:evidence.durableFormationId,
      symbol:evidence.symbol,policyVersion:'virtual400-daily/v10',patternEntryVersion:PATTERN_ENTRY_VERSION,
      evaluatedAt:at.toISOString(),eligible:false,reason:'PATTERN_EVENT_EVALUATED',direction:evidence.direction,
      formationAt:evidence.formationAt,confirmedAt:evidence.confirmedAt,triggerPrice:evidence.triggerPrice,
      referencePrice:evidence.referencePrice,observedStopPrice:evidence.stopPrice,
      observedTargetPrice:evidence.targetPrice,stopDistanceFraction:null,auxiliaryConditions:item.auxiliaryConditions};
    entryEvaluations.push(record);
    const reject=(reason:string)=>{record.reason=reason;diagnostics.push({symbol:evidence.symbol,reason});};
    if(!d.shouldContinue())return outcome('STOPPED');
    const requiredHoldMs=(d.tradingMode??'INTRADAY')==='INTRADAY'?3_600_000:14_400_000;
    if(evidence.maxHoldMs!==requiredHoldMs){reject('PATTERN_HOLD_HORIZON_MISMATCH');continue;}
    const now=at.getTime(),q=d.quote(evidence.symbol),market=d.markets!.get(evidence.symbol);
    const quoteFresh=!!q&&finite(q.priceUsd)&&q.priceUsd>0&&finite(q.ageMs)&&q.ageMs>=0&&q.ageMs<=60_000;
    if(!quoteFresh||!market){reject('PATTERN_QUOTE_OR_MARKET_UNAVAILABLE');continue;}
    if(!finite(evidence.confirmedAt)||evidence.confirmedAt>now
      ||now>evidence.expiresAt||!finite(evidence.maxHoldMs)||evidence.maxHoldMs<=0
      ||evidence.formationAt>evidence.confirmedAt||evidence.referencePrice<=0){
      reject('PATTERN_EVENT_STALE_OR_INVALID');continue;
    }
    const entry=q!.priceUsd,side=evidence.direction;
    const triggerValid=side==='LONG'?entry+1e-10>=evidence.triggerPrice:entry-1e-10<=evidence.triggerPrice;
    if(!triggerValid){reject('PATTERN_TRIGGER_NOT_CURRENT');continue;}
    const deviation=Math.abs(entry/evidence.referencePrice-1);
    if(!finite(deviation)||deviation>.02){reject('PATTERN_REFERENCE_PRICE_DRIFT');continue;}
    const stop=evidence.stopPrice;
    const stopDistance=Math.abs(entry-stop)/entry;
    record.stopDistanceFraction=finite(stopDistance)?stopDistance:null;
    if(!finite(stop)||stop<=0||(side==='LONG'?stop>=entry:stop<=entry)){reject('PATTERN_OBSERVED_STOP_WRONG_SIDE');continue;}
    if(stopDistance<.002-1e-10||stopDistance>.008+1e-10){reject('PATTERN_OBSERVED_STOP_OUTSIDE_EXECUTOR_BOUNDS');continue;}
    const requested=Math.min(profile.derivedLimits.maxTotalExposureUsd,
      profile.derivedLimits.maxMarginPerTradeUsd*PATTERN_DAILY_PAPER_POLICY.maxLeverage,
      PATTERN_DAILY_PAPER_POLICY.maxNotionalUsd,Math.max(0,budget-2)/stopDistance);
    if(!finite(requested)||requested<2.2){reject('PATTERN_RISK_BUDGET_AFTER_COST');continue;}
    entryStages.push({symbol:evidence.symbol,stage:'PATTERN_SIGNAL_VALIDATED'});
    const cost=await d.readCost(evidence.symbol,side==='LONG',requested);
    const checkedAt=d.clock?.()??d.now;
    if(!cost||cost.source!=='PAPER_GMX_ESTIMATE'||!validateExecutionEligibleSnapshot(cost,{
      market:market.marketToken,isLong:side==='LONG',orderType:'MarketIncrease',notionalUsd:requested},checkedAt.getTime()).ok){
      reject('PATTERN_COST_UNAVAILABLE_OR_INVALID');continue;
    }
    const holdCost=modeHoldingCost(cost,evidence.maxHoldMs/3_600_000);
    const totalCost=roundTrip(cost,holdCost);
    if(totalCost===null||!finite(totalCost)||totalCost<=0){reject('PATTERN_HOLDING_COST_UNAVAILABLE');continue;}
    if(totalCost>PATTERN_DAILY_PAPER_POLICY.maxRoundTripCostUsd+1e-8){reject('PATTERN_COST_CAP');continue;}
    const priceRisk=requested*stopDistance;
    if(priceRisk+2>budget+1e-8){reject('PATTERN_ACCOUNT_RISK_CAP');continue;}
    const current=d.quote(evidence.symbol),submitAt=d.clock?.()??d.now;
    if(!d.shouldContinue()||!current||current.priceUsd!==entry||!finite(current.ageMs)||current.ageMs<0||current.ageMs>60_000
      ||submitAt.getTime()>evidence.expiresAt
      ||!validateExecutionEligibleSnapshot(cost,{market:market.marketToken,isLong:side==='LONG',
        orderType:'MarketIncrease',notionalUsd:requested},submitAt.getTime()).ok){
      reject('PATTERN_RANKED_QUOTE_CHANGED');continue;
    }
    const refreshedStopDistance=Math.abs(current.priceUsd-stop)/current.priceUsd;
    if((side==='LONG'?stop>=current.priceUsd:stop<=current.priceUsd)
      ||refreshedStopDistance<.002-1e-10||refreshedStopDistance>.008+1e-10){
      reject('PATTERN_EXECUTION_STOP_INVALID');continue;
    }
    const planned=buildPatternDailyTradePlan({mode:d.tradingMode??'INTRADAY',entryPrice:current.priceUsd,
      structuralStop:stop,targetPrice:evidence.targetPrice,maxHoldMs:evidence.maxHoldMs,
      notionalUsd:requested,maxLeverage:PATTERN_DAILY_PAPER_POLICY.maxLeverage,
      estimatedRoundTripCostUsd:totalCost,riskBudgetUsd:budget,openedAtMs:submitAt.getTime()});
    if(!planned.ok){reject(planned.reason);continue;}
    const plan=planned.plan;
    const day=d.rows.filter(r=>r.action==='OPEN'&&new Date(r.timestamp).toDateString()===submitAt.toDateString()).length;
    const auxiliaryConditions=[...item.auxiliaryConditions,
      aux('historical_v9_cooldown_minutes',account.lastOpenAtMs===null?null:(submitAt.getTime()-account.lastOpenAtMs)/60_000,
        '>=',45,account.lastOpenAtMs===null||(submitAt.getTime()-account.lastOpenAtMs)>=45*60_000),
      aux('historical_v9_daily_entry_count',day,'<',32,day<32),
      aux('observed_target_move_fraction',evidence.targetPrice===null?null:Math.abs(evidence.targetPrice/current.priceUsd-1),
        'OBSERVATIONAL_ONLY',null,null),
      aux('conditional_target_gross_pnl_usd',evidence.targetPrice===null?null:
        requested*(evidence.targetPrice/current.priceUsd-1)*(side==='LONG'?1:-1),'OBSERVATIONAL_ONLY',null,null)];
    record.auxiliaryConditions=auxiliaryConditions;record.eligible=true;record.reason='PATTERN_PLAN_ACCEPTED';
    const id=MODE_DECISION_PREFIX+'pattern:'+createHash('sha256')
      .update(`${session.state.session.sessionId}:${evidence.eventId}`).digest('hex');
    if(d.rows.some(r=>r.openDecisionId===id)){reject('PATTERN_EVENT_ALREADY_CLAIMED');continue;}
    const audit={mode:'VIRTUAL_PAPER_400',policy:PATTERN_DAILY_PAPER_POLICY,policyVersion:'virtual400-daily/v10',
      sessionId:session.state.session.sessionId,patternEntry:evidence,patternEntryVersion:PATTERN_ENTRY_VERSION,
      auxiliaryConditions,selection:{kind:'V10_PATTERN_EVENT',riskPct},
      candidate:{symbol:evidence.symbol,side,source:'gmx-official-api',purpose:'PATTERN_ENTRY_EVIDENCE',
        evaluatedAt:now,closedAt:evidence.confirmedAt,referencePrice:evidence.referencePrice,
        stopFraction:stopDistance,patternEntry:evidence,auxiliaryConditions},
      signal:{strategyId:'PAPER_V10_PATTERN_ENTRY',reasons:[`${evidence.patternId} ${evidence.timeframe} ${side}; event ${evidence.eventId}`],
        strategyTargetPrice:evidence.targetPrice},tradePlan:plan,sizing:{finalNotionalUsd:requested},cost};
    if(!d.shouldContinue()||!await d.claim(id,audit)){reject('PATTERN_EVENT_CLAIM_EXISTS');continue;}
    entryStages.push({symbol:evidence.symbol,stage:'PATTERN_EVENT_CLAIMED'});
    const result=await d.open({strategy:session.state.session.strategyTag,decisionId:id,symbol:evidence.symbol,side,
      sizeUsd:requested,leverage:plan.leverage,quote:current,stopPriceUsd:stop,tpPriceUsd:evidence.targetPrice,
      openPositionCount:account.held.length,maxConcurrentPositions:1,riskProfileSnapshot:profile,
      entriesManilaDay:account.next.risk.dailyEntryCount,nowMs:submitAt.getTime()},cost);
    if(!result.ok)reject(result.reason);
    else record.reason='PATTERN_EVENT_OPENED';
    return outcome(result.ok?'OPENED':'BLOCKED',result.ok?'PATTERN_EVENT_OPENED':result.reason);
  }
  return outcome('NO_TRADE',candidates.length?'PATTERN_ENTRY_CANDIDATES_REJECTED':'NO_ISSUED_PATTERN_ENTRY');
}