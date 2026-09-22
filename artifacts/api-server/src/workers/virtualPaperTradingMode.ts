import type { DbTrade } from '@workspace/db';
import type { CostSnapshot } from '../lib/costSnapshot';
import { accrueHoldingCostsFromEntryRates } from '../lib/holdingCosts';

/** Research presets, NOT optimized returns or account-wide profit promises. */
export const VIRTUAL_TRADING_MODES = {
  INTRADAY: { label: '단타', minTargetRoePct: 5, maxTargetRoePct: 10, targetRoePct: 7.5,
    stopRoePct: 3, maxHoldHours: 12, strategies: ['TREND_PULLBACK', 'VOLATILITY_BREAKOUT', 'RANGE_MEAN_REVERSION'] },
  SWING: { label: '중기 스윙', minTargetRoePct: 10, maxTargetRoePct: 20, targetRoePct: 15,
    stopRoePct: 5, maxHoldHours: 72, strategies: ['TREND_PULLBACK'] },
} as const;
export type VirtualTradingMode = keyof typeof VIRTUAL_TRADING_MODES;
export const MODE_VERSION = 'virtual-trading-mode/v1';
export const LEGACY_DAILY_PLAN_VERSION = 'virtual-daily-experiment/v3';
export const DAILY_PLAN_VERSION = 'virtual-daily-experiment/v4';
export const STRUCTURAL_PLAN_VERSION = 'virtual-structural-plan/v2';
export const VIRTUAL_ENTRY_OPTIONS = Object.fromEntries(Object.entries(VIRTUAL_TRADING_MODES).map(([key, spec]) =>
  [key, { ...spec, targetRoePct: null, stopRoePct: 10, exitBasis: 'STRATEGY_PRICE_TARGET',
    dailyAccountTargetPct: [5, 10], minimumNetRewardRisk: 1.5 }]));
export const MODE_DECISION_PREFIX = 'vp400m1:';
export const tradingModeKey = (sessionId: string) => `virtual_trading_mode_v1:${sessionId}`;
export const isTradingMode = (value: unknown): value is VirtualTradingMode => value === 'INTRADAY' || value === 'SWING';
export interface TradingModeSelection { version: typeof MODE_VERSION; mode: VirtualTradingMode; sessionId: string; updatedAt: string }
export function readTradingMode(raw: string | null, sessionId: string): TradingModeSelection | null {
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).sort().join(',') !== 'mode,sessionId,updatedAt,version'
    || value.version !== MODE_VERSION || !isTradingMode(value.mode) || value.sessionId !== sessionId
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || new Date(value.updatedAt).toISOString() !== value.updatedAt) throw new Error('VIRTUAL_TRADING_MODE_INVALID');
  return value;
}
export interface VirtualTradePlan {
  version: typeof MODE_VERSION | typeof STRUCTURAL_PLAN_VERSION | typeof DAILY_PLAN_VERSION | typeof LEGACY_DAILY_PLAN_VERSION; mode: VirtualTradingMode; basis: 'INITIAL_POSITION_MARGIN_NET_ESTIMATED';
  targetRoePct: number; stopRoePct: number; maxHoldHours: number;
  entryPrice: number; structuralStop: number; notionalUsd: number; leverage: number;
  collateralUsd: number; costReserveUsd: number; plannedRiskUsd: number; tpPrice: number;
  openedAtMs: number; expiresAtMs: number;
  estimatedRoundTripCostUsd?: number;
}
const finitePositive = (v: number) => Number.isFinite(v) && v > 0;

/** Includes the entire selected holding horizon; uses the same rounded PAPER cost model as settlement. */
export function modeHoldingCost(cost: Pick<CostSnapshot, 'notionalUsd' | 'fundingRatePerHourFraction' | 'borrowingRatePerHourFraction'>, hours: number): number | null {
  const result = accrueHoldingCostsFromEntryRates({ notionalUsd: cost.notionalUsd, openedAtMs: 0,
    closedAtMs: hours * 3_600_000, fundingRatePerHourFraction: cost.fundingRatePerHourFraction,
    borrowingRatePerHourFraction: cost.borrowingRatePerHourFraction });
  return result.ok ? result.totalUsd : null;
}
export function buildVirtualTradePlan(input: { mode: VirtualTradingMode; entryPrice: number; structuralStop: number;
  notionalUsd: number; maxLeverage: number; costReserveUsd: number; riskBudgetUsd: number; openedAtMs: number }):
  { ok: true; plan: VirtualTradePlan } | { ok: false; reason: string } {
  const spec = VIRTUAL_TRADING_MODES[input.mode];
  if (!spec || ![input.entryPrice, input.structuralStop, input.notionalUsd, input.maxLeverage, input.riskBudgetUsd, input.openedAtMs].every(finitePositive)
    || input.costReserveUsd !== 0.4) return { ok: false, reason: 'MODE_COST_OR_INPUT_INVALID' };
  const distance = Math.abs(input.entryPrice - input.structuralStop) / input.entryPrice;
  const risk = input.notionalUsd * distance + input.costReserveUsd;
  if (distance <= 0 || distance >= 0.5 || risk > input.riskBudgetUsd + 1e-8) return { ok: false, reason: 'MODE_ACCOUNT_RISK_CAP' };
  // More collateral can reduce ROE risk; never shrink a structural stop or enlarge notional.
  const leverage = Math.floor(Math.min(10, input.maxLeverage, input.notionalUsd * spec.stopRoePct / 100 / risk) + 1e-10);
  const collateral = input.notionalUsd / leverage;
  if (leverage < 5 || !finitePositive(collateral) || collateral < 1.1 || collateral > 100)
    return { ok: false, reason: 'MODE_STOP_ROE_OR_MIN_LEVERAGE' };
  const reward = collateral * spec.targetRoePct / 100;
  if (reward < risk * 2 - 1e-8) return { ok: false, reason: 'MODE_NET_REWARD_RISK_BELOW_TWO' };
  const direction = input.structuralStop < input.entryPrice ? 1 : -1;
  const tp = input.entryPrice * (1 + direction * (reward + input.costReserveUsd) / input.notionalUsd);
  if (!finitePositive(tp)) return { ok: false, reason: 'MODE_TARGET_INVALID' };
  return { ok: true, plan: { version: MODE_VERSION, mode: input.mode, basis: 'INITIAL_POSITION_MARGIN_NET_ESTIMATED',
    targetRoePct: spec.targetRoePct, stopRoePct: spec.stopRoePct, maxHoldHours: spec.maxHoldHours,
    entryPrice: input.entryPrice, structuralStop: input.structuralStop, notionalUsd: input.notionalUsd,
    leverage, collateralUsd: collateral, costReserveUsd: input.costReserveUsd, plannedRiskUsd: risk, tpPrice: tp,
    openedAtMs: input.openedAtMs, expiresAtMs: input.openedAtMs + spec.maxHoldHours * 3_600_000 } };
}

/** Uses the strategy's existing target, not the account's daily aspiration as a per-trade gate.
 * Risk reserve and account/notional caps remain unchanged. Costs enter both net reward and loss.
 * The 1.5 net R:R floor matches the strategy arbiter; old v1 plans retain their exact contract. */
export function buildStructuralTradePlan(input: { mode: VirtualTradingMode; entryPrice: number; structuralStop: number;
  targetPrice: number; notionalUsd: number; maxLeverage: number; costReserveUsd: number;
  estimatedRoundTripCostUsd: number; riskBudgetUsd: number; openedAtMs: number }):
  { ok: true; plan: VirtualTradePlan } | { ok: false; reason: string } {
  const spec = VIRTUAL_TRADING_MODES[input.mode];
  if (!spec || ![input.entryPrice, input.structuralStop, input.targetPrice, input.notionalUsd,
    input.maxLeverage, input.riskBudgetUsd, input.openedAtMs].every(finitePositive)
    || input.costReserveUsd !== .4 || !Number.isFinite(input.estimatedRoundTripCostUsd)
    || input.estimatedRoundTripCostUsd < 0 || input.estimatedRoundTripCostUsd > .4)
    return { ok: false, reason: 'MODE_COST_OR_INPUT_INVALID' };
  const direction = input.structuralStop < input.entryPrice ? 1 : -1;
  const distance = Math.abs(input.entryPrice - input.structuralStop) / input.entryPrice;
  const priceRisk = input.notionalUsd * distance;
  const risk = priceRisk + input.costReserveUsd;
  if (distance <= 0 || distance >= .5 || risk > input.riskBudgetUsd + 1e-8)
    return { ok: false, reason: 'MODE_ACCOUNT_RISK_CAP' };
  const reward = input.notionalUsd * (input.targetPrice / input.entryPrice - 1) * direction - input.estimatedRoundTripCostUsd;
  if (reward <= 0 || reward + 1e-8 < 1.5 * (priceRisk + input.estimatedRoundTripCostUsd))
    return { ok: false, reason: 'MODE_NET_REWARD_RISK_BELOW_STRATEGY_FLOOR' };
  const leverage = Math.floor(Math.min(10, input.maxLeverage, input.notionalUsd * .10 / risk) + 1e-10);
  const collateral = input.notionalUsd / leverage;
  if (leverage < 5 || !finitePositive(collateral) || collateral < 1.1 || collateral > 100)
    return { ok: false, reason: 'MODE_STOP_ROE_OR_MIN_LEVERAGE' };
  return { ok: true, plan: { version: STRUCTURAL_PLAN_VERSION, mode: input.mode,
    basis: 'INITIAL_POSITION_MARGIN_NET_ESTIMATED', targetRoePct: reward / collateral * 100,
    stopRoePct: 10, maxHoldHours: spec.maxHoldHours, entryPrice: input.entryPrice,
    structuralStop: input.structuralStop, notionalUsd: input.notionalUsd, leverage,
    collateralUsd: collateral, costReserveUsd: .4, plannedRiskUsd: risk, tpPrice: input.targetPrice,
    estimatedRoundTripCostUsd: input.estimatedRoundTripCostUsd,
    openedAtMs: input.openedAtMs, expiresAtMs: input.openedAtMs + spec.maxHoldHours * 3_600_000 } };
}

export function buildDailyTradePlan(input:{mode:VirtualTradingMode;entryPrice:number;structuralStop:number;
  notionalUsd:number;maxLeverage:number;estimatedRoundTripCostUsd:number;riskBudgetUsd:number;openedAtMs:number}, legacy = false):
  {ok:true;plan:VirtualTradePlan}|{ok:false;reason:string} {
  if(!isTradingMode(input.mode)||![input.entryPrice,input.structuralStop,input.notionalUsd,input.maxLeverage,input.riskBudgetUsd,input.openedAtMs].every(finitePositive)
    ||!Number.isFinite(input.estimatedRoundTripCostUsd)||input.estimatedRoundTripCostUsd<0||input.estimatedRoundTripCostUsd>2
    ||input.notionalUsd>1000)return {ok:false,reason:'DAILY_PLAN_INPUT_INVALID'};
  const distance=Math.abs(input.entryPrice-input.structuralStop)/input.entryPrice;
  const risk=input.notionalUsd*distance+2;
  if(distance<.002-1e-10||distance>.008+1e-10||risk>input.riskBudgetUsd+1e-8)return {ok:false,reason:'DAILY_PLAN_RISK_CAP'};
  const leverage=Math.floor(Math.min(10,input.maxLeverage,input.notionalUsd*.1/risk)+1e-10);
  const collateral=input.notionalUsd/leverage;
  if(leverage<5||!finitePositive(collateral)||collateral<1.1||collateral>100)return {ok:false,reason:'DAILY_PLAN_MARGIN_CAP'};
  const maxHoldHours=input.mode==='INTRADAY'?(legacy?.5:1):4;
  const direction=input.structuralStop<input.entryPrice?1:-1;
  const tpPrice=input.entryPrice*(1+direction*2*distance);
  return {ok:true,plan:{version:legacy?LEGACY_DAILY_PLAN_VERSION:DAILY_PLAN_VERSION,mode:input.mode,basis:'INITIAL_POSITION_MARGIN_NET_ESTIMATED',
    targetRoePct:(input.notionalUsd*distance*2-input.estimatedRoundTripCostUsd)/collateral*100,
    stopRoePct:10,maxHoldHours,entryPrice:input.entryPrice,structuralStop:input.structuralStop,
    notionalUsd:input.notionalUsd,leverage,collateralUsd:collateral,costReserveUsd:2,plannedRiskUsd:risk,tpPrice,
    estimatedRoundTripCostUsd:input.estimatedRoundTripCostUsd,openedAtMs:input.openedAtMs,expiresAtMs:input.openedAtMs+maxHoldHours*3_600_000}};
}
export const DAILY_ENTRY_OPTIONS = Object.fromEntries(Object.entries(VIRTUAL_ENTRY_OPTIONS).map(([mode,spec])=>
  [mode,{...spec,exitBasis:'PAPER_EXPERIMENT_PRICE_TARGET',minimumNetRewardRisk:null,
    dailyAccountTargetPct:[5,10],dailyProfitCapPct:20,maxHoldHours:mode==='INTRADAY'?1:4,purpose:'AGGRESSIVE_PAPER_EXPERIMENT'}]));

/** Rebuild rather than trust serialized ROE/TP/expiry values. Never repair malformed evidence silently. */
export function parseVirtualTradePlan(value: unknown): VirtualTradePlan | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as VirtualTradePlan;
  if (!isTradingMode(p.mode)) return null;
  if (p.version !== MODE_VERSION && p.version !== STRUCTURAL_PLAN_VERSION && p.version !== DAILY_PLAN_VERSION && p.version !== LEGACY_DAILY_PLAN_VERSION) return null;
  const args = { mode: p.mode, entryPrice: p.entryPrice, structuralStop: p.structuralStop,
    notionalUsd: p.notionalUsd, maxLeverage: p.leverage, costReserveUsd: p.costReserveUsd,
    riskBudgetUsd: p.plannedRiskUsd, openedAtMs: p.openedAtMs };
  const rebuilt = (p.version === DAILY_PLAN_VERSION || p.version === LEGACY_DAILY_PLAN_VERSION)
    ? buildDailyTradePlan({...args,estimatedRoundTripCostUsd:p.estimatedRoundTripCostUsd!},p.version===LEGACY_DAILY_PLAN_VERSION)
    : p.version === STRUCTURAL_PLAN_VERSION
    ? buildStructuralTradePlan({ ...args, targetPrice: p.tpPrice, estimatedRoundTripCostUsd: p.estimatedRoundTripCostUsd! })
    : buildVirtualTradePlan(args);
  if (!rebuilt.ok || Object.keys(p).length !== Object.keys(rebuilt.plan).length) return null;
  return Object.entries(rebuilt.plan).every(([key, v]) => p[key as keyof VirtualTradePlan] === v) ? p : null;
}

/** Management is bound to the entry's immutable plan, never the current selector.
 * Missing/invalid plan or cost evidence requests a protective exit; existing price SL stays independent. */
export function tradingModeExit(row: DbTrade, rawPlan: unknown, price: number, nowMs: number): string | null {
  const plan = parseVirtualTradePlan(rawPlan);
  if (!plan) return 'MODE_PLAN_UNAVAILABLE';
  if (!finitePositive(price) || !Number.isFinite(nowMs)) return null;
  const opened = new Date(row.timestamp).getTime();
  if (nowMs < opened || !Number.isFinite(opened) || Math.abs(opened - plan.openedAtMs) > 1)
    return 'MODE_PLAN_TIME_INVALID';
  if (nowMs >= plan.expiresAtMs) return 'MODE_TIME_EXIT';
  const size = row.sizeInUsd === null ? NaN : Number(row.sizeInUsd);
  const entry = Number(row.price);
  const margin = size / plan.leverage; // remaining stake after any Risk REDUCE70
  const entryCost = row.estEntryCostUsd === null ? NaN : Number(row.estEntryCostUsd);
  const exitCost = row.estExitCostUsd === null ? NaN : Number(row.estExitCostUsd);
  const holding = accrueHoldingCostsFromEntryRates({ notionalUsd: size, openedAtMs: opened, closedAtMs: nowMs,
    fundingRatePerHourFraction: row.fundingRatePerHour === null ? null : Number(row.fundingRatePerHour),
    borrowingRatePerHourFraction: row.borrowingRatePerHour === null ? null : Number(row.borrowingRatePerHour) });
  if (!holding.ok || ![size, entry, margin].every(finitePositive)
    || ![entryCost, exitCost].every(v => Number.isFinite(v) && v >= 0)) return 'MODE_COST_UNAVAILABLE';
  const net = size * (price / entry - 1) * (row.side === 'SHORT' ? -1 : 1) - entryCost - exitCost - holding.totalUsd;
  const roe = net / margin * 100;
  if (roe <= -plan.stopRoePct) return 'MODE_NET_STOP';
  if ((plan.version === STRUCTURAL_PLAN_VERSION || plan.version === DAILY_PLAN_VERSION || plan.version === LEGACY_DAILY_PLAN_VERSION) && (row.side === 'SHORT' ? price <= plan.tpPrice : price >= plan.tpPrice))
    return 'TAKE_PROFIT';
  if (plan.version === MODE_VERSION && roe >= plan.targetRoePct) return 'MODE_NET_TAKE_PROFIT';
  return null;
}
