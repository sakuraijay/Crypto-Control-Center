import { describe, it, expect } from 'vitest';
import type { DbTrade } from '@workspace/db';
import { AUTHORIZED_PAPER_CREDIT, applyAuthorizedPaperCredit, validatePaperContributions } from '../workers/virtualPaperContribution';
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
