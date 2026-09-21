import { describe, it, expect, vi } from 'vitest';
import type { DbTrade } from '@workspace/db';
import { buildActiveVirtualPaper400SessionState, buildStoppedVirtualPaper400SessionState } from '../workers/virtualPaper400SessionState';
import { evaluateVirtualPaper400Account, initialVirtualPaper400RiskState, parseVirtualPaper400RiskState } from '../workers/virtualPaper400Accounting';
import { runVirtualPaper400Cycle, type VirtualPaper400CycleDeps } from '../workers/virtualPaper400Cycle';
import { virtualReplaySignal, virtualReplayCost } from './helpers/virtualPaper400Replay';

const now = new Date('2026-09-20T04:00:10.000Z');
const session = buildActiveVirtualPaper400SessionState('replay-only', new Date(now.getTime() - 3_600_000));
const initial = () => initialVirtualPaper400RiskState(session.session);
const quote = () => ({ priceUsd: 50_000, ageMs: 0 });
function deps(overrides: Partial<VirtualPaper400CycleDeps> = {}): VirtualPaper400CycleDeps {
  return { now, engineMode: 'PAPER', sessionRaw: JSON.stringify(session), previous: initial(), rows: [], quote,
    shouldContinue: () => true, persistRisk: vi.fn(async () => {}),
    readSignals: vi.fn(async () => [virtualReplaySignal(now.getTime())]),
    readCost: vi.fn(async (_s, _l, size) => virtualReplayCost(now.getTime(), size)),
    claim: vi.fn(async () => true), open: vi.fn(async () => ({ ok: true as const, tradeId: 'open-1', stopPriceUsd: 49_000, tpPriceUsd: 52_000 })),
    close: vi.fn(async () => true), reduce: vi.fn(async () => true), ...overrides };
}
function trades(net = -2): DbTrade[] {
  const shared = { symbol: 'BTC', side: 'LONG', strategy: session.session.strategyTag,
    testMode: false, managedBy: 'SERVER', settlementStatus: 'PAPER_ESTIMATED', costSource: 'PAPER_GMX_ESTIMATE',
    estEntryCostUsd: '0.1', estExitCostUsd: '0.1', fundingRatePerHour: '0.00001', borrowingRatePerHour: '0.00001' };
  return [{ ...shared, id: 'open-1', action: 'OPEN', timestamp: new Date(now.getTime() - 2_000),
    closeTime: now.getTime() - 1_000, price: '50000', sizeInUsd: '50', stopPriceUsd: '49000',
    takeProfitPriceUsd: '52000' },
  { ...shared, id: 'close-1', action: 'CLOSE', timestamp: new Date(now.getTime() - 1_000),
    closesTradeId: 'open-1', closeKind: 'FULL', pnl: String(net + 0.2), netPnlEstimatedUsd: String(net),
    estHoldingCostUsd: '0', closeTime: now.getTime() - 1_000 }] as DbTrade[];
}

describe('selected mode routes through strategy, costs, risk, durable claim and OPEN', () => {
  it.each(['INTRADAY','SWING'] as const)('persists %s plan before dispatch and retains the structural invalidation', async tradingMode => {
    const signal={...virtualReplaySignal(now.getTime()),structuralStop:49_900,expectedNetEdgeBps:300};
    const d=deps({policyAppliedAt:now.toISOString(),tradingMode,readSignals:vi.fn(async()=>[signal])});
    const result=await runVirtualPaper400Cycle(d);
    expect(result.status).toBe('OPENED');
    const [id,audit]=vi.mocked(d.claim).mock.calls[0] as [string,any];
    expect(id).toMatch(/^vp400m1:/); expect(audit.tradePlan.mode).toBe(tradingMode);
    const [args]=vi.mocked(d.open).mock.calls[0];
    expect(args.stopPriceUsd).toBe(49_900); expect(args.tpPriceUsd).toBe(audit.tradePlan.tpPrice);
    expect(args.leverage).toBe(audit.tradePlan.leverage); expect(args.sizeUsd).toBeLessThanOrEqual(200);
    expect(audit.tradePlan.plannedRiskUsd).toBeLessThanOrEqual(2);
  });
  it('refuses the old wide stop in intraday mode without shrinking it or dispatching a trade', async()=>{
    const d=deps({policyAppliedAt:now.toISOString(),tradingMode:'INTRADAY'});
    expect((await runVirtualPaper400Cycle(d)).diagnostics[0].reason).toBe('MODE_STOP_ROE_OR_MIN_LEVERAGE');
    expect(d.claim).not.toHaveBeenCalled(); expect(d.open).not.toHaveBeenCalled();
  });
  it.each(['cost','edge','strategy'])('blocks a swing candidate with incompatible %s',async flaw=>{
    const signal={...virtualReplaySignal(now.getTime()),structuralStop:49_900,expectedNetEdgeBps:flaw==='edge'?1:300,
      ...(flaw==='strategy'?{strategyId:'RANGE_MEAN_REVERSION' as const}: {})};
    const d=deps({policyAppliedAt:now.toISOString(),tradingMode:'SWING',readSignals:vi.fn(async()=>[signal]),
      readCost:vi.fn(async(_s,_l,n)=>({...virtualReplayCost(now.getTime(),n),fundingRatePerHourFraction:flaw==='cost'?.001:.00001}))});
    const result=await runVirtualPaper400Cycle(d);
    expect(result.diagnostics[0].reason).toBe(flaw==='cost'?'MODE_HORIZON_COST_CAP':flaw==='edge'?'MODE_TARGET_EXCEEDS_SIGNAL_EDGE':'MODE_STRATEGY_NOT_ELIGIBLE');
    expect(d.open).not.toHaveBeenCalled();
  });
});

describe('VIRTUAL 400 account evidence and restart', () => {
  it('rebuilds nonzero net loss, entries and HWM solely from its own ledger', () => {
    const previous = initial(); previous.equityHwmUsd = 410;
    const result = evaluateVirtualPaper400Account({ session: session.session, previous, rows: trades(), now, quote });
    expect(result.ledger.realizedEquityUsd).toBe(398);
    expect(result.next.risk.dailyRealizedNetPnlUsd).toBe(-2);
    expect(result.next.risk.dailyEntryCount).toBe(1);
    expect(result.next.risk.consecutiveLossCount).toBe(1);
    expect(result.next.equityHwmUsd).toBe(410);
    const restored = parseVirtualPaper400RiskState(JSON.stringify(result.next), session.session);
    expect(evaluateVirtualPaper400Account({ session: session.session, previous: restored, rows: trades(), now, quote }).ledger)
      .toEqual(result.ledger);
  });
  it('retains HARD_STOP across a new day and a resumed session', () => {
    const previous = initial(); previous.risk.locks.hardStopReason = 'prior drawdown';
    const result = evaluateVirtualPaper400Account({ session: session.session, previous, rows: [],
      now: new Date(now.getTime() + 86_400_000), quote });
    expect(result.evaluation.entryAllowed).toBe(false);
    expect(result.next.risk.locks.hardStopReason).toBe('prior drawdown');
  });
  it('rejects deletion or rewriting of a previously checkpointed losing settlement', () => {
    const saved = evaluateVirtualPaper400Account({ session: session.session, previous: initial(), rows: trades(), now, quote }).next;
    expect(() => evaluateVirtualPaper400Account({ session: session.session, previous: saved, rows: [], now, quote })).toThrow('HISTORY_CHANGED');
    expect(() => evaluateVirtualPaper400Account({ session: session.session, previous: saved, rows: trades(1), now, quote })).toThrow('HISTORY_CHANGED');
  });
  it.each(['foreign', 'missing-cost', 'duplicate', 'unresolved', 'client-forgery', 'missing-close', 'double-close'])('rejects %s evidence without fabricating zero', flaw => {
    const rows = trades();
    if (flaw === 'foreign') rows[1].strategy = 'SERVER_WORKER_AI';
    if (flaw === 'missing-cost') rows[1].netPnlEstimatedUsd = null;
    if (flaw === 'duplicate') rows.push(rows[1]);
    if (flaw === 'unresolved') rows[0].closeTime = 0;
    if (flaw === 'client-forgery') rows[1].managedBy = null;
    if (flaw === 'missing-close') rows.pop();
    if (flaw === 'double-close') rows.push({ ...rows[1], id: 'second-full' });
    expect(() => evaluateVirtualPaper400Account({ session: session.session, previous: initial(), rows, now, quote })).toThrow();
  });
  it('blocks missing marks rather than reporting flat equity', () => {
    const row = trades()[0]; row.closeTime = 0;
    const result = evaluateVirtualPaper400Account({ session: session.session, previous: initial(), rows: [row], now, quote: () => null });
    expect(result.equityUsd).toBeNull(); expect(result.evaluation.entryAllowed).toBe(false);
  });
});

describe('VIRTUAL 400 Signal → Risk → sizing → executor boundary (REPLAY)', () => {
  it('persists Risk and durable intent before a namespace-bound structural-stop OPEN', async () => {
    const d = deps(); const result = await runVirtualPaper400Cycle(d);
    expect(result.status).toBe('OPENED');
    expect(d.open).toHaveBeenCalledWith(expect.objectContaining({ strategy: session.session.strategyTag,
      stopPriceUsd: 49_000, leverage: 1, sizeUsd: expect.any(Number) }), expect.any(Object));
    const size = vi.mocked(d.open).mock.calls[0][0].sizeUsd;
    expect(size).toBeLessThanOrEqual(50);
    expect(vi.mocked(d.persistRisk).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.claim).mock.invocationCallOrder[0]);
    expect(vi.mocked(d.claim).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.open).mock.invocationCallOrder[0]);
  });
  it('uses 5–10x collateral allocation without multiplying fixed-cost-inclusive risk', async () => {
    const d = deps({ policyAppliedAt: now.toISOString() });
    const result = await runVirtualPaper400Cycle(d);
    expect(result.status).toBe('OPENED');
    const [open, cost] = vi.mocked(d.open).mock.calls[0];
    expect(open.leverage).toBe(10);
    expect(open.sizeUsd).toBeGreaterThan(50);
    expect(open.sizeUsd).toBe(cost.notionalUsd);
    expect(open.sizeUsd * 0.02 + cost.totalEstimatedRoundTripCostUsd).toBeLessThanOrEqual(2);
    expect(open.sizeUsd / open.leverage).toBeLessThanOrEqual(100);
    expect(result.policy?.version).toBe('virtual400-active/v2');
  });
  it('takes only the highest ranked eligible candidate and exposes missing costs', async () => {
    const signal = virtualReplaySignal(now.getTime());
    const d = deps({ policyAppliedAt: now.toISOString(), readSignals: async () => [signal, signal] });
    expect((await runVirtualPaper400Cycle(d)).status).toBe('OPENED');
    expect(d.open).toHaveBeenCalledOnce();
    const failed = await runVirtualPaper400Cycle(deps({ policyAppliedAt: now.toISOString(), readCost: async () => null }));
    expect(failed.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'COST_UNAVAILABLE' })]));
  });
  it('cannot apply aggressive entries across a pending recovery boundary', async () => {
    const d = deps({ policyAppliedAt: now.toISOString(), entryBlockedReason: 'EXECUTOR_RECOVERY_PENDING' });
    expect((await runVirtualPaper400Cycle(d)).status).toBe('BLOCKED');
    expect(d.open).not.toHaveBeenCalled();
  });
  it.each(['LIVE', 'STOP', 'DUPLICATE', 'MISSING_COST', 'NO_SIGNAL', 'STALE', 'SAVE_FAILURE'])('fails closed for %s without an entry-veto close-all', async reason => {
    const d = deps();
    if (reason === 'LIVE') d.engineMode = 'LIVE';
    if (reason === 'STOP') d.sessionRaw = JSON.stringify(buildStoppedVirtualPaper400SessionState(session, 'pause', now));
    if (reason === 'DUPLICATE') d.claim = vi.fn(async () => false);
    if (reason === 'MISSING_COST') d.readCost = vi.fn(async () => null);
    if (reason === 'NO_SIGNAL') d.readSignals = vi.fn(async () => []);
    if (reason === 'STALE') d.quote = () => ({ priceUsd: 50_000, ageMs: 90_000 });
    if (reason === 'SAVE_FAILURE') d.persistRisk = vi.fn(async () => { throw new Error('DB unavailable'); });
    if (reason === 'SAVE_FAILURE') await expect(runVirtualPaper400Cycle(d)).rejects.toThrow('DB unavailable');
    else expect((await runVirtualPaper400Cycle(d)).status).not.toBe('OPENED');
    expect(d.open).not.toHaveBeenCalled(); expect(d.close).not.toHaveBeenCalled();
  });
  it('preserves pending risk CLOSE after a previous failed attempt and even when STOPPED', async () => {
    const held = trades()[0]; held.closeTime = 0;
    const previous = initial(); previous.risk.locks.hardStopReason = 'drawdown';
    const d = deps({ previous, rows: [held], sessionRaw: JSON.stringify(buildStoppedVirtualPaper400SessionState(session, 'pause', now)) });
    expect((await runVirtualPaper400Cycle(d)).status).toBe('CLOSED');
    expect(d.close).toHaveBeenCalledOnce(); expect(d.open).not.toHaveBeenCalled();
  });
  it('keeps the profit-protection entry veto as REDUCE70, not a close-all', async () => {
    const row = trades()[0]; row.closeTime = 0;
    const d = deps({ rows: [row], quote: () => ({ priceUsd: 72_000, ageMs: 0 }) });
    expect((await runVirtualPaper400Cycle(d)).status).toBe('REDUCED');
    expect(d.reduce).toHaveBeenCalledOnce(); expect(d.close).not.toHaveBeenCalled();
    expect(vi.mocked(d.persistRisk).mock.calls.at(-1)?.[0].risk.locks.profitReductionDone).toBe(true);
  });
});
