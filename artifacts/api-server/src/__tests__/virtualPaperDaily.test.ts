import {describe,it,expect,vi} from 'vitest';
import {dailyPaperCandidate, type DailyPaperCandidate} from '../workers/virtualPaperDailyCandidate';
import {dailyPaperProfile,isDailyPaperProfile,evaluateDailyPaperRisk,DAILY_PAPER_POLICY,dailyPaperBudget} from '../workers/virtualPaperDailyPolicy';
import {buildAdaptiveDailyTradePlan,buildDailyTradePlan,parseVirtualTradePlan,LEGACY_DAILY_PLAN_VERSION,ADAPTIVE_DAILY_PLAN_VERSION} from '../workers/virtualPaperTradingMode';
import {EMPTY_LOCKS} from '../lib/riskStateMachine';
import {isAppliedRiskProfileSnapshot} from '../lib/riskProfiles';
import {runVirtualPaperDailyCycle, type PairedDailyCandidateComparison, type PaperEntryEvaluation} from '../workers/virtualPaperDailyCycle';
import {buildActiveVirtualPaper400SessionState} from '../workers/virtualPaper400SessionState';
import {initialVirtualPaper400RiskState} from '../workers/virtualPaper400Accounting';
import {MARKET_BY_SYMBOL_SERVER} from '../lib/gmxMarkets';
import {virtualReplayCost} from './helpers/virtualPaper400Replay';
const now=Date.parse('2026-09-22T03:00:10Z'),step=900000;
const raw=()=>({source:'gmx-official-api',prices:Array.from({length:16},(_,i)=>[(Math.floor(now/step)-16+i)*step/1000,50000+i,50100+i,49900+i,50010+i])});
const riskInput=()=>({equity:380,referenceCapital:400,dailyLossAware:-10,dailyRealized:-10,entries:10,held:0,fresh:true,locks:{...EMPTY_LOCKS}});
describe('explicit aggressive PAPER experiment',()=>{
 it.each([500,1000,2000])('scales daily goals and loss budget with funded principal %s, retaining accrued loss',capital=>{
  const budget=dailyPaperBudget(capital,-30,-40);
  expect(budget.profitTargetMinUsd).toBe(capital*.05);
  expect(budget.profitCapUsd).toBe(capital*.20);
  expect(budget.lossLimitUsd).toBe(capital*.05);
  expect(budget.remainingLossBudgetUsd).toBe(Math.max(0,capital*.05-40));
  const input={...riskInput(),referenceCapital:capital,equity:capital-40};
  expect(evaluateDailyPaperRisk({...input,dailyLossAware:-capital*.05}).state).toBe('DAILY_LOSS_LOCKED');
  expect(evaluateDailyPaperRisk({...input,dailyRealized:capital*.05}).entryAllowed).toBe(true);
  expect(evaluateDailyPaperRisk({...input,dailyRealized:capital*.20}).state).toBe('PROFIT_CAP_LOCKED');
  expect(evaluateDailyPaperRisk({...input,locks:{...EMPTY_LOCKS,dailyLockState:'DAILY_LOSS_LOCKED'}}).entryAllowed).toBe(false);
 });
 it('fails closed for invalid principal and budgets',()=>{
  for(const capital of [0,-1,NaN,Infinity]) {
   expect(()=>dailyPaperBudget(capital,0,0)).toThrow();
   expect(evaluateDailyPaperRisk({...riskInput(),referenceCapital:capital}).entryAllowed).toBe(false);
  }
 });
 it('uses completed real-source OHLC and excludes unfinished/future or stale candles',()=>{
  expect(dailyPaperCandidate('BTC',raw(),now)).toMatchObject({side:'LONG',purpose:'AGGRESSIVE_PAPER_EXPERIMENT'});
  expect(dailyPaperCandidate('BTC',{...raw(),source:'synthetic'},now)).toBeNull();
  expect(dailyPaperCandidate('BTC',raw(),now+step+60001)).toBeNull();
  const bad=raw();bad.prices[8][0]+=1;expect(dailyPaperCandidate('BTC',bad,now)).toBeNull();
  const unfinished=raw();unfinished.prices.push([Math.floor(now/step)*step/1000,100,1e9,1,1e8]);
  expect(dailyPaperCandidate('BTC',unfinished,now)).toEqual(dailyPaperCandidate('BTC',raw(),now));
 });
 it('tolerates losses and more than three entries, preserving hard/unresolved and day limits',()=>{
  expect(evaluateDailyPaperRisk(riskInput()).entryAllowed).toBe(true);
  expect(evaluateDailyPaperRisk({...riskInput(),dailyLossAware:-40}).state).toBe('DAILY_LOSS_LOCKED');
  expect(evaluateDailyPaperRisk({...riskInput(),locks:{...EMPTY_LOCKS,hardStopReason:'existing'}}).entryAllowed).toBe(false);
  expect(evaluateDailyPaperRisk({...riskInput(),entries:32}).entryAllowed).toBe(false);
  expect(evaluateDailyPaperRisk({...riskInput(),held:1}).entryAllowed).toBe(false);
  expect(evaluateDailyPaperRisk({...riskInput(),fresh:false}).entryAllowed).toBe(false);
 });
 it('locks at net 20%, preserves the day lock through restart, never requests profit-cap liquidation',()=>{
  const below={...riskInput(),dailyRealized:79.99,dailyLossAware:79.99};
  expect(evaluateDailyPaperRisk(below).entryAllowed).toBe(true);
  const capped=evaluateDailyPaperRisk({...below,dailyRealized:80,held:1});
  expect(capped.state).toBe('PROFIT_CAP_LOCKED');expect(capped.actions).toEqual([]);
  expect(evaluateDailyPaperRisk({...below,fresh:false,locks:capped.locks}).locks.dailyLockState).toBe('PROFIT_CAP_LOCKED');
  expect(evaluateDailyPaperRisk({...below,locks:JSON.parse(JSON.stringify(capped.locks))}).entryAllowed).toBe(false);
  expect(evaluateDailyPaperRisk({...below,dailyRealized:NaN}).entryAllowed).toBe(false);
 });
 it('restores old 30-minute plans without extending them and rejects forged expiry',()=>{
  const input={mode:'INTRADAY' as const,entryPrice:50000,structuralStop:49700,notionalUsd:1000,maxLeverage:10,estimatedRoundTripCostUsd:.1,riskBudgetUsd:8,openedAtMs:now};
  const old=buildDailyTradePlan(input,true),current=buildDailyTradePlan(input);
  if(!old.ok||!current.ok)throw Error('fixture');
  expect(old.plan.version).toBe(LEGACY_DAILY_PLAN_VERSION);
  expect(parseVirtualTradePlan(old.plan)?.expiresAtMs).toBe(now+1800000);
  expect(current.plan.expiresAtMs).toBe(now+3600000);
  expect(parseVirtualTradePlan({...old.plan,expiresAtMs:current.plan.expiresAtMs})).toBeNull();
 });
 it('keeps experimental profiles outside Standard/LIVE validation and refuses forgery',()=>{
  const p=dailyPaperProfile(400,new Date(now).toISOString());expect(isDailyPaperProfile(p)).toBe(true);
  expect(isAppliedRiskProfileSnapshot(p)).toBe(false);p.derivedLimits.maxLeverage=11;expect(isDailyPaperProfile(p)).toBe(false);
 });
 it.each(['INTRADAY','SWING'] as const)('restores immutable %s plans',mode=>{
  const p=buildDailyTradePlan({mode,entryPrice:50000,structuralStop:49700,notionalUsd:1000,maxLeverage:10,estimatedRoundTripCostUsd:.1,riskBudgetUsd:8,openedAtMs:now});
  expect(p.ok).toBe(true);if(!p.ok)return;
  expect(parseVirtualTradePlan(p.plan)).toEqual(p.plan);expect(p.plan.leverage).toBe(10);
  expect(p.plan.maxHoldHours).toBe(mode==='INTRADAY'?1:4);expect(parseVirtualTradePlan({...p.plan,tpPrice:51000})).toBeNull();
 });
  it('v8 accepts only observed-target plans within actual cost, full $2 reserve, 1% risk and net R:R limits',()=>{
   const input={mode:'INTRADAY' as const,entryPrice:50000,structuralStop:49825,targetPrice:50750,
    notionalUsd:500,maxLeverage:10,estimatedRoundTripCostUsd:1.2,riskBudgetUsd:4,openedAtMs:now};
   const p=buildAdaptiveDailyTradePlan(input);
   expect(p.ok).toBe(true);if(!p.ok)return;
   expect(p.plan.version).toBe(ADAPTIVE_DAILY_PLAN_VERSION);
   expect(p.plan.costReserveUsd).toBe(2);
   expect(p.plan.plannedRiskUsd).toBe(3.75);
   expect(parseVirtualTradePlan(p.plan)).toEqual(p.plan);
   expect(parseVirtualTradePlan({...p.plan,tpPrice:51000})).toBeNull();
   expect(buildAdaptiveDailyTradePlan({...input,estimatedRoundTripCostUsd:2.01}).ok).toBe(false);
   expect(buildAdaptiveDailyTradePlan({...input,riskBudgetUsd:3}).ok).toBe(false);
   expect(buildAdaptiveDailyTradePlan({...input,targetPrice:50200}).ok).toBe(false);
  });
  it('compares both versions at one quote while preserving exact v7 ATR-stop direction and sizing',async()=>{
   const candidate=trendCandidate();if(!candidate.evaluation)throw Error('v8 evidence missing');
   expect(candidate.legacyQuality?.eligible).toBe(true);
   expect(candidate.evaluation.selectedSetup).toBe('TREND_PULLBACK');
   expect(candidate.evaluation.signals.find(s=>s.kind==='TREND_PULLBACK')).toMatchObject({
     eligible:true,targetPrice:52500,targetBasis:'OBSERVED_SWING'});
   const session=buildActiveVirtualPaper400SessionState('daily-paired-test',new Date(now-1000));
   const paired=vi.fn((_proposal:PairedDailyCandidateComparison)=>{});
   const open=vi.fn(async()=>({ok:true as const,tradeId:'paper',stopPriceUsd:51580,tpPriceUsd:52500}));
   const d={sessionRaw:JSON.stringify(session),policyAppliedAt:new Date(now).toISOString(),policyVersion:DAILY_PAPER_POLICY.version,
     previous:initialVirtualPaper400RiskState(session.session),rows:[],now:new Date(now),engineMode:'PAPER',
     markets:MARKET_BY_SYMBOL_SERVER,quote:()=>({priceUsd:51800,ageMs:0}),shouldContinue:()=>true,
     persistRisk:async()=>{},readSignals:async()=>[],readDailyCandidates:async()=>[candidate],
     readCost:async(_s:string,_l:boolean,n:number)=>virtualReplayCost(now,n),recordPairedComparison:paired,
     claim:async()=>true,open,close:async()=>true,reduce:async()=>true};
   expect((await runVirtualPaperDailyCycle(d)).status).toBe('OPENED');
   const comparison=paired.mock.calls[0][0];
   expect(comparison.observedAt).toBe(now);
   expect(comparison.legacy).toMatchObject({eligible:true,side:'LONG',stopFraction:candidate.legacyStopFraction,
     plan:{version:'virtual-cost-filtered/v1',entryPrice:51800},costEvidence:{source:'PAPER_GMX_ESTIMATE',observedAt:now}});
   expect(comparison.adaptive).toMatchObject({eligible:true,side:'LONG',stopFraction:candidate.evaluation.stopFraction,
     targetPrice:52500,plan:{version:ADAPTIVE_DAILY_PLAN_VERSION,entryPrice:51800,tpPrice:52500},
     costEvidence:{source:'PAPER_GMX_ESTIMATE',observedAt:now}});
   expect(comparison.legacy.notionalUsd).not.toBe(comparison.adaptive.notionalUsd);
   expect(open).toHaveBeenCalledWith(expect.objectContaining({side:'LONG',stopPriceUsd:candidate.evaluation.stopPrice,tpPriceUsd:52500}),expect.anything());
  });
  it('does not claim or open when refreshed entry exceeds the original observed holding horizon',async()=>{
   const candidate=trendCandidate();
   if(!candidate.evaluation)throw Error('v8 fixture missing');
   candidate.evaluation.observedHorizonMoveFraction.INTRADAY=52500/51800-1;
   const session=buildActiveVirtualPaper400SessionState('daily-reachability-test',new Date(now-1000));
   const quote=vi.fn().mockReturnValueOnce({priceUsd:51800,ageMs:0}).mockReturnValue({priceUsd:51750,ageMs:0});
   const claim=vi.fn(async()=>true);
   const open=vi.fn(async()=>({ok:true as const,tradeId:'must-not-open',stopPriceUsd:51580,tpPriceUsd:52500}));
   const result=await runVirtualPaperDailyCycle({sessionRaw:JSON.stringify(session),policyAppliedAt:new Date(now).toISOString(),
     policyVersion:DAILY_PAPER_POLICY.version,previous:initialVirtualPaper400RiskState(session.session),
     rows:[],now:new Date(now),engineMode:'PAPER',markets:MARKET_BY_SYMBOL_SERVER,quote,shouldContinue:()=>true,
     persistRisk:async()=>{},readSignals:async()=>[],readDailyCandidates:async()=>[candidate],
     readCost:async(_s,_l,n)=>virtualReplayCost(now,n),claim,open,close:async()=>true,reduce:async()=>true});
   expect(result.status).toBe('NO_TRADE');
   expect(result.evaluations[0]).toMatchObject({eligible:false,reason:'V8_EXECUTION_TARGET_OUTSIDE_OBSERVED_HORIZON'});
   expect(result.evaluations[0].conditions).toEqual(expect.arrayContaining([
     expect.objectContaining({name:'v8_execution_target_move_fraction',passed:false,threshold:52500/51800-1})]));
   expect(claim).not.toHaveBeenCalled();
   expect(open).not.toHaveBeenCalled();
  });
 it('enters without ensemble signals; LIVE/STOP/duplicate claim never dispatches',async()=>{
  const session=buildActiveVirtualPaper400SessionState('daily-test',new Date(now-1000));
  const open=vi.fn(async()=>({ok:true as const,tradeId:'paper',stopPriceUsd:49700,tpPriceUsd:50600}));const claim=vi.fn(async()=>true);
   const paired=vi.fn((_proposal:PairedDailyCandidateComparison)=>{});const evaluationReport=vi.fn((_evaluation:PaperEntryEvaluation)=>{});
  const d={sessionRaw:JSON.stringify(session),policyAppliedAt:new Date(now).toISOString(),policyVersion:DAILY_PAPER_POLICY.version,
     previous:initialVirtualPaper400RiskState(session.session),rows:[],now:new Date(now),engineMode:'PAPER',
    markets:MARKET_BY_SYMBOL_SERVER,quote:()=>({priceUsd:50650,ageMs:0}),shouldContinue:()=>true,
    persistRisk:async()=>{},readSignals:async()=>[],readDailyCandidates:async()=>[breakoutCandidate()],
    readCost:async(_s:string,_l:boolean,n:number)=>virtualReplayCost(now,n),recordPairedComparison:paired,
    recordEntryEvaluation:evaluationReport,claim,open,close:async()=>true,reduce:async()=>true};
   const actualBreakout=breakoutCandidate();
   if(!actualBreakout.evaluation)throw Error('v8 evaluation missing');
   expect(actualBreakout.evaluation.selectedSetup).toBe('VOLATILITY_BREAKOUT');
   expect(actualBreakout.evaluation.signals.find(s=>s.kind==='VOLATILITY_BREAKOUT')).toMatchObject({
     eligible:true,targetBasis:'OBSERVED_RANGE_PROJECTION',targetPrice:51200});
   expect((await runVirtualPaperDailyCycle(d)).status).toBe('OPENED');expect(open).toHaveBeenCalledTimes(1);
   expect(open).toHaveBeenCalledWith(expect.objectContaining({stopPriceUsd:50515,tpPriceUsd:51200}),expect.anything());
   expect(paired).toHaveBeenCalledTimes(1);
   const expectedLegacyStop=Math.max(.002,Math.min(.008,actualBreakout.legacyQuality?.atrFraction??0));
   expect(paired.mock.calls[0][0]).toMatchObject({observedAt:now,
     legacy:{version:'virtual400-daily/v7',eligible:false,side:actualBreakout.legacySide,stopFraction:expectedLegacyStop,plan:null},
     adaptive:{version:'virtual400-daily/v8',eligible:true,side:'LONG',targetPrice:51200,
       plan:{version:ADAPTIVE_DAILY_PLAN_VERSION,costReserveUsd:2},
       costEvidence:{source:'PAPER_GMX_ESTIMATE',estimatedRoundTripUsd:expect.any(Number),observedAt:now}}});
   expect(evaluationReport.mock.calls[0][0]).toMatchObject({policyVersion:DAILY_PAPER_POLICY.version,
     eligible:true,reason:'PAPER_EXPERIMENT_OPENED',kind:'ECONOMICS',
     conditions:expect.arrayContaining([expect.objectContaining({name:'v8_net_reward_risk',passed:true,threshold:1.5})])});
   const expensive=await runVirtualPaperDailyCycle({...d,
     readDailyCandidates:async()=>[breakoutCandidate()],
     readCost:async(_s:string,_l:boolean,n:number)=>({...virtualReplayCost(now,n),positionFeeUsd:3}),
   });
   expect(expensive.status).toBe('NO_TRADE');expect(open).toHaveBeenCalledTimes(1);
   expect(paired.mock.calls[1][0].adaptive).toMatchObject({eligible:false,reason:'PAPER_EXPERIMENT_COST_CAP',
     estimatedRoundTripCostUsd:expect.any(Number),netRewardRisk:expect.any(Number),plan:null,
     costEvidence:{source:'PAPER_GMX_ESTIMATE'}});
   expect(expensive.evaluations[0].conditions).toEqual(expect.arrayContaining([
     expect.objectContaining({name:'v8_round_trip_cost_usd',passed:false,threshold:2}),
     expect.objectContaining({name:'v8_net_reward_risk',threshold:1.5}),
   ]));
  expect((await runVirtualPaperDailyCycle({...d,engineMode:'LIVE'})).status).toBe('BLOCKED');
  expect((await runVirtualPaperDailyCycle({...d,shouldContinue:()=>false})).status).toBe('BLOCKED');
    const candidates=await d.readDailyCandidates();
    if(!candidates[0]?.evaluation)throw Error('v8 candidate evaluation missing');
  const patternAnalysis={version:'paper-chart-reference/v1' as const,purpose:'REFERENCE_ONLY_UNVALIDATED' as const,evaluatedAt:now,
    frames:[{timeframe:'15m' as const,status:'OK' as const,closedAt:now-10_000,bars:80,volumeConfirmation:'UNAVAILABLE' as const,
      findings:[{id:'BULLISH_ENGULFING',family:'CANDLE' as const,direction:'LONG' as const,state:'SHAPE' as const,timeframe:'15m' as const,availableAt:now-10_000,trigger:null,invalidation:null,basis:'test'}]}]};
   const rejected={...candidates[0],patternAnalysis,quality:{...candidates[0].quality,eligible:false,reason:'WEAK_MOMENTUM'},
     evaluation:{...candidates[0].evaluation,eligible:false,reason:'NO_PATTERN_PASSED_SCORE_THRESHOLD'}};
   const denied=await runVirtualPaperDailyCycle({...d,readDailyCandidates:async()=>[rejected]});
   expect(denied.status).toBe('NO_TRADE');expect(denied.evaluations[0]).toMatchObject({eligible:false,reason:'NO_PATTERN_PASSED_SCORE_THRESHOLD'});
  expect(open).toHaveBeenCalledTimes(1);
  const auditClaim=vi.fn(async(_id:string,_audit:unknown)=>true);
   await runVirtualPaperDailyCycle({...d,claim:auditClaim,readDailyCandidates:async()=>[{...candidates[0],patternAnalysis}]});
  expect(auditClaim.mock.calls[0][1]).toMatchObject({candidate:{patternAnalysis},selection:{patternReferenceAdjustment:1/3*.1}});
  expect(open).toHaveBeenCalledTimes(2);
  claim.mockResolvedValue(false);await runVirtualPaperDailyCycle(d);expect(open).toHaveBeenCalledTimes(2);
 });
});

function breakoutCandidate():DailyPaperCandidate {
 const prices=Array.from({length:16},(_,i)=>{
   const time=(Math.floor(now/step)-16+i)*step/1000;
   const bar=i<11?[50050,50300,50000,50050]:i<15?[50550,50600,50515,50570]:[50580,50680,50515,50650];
   return [time,...bar];
 });
 return dailyPaperCandidate('BTC',{source:'gmx-official-api',prices},now)!;
}
function trendCandidate():DailyPaperCandidate {
 const prices=Array.from({length:16},(_,i)=>{
   const time=(Math.floor(now/step)-16+i)*step/1000;
   const close=50000+160*i;
   const bar=i<11?[close,close+100,close-100,close]
     :i===11?[51600,51650,51580,51600]
       :i===12?[51600,52500,51580,52000]
         :i===13?[52000,52400,51700,51800]
           :i===14?[51800,52400,51700,51850]:[51750,52300,51700,51800];
   return [time,...bar];
 });
 return dailyPaperCandidate('BTC',{source:'gmx-official-api',prices},now)!;
}
