import {describe,it,expect} from 'vitest';
import type {DbTrade} from '@workspace/db';
import {buildPaperLearningDataset,PAPER_DAILY_MOMENTUM_STRATEGY_VERSION} from '../workers/virtualPaperLearningDataset';
import {buildVirtualPaper400Session} from '../workers/virtualPaper400Ledger';
import {buildDailyTradePlan} from '../workers/virtualPaperTradingMode';
const at=Date.parse('2026-09-22T08:00:00Z');
const session=buildVirtualPaper400Session('learning',new Date(at-3600000));
const reconciliation={status:'PASS' as const,validator:'evaluateVirtualPaper400Account' as const,settlementRowCount:2};
function fixture(){
 const p=buildDailyTradePlan({mode:'INTRADAY',entryPrice:50000,structuralStop:49700,notionalUsd:1000,maxLeverage:10,estimatedRoundTripCostUsd:.1,riskBudgetUsd:8,openedAtMs:at});
 if(!p.ok)throw Error('plan fixture');
 const common={strategy:session.strategyTag,symbol:'BTC',side:'LONG',settlementStatus:'PAPER_ESTIMATED',costSource:'PAPER_GMX_ESTIMATE'};
 const rows=[{...common,id:'open',action:'OPEN',timestamp:new Date(at),closeTime:at+3600000,openDecisionId:'decision'},
 {...common,id:'partial',action:'CLOSE',timestamp:new Date(at+1800000),closesTradeId:'open',closeKind:'REDUCE70',pnl:'2',netPnlEstimatedUsd:'1',estEntryCostUsd:'.4',estExitCostUsd:'.4',estHoldingCostUsd:'.2'},
 {...common,id:'full',action:'CLOSE',timestamp:new Date(at+3600000),closesTradeId:'open',closeKind:'FULL',pnl:'-4',netPnlEstimatedUsd:'-5',estEntryCostUsd:'.4',estExitCostUsd:'.4',estHoldingCostUsd:'.2',closeReason:'MODE_TIME_EXIT'}] as DbTrade[];
 const audit={sessionId:session.sessionId,mode:'VIRTUAL_PAPER_400',tradePlan:p.plan,policy:{version:'virtual400-daily/v5'},candidate:{source:'gmx-official-api',purpose:'AGGRESSIVE_PAPER_EXPERIMENT',symbol:'BTC',side:'LONG',closedAt:at-900000,evaluatedAt:at,referencePrice:50000,momentum:.003,stopFraction:.006}};
 return {rows,audit,audits:new Map<string,unknown>([['decision',audit]])};
}
describe('PAPER learning evidence',()=>{
 it('exports one complete position with losses/costs, separate features/labels and deterministic provenance',()=>{
  const f=fixture();const d=buildPaperLearningDataset(session,f.rows,f.audits,reconciliation);
  expect(d.sampleCount).toBe(1);expect(d.liveEligible).toBe(false);expect(d.trainedModelAvailable).toBe(false);
  expect(d.samples[0]).toMatchObject({sampleId:'open',positionId:'open',
    strategyVersion:PAPER_DAILY_MOMENTUM_STRATEGY_VERSION,
    labels:{netPnlUsd:-4,grossPnlUsd:-2,estimatedCostsUsd:2,settlementIds:['full','partial']}});
  expect(d).toMatchObject({reviewedOpenCandidateCount:1,settlementRowCount:2,
    sampleExcludedTotal:1,exclusionRate:0,
    eligiblePeriods:{
      featureAt:{first:'2026-09-22T08:00:00.000Z',last:'2026-09-22T08:00:00.000Z'},
      openedAt:{first:'2026-09-22T08:00:00.000Z',last:'2026-09-22T08:00:00.000Z'},
      labelAvailableAt:{first:'2026-09-22T09:00:00.000Z',last:'2026-09-22T09:00:00.000Z'}},
    ledgerReconciliation:{status:'PASS',validator:'evaluateVirtualPaper400Account',
      scope:{sessionId:session.sessionId,strategyTag:session.strategyTag,tradeRowCount:3,
        reviewedOpenCandidateCount:1,settlementRowCount:2}}});
  expect((d.samples[0] as any).features).not.toHaveProperty('netPnlUsd');
  expect(buildPaperLearningDataset(session,f.rows,f.audits,reconciliation).datasetSha256).toBe(d.datasetSha256);
 });
 it('rejects future features, incomplete trades, missing audits and missing cost evidence without inventing samples',()=>{
  const f=fixture();f.audit.candidate.evaluatedAt=at+1;
  expect(buildPaperLearningDataset(session,f.rows,f.audits,reconciliation).sampleCount).toBe(0);
  expect(buildPaperLearningDataset(session,f.rows,new Map(),reconciliation).excluded[0].reason).toContain('EVIDENCE');
  const g=fixture();g.rows[0].closeTime=0;expect(buildPaperLearningDataset(session,g.rows,g.audits,reconciliation).excluded[0].reason).toBe('POSITION_NOT_FULLY_SETTLED');
  const h=fixture();h.rows[2].estHoldingCostUsd=null;
  const rejected=buildPaperLearningDataset(session,h.rows,h.audits,reconciliation);
  expect(rejected.sampleCount).toBe(0);
  expect(rejected).toMatchObject({reviewedOpenCandidateCount:1,sampleExcludedTotal:1,exclusionRate:1,
    eligiblePeriods:{featureAt:{first:null,last:null},openedAt:{first:null,last:null},
      labelAvailableAt:{first:null,last:null}}});
 });
});
