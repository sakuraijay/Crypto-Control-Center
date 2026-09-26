import { describe, it, expect } from 'vitest';
import type { DbTrade } from '@workspace/db';
import { buildVirtualTradePlan, parseVirtualTradePlan, readTradingMode, tradingModeExit, modeHoldingCost,
  type VirtualTradingMode, MODE_VERSION } from '../workers/virtualPaperTradingMode';
import { virtualReplayCost } from './helpers/virtualPaper400Replay';
const now = Date.parse('2026-09-21T01:00:00Z');
function build(mode: VirtualTradingMode = 'INTRADAY', overrides = {}) {
  return buildVirtualTradePlan({ mode, entryPrice: 100, structuralStop: 99.8, notionalUsd: 200,
    maxLeverage: 10, costReserveUsd: .4, riskBudgetUsd: 2, openedAtMs: now, ...overrides });
}
describe('PAPER mode plans and immutable exit contract', () => {
  it.each(['INTRADAY','SWING'] as const)('computes net targets for %s without expanding notional or shrinking structural stops', mode => {
    const result = build(mode); expect(result.ok).toBe(true); if (!result.ok) return;
    const p = result.plan;
    expect(p.structuralStop).toBe(99.8); expect(p.notionalUsd).toBe(200);
    expect(p.leverage).toBeGreaterThanOrEqual(5); expect(p.leverage).toBeLessThanOrEqual(10);
    expect(p.plannedRiskUsd / p.collateralUsd * 100).toBeLessThanOrEqual(p.stopRoePct + 1e-8);
    expect(p.stopRoePct).toBeLessThan(10);
    expect((p.tpPrice / 100 - 1) * 200 - .4).toBeCloseTo(p.targetRoePct / 100 * p.collateralUsd);
    expect(p.targetRoePct / 100 * p.collateralUsd).toBeGreaterThanOrEqual(p.plannedRiskUsd * 2);
    expect(parseVirtualTradePlan(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it('rejects structural risk incompatible with five times leverage, instead of tightening the stop', () => {
    expect(build('INTRADAY', { structuralStop: 99 })).toEqual({ ok: false, reason: 'MODE_ACCOUNT_RISK_CAP' });
    expect(build('INTRADAY', { structuralStop: 99.59 })).toEqual({ ok: false, reason: 'MODE_STOP_ROE_OR_MIN_LEVERAGE' });
  });
  it.each(['stopRoePct','targetRoePct','expiresAtMs','costReserveUsd','tpPrice'])('rejects forged %s evidence', key => {
    const result = build(); if (!result.ok) throw Error('fixture');
    expect(parseVirtualTradePlan({ ...result.plan, [key]: 999 })).toBeNull();
  });
  it('includes 72-hour holding costs and refuses absent funding rates', () => {
    const cost = virtualReplayCost(now, 200);
    expect(modeHoldingCost(cost, 72)).toBeCloseTo(.3);
    expect(modeHoldingCost(cost, 12)).toBeCloseTo(.06);
    expect(modeHoldingCost({ ...cost, fundingRatePerHourFraction: null }, 72)).toBeNull();
  });
  it('uses the entry plan after restart, exits on net gain/cost loss/deadline, and reports gaps honestly', () => {
    const result = build('SWING'); if (!result.ok) throw Error('fixture');
    const p = JSON.parse(JSON.stringify(result.plan));
    const row = { timestamp: new Date(now), sizeInUsd:'200', price:'100', side:'LONG',
      estEntryCostUsd:'.015', estExitCostUsd:'.015', fundingRatePerHour:'.00001', borrowingRatePerHour:'.00001' } as DbTrade;
    expect(tradingModeExit(row,p,100,now+1000)).toBeNull();
    expect(tradingModeExit(row,p,102,now+1000)).toBe('MODE_NET_TAKE_PROFIT');
    expect(tradingModeExit(row,p,99,now+1000)).toBe('MODE_NET_STOP');
    expect(tradingModeExit(row,p,80,now+1000)).toBe('MODE_NET_STOP'); // gap loss is NOT clamped to 10%
    expect(tradingModeExit(row,p,100,now+72*3_600_000)).toBe('MODE_TIME_EXIT');
    expect(tradingModeExit(row,null,100,now+1000)).toBe('MODE_PLAN_UNAVAILABLE');
    expect(tradingModeExit({...row,estExitCostUsd:null},p,100,now+1000)).toBe('MODE_COST_UNAVAILABLE');
  });
  it('builds short-side targets symmetrically', () => {
    const result=build('SWING',{structuralStop:100.2}); if(!result.ok)throw Error('fixture');
    expect(result.plan.tpPrice).toBeLessThan(100);
    const row={timestamp:new Date(now),sizeInUsd:'200',price:'100',side:'SHORT',estEntryCostUsd:'.015',estExitCostUsd:'.015',fundingRatePerHour:'0',borrowingRatePerHour:'0'} as DbTrade;
    expect(tradingModeExit(row,result.plan,98,now+1000)).toBe('MODE_NET_TAKE_PROFIT');
  });
  it('validates saved mode/session instead of falling back on corruption', () => {
    expect(readTradingMode(null,'s')).toBeNull();
    const selected={version:MODE_VERSION,mode:'SWING',sessionId:'s',updatedAt:new Date(now).toISOString()};
    expect(readTradingMode(JSON.stringify(selected),'s')).toEqual(selected);
    expect(()=>readTradingMode(JSON.stringify(selected),'another')).toThrow();
    expect(()=>readTradingMode(JSON.stringify({...selected,mode:'UNKNOWN'}),'s')).toThrow();
  });
});

import { buildStructuralTradePlan, STRUCTURAL_PLAN_VERSION } from '../workers/virtualPaperTradingMode';
describe('strategy-price plan replaces the contradictory fixed ROE entry gate',()=>{
  const args=()=>({mode:'INTRADAY' as const,entryPrice:100,structuralStop:99.2,targetPrice:101.6,
    notionalUsd:200,maxLeverage:10,costReserveUsd:.4,estimatedRoundTripCostUsd:.12,riskBudgetUsd:2,openedAtMs:now});
  it('admits a cost-positive 2R price signal, keeps exposure and stop, and caps net margin risk at 10%',()=>{
    expect(build('INTRADAY',{structuralStop:99.2}).ok).toBe(false);
    const r=buildStructuralTradePlan(args());expect(r.ok).toBe(true);if(!r.ok)return;
    expect(r.plan).toMatchObject({version:STRUCTURAL_PLAN_VERSION,notionalUsd:200,structuralStop:99.2,tpPrice:101.6});
    expect(r.plan.plannedRiskUsd).toBeCloseTo(2);expect(r.plan.leverage).toBeGreaterThanOrEqual(5);
    expect(r.plan.plannedRiskUsd/r.plan.collateralUsd).toBeLessThanOrEqual(.1+1e-9);
    expect(parseVirtualTradePlan(JSON.parse(JSON.stringify(r.plan)))).toEqual(r.plan);
  });
  it('refuses cost-adjusted negative/weak reward, reversed targets and risk above budget',()=>{
    for(const changes of [{targetPrice:100.1},{targetPrice:99},{estimatedRoundTripCostUsd:.41},{riskBudgetUsd:1.9},{structuralStop:100},{maxLeverage:4}]){
      expect(buildStructuralTradePlan({...args(),...changes}).ok).toBe(false);
    }
  });
  it('supports shorts and rejects forged saved risk/cost contracts',()=>{
    const r=buildStructuralTradePlan({...args(),structuralStop:100.8,targetPrice:98.4});if(!r.ok)throw Error(r.reason);
    expect(parseVirtualTradePlan(r.plan)).toEqual(r.plan);
    for(const key of ['plannedRiskUsd','stopRoePct','estimatedRoundTripCostUsd','targetRoePct'])expect(parseVirtualTradePlan({...r.plan,[key]:999})).toBeNull();
  });
});
