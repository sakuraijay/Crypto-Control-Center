import {describe,it,expect,vi} from 'vitest';
import {dailyPaperCandidate} from '../workers/virtualPaperDailyCandidate';
import {dailyPaperProfile,isDailyPaperProfile,evaluateDailyPaperRisk,DAILY_PAPER_POLICY} from '../workers/virtualPaperDailyPolicy';
import {buildDailyTradePlan,parseVirtualTradePlan,LEGACY_DAILY_PLAN_VERSION} from '../workers/virtualPaperTradingMode';
import {EMPTY_LOCKS} from '../lib/riskStateMachine';
import {isAppliedRiskProfileSnapshot} from '../lib/riskProfiles';
import {runVirtualPaperDailyCycle} from '../workers/virtualPaperDailyCycle';
import {buildActiveVirtualPaper400SessionState} from '../workers/virtualPaper400SessionState';
import {initialVirtualPaper400RiskState} from '../workers/virtualPaper400Accounting';
import {MARKET_BY_SYMBOL_SERVER} from '../lib/gmxMarkets';
import {virtualReplayCost} from './helpers/virtualPaper400Replay';
const now=Date.parse('2026-09-22T03:00:10Z'),step=900000;
const raw=()=>({source:'gmx-official-api',prices:Array.from({length:16},(_,i)=>[(Math.floor(now/step)-16+i)*step/1000,50000+i,50100+i,49900+i,50010+i])});
const riskInput=()=>({equity:380,dayOpening:400,dailyLossAware:-20,dailyRealized:-20,entries:10,held:0,fresh:true,locks:{...EMPTY_LOCKS}});
describe('explicit aggressive PAPER experiment',()=>{
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
 it('enters without ensemble signals; LIVE/STOP/duplicate claim never dispatches',async()=>{
  const session=buildActiveVirtualPaper400SessionState('daily-test',new Date(now-1000));
  const open=vi.fn(async()=>({ok:true as const,tradeId:'paper',stopPriceUsd:49700,tpPriceUsd:50600}));const claim=vi.fn(async()=>true);
  const d={sessionRaw:JSON.stringify(session),policyAppliedAt:new Date(now).toISOString(),policyVersion:DAILY_PAPER_POLICY.version,
    previous:initialVirtualPaper400RiskState(session.session),rows:[],now:new Date(now),engineMode:'PAPER',
    markets:MARKET_BY_SYMBOL_SERVER,quote:()=>({priceUsd:50025,ageMs:0}),shouldContinue:()=>true,
    persistRisk:async()=>{},readSignals:async()=>[],readDailyCandidates:async()=>[dailyPaperCandidate('BTC',raw(),now)!],
    readCost:async(_s:string,_l:boolean,n:number)=>virtualReplayCost(now,n),claim,open,close:async()=>true,reduce:async()=>true};
  expect((await runVirtualPaperDailyCycle(d)).status).toBe('OPENED');expect(open).toHaveBeenCalledTimes(1);
  expect((await runVirtualPaperDailyCycle({...d,engineMode:'LIVE'})).status).toBe('BLOCKED');
  expect((await runVirtualPaperDailyCycle({...d,shouldContinue:()=>false})).status).toBe('BLOCKED');
  claim.mockResolvedValue(false);await runVirtualPaperDailyCycle(d);expect(open).toHaveBeenCalledTimes(1);
 });
});
