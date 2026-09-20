// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualPaper400Provider, useVirtualPaper400, virtualSnapshotFresh, virtualSessionLabel, type VirtualPaper400Snapshot } from '@/lib/context/VirtualPaper400Context';
import { VirtualPaper400Card } from '@/components/dashboard/VirtualPaper400Card';
import { AiEngineProvider } from '@/lib/context/AiEngineContext';
const trade = vi.hoisted(() => ({ placeOrder: vi.fn(), clearAllPositions: vi.fn(), updatePositionRisk: vi.fn() }));
vi.mock('@/lib/context/TradingContext', () => ({ useTradingContext: () => ({ ...trade, closedTrades: [] }) }));
vi.mock('@/lib/context/StrategyContext', () => ({ useStrategyContext: () => ({ limits: {} }) }));
vi.mock('@/lib/context/WatchlistContext', () => ({ useWatchlistContext: () => ({ watchlist: [], streamStatus: 'offline' }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const at = '2026-09-20T15:30:00.000Z';
function snapshot(): VirtualPaper400Snapshot {
 return { ok: true, mode: 'VIRTUAL_PAPER_400', realFundsUsed: false, session: { status: 'ACTIVE' }, runtimeFresh: true,
 runtime: { at, status: 'NO_TRADE', reason: 'NO_ELIGIBLE_CLOSED_CANDLE_SIGNAL', policy: { version: 'virtual400-active/v1', appliedAt: at, symbols: ['BTC','ETH','SOL'], riskPerTradePct: .5, maxLeverage: 2, cooldownMinutes: 15 },
 account: { equityUsd: 397, unrealizedNetPnlUsd: 0, ledger: { realizedEquityUsd: 397, realizedNetPnlUsd: -3, settlementCount: 2 }, held: [] } } };
}
function Badge() { const { status } = useVirtualPaper400(); return <div data-testid="badge">{status}</div>; }
function mount() { return render(<VirtualPaper400Provider><Badge /><VirtualPaper400Card /></VirtualPaper400Provider>); }
async function flush() { await act(async () => { await Promise.resolve(); }); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(at)); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('server authority after retiring the browser trading engine', () => {
 it('restores the applied 5–10x range after remount without browser writes', async () => {
  const data = snapshot(); data.runtime!.policy = { ...data.runtime!.policy!, version: 'virtual400-active/v2', minLeverage: 5, maxLeverage: 10 };
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => data })); vi.stubGlobal('fetch', fetcher);
  const view = mount(); await flush(); expect(screen.getByTestId('virtual-active-policy').textContent).toContain('5–10x');
  view.unmount(); mount(); await flush();
  expect(screen.getByTestId('virtual-active-policy').textContent).toContain('적극적 가상 매매');
  expect(screen.getByTestId('virtual-active-policy').textContent).toContain('5–10x');
  expect(fetcher.mock.calls.every((call: any) => !call[1]?.method)).toBe(true);
 });
 it('restores server policy, losses and ACTIVE state after closing and reopening with GET only', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => snapshot() })); vi.stubGlobal('fetch', fetcher);
  let view = mount(); await flush();
  expect(screen.getByTestId('badge').textContent).toContain('조건 대기');
  expect(screen.getByTestId('virtual-active-policy').textContent).toContain('0.5%');
  expect(screen.getByTestId('metric-비용 차감 실현 손익').textContent).toContain('-3.00');
  expect(screen.queryByRole('button', { name: '가상매매 시작' })).toBeNull();
  expect(screen.getByRole('button', { name: '신규 진입 중지' })).toBeTruthy();
  expect(screen.queryByText('Auto-executing')).toBeNull();
  view.unmount(); view = mount(); await flush();
  expect(screen.getByTestId('virtual-active-policy').textContent).toContain('최대 2x');
  expect(screen.getByTestId('metric-비용 차감 실현 손익').textContent).toContain('-3.00');
  expect(fetcher.mock.calls).toHaveLength(2);
  expect(fetcher.mock.calls.every((call: any) => !call[1]?.method)).toBe(true);
 });
 it('shares one poll and clears active display on failure, then recovers saved policy', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => snapshot() }).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, json: async () => snapshot() });
  vi.stubGlobal('fetch', fetcher); mount(); await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByTestId('badge').textContent).toBe('서버 상태 미확인');
  expect(screen.queryByTestId('virtual-active-policy')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByTestId('badge').textContent).toContain('조건 대기');
  expect(screen.getByTestId('virtual-active-policy')).toBeTruthy();
 });
 it('expires an old heartbeat despite runtimeFresh=true and never displays a stale AUTO state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => snapshot() })));
  mount(); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
  expect(screen.getByTestId('badge').textContent).toBe('서버 실행 확인 대기');
  expect(screen.getByTestId('metric-가상 평가자산').textContent).toContain('미확인');
 });
 it('keeps STOP distinct from missing, blocked, future and malformed evidence', () => {
  const s = snapshot(); s.session.status = 'STOPPED'; expect(virtualSessionLabel(s, true)).toBe('신규 진입 중지');
  s.session.status = 'MISSING'; expect(virtualSessionLabel(s, false)).toBe('시작 전');
  s.session.status = 'ACTIVE'; s.runtime!.status = 'BLOCKED'; expect(virtualSessionLabel(s, true)).toContain('진입 차단');
  expect(virtualSnapshotFresh(s, Date.parse(at)-1)).toBe(false);
  s.runtime!.at = 'bad'; expect(virtualSnapshotFresh(s)).toBe(false);
 });
 it('never starts a session on load and retains explicit PIN-authenticated STOP', async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => ({ ok: true, json: async () => init?.method === 'PUT' ? { ok: true } : snapshot() }));
  vi.stubGlobal('fetch', fetcher); mount(); await flush();
  fireEvent.click(screen.getByRole('button', { name: '신규 진입 중지' }));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('서버 운영자 PIN'), { target: { value: 'test-only-pin' } });
  fireEvent.click(screen.getByRole('button', { name: '중지 적용' })); await flush();
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(writes).toHaveLength(1); expect(writes[0][1]?.body).toBe(JSON.stringify({ action: 'STOP' }));
  expect(writes[0][1]?.headers).toEqual({ 'content-type': 'application/json', 'x-operator-pin': 'test-only-pin' });
 });
 it('does not calculate decisions, create approvals, place or close trades while the browser stays open', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ decisions: [], approvals: [] }) }));
  vi.stubGlobal('fetch', fetcher);
  render(<AiEngineProvider><div>history UI</div></AiEngineProvider>); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(trade.placeOrder).not.toHaveBeenCalled(); expect(trade.clearAllPositions).not.toHaveBeenCalled(); expect(trade.updatePositionRisk).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.every((call: any) => !call[1]?.method)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
 });
});
