import {describe,it,expect} from 'vitest';
import {evaluatePatternEntries} from '../intel/patterns/patternEntryStrategies';
import type {RawCandles} from '../intel/patterns/chartPatterns';
import {PATTERN_DAILY_PAPER_POLICY,evaluatePatternDailyPaperRisk} from '../workers/virtualPaperDailyPolicy';
import {buildPatternDailyTradePlan,parseVirtualTradePlan,tradingModeExit,PATTERN_DAILY_PLAN_VERSION,
  PATTERN_DAILY_ENTRY_OPTIONS} from '../workers/virtualPaperTradingMode';
import {runVirtualPaperPatternDailyCycle,isValidPatternEntryAudit,type PatternDailyCandidate} from '../workers/virtualPaperPatternDailyCycle';
import {buildActiveVirtualPaper400SessionState} from '../workers/virtualPaper400SessionState';
import {initialVirtualPaper400RiskState} from '../workers/virtualPaper400Accounting';
import {MARKET_BY_SYMBOL_SERVER} from '../lib/gmxMarkets';
import {EMPTY_LOCKS} from '../lib/riskStateMachine';
import {virtualReplayCost} from './helpers/virtualPaper400Replay';

const step=900_000,base=Math.floor(Date.now()/step)*step-step*70,now=base+70*step;
const patternRaw=():RawCandles=>{
  const prices:number[][]=[];
  for(let i=0;i<67;i++)prices.push([base+i*step,100,100.1,99.9,100.05]);
  prices.push([base+67*step,100,100.2,99.8,100]);
  prices.push([base+68*step,100,100.3,99.9,100.21]);
  return {source:'gmx-official-api',prices};
};
const issued=()=>{
  const result=evaluatePatternEntries('BTC',{'15m':patternRaw()},now,'INTRADAY');
  const candidate=result.candidates.find(c=>c.patternId==='DOJI');
  if(!candidate)throw Error('real engine-issued fixture missing');
  return candidate;
};
function deps(candidate:PatternDailyCandidate,options:{cost?:'ok'|'missing'|'over';claim?:boolean;continue?:boolean;openFailure?:boolean}={}){
  const session=buildActiveVirtualPaper400SessionState('pattern-daily-test',new Date(now-60_000));
  const initial=initialVirtualPaper400RiskState(session.session);
  const opens:unknown[]=[],claims=new Set<string>();
  const d={
    sessionRaw:JSON.stringify(session),policyVersion:PATTERN_DAILY_PAPER_POLICY.version,
    policyAppliedAt:new Date(now-1000).toISOString(),tradingMode:'INTRADAY' as const,
    previous:initial,rows:[],now:new Date(now),clock:()=>new Date(now),engineMode:'PAPER',
    markets:new Map([['BTC',MARKET_BY_SYMBOL_SERVER.get('BTC')!]]),
    quote:(symbol:string)=>symbol==='BTC'?{priceUsd:100.21,ageMs:1}:null,
    shouldContinue:()=>options.continue!==false,persistRisk:async()=>{},readSignals:async()=>[],
    readPatternCandidates:async()=>[candidate],
    readCost:async(_symbol:string,_isLong:boolean,notional:number)=>{
      if(options.cost==='missing')return null;
      const cost=virtualReplayCost(now,notional);
      if(options.cost==='over')cost.positionFeeUsd=3;
      return cost;
    },
    claim:async(id:string)=>{if(options.claim===false||claims.has(id))return false;claims.add(id);return true;},
    open:async(args:unknown)=>{opens.push(args);return options.openFailure
      ?{ok:false as const,reason:'EXECUTOR_OPEN_UNCERTAIN'}
      :{ok:true as const,tradeId:'paper-open',stopPriceUsd:candidate.patternEntry.stopPrice,
        tpPriceUsd:candidate.patternEntry.targetPrice};},
    close:async()=>true,reduce:async()=>true,
  };
  return {d,opens,claims};
}
const asCandidate=(patternEntry=issued()):PatternDailyCandidate=>({patternEntry,auxiliaryConditions:[
  {name:'v9_net_rr',value:.2,operator:'>=',threshold:1.5,passed:false,role:'AUXILIARY'},
]});

describe('PAPER daily pattern-entry v10',()=>{
  it('opens an engine-issued stop/time-exit opportunity with no observed target and low-RR auxiliary evidence',async()=>{
    const {d,opens}=deps(asCandidate());
    const result=await runVirtualPaperPatternDailyCycle(d);
    expect(result.status).toBe('OPENED');
    expect(opens).toHaveLength(1);
    expect((opens[0] as {tpPriceUsd:number|null}).tpPriceUsd).toBeNull();
    expect(result.entryEvaluations[0]).toMatchObject({policyVersion:'virtual400-daily/v10',
      patternEntryVersion:'paper-pattern-entry/v10',eligible:true});
    expect(result.entryEvaluations[0].auxiliaryConditions).toContainEqual(expect.objectContaining({
      name:'v9_net_rr',passed:false,role:'AUXILIARY'}));
    expect(result.entryEvaluations[0].auxiliaryConditions.some(c=>c.name.includes('net_reward_risk')&&c.passed===false)).toBe(false);
    expect(result.tradingMode).toMatchObject({targetRoePct:null,minTargetRoePct:null,maxTargetRoePct:null,maxHoldHours:1,
      maxHoldMs:3_600_000,exitBasis:'OBSERVED_PATTERN_STOP_OR_TIME_EXIT'});
  });
  it('persists a nullable-target, max-hold pattern plan and accepts it without an RR gate',()=>{
    const event=issued();
    const plan=buildPatternDailyTradePlan({mode:'INTRADAY',entryPrice:100.21,structuralStop:event.stopPrice,
      targetPrice:null,maxHoldMs:event.maxHoldMs,notionalUsd:400,maxLeverage:10,estimatedRoundTripCostUsd:.5,
      riskBudgetUsd:4,openedAtMs:now});
    expect(plan.ok).toBe(true);
    if(!plan.ok)return;
    expect(plan.plan).toMatchObject({version:PATTERN_DAILY_PLAN_VERSION,tpPrice:null,maxHoldMs:event.maxHoldMs});
    expect(parseVirtualTradePlan(JSON.parse(JSON.stringify(plan.plan)))).toEqual(plan.plan);
    const row={timestamp:new Date(now),sizeInUsd:'400',price:'100.21',side:'LONG',estEntryCostUsd:'0.9',
      estExitCostUsd:'0.7',fundingRatePerHour:'0.00001',borrowingRatePerHour:'0.00002'};
    expect(tradingModeExit(row as never,plan.plan,100.21,plan.plan.expiresAtMs-1)).toBeNull();
    expect(tradingModeExit(row as never,plan.plan,100.21,plan.plan.expiresAtMs)).toBe('MODE_TIME_EXIT');
  });
  it('restricts executor evidence to the canonical 38 registry IDs and supported entry frames',()=>{
    const evidence=issued();
    expect(isValidPatternEntryAudit(evidence)).toBe(true);
    expect(isValidPatternEntryAudit({...evidence,patternId:'MADE_UP_PATTERN'})).toBe(false);
    expect(isValidPatternEntryAudit({...evidence,timeframe:'1d'})).toBe(false);
  });
  it('publishes nullable no-target return options with mode-derived hold horizons',()=>{
    expect(PATTERN_DAILY_ENTRY_OPTIONS.INTRADAY).toMatchObject({targetRoePct:null,minTargetRoePct:null,
      maxTargetRoePct:null,maxHoldHours:1,exitBasis:'OBSERVED_PATTERN_STOP_OR_TIME_EXIT'});
    expect(PATTERN_DAILY_ENTRY_OPTIONS.SWING).toMatchObject({targetRoePct:null,minTargetRoePct:null,
      maxTargetRoePct:null,maxHoldHours:4,exitBasis:'OBSERVED_PATTERN_STOP_OR_TIME_EXIT'});
  });
  it.each([
    {cost:'missing' as const,reason:'PATTERN_COST_UNAVAILABLE_OR_INVALID'},
    {cost:'over' as const,reason:'PATTERN_COST_CAP'},
  ])('fails closed when exact estimated cost is unavailable or over budget',async({cost,reason})=>{
    const {d,opens}=deps(asCandidate(),{cost});
    const result=await runVirtualPaperPatternDailyCycle(d);
    expect(result.status).toBe('NO_TRADE');
    expect(result.diagnostics.some(row=>row.reason===reason)).toBe(true);
    expect(opens).toHaveLength(0);
  });
  it('does not re-claim/open the same stable event and refuses a canceled worker generation',async()=>{
    const {d,opens}=deps(asCandidate(),{claim:false});
    const duplicate=await runVirtualPaperPatternDailyCycle(d);
    expect(duplicate.diagnostics.some(row=>row.reason==='PATTERN_EVENT_CLAIM_EXISTS')).toBe(true);
    expect(opens).toHaveLength(0);
    const canceled=deps(asCandidate(),{continue:false});
    const stopped=await runVirtualPaperPatternDailyCycle(canceled.d);
    expect(stopped.status).toBe('BLOCKED');
    expect(canceled.opens).toHaveLength(0);
  });
  it('keeps a failed or uncertain claimed OPEN consumed for at-most-once event execution',async()=>{
    const {d,opens}=deps(asCandidate(),{openFailure:true});
    const failed=await runVirtualPaperPatternDailyCycle(d);
    expect(failed.status).toBe('BLOCKED');
    expect(opens).toHaveLength(1);
    const retry=await runVirtualPaperPatternDailyCycle(d);
    expect(retry.diagnostics.some(row=>row.reason==='PATTERN_EVENT_CLAIM_EXISTS')).toBe(true);
    expect(opens).toHaveLength(1);
  });
  it('keeps daily/weekly/cumulative, unresolved, held-position guards but not v9 count/profit/cooldown screens',()=>{
    const input={equity:600,referenceCapital:400,dailyLossAware:0,dailyRealized:120,entries:1000,held:0,fresh:true,
      locks:{...EMPTY_LOCKS},weeklyLossAware:0};
    expect(evaluatePatternDailyPaperRisk(input).entryAllowed).toBe(true);
    expect(evaluatePatternDailyPaperRisk({...input,dailyLossAware:-20}).entryAllowed).toBe(false);
    expect(evaluatePatternDailyPaperRisk({...input,weeklyLossAware:-40}).entryAllowed).toBe(false);
    expect(evaluatePatternDailyPaperRisk({...input,equity:280}).entryAllowed).toBe(false);
    expect(evaluatePatternDailyPaperRisk({...input,locks:{...EMPTY_LOCKS,unresolvedReason:'pending'}}).entryAllowed).toBe(false);
    expect(evaluatePatternDailyPaperRisk({...input,held:1}).entryAllowed).toBe(false);
  });
  it('does not fabricate direction from neutral or opposite evidence',async()=>{
    const result=evaluatePatternEntries('BTC',{'15m':patternRaw()},now,'INTRADAY');
    const {d,opens}=deps({patternEntry:{...issued(),conflictingPatternIds:['BEARISH_ENGULFING']},auxiliaryConditions:[]});
    const conflicted=await runVirtualPaperPatternDailyCycle(d);
    expect(conflicted.status).toBe('NO_TRADE');
    expect(opens).toHaveLength(0);
    expect(result.candidates.some(c=>c.direction!=='LONG'&&c.direction!=='SHORT')).toBe(false);
  });
});