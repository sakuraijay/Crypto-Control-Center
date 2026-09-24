import type { DbTrade } from '@workspace/db';
import type { VirtualPaper400SessionV1 } from './virtualPaper400Ledger';

const dayKey = (at: number) => new Date(at + 8 * 60 * 60_000).toISOString().slice(0, 10);
const round = (n: number) => Math.round(n * 1e8) / 1e8;
export interface PaperCalendarDay {
  date: string; netPnlUsd: number; grossPnlUsd: number; costUsd: number;
  entries: number; completedTrades: number; settlements: number;
}
/** Called only after the whole session ledger has passed account reconciliation.
 * Calendar failure must not interrupt position protection. No deposits or unrealized PnL. */
export function buildVirtualPaperCalendar(session: VirtualPaper400SessionV1, rows: DbTrade[], now: Date) {
  try {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs) || session.startedAtMs > nowMs) throw Error('invalid time');
    const days = new Map<string, PaperCalendarDay>();
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.strategy !== session.strategyTag) continue;
      const at = new Date(row.timestamp).getTime();
      if (seen.has(String(row.id)) || !Number.isFinite(at) || at < session.startedAtMs || at > nowMs
        || !['OPEN','CLOSE'].includes(row.action)) throw Error('invalid row');
      seen.add(String(row.id));
      const date = dayKey(at);
      const day = days.get(date) ?? { date, netPnlUsd: 0, grossPnlUsd: 0, costUsd: 0, entries: 0, completedTrades: 0, settlements: 0 };
      if (row.action === 'OPEN') day.entries++;
      else {
        if (row.settlementStatus !== 'PAPER_ESTIMATED' || row.costSource !== 'PAPER_GMX_ESTIMATE'
          || !['FULL','REDUCE70'].includes(row.closeKind ?? '')
          || row.pnl === null || row.netPnlEstimatedUsd === null) throw Error('invalid settlement');
        const gross = Number(row.pnl), net = Number(row.netPnlEstimatedUsd);
        if (!Number.isFinite(gross) || !Number.isFinite(net) || gross - net < -1e-7) throw Error('invalid amounts');
        day.grossPnlUsd = round(day.grossPnlUsd + gross);
        day.netPnlUsd = round(day.netPnlUsd + net);
        day.costUsd = round(day.costUsd + gross - net);
        day.settlements++;
        if (row.closeKind === 'FULL') day.completedTrades++;
      }
      days.set(date, day);
    }
    return { version: 'paper-calendar/v1' as const, status: 'AVAILABLE' as const, timezone: 'Asia/Manila' as const,
      coverageStart: dayKey(session.startedAtMs), throughDate: dayKey(nowMs), observedAt: now.toISOString(),
      days: [...days.values()].sort((a,b) => a.date.localeCompare(b.date)) };
  } catch {
    return { version: 'paper-calendar/v1' as const, status: 'UNAVAILABLE' as const, timezone: 'Asia/Manila' as const,
      coverageStart: null, throughDate: null, observedAt: null, days: [] };
  }
}
