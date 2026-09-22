import { describe, expect, it } from 'vitest';
import { amount, finite, settlementCosts, settlementCsv, settlementSeries, timestamp, type VirtualRuntime, type VirtualSettlement } from '@/lib/virtual400Presentation';
const row = (id: string, closedAt: string, net: string): VirtualSettlement => ({ id, closedAt, netPnlUsd: net, symbol: 'BTC', side: 'LONG', openedAt: null, entryPrice: null, exitPrice: '100', stopPrice: null, targetPrice: null, strategy: null, reasons: [], closeReason: 'STOP', grossPnlUsd: '-1', entryCostUsd: '0.1', exitCostUsd: '0.2', holdingCostUsd: '0', plannedRiskUsd: null, netR: null, closeKind: 'PROTECTION' });
const runtime = (): VirtualRuntime => ({ at: '2026-09-20T15:00:00Z', status: 'NO_TRADE', reason: null, account: { equityUsd: 395, unrealizedNetPnlUsd: 0, held: [], ledger: { realizedEquityUsd: 395, realizedNetPnlUsd: -5, settlementCount: 20 } }, journal: [row('later', '2026-09-20T14:00:00Z', '-3'), row('earlier', '2026-09-20T13:00:00Z', '1')] });
describe('financial presentation without fabricated history', () => {
 it.each([null, undefined, '', '   ', true, {}, 'no', Infinity])('does not turn missing or invalid data into zero: %s', value => { expect(finite(value)).toBeNull(); expect(amount(value)).toBe('미확인'); });
 it('preserves zero, losses and signed profit', () => { expect(amount('0')).toBe('0.00'); expect(amount('-3', true)).toBe('-3.00'); expect(amount('3', true)).toBe('+3.00'); });
 it('anchors only the returned chronological window to the actual ledger, not initial 400', () => {expect(settlementSeries(runtime()).map(p=>[p.id,p.balance,p.net])).toEqual([['baseline',397,0],['earlier',398,1],['later',395,-3]]);});
 it('renders no curve when there are no settlements or inconsistent evidence', () => {
  const s=runtime(); s.journal=[]; expect(settlementSeries(s)).toEqual([]);
  s.journal=[row('a','bad','2')]; expect(settlementSeries(s)).toEqual([]);
  s.journal=[row('a',s.at,'bad')]; expect(settlementSeries(s)).toEqual([]);
  s.journal=[row('a',s.at,'2'),row('a',s.at,'2')]; expect(settlementSeries(s)).toEqual([]);
 });
 it('does not hide missing cost components', () => { const r=row('a','2026-09-20','-3'); expect(settlementCosts(r)).toBeCloseTo(.3); r.holdingCostUsd=null; expect(settlementCosts(r)).toBeNull(); });
 it('exports actual losses, units, simulation label, missing fields and safe text', () => {const r=row('=HYPERLINK("bad")','2026-09-20T14:00:00Z','-3'); const csv=settlementCsv([r]);expect(csv).toContain('SIMULATED / ESTIMATED'); expect(csv).toContain('"-3"'); expect(csv).toContain('"UNAVAILABLE"'); expect(csv).toContain("\"'=HYPERLINK"); expect(csv).toContain('Net USDC');});
 it('shows explicit PHT time and rejects malformed timestamps', () => { expect(timestamp('2026-09-20T14:00:00Z')).toBe('22:00:00'); expect(timestamp('bad')).toBe('미확인'); });
});

it('excludes new capital from the performance curve instead of manufacturing a profit jump',()=>{
 const before=runtime();const funded=runtime();funded.account.ledger.realizedEquityUsd+=100;
 funded.account.ledger.netContributionsUsd=100;
 expect(settlementSeries(funded)).toEqual(settlementSeries(before));
});
