import { sanitizeCostError } from '../lib/costSnapshot';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';

const HOUR = 3_600_000;
const VERSION = 'virtual-diagnostics/v1';
type Counts = Record<string, number>;
interface Bucket { hour: number; counts: Counts }
interface State {
  version: typeof VERSION; sessionId: string; since: number; lastMinute: number;
  cursors: Record<string, number>; buckets: Bucket[];
}
export const virtualDiagnosticsKey = (sessionId: string) => `virtual_diagnostics_v1:${sessionId}`;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const symbolOk = (s: string) => /^[A-Z0-9_]{1,24}$/.test(s);
const countKeyOk = (s: string) => /^[A-Z0-9_:.-]{1,120}$/.test(s);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function restore(raw: string | null, sessionId: string, now: number): State | null {
  if (raw === null) return { version: VERSION, sessionId, since: now, lastMinute: -1, cursors: {}, buckets: [] };
  try {
    const s = JSON.parse(raw);
    if (!object(s) || s.version !== VERSION || s.sessionId !== sessionId || !finite(s.since) || s.since > now
      || !Number.isSafeInteger(s.lastMinute) || (s.lastMinute as number) < -1 || (s.lastMinute as number) > Math.floor(now / 60_000)
      || !object(s.cursors) || Object.keys(s.cursors).length > 512
      || Object.entries(s.cursors).some(([k,v]) => !symbolOk(k) || !finite(v) || v > now)
      || !Array.isArray(s.buckets) || s.buckets.length > 24) return null;
    let previous = -1;
    for (const b of s.buckets) {
      if (!object(b) || !finite(b.hour) || b.hour % HOUR !== 0 || b.hour <= previous || b.hour > now
        || !object(b.counts) || Object.keys(b.counts).length > 128
        || Object.entries(b.counts).some(([k,v]) => !countKeyOk(k) || !Number.isSafeInteger(v) || (v as number) < 0)) return null;
      previous = b.hour;
    }
    return s as unknown as State;
  } catch { return null; }
}
export function advanceVirtualDiagnostics(input: {
  raw: string | null; sessionId: string; now: number;
  records: readonly StrategyShadowRecord[];
  analysis: readonly { symbol: string; reason: string }[];
  diagnostics: readonly { symbol: string; reason: string }[];
  entryStages?: readonly { symbol: string; stage: string }[];
  status: string; reason: string | null;
  openCount: number; closeCount: number; lastOpenAtMs: number | null; sessionStartedAtMs: number;
}) {
  const s = restore(input.raw, input.sessionId, input.now);
  if (!s) return { state: null, summary: { status: 'UNAVAILABLE', reason: 'DIAGNOSTICS_STATE_INVALID', historyReconstructed: false } };
  const hour = Math.floor(input.now / HOUR) * HOUR;
  s.buckets = s.buckets.filter(b => b.hour >= hour - 23 * HOUR);
  if (s.buckets.at(-1)?.hour !== hour) s.buckets.push({ hour, counts: {} });
  const counts = s.buckets.at(-1)!.counts;
  const increment = (key: string) => {
    const safe = countKeyOk(key) ? key : 'OTHER';
    const bounded = Object.hasOwn(counts, safe) || Object.keys(counts).length < 127 ? safe : 'OTHER';
    counts[bounded] = (counts[bounded] ?? 0) + 1;
  };
  // Cycle availability and evaluated completed candles are different denominators.
  const minute = Math.floor(input.now / 60_000);
  if (minute > s.lastMinute) {
    s.lastMinute = minute;
    increment('OBSERVED_MINUTE'); increment(`CYCLE:${input.status}`);
    if (input.reason) increment(`CYCLE_REASON:${input.reason}`);
    for (const a of input.analysis) {
      if (a.reason.includes('COST_UNAVAILABLE')) increment('ANALYSIS_COST_UNAVAILABLE');
    }
  }
  for (const r of input.records) {
    if (!symbolOk(r.symbol) || !finite(r.sourceCandleCloseTime) || r.sourceCandleCloseTime > input.now
      || r.sourceCandleCloseTime <= (s.cursors[r.symbol] ?? 0)) continue;
    if (!Object.hasOwn(s.cursors, r.symbol) && Object.keys(s.cursors).length >= 512) { increment('SYMBOL_CAP_REACHED'); continue; }
    s.cursors[r.symbol] = r.sourceCandleCloseTime;
    increment('EVALUATED_CANDLE'); increment(`REGIME:${r.regime}`); increment(`ACTION:${r.action}`);
    if (r.action === 'LONG' || r.action === 'SHORT') increment('DIRECTIONAL_CANDIDATE');
    for (const stage of input.entryStages?.filter(s => s.symbol === r.symbol) ?? []) increment(`STAGE:${stage.stage}`);
    for (const d of input.diagnostics.filter(d => d.symbol === r.symbol)) increment(`ENTRY_REJECT:${d.reason}`);
  }
  const totals: Counts = {};
  for (const b of s.buckets) for (const [key,value] of Object.entries(b.counts)) totals[key] = (totals[key] ?? 0) + value;
  const recentReasons = input.analysis.slice(0, 3).map(a => ({ symbol: a.symbol,
    reason: sanitizeCostError(a.reason).slice(0, 500),
    strategies: input.records.find(r => r.symbol === a.symbol)?.rejectedStrategies?.slice(0, 3).map(r => ({
      strategy: r.strategyId, reasons: r.reasons.slice(0, 8).map(reason => sanitizeCostError(reason).slice(0, 180)),
    })) ?? [],
  }));
  return { state: s, summary: { status: 'OBSERVED', observedAt: new Date(input.now).toISOString(),
    recordingStartedAt: new Date(s.since).toISOString(),
    windowStart: new Date(Math.max(s.since, hour - 23 * HOUR)).toISOString(),
    windowBasis: 'UP_TO_24_UTC_HOURLY_BUCKETS', historyReconstructed: false,
    counts: totals, recentReasons, ledger: { opens: input.openCount, closes: input.closeCount },
    minutesWithoutNewEntry: Math.max(0, Math.floor((input.now - (input.lastOpenAtMs ?? input.sessionStartedAtMs)) / 60_000)),
  } };
}
