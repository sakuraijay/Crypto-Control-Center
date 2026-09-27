// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CalendarPage from '@/pages/calendar';
import { NAV_GROUPS } from '@/components/shell/navigation';
const state = vi.hoisted(() => ({ fresh: true, error: null, data: { runtime: { calendar: {
  status: 'AVAILABLE', coverageStart: '2026-08-31', throughDate: '2026-09-24', observedAt: '2026-09-24T10:00:00Z',
  days: [
    { date: '2026-08-31', netPnlUsd: 100, grossPnlUsd: 102, costUsd: 2, entries: 1, completedTrades: 1, settlements: 1 },
    { date: '2026-09-23', netPnlUsd: -2, grossPnlUsd: 1, costUsd: 3, entries: 2, completedTrades: 1, settlements: 2 },
  ],
} } } }));
vi.mock('@/lib/context/VirtualPaper400Context', () => ({ useVirtualPaper400: () => state }));
afterEach(() => { cleanup(); state.fresh = true; });
describe('PAPER calendar user journey', () => {
  it('shows monthly totals, zero-trade days, disabled future dates and settlement detail', () => {
    render(<CalendarPage />);
    expect(screen.getByRole('heading', { name: '2026년 9월' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /2026-09-22 순손익 .*진입 0회/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: '2026-09-25 예정' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /2026-09-23 순손익/ }));
    expect(screen.getByText('추정 비용 3.00 USDC')).toBeTruthy();
    expect(screen.getByText('정산 2건 · 부분청산 포함')).toBeTruthy();
    expect(screen.queryByText('+100.00')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '이전 달' }));
    expect(screen.getByRole('heading', { name: '2026년 8월' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '이전 달' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('2026-09-23 상세')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '이번 달' }));
    expect(screen.getByRole('heading', { name: '2026년 9월' })).toBeTruthy();
  });
  it('does not present stale values as verified zero or profit', () => {
    state.fresh = false; render(<CalendarPage />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('places the calendar immediately below trading history', () => {
    const items = NAV_GROUPS[0].items;
    expect(items[items.findIndex(item => item.href === '/activity') + 1].href).toBe('/calendar');
  });
});
