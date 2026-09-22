import {createHash} from 'node:crypto';
import type {VirtualPaper400CycleDeps} from './virtualPaper400Cycle';
import type {DailyPaperCandidate} from './virtualPaperDailyCandidate';
import {DAILY_PAPER_POLICY as policy,dailyPaperProfile} from './virtualPaperDailyPolicy';
import {evaluateVirtualPaper400SessionState} from './virtualPaper400SessionState';
import {evaluateVirtualPaper400Account} from './virtualPaper400Accounting';
import {buildDailyTradePlan,DAILY_ENTRY_OPTIONS,MODE_DECISION_PREFIX,modeHoldingCost} from './virtualPaperTradingMode';
import {validateExecutionEligibleSnapshot} from '../lib/costSnapshot';
export interface DailyCycleDeps extends VirtualPaper400CycleDeps {readDailyCandidates():Promise<DailyPaperCandidate[]>}
export async function runVirtualPaperDailyCycle(d:DailyCycleDeps){
  const session=evaluateVirtualPaper400SessionState(d.sessionRaw);if(!session.state)throw Error('VIRTUAL_SESSION_INVALID');
  const account=evaluateVirtualPaper400Account({session:session.state.session,previous:d.previous,rows:d.rows,now:d.now,quote:d.quote,aggressiveDaily:true});
  const diagnostics:{symbol:string;reason:string;details?:string[]}[]=[];const entryStages:{symbol:string;stage:string}[]=[];
  const mode=d.tradingMode??'INTRADAY';
  const outcome=(status:string,reason:string|null=null)=>({status,reason,diagnostics,entryStages,
    policy:{...policy,...(d.policyVersion==='virtual400-daily/v3'?{version:'virtual400-daily/v3',cooldownMinutes:60,maxDailyEntries:24}:{}),symbols:[...(d.markets?.keys()??[])],appliedAt:d.policyAppliedAt},
    tradingMode:{mode,...DAILY_ENTRY_OPTIONS[mode]},at:d.now.toISOString(),mode:'VIRTUAL_PAPER_400' as const,
    realFundsUsed:false,costBasis:'SIMULATED / ESTIMATED' as const,
    account:{...account,held:account.held.map(r=>({id:r.id,symbol:r.symbol,side:r.side,sizeUsd:r.sizeInUsd,entryPrice:r.price,stopPrice:r.stopPriceUsd,takeProfitPrice:r.takeProfitPriceUsd}))}});
  if(d.engineMode!=='PAPER'||!d.shouldContinue())return outcome('BLOCKED','PAPER_MODE_REQUIRED');
  await d.persistRisk(account.next);
  if(account.evaluation.actions.includes('CLOSE_ALL_POSITIONS')&&account.held.length){
    for(const r of account.held)if(!d.shouldContinue()||!await d.close(r,`PAPER_EXPERIMENT_${account.evaluation.state}`))return outcome('BLOCKED','PAPER_CLOSE_PENDING');
    return outcome('CLOSED');
  }
  if(!session.active)return outcome('STOPPED');
  if(d.policyVersion!==policy.version)return outcome('BLOCKED','DAILY_POLICY_NOT_APPLIED');
  if(d.entryBlockedReason)return outcome('BLOCKED',d.entryBlockedReason);
  if(!account.evaluation.entryAllowed)return outcome(account.held.length?'NO_TRADE':'BLOCKED',account.evaluation.blockReasons.join('; '));
  if(account.lastOpenAtMs!==null&&d.now.getTime()-account.lastOpenAtMs<policy.cooldownMinutes*60_000)return outcome('NO_TRADE','PAPER_ENTRY_COOLDOWN');
  const profile=dailyPaperProfile(account.equityUsd??0,d.policyAppliedAt!);
  const remainingDailyLoss=Math.max(0,account.next.risk.startOfDayEquityUsd*.1+account.next.risk.dailyLossAwareNetPnlUsd);
  const budget=Math.min(profile.derivedLimits.maxRiskPerTradeUsd,remainingDailyLoss);
  const candidates=(await d.readDailyCandidates()).sort((a,b)=>Math.abs(b.momentum)-Math.abs(a.momentum));
  for(const candidate of candidates){
    const reject=(reason:string)=>diagnostics.push({symbol:candidate.symbol,reason,details:['AGGRESSIVE_PAPER_EXPERIMENT: 미검증 모멘텀 시험; 손실 포함 기록']});
    const now=d.clock?.()??d.now;const q=d.quote(candidate.symbol);const market=d.markets?.get(candidate.symbol);
    if(!d.shouldContinue())return outcome('STOPPED');
    if(!market||!q||!Number.isFinite(q.priceUsd)||q.priceUsd<=0||!Number.isFinite(q.ageMs)||q.ageMs<0||q.ageMs>60_000
      ||candidate.source!=='gmx-official-api'||candidate.purpose!=='AGGRESSIVE_PAPER_EXPERIMENT'
      ||candidate.evaluatedAt>now.getTime()||now.getTime()-candidate.evaluatedAt>60_000
      ||candidate.closedAt>now.getTime()||now.getTime()-candidate.closedAt>960_000
      ||!Number.isFinite(candidate.referencePrice)||Math.abs(q.priceUsd/candidate.referencePrice-1)>.02){reject('PAPER_EXPERIMENT_DATA_STALE');continue;}
    const distance=candidate.stopFraction;const direction=candidate.side==='LONG'?1:-1;
    if(!Number.isFinite(distance)||distance<.002||distance>.008){reject('PAPER_EXPERIMENT_STOP_INVALID');continue;}
    // Reserve actual worst permitted costs before allocating exposure. Never add virtual capital.
    const requested=Math.min(profile.derivedLimits.maxTotalExposureUsd,Math.max(0,budget-2)/distance);
    if(requested<2.2){reject('PAPER_EXPERIMENT_BUDGET_EXHAUSTED');continue;}
    const cost=await d.readCost(candidate.symbol,direction===1,requested);
    const submitNow=d.clock?.()??d.now;const current=d.quote(candidate.symbol);
    if(!cost||cost.source!=='PAPER_GMX_ESTIMATE'||!current||!Number.isFinite(current.priceUsd)||current.priceUsd<=0||Math.abs(current.priceUsd/candidate.referencePrice-1)>.02||!Number.isFinite(current.ageMs)||current.ageMs<0||current.ageMs>60_000){reject('PAPER_EXPERIMENT_COST_OR_QUOTE');continue;}
    const checked=validateExecutionEligibleSnapshot(cost,{market:market.marketToken,isLong:direction===1,orderType:'MarketIncrease',notionalUsd:requested},submitNow.getTime());
    const holding=modeHoldingCost(cost,mode==='INTRADAY'?.5:4);
    const roundTrip=cost.positionFeeUsd+cost.estimatedExitFeeUsd+cost.executionFeeUsd+Math.max(0,cost.estimatedPriceImpactUsd)+Math.max(0,cost.estimatedExitPriceImpactUsd)+(holding??Infinity);
    if(!checked.ok||holding===null||roundTrip>2){reject('PAPER_EXPERIMENT_COST_CAP');continue;}
    const stop=current.priceUsd*(1-direction*distance);
    const planned=buildDailyTradePlan({mode,entryPrice:current.priceUsd,structuralStop:stop,notionalUsd:requested,maxLeverage:10,estimatedRoundTripCostUsd:roundTrip,riskBudgetUsd:budget,openedAtMs:submitNow.getTime()});
    if(!planned.ok){reject(planned.reason);continue;}
    const plan=planned.plan;
    if(plan.collateralUsd>profile.derivedLimits.maxMarginPerTradeUsd){reject('PAPER_EXPERIMENT_MARGIN_CAP');continue;}
    const id=MODE_DECISION_PREFIX+'daily:'+createHash('sha256').update(`${session.state.session.sessionId}:${candidate.symbol}:${candidate.closedAt}`).digest('hex');
    if(d.rows.some(r=>r.openDecisionId===id)){reject('PAPER_EXPERIMENT_DUPLICATE');continue;}
    const audit={mode:'VIRTUAL_PAPER_400',policy,sessionId:session.state.session.sessionId,candidate,
      signal:{strategyId:'PAPER_DAILY_MOMENTUM_EXPERIMENT',reasons:[`AGGRESSIVE_PAPER_EXPERIMENT: ${candidate.momentum} completed-candle momentum; losses retained; not ensemble success`],strategyTargetPrice:plan.tpPrice},
      tradePlan:plan,sizing:{finalNotionalUsd:requested},cost};
    if(!d.shouldContinue()||!await d.claim(id,audit)){reject('PAPER_EXPERIMENT_CLAIM_EXISTS');continue;}
    if(!d.shouldContinue())return outcome('STOPPED');
    entryStages.push({symbol:candidate.symbol,stage:'PAPER_EXPERIMENT_CLAIMED'});
    const result=await d.open({strategy:session.state.session.strategyTag,decisionId:id,symbol:candidate.symbol,side:candidate.side,
      sizeUsd:requested,leverage:plan.leverage,quote:current,stopPriceUsd:stop,tpPriceUsd:plan.tpPrice,
      openPositionCount:account.held.length,maxConcurrentPositions:1,riskProfileSnapshot:profile,
      entriesManilaDay:account.next.risk.dailyEntryCount,nowMs:submitNow.getTime()},cost);
    return outcome(result.ok?'OPENED':'BLOCKED',result.ok?'AGGRESSIVE_PAPER_EXPERIMENT':result.reason);
  }
  return outcome('NO_TRADE',candidates.length?'PAPER_EXPERIMENT_ENTRY_REJECTED':'PAPER_EXPERIMENT_CANDLE_UNAVAILABLE');
}
