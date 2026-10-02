import { describe, it, expect } from 'vitest';
import { adaptivePaperAuditMatches } from '../workers/adaptivePaperAudit';
import { buildAdaptiveDailyTradePlan, parseVirtualTradePlan } from '../workers/virtualPaperTradingMode';
import {ADAPTIVE_SIGNAL_VERSION, type DailyPaperCandidate} from '../workers/virtualPaperDailyCandidate';

const nowMs = Date.parse('2026-10-01T20:00:02Z');
function fixture() {
  const built = buildAdaptiveDailyTradePlan({mode:'INTRADAY',entryPrice:100,structuralStop:99.6,
    targetPrice:101.4,notionalUsd:500,maxLeverage:10,estimatedRoundTripCostUsd:.8,riskBudgetUsd:4,openedAtMs:nowMs});
  if (!built.ok) throw Error(built.reason);
  const candidate: DailyPaperCandidate = {
    symbol:'ETH',side:'LONG',source:'gmx-official-api',purpose:'AGGRESSIVE_PAPER_EXPERIMENT',
    referencePrice:100,closedAt:nowMs-2000,evaluatedAt:nowMs,stopFraction:.004,momentum:.001,
    legacyQuality:{eligible:false,reason:'WEAK_MOMENTUM',regime:'RANGE',efficiency:.2,atrFraction:.001},
    quality:{eligible:true,reason:'ADAPTIVE_SIGNAL_SCORE_ACCEPTED',regime:'RANGE',efficiency:.2,atrFraction:.001,score:67},
     evaluation:{version:'paper-entry-signals/v8',regime:'RANGE',tradingMode:'INTRADAY',atrFraction:.001,
      symbolMedianTrueRangeFraction:.001,adaptiveVolatilityMin:.00045,adaptiveVolatilityMax:.003,
      efficiency:.2,momentumFraction:.001,stopPrice:99.6,stopFraction:.004,
      observedHorizonMoveFraction:{INTRADAY:.02,SWING:.035},
       signals:[{kind:'RANGE_MEAN_REVERSION',side:'LONG',score:67,threshold:45,eligible:true,
         reason:'CLOSED_BAR_RANGE_EDGE_REJECTION',targetPrice:101.4,targetBasis:'OBSERVED_SWING',
         admissionEligible:true,modeAllowed:null,targetMoveFraction:null,observedHorizonMoveFraction:null,
         modeRejection:null,horizonRejection:null}],
      selectedSetup:'RANGE_MEAN_REVERSION',selectedScore:67,scoreThreshold:45,eligible:true,
       observedStopPrice:99.6,stopFailure:null,
       signalConditions:[{setup:'RANGE_MEAN_REVERSION',side:'LONG',score:67,threshold:45,eligible:true,
         reason:'CLOSED_BAR_RANGE_EDGE_REJECTION',targetPrice:101.4,targetBasis:'OBSERVED_SWING',
         observedStopPrice:99.6,stopDistanceFraction:.004,stopFailure:null,admissionEligible:true,
         modeAllowed:null,targetMoveFraction:null,observedHorizonMoveFraction:null,modeRejection:null,horizonRejection:null}],
      reason:'ADAPTIVE_SIGNAL_SCORE_ACCEPTED'},
  };
  return {candidate,plan:built.plan};
}
const args = {symbol:'ETH',side:'LONG' as const,nowMs};
describe('final server PAPER structural evidence binding',()=>{
  it('binds a cost-inclusive 1% plan to structural prices without requiring v7 momentum',()=>{
    const {candidate,plan}=fixture();
    expect(plan.plannedRiskUsd).toBeCloseTo(4);
    expect(plan.costReserveUsd).toBe(2);
    expect(plan.tpPrice).toBe(101.4);
    expect(parseVirtualTradePlan(plan)).toEqual(plan);
    expect(adaptivePaperAuditMatches(candidate,plan,args)).toBe(true);
  });
  it("accepts v9's explicitly versioned lower score threshold without changing the v8 gate",()=>{
    const {candidate,plan}=fixture();
    candidate.evaluation!.version=ADAPTIVE_SIGNAL_VERSION;
    candidate.evaluation!.scoreThreshold=30;
    candidate.evaluation!.signals[0].threshold=30;
    candidate.evaluation!.signals[0].modeAllowed=true;
    candidate.evaluation!.signals[0].admissionEligible=true;
    candidate.evaluation!.signalConditions[0].threshold=30;
    expect(adaptivePaperAuditMatches(candidate,plan,args)).toBe(true);
    candidate.evaluation!.signals[0].threshold=29;
    expect(adaptivePaperAuditMatches(candidate,plan,args)).toBe(false);
  });
  it('cannot lower a setup threshold or claim unobserved reachable prices',()=>{
    const {candidate,plan}=fixture();
    if(!candidate.evaluation)throw Error('v8 evaluation fixture missing');
    candidate.evaluation.signals[0].threshold=0;
    expect(adaptivePaperAuditMatches(candidate,plan,args)).toBe(false);
    candidate.evaluation.signals[0].threshold=45;
    candidate.evaluation.observedHorizonMoveFraction.INTRADAY=.001;
    expect(adaptivePaperAuditMatches(candidate,plan,args)).toBe(false);
  });
  it('refuses missing evidence, stale data, wrong symbol, side, or an independently moved stop',()=>{
    const {candidate,plan}=fixture();
    expect(adaptivePaperAuditMatches(undefined,plan,args)).toBe(false);
    expect(adaptivePaperAuditMatches(candidate,plan,{...args,nowMs:nowMs+60_001})).toBe(false);
    expect(adaptivePaperAuditMatches(candidate,plan,{...args,symbol:'BTC'})).toBe(false);
    expect(adaptivePaperAuditMatches(candidate,plan,{...args,side:'SHORT'})).toBe(false);
    expect(adaptivePaperAuditMatches(candidate,{...plan,structuralStop:99.7},args)).toBe(false);
    expect(parseVirtualTradePlan({...plan,tpPrice:102})).toBeNull();
  });
  it('permits a refreshed execution price only while the original structural stop/target remain bound',()=>{
    const {candidate}=fixture();
    const rebuilt=buildAdaptiveDailyTradePlan({mode:'INTRADAY',entryPrice:99.99,structuralStop:99.6,
      targetPrice:101.4,notionalUsd:500,maxLeverage:10,estimatedRoundTripCostUsd:.8,riskBudgetUsd:4,openedAtMs:nowMs});
    expect(rebuilt.ok).toBe(true);
    if(rebuilt.ok)expect(adaptivePaperAuditMatches(candidate,rebuilt.plan,args)).toBe(true);
  });
  it('refuses a better-economic refreshed entry that exceeds observed target reachability',()=>{
    const {candidate,plan}=fixture();
    if(!candidate.evaluation)throw Error('v8 fixture missing');
    candidate.evaluation.observedHorizonMoveFraction.INTRADAY=.014;
    expect(adaptivePaperAuditMatches(candidate,plan,args)).toBe(true);
    const refreshed=buildAdaptiveDailyTradePlan({mode:'INTRADAY',entryPrice:99.9,structuralStop:99.6,
      targetPrice:101.4,notionalUsd:500,maxLeverage:10,estimatedRoundTripCostUsd:.8,riskBudgetUsd:4,openedAtMs:nowMs});
    expect(refreshed.ok).toBe(true);
    if(refreshed.ok){
      expect(refreshed.plan.tpPrice).toBe(plan.tpPrice);
      expect(refreshed.plan.structuralStop).toBe(plan.structuralStop);
      expect(adaptivePaperAuditMatches(candidate,refreshed.plan,args)).toBe(false);
    }
  });
});
