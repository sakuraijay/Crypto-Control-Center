import {describe,it,expect} from 'vitest';
import {dailyPaperRiskPct,dailyPaperBudget,evaluateDailyPaperRisk,dailyPaperProfile,isDailyPaperProfile} from '../workers/virtualPaperDailyPolicy';
import {EMPTY_LOCKS} from '../lib/riskStateMachine';
import {dailyPaperCandidate} from '../workers/virtualPaperDailyCandidate';
import {buildDailyTradePlan,buildFilteredTradePlan,parseVirtualTradePlan,FILTERED_PLAN_VERSION,tradingModeExit} from '../workers/virtualPaperTradingMode';
import {restorePaperComparison,addPaperComparison,advancePaperComparison,summarizePaperComparison} from '../workers/virtualPaperComparison';
import type {DbTrade} from '@workspace/db';
const now=Date.parse('2026-09-29T00:00:10Z');
const risk={equity:750,referenceCapital:1000,dailyLossAware:0,dailyRealized:0,entries:0,held:0,fresh:true,locks:{...EMPTY_LOCKS},nowMs:now};
describe('PAPER v7 guardrails and prospective comparison',()=>{
 it('locks at exactly five percent including unrealized losses; does not erase old locks',()=>{
  expect(dailyPaperBudget(1000,-20,-49.99).remainingLossBudgetUsd).toBeCloseTo(.01);
  expect(evaluateDailyPaperRisk({...risk,dailyLossAware:-49.99}).entryAllowed).toBe(true);
  const locked=evaluateDailyPaperRisk({...risk,dailyLossAware:-50,held:1});
  expect(locked.state).toBe('DAILY_LOSS_LOCKED');expect(locked.actions).toEqual(['CLOSE_ALL_POSITIONS']);
  expect(evaluateDailyPaperRisk({...risk,locks:locked.locks}).entryAllowed).toBe(false);
 });
 it('limits cumulative and weekly losses and waits four hours after three losses',()=>{
  expect(evaluateDailyPaperRisk({...risk,equity:700}).locks.hardStopReason).toBe('PAPER_CUMULATIVE_LOSS_30_PERCENT');
  expect(evaluateDailyPaperRisk({...risk,weeklyLossAware:-100}).state).toBe('WEEKLY_LOSS_LOCKED');
  expect(evaluateDailyPaperRisk({...risk,consecutiveLosses:3,lastCloseAtMs:now-1}).entryAllowed).toBe(false);
  expect(evaluateDailyPaperRisk({...risk,consecutiveLosses:3,lastCloseAtMs:now-4*3600_000}).entryAllowed).toBe(true);
  expect(dailyPaperProfile(750,'2026-09-29T00:00:00Z',.5).derivedLimits.maxRiskPerTradeUsd).toBe(3.75);
  expect(isDailyPaperProfile(dailyPaperProfile(750,'2026-09-29T00:00:00Z',2))).toBe(true);
 });
 it('restores the one-percent tier after the loss recovery period instead of permanently freezing a losing account',()=>{
  expect(dailyPaperRiskPct(2,now-1,now)).toBe(.5);
  expect(dailyPaperRiskPct(2,now-4*3600_000,now)).toBe(1);
  expect(dailyPaperRiskPct(1,now-1,now)).toBe(1);
 });
 it('rejects tiny signals even though legacy candidate exists, and ignores unfinished candles',()=>{
  const step=900_000,prices=Array.from({length:16},(_,i)=>[(Math.floor(now/step)-16+i)*step/1000,100+i*.001,100.3+i*.001,99.7+i*.001,100.01+i*.001]);
  const c=dailyPaperCandidate('BTC',{source:'gmx-official-api',prices},now)!;
  expect(c.quality?.eligible).toBe(false);
  expect(dailyPaperCandidate('BTC',{source:'gmx-official-api',prices:[...prices,[Math.floor(now/step)*step/1000,100,200,1,150]]},now)).toEqual(c);
 });
 it('rejects poor net R without inflating targets and preserves old contracts',()=>{
  const args={mode:'INTRADAY' as const,entryPrice:100,structuralStop:99.2,notionalUsd:1000,maxLeverage:10,estimatedRoundTripCostUsd:2,riskBudgetUsd:10,openedAtMs:now};
  expect(buildDailyTradePlan(args).ok).toBe(true);expect(buildFilteredTradePlan(args).ok).toBe(false);
  const p=buildFilteredTradePlan({...args,estimatedRoundTripCostUsd:1});if(!p.ok)throw Error('fixture');
  expect(p.plan.version).toBe(FILTERED_PLAN_VERSION);expect(p.plan.tpPrice).toBeCloseTo(101.6);
  expect(parseVirtualTradePlan(p.plan)).toEqual(p.plan);
  const row={timestamp:new Date(now),sizeInUsd:'1000',price:'100',side:'LONG',estEntryCostUsd:'.5',estExitCostUsd:'.5',fundingRatePerHour:'0',borrowingRatePerHour:'0'} as DbTrade;
  expect(tradingModeExit(row,p.plan,100,now+1800_000)).toBe('MODE_NO_PROGRESS_EXIT');
  const old=buildDailyTradePlan({...args,estimatedRoundTripCostUsd:1});if(!old.ok)throw Error('fixture');
  expect(tradingModeExit(row,old.plan,100,now+1800_000)).toBeNull();
 });
 it('persists paired outcomes, excludes immature pairs and never uses stale prices',()=>{
  const s=restorePaperComparison(null,'session',now);
  const p={id:'BTC:1',symbol:'BTC',side:'LONG' as const,entry:100,stop:99,target:102,notional:1000,cost:1,openedAt:now,expiresAt:now+3600_000,accepted:true};
  addPaperComparison(s,p);addPaperComparison(s,p);expect(s.samples).toHaveLength(1);
  advancePaperComparison(s,()=>({priceUsd:100,ageMs:0}),now+1800_000);
  expect(summarizePaperComparison(s).completedPairs).toBe(0);
  advancePaperComparison(s,()=>({priceUsd:102,ageMs:60001}),now+3600_000);
  expect(summarizePaperComparison(s).completedPairs).toBe(0);
  const restored=restorePaperComparison(JSON.stringify(s),'session',now+3600_000);
  advancePaperComparison(restored,()=>({priceUsd:102,ageMs:0}),now+3600_000);
  const report=summarizePaperComparison(restored);expect(report.completedPairs).toBe(1);
  expect(report.filtered.netPnlUsd).toBe(-1);expect(report.baseline.netPnlUsd).toBeCloseTo(19);
  expect(report.automaticPromotion).toBe(false);expect(report.outOfSampleStrategyValidated).toBe(false);
 });
});
