/** Fixed existing historical corpus; no downloads, orders, tuning, or profit claim.
 * Compares entry-plan compatibility, NOT a portfolio backtest or OOS profitability proof. */
import { OFFLINE_BTC_BINANCE_DATASET as data } from '../artifacts/api-server/src/intel/fixtures/offlineBtcBinanceDatasetV2';
import { buildMultiTimeframeCandleSet, DEFAULT_CANDLE_FOUNDATION_CONFIG } from '../artifacts/api-server/src/intel/candleFoundationV2';
import { computeCandleTechnicalSnapshot } from '../artifacts/api-server/src/intel/candleTechnicalFeaturesV2';
import { extractLatestCandleFeatures } from '../artifacts/api-server/src/intel/candlePatternFeatures';
import { computeMarketStructure } from '../artifacts/api-server/src/intel/marketStructureV2';
import { evaluateRegime } from '../artifacts/api-server/src/intel/regimeEngineV2';
import { evaluateTrendPullback } from '../artifacts/api-server/src/intel/trendPullbackStrategyV2';
import { evaluateVolatilityBreakout } from '../artifacts/api-server/src/intel/volatilityBreakoutStrategyV2';
import { evaluateRangeMeanReversion } from '../artifacts/api-server/src/intel/rangeMeanReversionStrategyV2';
import { arbitrateStrategySignals } from '../artifacts/api-server/src/intel/strategyArbiterV2';
import { deriveConservativeShadowCostBps } from '../artifacts/api-server/src/intel/strategyShadowWorkerBatchV2';
import { buildVirtualTradePlan, buildStructuralTradePlan } from '../artifacts/api-server/src/workers/virtualPaperTradingMode';
import type { CostSnapshot } from '../artifacts/api-server/src/lib/costSnapshot';
import type { RegimeState } from '../artifacts/api-server/src/intel/regimeEngineV2';
import type { CandleFrameInput } from '../artifacts/api-server/src/intel/candleFoundationV2';
const market = '0x1111111111111111111111111111111111111111';
const steps = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const reports=[];
for (const stress of [1,2]) {
  let previous: RegimeState | null=null;
  const counts:Record<string,number>={}; const bump=(key:string)=>{counts[key]=(counts[key]??0)+1;};
  for(const candle of data.candles['15m'].slice(239)) {
    const close=candle.t+steps['15m']; const now=close+2001;
    const cost=data.costs.find(c=>c.observedAtMs===close); if(!cost){bump('COST_MISSING');continue;}
    const frames=Object.fromEntries(Object.entries(steps).map(([tf,step])=>[tf,{
      symbol:'BTC',timeframe:tf,source:'binance-spot-rest-capture',fetchedAtMs:now,
      candles:data.candles[tf as keyof typeof steps].filter(c=>c.t+step<=now).slice(-240),
    }])) as Record<keyof typeof steps,CandleFrameInput>;
    const snapshot=(long:boolean):CostSnapshot=>({market,isLong:long,orderType:'MarketIncrease',notionalUsd:100,
      positionFeeUsd:cost.feeBpsPerSide/100*stress,estimatedExitFeeUsd:cost.feeBpsPerSide/100*stress,
      executionFeeUsd:0,estimatedPriceImpactUsd:(cost.impactBps+cost.entrySlippageBps)/100*stress,
      estimatedExitPriceImpactUsd:(cost.impactBps+cost.exitSlippageBps)/100*stress,
      fundingFeeUsd:cost.fundingBpsPerHour/100*stress,borrowingFeeUsd:0,
      fundingRatePerHourFraction:cost.fundingBpsPerHour/10_000*stress,borrowingRatePerHourFraction:0,
      totalEstimatedRoundTripCostUsd:(cost.feeBpsPerSide*2+cost.impactBps*2+cost.entrySlippageBps+cost.exitSlippageBps+cost.fundingBpsPerHour)/100*stress,
      source:'PAPER_GMX_ESTIMATE',blockNumber:null,apiTimestamp:new Date(now).toISOString(),
      fetchedAt:new Date(now).toISOString(),expiresAt:new Date(now+60_000).toISOString()});
    const evidence=deriveConservativeShadowCostBps({market,notionalUsd:100,holdingHorizonHours:1,long:snapshot(true),short:snapshot(false)},now);
    // Explicit offline source allowlist on this pure validator only. Runtime GMX allowlist is unchanged.
    const foundation=buildMultiTimeframeCandleSet('BTC',frames,now,{...DEFAULT_CANDLE_FOUNDATION_CONFIG,trustedSources:['binance-spot-rest-capture']});
    if(!foundation.tradeAllowed){bump('FOUNDATION_REJECT');continue;}
    const c15=foundation.frames['15m']!.candles,c1=foundation.frames['1h']!.candles;
    const technical15m=computeCandleTechnicalSnapshot(c15),technical1h=computeCandleTechnicalSnapshot(c1);
    const structure15m=computeMarketStructure(c15),structure1h=computeMarketStructure(c1);
    const pattern15m=extractLatestCandleFeatures(c15);
    const regime=evaluateRegime({symbol:'BTC',sourceCandleCloseTime:close,currentClose:c15.at(-1)!.c,
      momentumPct:(c1.at(-1)!.c/c1.at(-5)!.c-1)*100,technical:technical1h,structure:structure1h},previous);
    previous=regime;bump(`REGIME:${regime.regime}`);
    const commonSignal={symbol:'BTC',sourceCandleCloseTime:close,evaluatedAt:now,entryPrice:c15.at(-1)!.c,
      expectedCostsBps:evidence.expectedCostsBps,dataQuality:foundation.quality==='GOOD'?'GOOD' as const:'DEGRADED' as const,
      regime,structure1h,structure15m,pattern15m};
    const arbiter=arbitrateStrategySignals({symbol:'BTC',regime:regime.regime,sourceCandleCloseTime:close,candidates:[
      evaluateTrendPullback({...commonSignal,atr15m:technical15m.atr.absolute}),
      evaluateVolatilityBreakout({...commonSignal,technical15m}),evaluateRangeMeanReversion({...commonSignal,technical15m})]});
    bump(arbiter.action);const selected=arbiter.selectedSignal;if(!selected)continue;
    const r={entryPrice:selected.proposedEntryPrice,structuralStop:selected.structuralStop,
      strategyTargetPrice:selected.targets[0]?.price,confidence:selected.confidence,expectedNetEdgeBps:selected.netExpectedEdgeBps};
    if(!r.entryPrice||!r.structuralStop||!r.strategyTargetPrice)continue;
    bump('DIRECTIONAL_RECORD');if((r.confidence??0)<80){bump('CONFIDENCE_BELOW_80');continue;}
    const distance=Math.abs(r.entryPrice-r.structuralStop)/r.entryPrice;
    const notional=Math.min(200,1.6/distance);
    const holding=Math.ceil(notional*cost.fundingBpsPerHour/10_000*stress*12*100-1e-9)/100;
    const estimated=notional*(cost.feeBpsPerSide*2+cost.impactBps*2+cost.entrySlippageBps+cost.exitSlippageBps)/10_000*stress+holding;
    if(estimated>.4){bump('HORIZON_COST_OVER_CAP');continue;}
    const common={mode:'INTRADAY' as const,entryPrice:r.entryPrice,structuralStop:r.structuralStop,notionalUsd:notional,
      maxLeverage:10,costReserveUsd:.4,riskBudgetUsd:2,openedAtMs:now};
    const old=buildVirtualTradePlan(common);
    bump(old.ok && notional*(r.expectedNetEdgeBps??0)/10_000-holding>=old.plan.collateralUsd*old.plan.targetRoePct/100?'LEGACY_PLAN_COMPATIBLE':'LEGACY_PLAN_REJECTED');
    const next=buildStructuralTradePlan({...common,targetPrice:r.strategyTargetPrice,estimatedRoundTripCostUsd:estimated});
    bump(next.ok?'STRUCTURAL_PLAN_COMPATIBLE':next.reason);
  }
  reports.push({costStress:stress,counts});
}
console.log(JSON.stringify({kind:'HISTORICAL_ENTRY_COMPATIBILITY_ONLY',dataset:data.provenance,
  selection:'Entire committed 15m corpus after 239-candle warmup; no parameter search or period selection',
  limitations:['BTC only; Binance spot prices and modeled derivatives costs, not historical GMX fills',
    'Candidate/plan comparison only: no CandleSignal final execution gate, lifecycle or portfolio simulation',
    'No daily returns, OOS profitability, or multi-coin coverage established',
    'Legacy and structural policies compared on identical completed candles and costs'],reports},null,2));
