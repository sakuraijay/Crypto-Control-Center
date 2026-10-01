import type { AppliedRiskProfileSnapshot } from '../lib/riskProfiles';
import { EMPTY_LOCKS, type RiskEvaluationResult, type PersistedLocks } from '../lib/riskStateMachine';
export const LEGACY_DAILY_PAPER_POLICY = Object.freeze({ version: 'virtual400-daily/v7',
  riskPerTradePct: 1, minLeverage: 5, maxLeverage: 10, maxMarginUsd: 100, maxNotionalUsd: 1000,
  cooldownMinutes: 45, maxDailyEntries: 32, dailyLossPct: 5, dailyProfitTargetMinPct: 5, dailyProfitCapPct: 20, dailyBudgetBasis: 'FUNDED_PRINCIPAL', maxRoundTripCostUsd: 2,
  weeklyLossPct: 10, cumulativeLossPct: 30, minimumNetRewardRisk: 1.5,
  purpose: 'COST_FILTERED_PAPER_EXPERIMENT', confidence: null });
/**
 * v8 changes signal selection and admits only structurally evidenced plans
 * with positive net reward and >=1 net-R:R. Principal/loss/position/exposure
 * limits intentionally match v7; this is not a less-protected account policy.
 */
export const DAILY_PAPER_POLICY = Object.freeze({ version: 'virtual400-daily/v8',
  riskPerTradePct: 1, minLeverage: 5, maxLeverage: 10, maxMarginUsd: 100, maxNotionalUsd: 1000,
  cooldownMinutes: 45, maxDailyEntries: 32, dailyLossPct: 5, dailyProfitTargetMinPct: 5, dailyProfitCapPct: 20, dailyBudgetBasis: 'FUNDED_PRINCIPAL', maxRoundTripCostUsd: 2,
  weeklyLossPct: 10, cumulativeLossPct: 30, minimumNetRewardRisk: 1,
  adaptiveVolatilityMultiplierMin: .45, adaptiveVolatilityMultiplierMax: 3, minimumAdaptiveAtrPct: .0002,
  maximumAdaptiveAtrPct: .02, minimumSignalScore: 45,
  purpose: 'STRUCTURAL_SIGNAL_SCORED_PAPER_EXPERIMENT', confidence: null });
/** Deposits change principal, never daily PnL; equity gains/losses do not resize these daily targets. */
export function dailyPaperBudget(fundedCapitalUsd: number, dailyRealized: number, dailyLossAware: number) {
  if (![fundedCapitalUsd, dailyRealized, dailyLossAware].every(Number.isFinite) || fundedCapitalUsd <= 0)
    throw Error('PAPER_DAILY_BUDGET_INVALID');
  const lossLimitUsd = fundedCapitalUsd * DAILY_PAPER_POLICY.dailyLossPct / 100;
  return { version: 'funded-principal/v1' as const, basis: 'FUNDED_PRINCIPAL' as const,
    referenceCapitalUsd: fundedCapitalUsd, profitTargetMinPct: 5, profitCapPct: 20, lossLimitPct: DAILY_PAPER_POLICY.dailyLossPct,
    profitTargetMinUsd: fundedCapitalUsd * .05, profitCapUsd: fundedCapitalUsd * .20, lossLimitUsd,
    realizedNetPnlUsd: dailyRealized, lossAwareNetPnlUsd: dailyLossAware,
    remainingLossBudgetUsd: Math.max(0, lossLimitUsd + dailyLossAware) };
}
export function dailyPaperProfile(capital: number, appliedAt: string, riskPct = 1): AppliedRiskProfileSnapshot {
  const c = Math.max(0, Math.min(1000, capital));
  return { name:'aggressive',version:'risk-profile/v1',appliedAt,derivedLimits:{
    immediateEntryThreshold:0,maxRiskPerTradePct:riskPct,reserveCashPct:20,
    maxMarginPerTradeUsd:Math.min(100,c*.8),maxConcurrentPositions:1,cooldownMinutes:45,
    maxLeverage:10,maxTotalExposureUsd:Math.min(1000,c*2.5),allocatedTradingCapitalUsd:c,maxRiskPerTradeUsd:c*riskPct/100,
  }};
}
/** Loss recovery is time-bounded: a historical drawdown must not permanently freeze the small-account tier. */
export function dailyPaperRiskPct(consecutiveLosses:number,lastCloseAtMs:number|null,nowMs:number):.5|1 {
  return consecutiveLosses>=2 && lastCloseAtMs!==null && nowMs-lastCloseAtMs<4*3600_000 ? .5 : 1;
}
export function isDailyPaperProfile(value: unknown): value is AppliedRiskProfileSnapshot {
  if (!value || typeof value!=='object') return false;
  const p=value as AppliedRiskProfileSnapshot;
  if (!p.derivedLimits || !Number.isFinite(p.derivedLimits.allocatedTradingCapitalUsd)
    || typeof p.appliedAt!=='string' || !Number.isFinite(Date.parse(p.appliedAt))) return false;
  if (![.5,1,2].includes(p.derivedLimits.maxRiskPerTradePct)) return false;
  // Two percent profiles belong to immutable pre-v7 positions.
  const expected=dailyPaperProfile(p.derivedLimits.allocatedTradingCapitalUsd,p.appliedAt,p.derivedLimits.maxRiskPerTradePct);
  return Object.keys(p).sort().join(',')===Object.keys(expected).sort().join(',')
    && p.name===expected.name && p.version===expected.version
    && Object.keys(p.derivedLimits).length===Object.keys(expected.derivedLimits).length
    && Object.entries(expected.derivedLimits).every(([k,v])=>p.derivedLimits[k as keyof typeof p.derivedLimits]===v);
}
/** User-authorized PAPER-only loss tolerance. Never alters the common/LIVE risk engine.
 * Ledger and HWM remain intact; existing hard/unresolved locks remain authoritative. */
export function evaluateDailyPaperRisk(i:{equity:number|null;referenceCapital:number;dailyLossAware:number;dailyRealized:number;
  entries:number;held:number;fresh:boolean;locks:PersistedLocks;weeklyLossAware?:number;consecutiveLosses?:number;lastCloseAtMs?:number;nowMs?:number}):RiskEvaluationResult {
  const locks={...EMPTY_LOCKS,weeklyLockReason:i.locks.weeklyLockReason,hardStopReason:i.locks.hardStopReason,unresolvedReason:i.locks.unresolvedReason,
    ...(['PROFIT_CAP_LOCKED','DAILY_LOSS_LOCKED'].includes(i.locks.dailyLockState ?? '')
      ? {dailyLockState:i.locks.dailyLockState,dailyLockReason:i.locks.dailyLockReason}: {})};
  const r:RiskEvaluationResult={state:'NORMAL',entryAllowed:true,blockReasons:[],actions:[],sizeFactor:1,maxLeverage:10,locks};
  const block=(reason:string)=>{r.entryAllowed=false;r.blockReasons.push(reason);return r;};
  if(locks.unresolvedReason){r.state='UNRESOLVED';return block('PAPER_UNRESOLVED');}
  if(locks.hardStopReason){r.state='HARD_STOPPED';return block('PAPER_EXISTING_HARD_STOP');}
  if(!i.fresh || i.equity===null || !Number.isFinite(i.equity))return block('PAPER_MARKET_DATA_UNAVAILABLE');
  if(i.equity<=2.2){r.state='HARD_STOPPED';r.actions=['CLOSE_ALL_POSITIONS'];locks.hardStopReason='PAPER_CAPITAL_EXHAUSTED';return block(locks.hardStopReason);}
  if(!Number.isFinite(i.referenceCapital)||i.referenceCapital<=0||!Number.isFinite(i.dailyRealized)||!Number.isFinite(i.dailyLossAware))return block('PAPER_DAILY_PROFIT_EVIDENCE_INVALID');
  if(i.equity<=i.referenceCapital*(1-DAILY_PAPER_POLICY.cumulativeLossPct/100)){
    r.state='HARD_STOPPED';r.actions=['CLOSE_ALL_POSITIONS'];locks.hardStopReason='PAPER_CUMULATIVE_LOSS_30_PERCENT';return block(locks.hardStopReason);
  }
  if((i.weeklyLossAware??0)<=-i.referenceCapital*DAILY_PAPER_POLICY.weeklyLossPct/100 || locks.weeklyLockReason){
    r.state='WEEKLY_LOSS_LOCKED';r.actions=['CLOSE_ALL_POSITIONS'];locks.weeklyLockReason='PAPER_WEEKLY_LOSS_10_PERCENT';return block(locks.weeklyLockReason);
  }
  if(i.dailyLossAware<=-Math.max(0,i.referenceCapital)*DAILY_PAPER_POLICY.dailyLossPct/100 || i.locks.dailyLockState==='DAILY_LOSS_LOCKED'){
    r.state='DAILY_LOSS_LOCKED';r.actions=['CLOSE_ALL_POSITIONS'];locks.dailyLockState='DAILY_LOSS_LOCKED';locks.dailyLockReason='PAPER_DAILY_LOSS_5_PERCENT';return block(locks.dailyLockReason);
  }
  if(i.dailyRealized>=i.referenceCapital*DAILY_PAPER_POLICY.dailyProfitCapPct/100 || i.locks.dailyLockState==='PROFIT_CAP_LOCKED'){
    r.state='PROFIT_CAP_LOCKED';locks.dailyLockState='PROFIT_CAP_LOCKED';locks.dailyLockReason='PAPER_DAILY_PROFIT_20_PERCENT';return block(locks.dailyLockReason);
  }
  if((i.consecutiveLosses??0)>=3 && i.lastCloseAtMs!==undefined && i.nowMs!==undefined && i.nowMs-i.lastCloseAtMs<4*3600_000)return block('PAPER_LOSS_STREAK_COOLDOWN');
  if(i.held>=1)return block('PAPER_POSITION_HELD');
  if(i.entries>=DAILY_PAPER_POLICY.maxDailyEntries)return block('PAPER_DAILY_ENTRY_CAP');
  return r;
}
