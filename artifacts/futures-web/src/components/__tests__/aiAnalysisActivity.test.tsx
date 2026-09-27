// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualPaper400Provider, type VirtualPaper400Snapshot } from '@/lib/context/VirtualPaper400Context';
import { AiAnalysisActivity } from '@/components/dashboard/AiAnalysisActivity';
import { activityPresentation, freshVirtualActivity, type VirtualActivity } from '@/lib/virtualActivityPresentation';

const at = '2026-09-21T00:00:00.000Z';
function activity(): VirtualActivity {
  return { schemaVersion: 'virtual-activity/v1', source: 'SERVER_STRATEGY_ENGINE', sessionId: 'test',
    cycleNumber: 7, startedAt: at, updatedAt: at, phase: 'ANALYZING_MARKETS', symbols: ['BTC','ETH','SOL'],
    outcome: null, reason: null, analysisCompletedAt: null, results: [],
    events: [{ phase: 'CHECKING_ACCOUNT', at, symbols: [] },
      { phase: 'ANALYZING_MARKETS', at, symbols: ['BTC','ETH','SOL'] }] };
}
function snapshot(): VirtualPaper400Snapshot {
  return { ok: true, mode: 'VIRTUAL_PAPER_400', realFundsUsed: false, session: { status: 'ACTIVE' },
    runtimeFresh: false, runtime: null, activityFresh: true, activity: activity() };
}
async function mount(response = snapshot()) {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => response }));
  vi.stubGlobal('fetch', fetcher);
  render(<VirtualPaper400Provider><AiAnalysisActivity /></VirtualPaper400Provider>);
  await act(async () => { await Promise.resolve(); });
  return fetcher;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(at)); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('AI activity from actual server observations', () => {
  it('shows the real batch and observed stages with one shared GET and no fabricated progress', async () => {
    const fetcher = await mount();
    expect(screen.getByRole('status').textContent).toBe('확정 캔들·전략 분석 중');
    for (const symbol of ['BTC','ETH','SOL']) expect(screen.getByText(symbol)).toBeTruthy();
    const steps = within(screen.getByRole('list', { name: '이번 서버 주기에서 관측한 단계' }));
    expect(steps.getByText('거래 비용 확인').parentElement!.textContent).toContain('미관측');
    expect(steps.getByText('확정 캔들·전략 분석').parentElement!.getAttribute('aria-current')).toBe('step');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBeUndefined();
  });
  it('turns completed work into waiting and displays the actual symbol reason and completion time', async () => {
    const s = snapshot(); s.activity = { ...activity(), phase: 'WAITING', symbols: [], outcome: 'NO_TRADE',
      reason: 'NO_ELIGIBLE_CLOSED_CANDLE_SIGNAL', analysisCompletedAt: at,
      results: [{ symbol: 'BTC', reason: 'TRANSITION regime', evaluated: true }] };
    await mount(s);
    expect(screen.getByRole('status').textContent).toBe('다음 분석 주기 대기');
    expect(screen.getByText('시장 국면 전환 중 · 신규 전략 조건 대기')).toBeTruthy();
    expect(screen.getByText(/마지막 분석 완료 08:00:00 PHT/)).toBeTruthy();
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
  });
  it('expires a stuck running indicator even when the server fresh flag remains true', async () => {
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
    expect(screen.getByRole('status').textContent).toBe('최신 분석 활동 확인 대기');
    expect(screen.queryByText('BTC')).toBeNull();
    expect(document.querySelector('.ccc-ai-state.is-live')).toBeNull();
  });
  it('gives explicit STOP precedence over an in-flight observation', async () => {
    const s = snapshot(); s.session.status = 'STOPPED'; await mount(s);
    expect(screen.getByRole('status').textContent).toBe('신규 진입 중지');
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    expect(document.querySelector('.ccc-ai-state.is-live')).toBeNull();
  });
  it('rejects future, unknown, and malformed activities without manufacturing market work', () => {
    const s = snapshot(), now = Date.parse(at);
    expect(freshVirtualActivity(s, now - 1)).toBeNull();
    s.activity = { ...activity(), phase: 'NEW_UNKNOWN_PHASE' as any };
    expect(freshVirtualActivity(s, now)).toBeNull();
    s.activity = { ...activity(), results: [null] as any, symbols: ['DOGE'], events: [null] as any };
    expect(activityPresentation(s, false, now).symbols).toEqual([]);
    s.activity = null;
    expect(activityPresentation(s, false, now).live).toBe(false);
  });
  it('does not report skipped analysis as completed and clearly surfaces errors', async () => {
    const s = snapshot(); s.activity = { ...activity(), phase: 'ERROR', symbols: [], outcome: 'ERROR',
      reason: 'CYCLE_FAILED', results: [{ symbol: 'BTC', reason: 'COST_UNAVAILABLE', evaluated: false }] };
    await mount(s);
    expect(screen.getByRole('status').textContent).toBe('분석 주기 오류');
    expect(screen.getByText('거래 비용 확인 대기')).toBeTruthy();
    expect(screen.getByText('마지막 분석 완료 미확인')).toBeTruthy();
  });
});
