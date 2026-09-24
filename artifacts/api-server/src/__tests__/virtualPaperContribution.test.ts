import { describe, it, expect } from 'vitest';
import type { DbTrade } from '@workspace/db';
import { AUTHORIZED_PAPER_CREDIT, AUTHORIZED_PAPER_SEED_1000_CREDIT, applyAuthorizedPaperCredit, validatePaperContributions } from '../workers/virtualPaperContribution';
import { dailyPaperProfile, isDailyPaperProfile } from '../workers/virtualPaperDailyPolicy';
import { buildVirtualPaper400Session } from '../workers/virtualPaper400Ledger';
import { initialVirtualPaper400RiskState, evaluateVirtualPaper400Account, parseVirtualPaper400RiskState } from '../workers/virtualPaper400Accounting';
const start = new Date('2026-09-20T00:00:00Z');
const now = new Date('2026-09-22T08:00:00Z');
const session = buildVirtualPaper400Session(AUTHORIZED_PAPER_CREDIT.sessionId, start);
const quote = () => ({priceUsd: 50000, ageMs:0});
function lossRows(): DbTrade[] {
 const shared = {symbol:'BTC',side:'LONG',strategy:session.strategyTag,testMode:false,managedBy:'SERVER',settlementStatus:'PAPER_ESTIMATED',costSource:'PAPER_GMX_ESTIMATE',estEntryCostUsd:'1',estExitCostUsd:'1',fundingRatePerHour:'0',borrowingRatePerHour:'0'};
 return [{...shared,id:'open',action:'OPEN',timestamp:new Date('2026-09-22T06:00:00Z'),closeTime:Date.parse('2026-09-22T06:30:00Z'),price:'50000',sizeInUsd:'750',stopPriceUsd:'49500',takeProfitPriceUsd:'51000'},
 {...shared,id:'close',action:'CLOSE',timestamp:new Date('2026-09-22T06:30:00Z'),closeTime:Date.parse('2026-09-22T06:30:00Z'),closesTradeId:'open',closeKind:'FULL',pnl:'-8',netPnlEstimatedUsd:'-10',estHoldingCostUsd:'0'}] as DbTrade[];
}
describe('authorized PAPER contribution with immutable trading history',()=>{
 it('adds the second approved 500 once, preserving ledger fingerprints, losses and PHT budgets across restart',()=>{
  const first=applyAuthorizedPaperCredit(initialVirtualPaper400RiskState(session),session,now,'PAPER',true);
  const later=new Date('2026-09-24T07:00:00Z');
  const before=evaluateVirtualPaper400Account({session,rows:lossRows(),previous:first,quote,now:later,aggressiveDaily:true});
  before.next.risk.locks.dailyLockState='DAILY_LOSS_LOCKED';
  before.next.risk.locks.dailyLockReason='PAPER_DAILY_LOSS_10_PERCENT';
  const credited=applyAuthorizedPaperCredit(before.next,session,later,'PAPER',true);
  expect(credited.risk).toEqual(before.next.risk);
  expect(credited.equityHwmUsd).toBe(before.next.equityHwmUsd+500);
  expect(credited.contributions).toHaveLength(2);
  expect(credited.contributions![0]).toEqual(first.contributions![0]);
  expect(credited.contributions![1]).toMatchObject({id:AUTHORIZED_PAPER_SEED_1000_CREDIT.id,amountUsd:500});
  const after=evaluateVirtualPaper400Account({session,rows:lossRows(),previous:credited,quote,now:later,aggressiveDaily:true});
  expect(after.ledger).toMatchObject({initialEquityUsd:400,netContributionsUsd:600,fundedCapitalUsd:1000,realizedEquityUsd:990,realizedNetPnlUsd:-10,settlementCount:1});
  expect(after.next.settlementSha256).toBe(before.next.settlementSha256);
  expect(after.next.risk.startOfDayEquityUsd).toBe(before.next.risk.startOfDayEquityUsd);
  expect(after.next.risk.dailyRealizedNetPnlUsd).toBe(before.next.risk.dailyRealizedNetPnlUsd);
  expect(after.evaluation.state).toBe('DAILY_LOSS_LOCKED');
  const restored=parseVirtualPaper400RiskState(JSON.stringify(after.next),session);
  expect(applyAuthorizedPaperCredit(restored,session,new Date(later.getTime()+60000),'PAPER',true)).toBe(restored);
  const tomorrow=evaluateVirtualPaper400Account({session,rows:lossRows(),previous:restored,quote,now:new Date('2026-09-24T16:00:00Z'),aggressiveDaily:true});
  expect(tomorrow.next.risk.startOfDayEquityUsd).toBe(990);
  expect(tomorrow.next.risk.dailyRealizedNetPnlUsd).toBe(0);
  expect(tomorrow.evaluation.entryAllowed).toBe(true);
 });
 it('does not credit the second event early, in LIVE/STOP or with altered, duplicate or reordered events',()=>{
  const first=applyAuthorizedPaperCredit(initialVirtualPaper400RiskState(session),session,now,'PAPER',true);
  const eligible=new Date(AUTHORIZED_PAPER_SEED_1000_CREDIT.eligibleAfter);
  expect(applyAuthorizedPaperCredit(first,session,new Date(eligible.getTime()-1),'PAPER',true)).toBe(first);
  expect(applyAuthorizedPaperCredit(first,session,eligible,'LIVE',true)).toBe(first);
  expect(applyAuthorizedPaperCredit(first,session,eligible,'PAPER',false)).toBe(first);
  const both=applyAuthorizedPaperCredit(first,session,eligible,'PAPER',true).contributions!;
  for(const invalid of [[both[1]],[both[1],both[0]],[both[0],both[0]],[...both,both[1]],
    [both[0],{...both[1],amountUsd:501}],[both[0],{...both[1],appliedAt:now.toISOString()}]]) {
    expect(()=>validatePaperContributions(invalid,session)).toThrow();
  }
 });
 it('uses capital up to 1000 for the unchanged 2% risk rate while retaining order and margin caps',()=>{
  const profile=dailyPaperProfile(1000,now.toISOString());
  expect(profile.derivedLimits).toMatchObject({allocatedTradingCapitalUsd:1000,maxRiskPerTradeUsd:20,maxRiskPerTradePct:2,maxTotalExposureUsd:1000,maxMarginPerTradeUsd:100,maxLeverage:10,maxConcurrentPositions:1});
  expect(dailyPaperProfile(1200,now.toISOString())).toEqual(profile);
  expect(dailyPaperProfile(500,now.toISOString()).derivedLimits.maxRiskPerTradeUsd).toBe(10);
  expect(isDailyPaperProfile(profile)).toBe(true);
 });
 it('adds 100 exactly once across restart, preserving losses, daily budget and HWM drawdown',()=>{
  const before = evaluateVirtualPaper400Account({session,rows:lossRows(),previous:initialVirtualPaper400RiskState(session),quote,now,aggressiveDaily:true});
  expect(before.ledger.realizedEquityUsd).toBe(390);
  const credited=applyAuthorizedPaperCredit(before.next,session,now,'PAPER',true);
  const after=evaluateVirtualPaper400Account({session,rows:lossRows(),previous:credited,quote,now,aggressiveDaily:true});
  expect(after.ledger).toMatchObject({initialEquityUsd:400,netContributionsUsd:100,fundedCapitalUsd:500,realizedEquityUsd:490,realizedNetPnlUsd:-10,settlementCount:1});
  expect(after.next.equityHwmUsd-after.ledger.realizedEquityUsd).toBe(10);
  expect(after.next.risk.startOfDayEquityUsd).toBe(before.next.risk.startOfDayEquityUsd);
  expect(after.next.risk.dailyRealizedNetPnlUsd).toBe(-10);
  expect(after.next.risk.dailyEntryCount).toBe(1);
  expect(after.next.settlementSha256).toBe(before.next.settlementSha256);
  const restored=parseVirtualPaper400RiskState(JSON.stringify(after.next),session);
  expect(applyAuthorizedPaperCredit(restored,session,new Date(now.getTime()+60000),'PAPER',true)).toEqual(restored);
  const tomorrow=evaluateVirtualPaper400Account({session,rows:lossRows(),previous:restored,quote,now:new Date('2026-09-23T08:00:00Z'),aggressiveDaily:true});
  expect(tomorrow.ledger.realizedEquityUsd).toBe(490);
  expect(tomorrow.next.risk.startOfDayEquityUsd).toBe(490);
  expect(tomorrow.next.risk.dailyRealizedNetPnlUsd).toBe(0);
 });
 it('excludes deposits and unrealized gains from profit cap and resets only the daily cap at PHT midnight',()=>{
  const rows=lossRows();rows[1].pnl='82';rows[1].netPnlEstimatedUsd='80';
  const base=applyAuthorizedPaperCredit(initialVirtualPaper400RiskState(session),session,now,'PAPER',true);
  const capped=evaluateVirtualPaper400Account({session,rows,previous:base,quote,now,aggressiveDaily:true});
  expect(capped.next.risk.startOfDayEquityUsd).toBe(400);
  expect(capped.next.risk.dailyRealizedNetPnlUsd).toBe(80);
  expect(capped.evaluation.state).toBe('PROFIT_CAP_LOCKED');
  expect(capped.evaluation.actions).toEqual([]);
  const restart=parseVirtualPaper400RiskState(JSON.stringify(capped.next),session);
  expect(evaluateVirtualPaper400Account({session,rows,previous:restart,quote,now,aggressiveDaily:true}).evaluation.entryAllowed).toBe(false);
  const tomorrow=evaluateVirtualPaper400Account({session,rows,previous:restart,quote,now:new Date('2026-09-22T16:00:00Z'),aggressiveDaily:true});
  expect(tomorrow.evaluation.entryAllowed).toBe(true);expect(tomorrow.next.risk.startOfDayEquityUsd).toBe(580);
  const depositOnly=evaluateVirtualPaper400Account({session,rows:[],previous:base,quote,now,aggressiveDaily:true});
  expect(depositOnly.evaluation.entryAllowed).toBe(true);
 });
 it('preserves daily/hard locks and refuses LIVE, STOP, another session or malformed/duplicate credits',()=>{
  const base=initialVirtualPaper400RiskState(session);base.risk.locks.hardStopReason='existing';base.risk.locks.dailyLockState='DAILY_LOSS_LOCKED';
  const credit=applyAuthorizedPaperCredit(base,session,now,'PAPER',true);
  expect(credit.risk).toEqual(base.risk);
  expect(applyAuthorizedPaperCredit(base,session,now,'LIVE',true)).toBe(base);
  expect(applyAuthorizedPaperCredit(base,session,now,'PAPER',false)).toBe(base);
  expect(applyAuthorizedPaperCredit(base,buildVirtualPaper400Session('other',start),now,'PAPER',true)).toBe(base);
  expect(()=>validatePaperContributions([...credit.contributions!,...credit.contributions!],session)).toThrow();
  expect(()=>validatePaperContributions([{...credit.contributions![0],amountUsd:101}],session)).toThrow();
  expect(()=>validatePaperContributions(credit.contributions,buildVirtualPaper400Session('other',start))).toThrow();
 });
});
