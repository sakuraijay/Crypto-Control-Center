import {createHash} from 'node:crypto';
import {patternReferenceAdjustment} from '../intel/patterns/chartPatterns';
import type {CostSnapshot} from '../lib/costSnapshot';
import type {VirtualPaper400CycleDeps} from './virtualPaper400Cycle';
import type {DailyPaperCandidate} from './virtualPaperDailyCandidate';
import {ADAPTIVE_SIGNAL_VERSION} from './virtualPaperDailyCandidate';
import {DAILY_PAPER_POLICY as policy, LEGACY_DAILY_PAPER_POLICY as legacyPolicy,
  dailyPaperProfile, dailyPaperRiskPct} from './virtualPaperDailyPolicy';
import {evaluateVirtualPaper400SessionState} from './virtualPaper400SessionState';
import {evaluateVirtualPaper400Account} from './virtualPaper400Accounting';
import {buildAdaptiveDailyTradePlan, buildDailyTradePlan, buildFilteredTradePlan, DAILY_ENTRY_OPTIONS,
  LEGACY_DAILY_ENTRY_OPTIONS, MODE_DECISION_PREFIX, modeHoldingCost, type VirtualTradePlan} from './virtualPaperTradingMode';
import type {PaperComparisonProposal} from './virtualPaperComparison';
import {validateExecutionEligibleSnapshot} from '../lib/costSnapshot';

export type DailyComparisonLeg = {
  version:'virtual400-daily/v7'|'virtual400-daily/v8';
  eligible:boolean;reason:string;side:'LONG'|'SHORT';stopFraction:number|null;
  notionalUsd:number|null;targetPrice:number|null;estimatedRoundTripCostUsd:number|null;netRewardRisk:number|null;
  plan?:VirtualTradePlan|null;
  costEvidence?:{estimatedRoundTripUsd:number;source:'PAPER_GMX_ESTIMATE';observedAt:number}|null;
  conditions:Array<{name:string;value:number|null;operator:string;threshold:number|null;passed:boolean|null}>;
};
export interface PairedDailyCandidateComparison {
  id:string;symbol:string;closedAt:number;observedAt:number;
  legacy:DailyComparisonLeg;
  adaptive:DailyComparisonLeg&{setup:string|null;score:number};
}
export interface PaperEntryEvaluation {
  id:string;symbol:string;policyVersion:'virtual400-daily/v7'|'virtual400-daily/v8';
  closedAt:number;evaluatedAt:string;eligible:boolean;reason:string;kind:'SIGNAL'|'SAFETY'|'ECONOMICS';
  conditions:Array<{name:string;value:number|null;operator:string;threshold:number|null;passed:boolean|null}>;
}
export interface DailyCycleDeps extends VirtualPaper400CycleDeps {
  readDailyCandidates():Promise<DailyPaperCandidate[]>;
  recordComparison?(proposal:PaperComparisonProposal):void;
  /** Emits both policies for every candidate, including signal/safety/cost rejections. */
  recordPairedComparison?(proposal:PairedDailyCandidateComparison):void;
  /** Machine-readable per-candidate safety and economics evidence for diagnostics. */
  recordEntryEvaluation?(evaluation:PaperEntryEvaluation):void;
}
type Quote = NonNullable<ReturnType<DailyCycleDeps['quote']>>;
type BranchAssessment = {
  leg:DailyComparisonLeg;side:'LONG'|'SHORT';stop:number;distance:number;notional:number;
  cost:CostSnapshot;roundTrip:number;plan:VirtualTradePlan;quote:Quote;submittedAt:Date;score:number;
};
type RankedCandidate = BranchAssessment&{candidate:DailyPaperCandidate;evaluation:PaperEntryEvaluation};
type Condition = PaperEntryEvaluation['conditions'][number];
const condition=(name:string,value:number|null,operator:string,threshold:number|null,passed:boolean|null):Condition=>
  ({name,value:Number.isFinite(value)?value:null,operator,threshold:Number.isFinite(threshold)?threshold:null,passed});
const roundTripCost=(cost:CostSnapshot,holding:number|null)=>cost.positionFeeUsd+cost.estimatedExitFeeUsd
  +cost.executionFeeUsd+Math.max(0,cost.estimatedPriceImpactUsd)+Math.max(0,cost.estimatedExitPriceImpactUsd)+(holding??Infinity);

export async function runVirtualPaperDailyCycle(d:DailyCycleDeps){
  const session=evaluateVirtualPaper400SessionState(d.sessionRaw);
  if(!session.state)throw Error('VIRTUAL_SESSION_INVALID');
  const account=evaluateVirtualPaper400Account({session:session.state.session,previous:d.previous,rows:d.rows,now:d.now,
    quote:d.quote,aggressiveDaily:true});
  const diagnostics:{symbol:string;reason:string;details?:string[]}[]=[];
  const entryStages:{symbol:string;stage:string}[]=[];
  const evaluations:PaperEntryEvaluation[]=[];
  const mode=d.tradingMode??'INTRADAY';
  const adaptivePolicyApplied=d.policyVersion===policy.version;
  const activePolicy=adaptivePolicyApplied?policy:legacyPolicy;
  const lastCloseAtMs=d.rows.filter(r=>r.action==='CLOSE'&&r.closeKind==='FULL')
    .reduce<number|null>((latest,r)=>Math.max(latest??0,new Date(r.timestamp).getTime()),null);
  const riskPct=dailyPaperRiskPct(account.next.risk.consecutiveLossCount,lastCloseAtMs,d.now.getTime());
  let evaluationsRecorded=false;
  const outcome=(status:string,reason:string|null=null)=>{
    if(!evaluationsRecorded){
      for(const evaluation of evaluations)d.recordEntryEvaluation?.(evaluation);
      evaluationsRecorded=true;
    }
    return {status,reason,diagnostics,entryStages,evaluations,
      policy:{...activePolicy,riskPerTradePct:riskPct,
        ...(d.policyVersion==='virtual400-daily/v3'?{version:'virtual400-daily/v3',cooldownMinutes:60,maxDailyEntries:24}:{}),
        ...(['virtual400-daily/v4','virtual400-daily/v5','virtual400-daily/v6'].includes(d.policyVersion??'')?{version:d.policyVersion}:{}),
        symbols:[...(d.markets?.keys()??[])],appliedAt:d.policyAppliedAt},
      tradingMode:{mode,...(adaptivePolicyApplied?DAILY_ENTRY_OPTIONS[mode]:LEGACY_DAILY_ENTRY_OPTIONS[mode]),
        ...(['virtual400-daily/v3','virtual400-daily/v4'].includes(d.policyVersion??'')&&mode==='INTRADAY'?{maxHoldHours:.5}:{})},
      at:d.now.toISOString(),mode:'VIRTUAL_PAPER_400' as const,realFundsUsed:false,costBasis:'SIMULATED / ESTIMATED' as const,
      account:{...account,held:account.held.map(r=>({id:r.id,symbol:r.symbol,side:r.side,sizeUsd:r.sizeInUsd,
        entryPrice:r.price,stopPrice:r.stopPriceUsd,takeProfitPrice:r.takeProfitPriceUsd}))}};
  };
  if(d.engineMode!=='PAPER'||!d.shouldContinue())return outcome('BLOCKED','PAPER_MODE_REQUIRED');
  await d.persistRisk(account.next);
  if(account.evaluation.actions.includes('CLOSE_ALL_POSITIONS')&&account.held.length){
    for(const r of account.held)
      if(!d.shouldContinue()||!await d.close(r,`PAPER_EXPERIMENT_${account.evaluation.state}`))
        return outcome('BLOCKED','PAPER_CLOSE_PENDING');
    return outcome('CLOSED');
  }
  if(!session.active)return outcome('STOPPED');
  if(!adaptivePolicyApplied&&d.policyVersion!==legacyPolicy.version)return outcome('BLOCKED','DAILY_POLICY_NOT_APPLIED');
  if(d.entryBlockedReason)return outcome('BLOCKED',d.entryBlockedReason);
  if(!account.evaluation.entryAllowed)
    return outcome(account.held.length?'NO_TRADE':'BLOCKED',account.evaluation.blockReasons.join('; '));
  if(account.lastOpenAtMs!==null&&d.now.getTime()-account.lastOpenAtMs<activePolicy.cooldownMinutes*60_000)
    return outcome('NO_TRADE','PAPER_ENTRY_COOLDOWN');
  const profile=dailyPaperProfile(account.equityUsd??0,d.policyAppliedAt!,riskPct);
  const remainingDailyLoss=account.dailyBudget!.remainingLossBudgetUsd;
  const weeklyRemaining=account.ledger.fundedCapitalUsd*.10+account.next.risk.weeklyRealizedNetPnlUsd;
  const cumulativeRemaining=(account.equityUsd??0)-account.ledger.fundedCapitalUsd*.70;
  const budget=Math.min(profile.derivedLimits.maxRiskPerTradeUsd,remainingDailyLoss,weeklyRemaining,cumulativeRemaining);
  const candidates=(await d.readDailyCandidates()).sort((a,b)=>Math.abs(b.momentum)-Math.abs(a.momentum));
  const ranked:RankedCandidate[]=[];

  const assess=(candidate:DailyPaperCandidate)=>async():Promise<RankedCandidate|null>=>{
    const id=`${candidate.symbol}:${candidate.closedAt}`;
    const now=d.clock?.()??d.now;
    const conditions:Condition[]=[];
      let finalReason='PAPER_CANDIDATE_EVALUATED';
    let finalKind:PaperEntryEvaluation['kind']='SIGNAL';
    const reject=(reason:string,kind:PaperEntryEvaluation['kind']='SAFETY')=>{
      diagnostics.push({symbol:candidate.symbol,reason,details:['PAPER_POLICY_COMPARISON: both v7 and v8 outcomes retained']});
      finalReason=reason;
      finalKind=kind;
    };
    const evaluation:PaperEntryEvaluation={
      id,symbol:candidate.symbol,policyVersion:adaptivePolicyApplied?policy.version:legacyPolicy.version,
      closedAt:candidate.closedAt,evaluatedAt:now.toISOString(),eligible:false,reason:'PAPER_CANDIDATE_EVALUATED',
      kind:'SIGNAL',conditions,
    };
    const candidateEvaluation=candidate.evaluation;
    const adaptive=candidateEvaluation?.version===ADAPTIVE_SIGNAL_VERSION;
    const signal=adaptive&&candidateEvaluation
      ?candidateEvaluation.signals.find(s=>s.kind===candidateEvaluation.selectedSetup):undefined;
    const legacyQuality=candidate.legacyQuality??candidate.quality;
    const legacySide=candidate.legacySide??candidate.side;
    const legacyStopFraction=candidate.legacyStopFraction??candidate.stopFraction;
    let activeBranch:BranchAssessment|null=null;
    let adaptiveLeg:DailyComparisonLeg={version:policy.version,eligible:false,reason:'V8_SIGNAL_EVIDENCE_MISSING',
      side:signal?.side??candidate.side,stopFraction:candidate.evaluation?.stopFraction??null,notionalUsd:null,
      targetPrice:signal?.targetPrice??null,estimatedRoundTripCostUsd:null,netRewardRisk:null,
      plan:null,costEvidence:null,conditions:[],setup:signal?.kind??null,
      score:candidate.evaluation?.selectedScore??0} as DailyComparisonLeg&{setup:string|null;score:number};
    let legacyLeg:DailyComparisonLeg={version:legacyPolicy.version,eligible:false,reason:legacyQuality?.reason??'V7_QUALITY_EVIDENCE_MISSING',
      side:legacySide,stopFraction:Number.isFinite(legacyStopFraction)?legacyStopFraction:null,notionalUsd:null,
      targetPrice:null,estimatedRoundTripCostUsd:null,netRewardRisk:null,plan:null,costEvidence:null,conditions:[]};
    const addArmCondition=(leg:DailyComparisonLeg,c:Condition)=>{conditions.push(c);leg.conditions.push(c);};
    const addSharedCondition=(c:Condition)=>{conditions.push(c);legacyLeg.conditions.push(c);adaptiveLeg.conditions.push(c);};
    let assessmentResult:RankedCandidate|null=null;
    let pairedAt=now.getTime();
    try{
      if(!d.shouldContinue()){reject('PAPER_CYCLE_STOPPED');return null;}
      const q=d.quote(candidate.symbol);
      const market=d.markets?.get(candidate.symbol);
      const freshQuote=!!q&&Number.isFinite(q.priceUsd)&&q.priceUsd>0&&Number.isFinite(q.ageMs)&&q.ageMs>=0&&q.ageMs<=60_000;
      const freshCandidate=candidate.source==='gmx-official-api'&&candidate.purpose==='AGGRESSIVE_PAPER_EXPERIMENT'
        &&candidate.evaluatedAt<=now.getTime()&&now.getTime()-candidate.evaluatedAt<=60_000
        &&candidate.closedAt<=now.getTime()&&now.getTime()-candidate.closedAt<=960_000
        &&Number.isFinite(candidate.referencePrice)&&candidate.referencePrice>0;
      const referenceDeviation=freshQuote?Math.abs(q!.priceUsd/candidate.referencePrice-1):NaN;
      addSharedCondition(condition('quote_age_ms',q?.ageMs??null,'<=',60_000,freshQuote));
      addSharedCondition(condition('candidate_age_ms',Number.isFinite(candidate.evaluatedAt)?now.getTime()-candidate.evaluatedAt:null,'<=',60_000,freshCandidate));
      addSharedCondition(condition('quote_reference_deviation_pct',referenceDeviation*100,'<=',2,Number.isFinite(referenceDeviation)&&referenceDeviation<=.02));
      if(!market||!freshQuote||!freshCandidate||referenceDeviation>.02){
        reject('PAPER_EXPERIMENT_DATA_STALE','SAFETY');return null;
      }
      const current=q!;
      const entry=current.priceUsd;
      const adaptiveSide=signal?.side??candidate.side;
      const adaptiveStop=candidate.evaluation?.stopPrice;
      const adaptiveStopDistance=Number.isFinite(adaptiveStop)&&adaptiveStop!>0
        ?Math.abs(entry-adaptiveStop!)/entry:NaN;
      const adaptiveStopValid=adaptiveStopDistance>=.002-1e-10&&adaptiveStopDistance<=.008+1e-10
        &&(adaptiveSide==='LONG'?adaptiveStop!<entry:adaptiveStop!>entry);
      const adaptiveTarget=signal?.targetPrice??null;
      const adaptiveTargetMove=adaptiveTarget!==null?Math.abs(adaptiveTarget-entry)/entry:NaN;
      const observedHorizon=adaptive&&candidateEvaluation?candidateEvaluation.observedHorizonMoveFraction[mode]:NaN;
      const adaptiveHorizonValid=Number.isFinite(adaptiveTargetMove)&&Number.isFinite(observedHorizon)
        &&adaptiveTargetMove<=observedHorizon+1e-10;
      addArmCondition(adaptiveLeg,condition('v8_signal_score',candidate.evaluation?.selectedScore??null,'>=',
        candidateEvaluation?.scoreThreshold??null,!!signal?.eligible&&!!candidateEvaluation
          &&candidateEvaluation.selectedScore>=candidateEvaluation.scoreThreshold));
      const setupAllowed=mode==='INTRADAY'||signal?.kind==='TREND_PULLBACK';
      addArmCondition(adaptiveLeg,condition('v8_setup_allowed_for_mode',setupAllowed?1:0,'=',1,setupAllowed));
      addArmCondition(adaptiveLeg,condition('v8_atr_fraction',candidate.evaluation?.atrFraction??null,'between',
        candidate.evaluation?candidate.evaluation.adaptiveVolatilityMin:null,
        !!candidate.evaluation&&candidate.evaluation.atrFraction>=candidate.evaluation.adaptiveVolatilityMin
          &&candidate.evaluation.atrFraction<=candidate.evaluation.adaptiveVolatilityMax));
      addArmCondition(adaptiveLeg,condition('v8_atr_fraction_max',candidate.evaluation?.atrFraction??null,'<=',
        candidate.evaluation?.adaptiveVolatilityMax??null,
        !!candidate.evaluation&&candidate.evaluation.atrFraction<=candidate.evaluation.adaptiveVolatilityMax));
      addArmCondition(adaptiveLeg,condition('v8_stop_fraction',adaptiveStopDistance,'between',.002,
        adaptiveStopValid));
      addArmCondition(adaptiveLeg,condition('v8_observed_target_move_fraction',adaptiveTargetMove,'<=',observedHorizon,adaptiveHorizonValid));
      const adaptiveSignalValid=adaptive&&!!candidateEvaluation?.eligible&&!!signal?.eligible
        &&signal.side===candidate.side&&signal.side===adaptiveSide&&signal.targetPrice!==null
        &&(signal.targetBasis==='OBSERVED_SWING'||signal.targetBasis==='OBSERVED_RANGE_PROJECTION')
        &&adaptiveStopValid&&adaptiveHorizonValid&&setupAllowed;
      const legacyDistance=Number.isFinite(legacyStopFraction)?legacyStopFraction:NaN;
      const legacyStopValid=legacyDistance>=.002-1e-10&&legacyDistance<=.008+1e-10;
      const legacyStop=entry*(1-(legacySide==='LONG'?1:-1)*legacyDistance);
      addArmCondition(legacyLeg,condition('v7_legacy_quality',legacyQuality?.eligible?1:0,'=',1,!!legacyQuality?.eligible));
      addArmCondition(legacyLeg,condition('v7_legacy_stop_fraction',legacyDistance,'between',.002,legacyStopValid));

      const assessBranch=async(adaptiveBranch:boolean):Promise<BranchAssessment|null>=>{
        const side=adaptiveBranch?adaptiveSide:legacySide;
        const distance=adaptiveBranch?adaptiveStopDistance:legacyDistance;
        const stop=adaptiveBranch?adaptiveStop!:legacyStop;
        const target=adaptiveBranch?adaptiveTarget:null;
        const signalValid=adaptiveBranch?adaptiveSignalValid:!!legacyQuality?.eligible&&legacyStopValid;
        const reasonPrefix=adaptiveBranch?'V8':'V7';
        const report=adaptiveBranch?adaptiveLeg:legacyLeg;
        report.side=side;report.stopFraction=Number.isFinite(distance)?distance:null;report.targetPrice=target;
        if(!Number.isFinite(distance)||distance<=0){report.reason=`${reasonPrefix}_STOP_INVALID`;return null;}
        const requested=Math.min(profile.derivedLimits.maxTotalExposureUsd,Math.max(0,budget-2)/distance);
        report.notionalUsd=requested;
        if(requested<2.2){report.reason='PAPER_EXPERIMENT_BUDGET_EXHAUSTED';return null;}
        if(!signalValid){report.reason=adaptiveBranch?candidate.evaluation?.reason??'V8_SIGNAL_INELIGIBLE'
          :legacyQuality?.reason??'V7_QUALITY_EVIDENCE_MISSING';return null;}
        const cost=await d.readCost(candidate.symbol,side==='LONG',requested);
        const validationAt=d.clock?.()??d.now;
        const observedCostAt=cost?Date.parse(cost.fetchedAt):NaN;
        if(!cost||cost.source!=='PAPER_GMX_ESTIMATE'||!Number.isFinite(observedCostAt)
          ||!validateExecutionEligibleSnapshot(cost,{market:market.marketToken,isLong:side==='LONG',
            orderType:'MarketIncrease',notionalUsd:requested},validationAt.getTime()).ok){
          report.reason='PAPER_EXPERIMENT_COST_OR_QUOTE';return null;
        }
        const holding=modeHoldingCost(cost,mode==='INTRADAY'?1:4);
        const roundTrip=roundTripCost(cost,holding);
        report.estimatedRoundTripCostUsd=roundTrip;
        report.costEvidence={estimatedRoundTripUsd:roundTrip,source:'PAPER_GMX_ESTIMATE',observedAt:observedCostAt};
        addArmCondition(report,condition(`${reasonPrefix.toLowerCase()}_round_trip_cost_usd`,roundTrip,'<=',2,
          holding!==null&&roundTrip<=2));
        const priceRisk=requested*distance;
        const reportTarget=adaptiveBranch?target:entry*(1+(side==='LONG'?1:-1)*2*distance);
        const priceReward=requested*(reportTarget!/entry-1)*(side==='LONG'?1:-1);
        const netReward=priceReward-roundTrip;
        const netRisk=adaptiveBranch?priceRisk+2:priceRisk+roundTrip;
        const netRewardRisk=netReward/netRisk;
        report.netRewardRisk=netRewardRisk;report.targetPrice=reportTarget??null;
        addArmCondition(report,condition(`${reasonPrefix.toLowerCase()}_planned_risk_usd`,priceRisk+2,'<=',budget,
          priceRisk+2<=budget+1e-8));
        addArmCondition(report,condition(`${reasonPrefix.toLowerCase()}_net_reward_risk`,netRewardRisk,'>=',
          adaptiveBranch?1:1.5,netRewardRisk>=(adaptiveBranch?1:1.5)-1e-8));
        if(holding===null||roundTrip>2){report.reason='PAPER_EXPERIMENT_COST_CAP';return null;}
        // Both comparison arms use the same candidate-time quote and plan
        // timestamp. Each arm obtains its own cost snapshot at its own size.
        const refreshedStop=adaptiveBranch?stop:entry*(1-(side==='LONG'?1:-1)*distance);
        const planInput={mode,entryPrice:entry,structuralStop:refreshedStop,notionalUsd:requested,
          maxLeverage:10,estimatedRoundTripCostUsd:roundTrip,riskBudgetUsd:budget,openedAtMs:now.getTime()};
        const planResult=adaptiveBranch&&target!==null
          ?buildAdaptiveDailyTradePlan({...planInput,targetPrice:target})
          :adaptiveBranch?{ok:false as const,reason:'V8_OBSERVED_TARGET_MISSING'}
            :buildFilteredTradePlan(planInput);
        if(!planResult.ok){report.reason=planResult.reason;report.plan=null;return null;}
        const plan=planResult.plan;
        report.targetPrice=reportTarget??null;report.plan=plan;
        const marginValid=plan.collateralUsd<=profile.derivedLimits.maxMarginPerTradeUsd;
        addArmCondition(report,condition(`${reasonPrefix.toLowerCase()}_collateral_usd`,plan.collateralUsd,'<=',
          profile.derivedLimits.maxMarginPerTradeUsd,marginValid));
        report.eligible=marginValid;
        report.reason=marginValid?'PAPER_PLAN_ACCEPTED':'PAPER_EXPERIMENT_MARGIN_CAP';
        if(!marginValid)return null;
        const score=adaptiveBranch?(candidateEvaluation?.selectedScore??0)+netRewardRisk
          -Math.max(0,cost.estimatedPriceImpactUsd)/Math.max(plan.plannedRiskUsd,Number.EPSILON)
          :netRewardRisk*(.5+(legacyQuality?.efficiency??0))
            -Math.max(0,cost.estimatedPriceImpactUsd)/Math.max(plan.plannedRiskUsd,Number.EPSILON)
            +patternReferenceAdjustment(candidate.patternAnalysis,side,now.getTime());
        if(adaptiveBranch){
          const baseline=buildDailyTradePlan(planInput);
          if(baseline.ok)d.recordComparison?.({id:`${candidate.symbol}:${candidate.closedAt}`,symbol:candidate.symbol,side,
            entry,stop:plan.structuralStop,target:baseline.plan.tpPrice,notional:requested,cost:roundTrip,
            openedAt:now.getTime(),expiresAt:baseline.plan.expiresAtMs,accepted:true});
        }
        return {leg:report as DailyComparisonLeg,side,stop:plan.structuralStop,distance,notional:requested,cost,
          roundTrip,plan,quote:current,submittedAt:now,score};
      };

      // Both policies are assessed at this candle timestamp with their exact
      // distinct stop/direction/sizing rules. Only the configured active arm
      // may be submitted; the other is metadata-only.
      const legacyAssessed=await assessBranch(false);
      const adaptiveAssessed=await assessBranch(true);
      const selected=adaptivePolicyApplied?adaptiveAssessed:legacyAssessed;
      legacyLeg.eligible=!!legacyAssessed;
      if(legacyAssessed)legacyLeg.reason='V7_CANDIDATE_ACCEPTED';
      adaptiveLeg.eligible=!!adaptiveAssessed;
      if(adaptiveAssessed)adaptiveLeg.reason='V8_CANDIDATE_ACCEPTED';
      if(!selected){
        const selectedLeg=adaptivePolicyApplied?adaptiveLeg:legacyLeg;
        reject(selectedLeg.reason,selectedLeg.reason.includes('QUALITY')||selectedLeg.reason.includes('SIGNAL')
          ?'SIGNAL':selectedLeg.reason.includes('PLAN')||selectedLeg.reason.includes('REWARD')||selectedLeg.reason.includes('COST')
            ?'ECONOMICS':'SAFETY');
      }else{
        activeBranch=selected;
        evaluation.eligible=true;evaluation.reason='PAPER_PLAN_ACCEPTED';evaluation.kind='ECONOMICS';
        finalReason='PAPER_PLAN_ACCEPTED';finalKind='ECONOMICS';
        addArmCondition(adaptivePolicyApplied?adaptiveLeg:legacyLeg,condition('active_policy_entry',1,'=',1,true));
        assessmentResult={...selected,candidate,evaluation};
        const activeQuality=adaptivePolicyApplied?candidate.evaluation?.selectedScore??0:legacyQuality?.efficiency??0;
        assessmentResult.score=adaptivePolicyApplied?selected.score:selected.score+activeQuality;
      }
      return assessmentResult;
    }catch{
      reject('PAPER_CANDIDATE_ASSESSMENT_ERROR','SAFETY');
      return null;
    }finally{
      evaluation.eligible=!!activeBranch;
      evaluation.reason=finalReason;
      evaluation.kind=finalKind;
      evaluations.push(evaluation);
      const selectedSetup=candidate.evaluation?.selectedSetup??null;
      const selectedScore=candidate.evaluation?.selectedScore??0;
      const paired:PairedDailyCandidateComparison={id,symbol:candidate.symbol,closedAt:candidate.closedAt,observedAt:pairedAt,
        legacy:legacyLeg,adaptive:{...adaptiveLeg,setup:selectedSetup,score:selectedScore}};
      d.recordPairedComparison?.(paired);
    }
  };

  for(const candidate of candidates){
    const result=await assess(candidate)();
    if(result)ranked.push(result);
    if(!d.shouldContinue())return outcome('STOPPED');
  }
  for(const {candidate,plan:rankedPlan,cost,notional,score,evaluation,side} of ranked.sort((a,b)=>b.score-a.score)){
    const reject=(reason:string)=>{
      diagnostics.push({symbol:candidate.symbol,reason});
      evaluation.eligible=false;evaluation.reason=reason;evaluation.kind='SAFETY';
    };
    const submitNow=d.clock?.()??d.now;
    const current=d.quote(candidate.symbol);
    const market=d.markets?.get(candidate.symbol);
    const direction=side==='LONG'?1:-1;
    if(submitNow.getTime()-candidate.evaluatedAt>60_000||!market||!current||!Number.isFinite(current.priceUsd)
      ||current.priceUsd<=0||!Number.isFinite(current.ageMs)||current.ageMs<0||current.ageMs>60_000
      ||Math.abs(current.priceUsd-candidate.referencePrice)/candidate.referencePrice>.02
      ||!validateExecutionEligibleSnapshot(cost,{market:market.marketToken,isLong:direction===1,
        orderType:'MarketIncrease',notionalUsd:notional},submitNow.getTime()).ok){reject('PAPER_RANKED_QUOTE_CHANGED');continue;}
    if(adaptivePolicyApplied){
      const executionTargetMove=Math.abs(rankedPlan.tpPrice/current.priceUsd-1);
      const observedBound=candidate.evaluation?.observedHorizonMoveFraction[mode];
      const withinObservedHorizon=typeof observedBound==='number'&&Number.isFinite(observedBound)
        &&observedBound>0&&executionTargetMove<=observedBound+1e-10;
      evaluation.conditions.push(condition('v8_execution_target_move_fraction',executionTargetMove,'<=',
        observedBound??null,withinObservedHorizon));
      if(!withinObservedHorizon){reject('V8_EXECUTION_TARGET_OUTSIDE_OBSERVED_HORIZON');continue;}
    }
    const refreshedInput={mode,entryPrice:current.priceUsd,structuralStop:rankedPlan.structuralStop,
      targetPrice:rankedPlan.tpPrice,notionalUsd:notional,maxLeverage:rankedPlan.leverage,
      estimatedRoundTripCostUsd:rankedPlan.estimatedRoundTripCostUsd!,riskBudgetUsd:budget,openedAtMs:submitNow.getTime()};
    const refreshed=adaptivePolicyApplied?buildAdaptiveDailyTradePlan(refreshedInput):buildFilteredTradePlan(refreshedInput);
    if(!refreshed.ok){reject(refreshed.reason);continue;}
    const plan=refreshed.plan;
    const id=MODE_DECISION_PREFIX+'daily:'+createHash('sha256')
      .update(`${session.state.session.sessionId}:${candidate.symbol}:${candidate.closedAt}`).digest('hex');
    if(d.rows.some(r=>r.openDecisionId===id)){reject('PAPER_EXPERIMENT_DUPLICATE');continue;}
    const activePolicy=adaptivePolicyApplied?policy:legacyPolicy;
    const audit={mode:'VIRTUAL_PAPER_400',policy:activePolicy,sessionId:session.state.session.sessionId,candidate,
      selection:{score,kind:adaptivePolicyApplied?'V8_SCORE_NET_RISK':'V7_NET_TARGET_COST_QUALITY',riskPct,
        ...(candidate.patternAnalysis?{patternReferenceAdjustment:patternReferenceAdjustment(candidate.patternAnalysis,side,submitNow.getTime())}:{})},
      signal:{strategyId:adaptivePolicyApplied?'PAPER_V8_STRUCTURAL_SIGNAL':'PAPER_COST_FILTERED_EXPERIMENT',
        reasons:[adaptivePolicyApplied?`v8 ${candidate.evaluation?.selectedSetup??'UNSELECTED'} score ${candidate.evaluation?.selectedScore??0}; ${candidate.evaluation?.reason??'V8_SIGNAL_EVIDENCE_MISSING'}; not a probability estimate`
          :`v7 ${candidate.momentum} completed-candle momentum; losses retained; not ensemble success`],
        strategyTargetPrice:plan.tpPrice},
      tradePlan:plan,sizing:{finalNotionalUsd:notional},cost};
    if(!d.shouldContinue()||!await d.claim(id,audit)){
      reject('PAPER_EXPERIMENT_CLAIM_EXISTS');continue;
    }
    if(!d.shouldContinue())return outcome('STOPPED');
    entryStages.push({symbol:candidate.symbol,stage:'PAPER_EXPERIMENT_CLAIMED'});
    const result=await d.open({strategy:session.state.session.strategyTag,decisionId:id,symbol:candidate.symbol,side,
      sizeUsd:notional,leverage:plan.leverage,quote:current,stopPriceUsd:plan.structuralStop,tpPriceUsd:plan.tpPrice,
      openPositionCount:account.held.length,maxConcurrentPositions:1,riskProfileSnapshot:profile,
      entriesManilaDay:account.next.risk.dailyEntryCount,nowMs:plan.openedAtMs},cost);
    if(!result.ok)reject(result.reason);
    else{evaluation.eligible=true;evaluation.reason='PAPER_EXPERIMENT_OPENED';}
    return outcome(result.ok?'OPENED':'BLOCKED',result.ok?'AGGRESSIVE_PAPER_EXPERIMENT':result.reason);
  }
  return outcome('NO_TRADE',candidates.length?'PAPER_EXPERIMENT_ENTRY_REJECTED':'PAPER_EXPERIMENT_CANDLE_UNAVAILABLE');
}