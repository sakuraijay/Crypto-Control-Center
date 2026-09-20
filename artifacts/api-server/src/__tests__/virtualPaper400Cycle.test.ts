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
