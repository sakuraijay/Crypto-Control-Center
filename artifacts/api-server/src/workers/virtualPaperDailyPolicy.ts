import type { AppliedRiskProfileSnapshot } from '../lib/riskProfiles';
import { EMPTY_LOCKS, type RiskEvaluationResult, type PersistedLocks } from '../lib/riskStateMachine';
export const DAILY_PAPER_POLICY = Object.freeze({ version: 'virtual400-daily/v4',
  riskPerTradePct: 2, minLeverage: 5, maxLeverage: 10, maxMarginUsd: 100, maxNotionalUsd: 1000,
  cooldownMinutes: 45, maxDailyEntries: 32, dailyLossPct: 10, maxRoundTripCostUsd: 2,
  purpose: 'AGGRESSIVE_PAPER_EXPERIMENT', confidence: null });
export function dailyPaperProfile(capital: number, appliedAt: string): AppliedRiskProfileSnapshot {
  const c = Math.max(0, Math.min(500, capital));
  return { name:'aggressive',version:'risk-profile/v1',appliedAt,derivedLimits:{
    immediateEntryThreshold:0,maxRiskPerTradePct:2,reserveCashPct:20,
    maxMarginPerTradeUsd:Math.min(100,c*.8),maxConcurrentPositions:1,cooldownMinutes:45,
    maxLeverage:10,maxTotalExposureUsd:Math.min(1000,c*2.5),allocatedTradingCapitalUsd:c,maxRiskPerTradeUsd:c*.02,
  }};
}
export function isDailyPaperProfile(value: unknown): value is AppliedRiskProfileSnapshot {
  if (!value || typeof value!=='object') return false;
  const p=value as AppliedRiskProfileSnapshot;
  if (!p.derivedLimits || !Number.isFinite(p.derivedLimits.allocatedTradingCapitalUsd)
    || typeof p.appliedAt!=='string' || !Number.isFinite(Date.parse(p.appliedAt))) return false;
  const expected=dailyPaperProfile(p.derivedLimits.allocatedTradingCapitalUsd,p.appliedAt);
  return Object.keys(p).sort().join(',')===Object.keys(expected).sort().join(',')
    && p.name===expected.name && p.version===expected.version
    && Object.keys(p.derivedLimits).length===Object.keys(expected.derivedLimits).length
    && Object.entries(expected.derivedLimits).every(([k,v])=>p.derivedLimits[k as keyof typeof p.derivedLimits]===v);
}
/** User-authorized PAPER-only loss tolerance. Never alters the common/LIVE risk engine.
 * Ledger and HWM remain intact; existing hard/unresolved locks remain authoritative. */
export function evaluateDailyPaperRisk(i:{equity:number|null;dayOpening:number;dailyLossAware:number;
  entries:number;held:number;fresh:boolean;locks:PersistedLocks}):RiskEvaluationResult {
  const locks={...EMPTY_LOCKS,hardStopReason:i.locks.hardStopReason,unresolvedReason:i.locks.unresolvedReason};
  const r:RiskEvaluationResult={state:'NORMAL',entryAllowed:true,blockReasons:[],actions:[],sizeFactor:1,maxLeverage:10,locks};
  const block=(reason:string)=>{r.entryAllowed=false;r.blockReasons.push(reason);return r;};
  if(locks.unresolvedReason){r.state='UNRESOLVED';return block('PAPER_UNRESOLVED');}
  if(locks.hardStopReason){r.state='HARD_STOPPED';return block('PAPER_EXISTING_HARD_STOP');}
  if(!i.fresh || i.equity===null || !Number.isFinite(i.equity))return block('PAPER_MARKET_DATA_UNAVAILABLE');
  if(i.equity<=2.2){r.state='HARD_STOPPED';r.actions=['CLOSE_ALL_POSITIONS'];locks.hardStopReason='PAPER_CAPITAL_EXHAUSTED';return block(locks.hardStopReason);}
  if(i.dailyLossAware<=-Math.max(0,i.dayOpening)*.10 || i.locks.dailyLockState==='DAILY_LOSS_LOCKED'){
    r.state='DAILY_LOSS_LOCKED';r.actions=['CLOSE_ALL_POSITIONS'];locks.dailyLockState='DAILY_LOSS_LOCKED';locks.dailyLockReason='PAPER_DAILY_LOSS_10_PERCENT';return block(locks.dailyLockReason);
  }
  if(i.held>=1)return block('PAPER_POSITION_HELD');
  if(i.entries>=DAILY_PAPER_POLICY.maxDailyEntries)return block('PAPER_DAILY_ENTRY_CAP');
  return r;
}
