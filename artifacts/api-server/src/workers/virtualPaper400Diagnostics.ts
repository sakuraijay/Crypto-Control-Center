import { sanitizeCostError } from '../lib/costSnapshot';
import type { StrategyShadowRecord } from '../intel/strategyShadowAdapterV2';
import type { PaperEntryEvaluation as DailyPaperEntryEvaluation } from './virtualPaperDailyCycle';

const HOUR = 3_600_000;
const VERSION = 'virtual-diagnostics/v1';
type Counts = Record<string, number>;
interface Incident { minute: number; kind: string; symbol: string; detail: string }
export interface PaperEntryConditionEvidence {
  name: string;
  value: number | null;
  operator: string;
  threshold: number | null;
  passed: boolean | null;
  unit?: string;
}
/** One completed-candle observation. This records measured evidence, not a forecast. */
export interface PaperDiagnosticEvaluation {
  id: string;
  symbol: string;
  closedAt: number;
  evaluatedAt: number;
  policyVersion: string;
  eligible: boolean;
  reason: string;
  kind: 'SIGNAL' | 'SAFETY';
  conditions: PaperEntryConditionEvidence[];
}
interface FeatureAggregate { observed: number; missing: number; passed: number; failed: number; sum: number; min: number | null; max: number | null; thresholdSum: number; thresholdCount: number }
interface EntryAggregate {
  candidates: number; eligible: number; rejected: number; byPolicy: Record<string, { candidates: number; eligible: number; rejected: number }>;
  reasons: Counts; legacy: { candidates: number; eligible: number; rejected: number; reasons: Counts };
  signal: { candidates: number; eligible: number; rejected: number; reasons: Counts };
  safety: { candidates: number; eligible: number; rejected: number; reasons: Counts };
  conditions: Record<string, FeatureAggregate>;
}
interface Bucket { hour: number; counts: Counts; incidents?: Incident[]; entryEvaluations?: EntryAggregate }
interface State {
  version: typeof VERSION; sessionId: string; since: number; lastMinute: number;
  cursors: Record<string, number>; buckets: Bucket[]; evaluationCursors?: Record<string, number>;
}
export const virtualDiagnosticsKey = (sessionId: string) => `virtual_diagnostics_v1:${sessionId}`;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const symbolOk = (s: string) => /^[A-Z0-9_]{1,24}$/.test(s);
const countKeyOk = (s: string) => /^[A-Z0-9_:.-]{1,120}$/.test(s);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const versionOk = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9/_:.-]{1,48}$/.test(s);
const conditionNameOk = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_:. -]{1,64}$/.test(s);
const conditionOperatorOk = (s: unknown) => typeof s === 'string' && ['>=', '<=', '>', '<', '==', '!=', 'between', 'measured'].includes(s);
const nullableFinite = (n: unknown): n is number | null => n === null || (typeof n === 'number' && Number.isFinite(n));
const reasonOk = (s: unknown): s is string => typeof s === 'string' && s.length <= 300 && !/[\u0000-\u001f]/.test(s);
const evaluationId = (e: Pick<PaperDiagnosticEvaluation, 'symbol' | 'policyVersion'>) => `${e.symbol}:${e.policyVersion}`;
function validEvaluation(e: PaperDiagnosticEvaluation, now: number): boolean {
  return object(e) && typeof e.id === 'string' && e.id === `${e.symbol}:${e.closedAt}`
    && symbolOk(e.symbol) && Number.isSafeInteger(e.closedAt) && e.closedAt > 0 && e.closedAt <= now
    && e.closedAt >= now - 24 * HOUR
    && Number.isSafeInteger(e.evaluatedAt) && e.evaluatedAt >= e.closedAt && e.evaluatedAt <= now
    && versionOk(e.policyVersion) && typeof e.eligible === 'boolean' && reasonOk(e.reason)
    && (e.kind === 'SIGNAL' || e.kind === 'SAFETY') && Array.isArray(e.conditions) && e.conditions.length <= 32
    && e.conditions.every(c => object(c) && conditionNameOk(c.name) && nullableFinite(c.value)
      && conditionOperatorOk(c.operator) && nullableFinite(c.threshold) && (typeof c.passed === 'boolean' || c.passed === null)
      && (c.unit === undefined || (typeof c.unit === 'string' && /^[A-Za-z%/]{1,16}$/.test(c.unit))))
    ;
}
function validEntryAggregate(value: unknown): value is EntryAggregate {
  const legacy = object(value) && object(value.legacy) ? value.legacy : null;
  const signal = object(value) && object(value.signal) ? value.signal : null;
  const safety = object(value) && object(value.safety) ? value.safety : null;
  if (!object(value) || !Number.isSafeInteger(value.candidates) || !Number.isSafeInteger(value.eligible)
    || !Number.isSafeInteger(value.rejected) || (value.candidates as number) < 0
    || (value.eligible as number) < 0 || (value.rejected as number) < 0
    || (value.eligible as number) + (value.rejected as number) !== value.candidates
    || !object(value.byPolicy) || Object.keys(value.byPolicy).length > 16
    || Object.entries(value.byPolicy).some(([version, counts]) => !versionOk(version) || !object(counts)
      || !['candidates', 'eligible', 'rejected'].every(k => Number.isSafeInteger(counts[k])
        && (counts[k] as number) >= 0)
      || (counts.candidates as number) !== (counts.eligible as number) + (counts.rejected as number))
    || !object(value.reasons) || Object.keys(value.reasons).length > 64
    || Object.entries(value.reasons).some(([k,n]) => !countKeyOk(k) || !Number.isSafeInteger(n) || (n as number) < 0)
    || !legacy || !['candidates', 'eligible', 'rejected'].every(k => Number.isSafeInteger(legacy[k])
      && (legacy[k] as number) >= 0)
    || (legacy.candidates as number) !== (legacy.eligible as number) + (legacy.rejected as number)
    || !object(legacy.reasons) || Object.keys(legacy.reasons).length > 64
    || Object.entries(legacy.reasons).some(([k,n]) => !countKeyOk(k) || !Number.isSafeInteger(n) || (n as number) < 0)
    || !signal || !safety
    || [signal, safety].some(group => !['candidates', 'eligible', 'rejected'].every(k =>
      Number.isSafeInteger(group[k]) && (group[k] as number) >= 0)
      || (group.candidates as number) !== (group.eligible as number) + (group.rejected as number)
      || !object(group.reasons) || Object.keys(group.reasons).length > 64
      || Object.entries(group.reasons).some(([k,n]) => !countKeyOk(k) || !Number.isSafeInteger(n) || (n as number) < 0))
    || !object(value.conditions) || Object.keys(value.conditions).length > 32) return false;
  return Object.entries(value.conditions).every(([name, metric]) => conditionNameOk(name) && object(metric)
    && ['observed', 'missing', 'passed', 'failed', 'thresholdCount'].every(k => Number.isSafeInteger(metric[k])
      && (metric[k] as number) >= 0)
    && (metric.passed as number) + (metric.failed as number) <= (metric.observed as number) + (metric.missing as number)
    && typeof metric.sum === 'number' && Number.isFinite(metric.sum)
    && nullableFinite(metric.min) && nullableFinite(metric.max)
    && typeof metric.thresholdSum === 'number' && Number.isFinite(metric.thresholdSum)
    && ((metric.observed as number) === 0 ? metric.sum === 0 && metric.min === null && metric.max === null
      : metric.min !== null && metric.max !== null));
}
const incidentOk = (v: unknown, now: number): v is Incident => object(v)
  && Number.isSafeInteger(v.minute) && (v.minute as number) >= 0 && (v.minute as number) <= Math.floor(now / 60_000)
  && typeof v.kind === 'string' && countKeyOk(v.kind)
  && typeof v.symbol === 'string' && symbolOk(v.symbol)
  && typeof v.detail === 'string' && v.detail.length <= 500;
function restore(raw: string | null, sessionId: string, now: number): State | null {
  if (raw === null) return { version: VERSION, sessionId, since: now, lastMinute: -1, cursors: {}, buckets: [] };
  try {
    const s = JSON.parse(raw);
    if (!object(s) || s.version !== VERSION || s.sessionId !== sessionId || !finite(s.since) || s.since > now
      || !Number.isSafeInteger(s.lastMinute) || (s.lastMinute as number) < -1 || (s.lastMinute as number) > Math.floor(now / 60_000)
      || !object(s.cursors) || Object.keys(s.cursors).length > 512
      || Object.entries(s.cursors).some(([k,v]) => !symbolOk(k) || !finite(v) || v > now)
      || (s.evaluationCursors !== undefined && (!object(s.evaluationCursors) || Object.keys(s.evaluationCursors).length > 64
        || Object.entries(s.evaluationCursors).some(([k,v]) => !/^[A-Z0-9_]{1,24}:[A-Za-z0-9/_:.-]{1,48}$/.test(k)
          || !finite(v) || v > now)))
      || !Array.isArray(s.buckets) || s.buckets.length > 24) return null;
    let previous = -1;
    for (const b of s.buckets) {
      if (!object(b) || !finite(b.hour) || b.hour % HOUR !== 0 || b.hour <= previous || b.hour > now
        || !object(b.counts) || Object.keys(b.counts).length > 128
        || Object.entries(b.counts).some(([k,v]) => !countKeyOk(k) || !Number.isSafeInteger(v) || (v as number) < 0)
        || (b.entryEvaluations !== undefined && !validEntryAggregate(b.entryEvaluations))
        || (b.incidents !== undefined && (!Array.isArray(b.incidents) || b.incidents.length > 64
          || b.incidents.some(incident => !incidentOk(incident, now)
            || incident.minute * 60_000 < (b.hour as number)
            || incident.minute * 60_000 >= (b.hour as number) + HOUR)))) return null;
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
  adaptiveEvaluations?: readonly DailyPaperEntryEvaluation[];
  nextEvaluationAt?: number | null;
  entryStages?: readonly { symbol: string; stage: string }[];
  status: string; reason: string | null;
  openCount: number; closeCount: number; lastOpenAtMs: number | null; sessionStartedAtMs: number;
}) {
  const s = restore(input.raw, input.sessionId, input.now);
  if (!s) return { state: null, summary: { status: 'UNAVAILABLE', reason: 'DIAGNOSTICS_STATE_INVALID', historyReconstructed: false } };
  const hour = Math.floor(input.now / HOUR) * HOUR;
  s.buckets = s.buckets.filter(b => b.hour >= hour - 23 * HOUR);
  if (s.buckets.at(-1)?.hour !== hour) s.buckets.push({ hour, counts: {}, incidents: [] });
  const bucket = s.buckets.at(-1)!;
  bucket.incidents ??= [];
  const counts = bucket.counts;
  const increment = (key: string) => {
    const safe = countKeyOk(key) ? key : 'OTHER';
    const bounded = Object.hasOwn(counts, safe) || Object.keys(counts).length < 127 ? safe : 'OTHER';
    counts[bounded] = (counts[bounded] ?? 0) + 1;
  };
  const incrementAggregate = (target: Counts, key: string) => {
    const safe = countKeyOk(key) ? key : 'OTHER';
    const bounded = Object.hasOwn(target, safe) || Object.keys(target).length < 63 ? safe : 'OTHER';
    target[bounded] = (target[bounded] ?? 0) + 1;
  };
  const incident = (kind: string, symbol: string, detail: string, minute: number) => {
    if (!countKeyOk(kind) || !symbolOk(symbol) || bucket.incidents!.length >= 64) return;
    bucket.incidents!.push({ minute, kind, symbol,
      detail: sanitizeCostError(detail).slice(0, 500) });
  };
  const minute = Math.floor(input.now / 60_000);
  s.evaluationCursors ??= {};
  for (const [key, closedAt] of Object.entries(s.evaluationCursors)) {
    if (closedAt < input.now - 24 * HOUR) delete s.evaluationCursors[key];
  }
  const adaptiveSeenThisCycle = new Set<string>();
  const latestEntryEvaluations = new Map<string, PaperDiagnosticEvaluation>();
  for (const row of input.adaptiveEvaluations ?? []) {
    const evaluation: PaperDiagnosticEvaluation = {
      ...row, evaluatedAt: Date.parse(row.evaluatedAt),
      kind: row.kind === 'ECONOMICS' ? 'SAFETY' : row.kind,
      reason: sanitizeCostError(row.reason).slice(0, 300),
      conditions: row.conditions.map(condition => ({
        ...condition, operator: condition.operator === '=' ? '==' : condition.operator,
      })),
    };
    if (!validEvaluation(evaluation, input.now)) continue;
    const cursorKey = evaluationId(evaluation);
    if (!latestEntryEvaluations.has(cursorKey)) latestEntryEvaluations.set(cursorKey, evaluation);
    const seenAt = s.evaluationCursors[cursorKey] ?? 0;
    if (evaluation.closedAt <= seenAt || adaptiveSeenThisCycle.has(cursorKey)) continue;
    adaptiveSeenThisCycle.add(cursorKey);
    // Evaluation cursors are per symbol and policy; an old candle can never
    // overwrite a newer observation after a rotation or process restart.
    if (!Object.hasOwn(s.evaluationCursors, cursorKey) && Object.keys(s.evaluationCursors).length >= 64) {
      delete s.evaluationCursors[cursorKey]; increment('PAPER_EVALUATION_CURSOR_CAP_REACHED'); continue;
    }
    s.evaluationCursors[cursorKey] = evaluation.closedAt;
    const b = s.buckets.find(row => row.hour === Math.floor(input.now / HOUR) * HOUR) ?? bucket;
    const entry = b.entryEvaluations ??= {
      candidates: 0, eligible: 0, rejected: 0, byPolicy: {}, reasons: {},
      legacy: { candidates: 0, eligible: 0, rejected: 0, reasons: {} },
      signal: { candidates: 0, eligible: 0, rejected: 0, reasons: {} },
      safety: { candidates: 0, eligible: 0, rejected: 0, reasons: {} }, conditions: {},
    };
    entry.candidates++;
    if (evaluation.eligible) entry.eligible++;
    else {
      entry.rejected++;
      const reason = sanitizeCostError(evaluation.reason).slice(0, 120);
      incrementAggregate(entry.reasons, reason);
      incident('PAPER_SIGNAL_REJECT', evaluation.symbol, reason, minute);
    }
    const policy = entry.byPolicy[evaluation.policyVersion] ??= { candidates: 0, eligible: 0, rejected: 0 };
    policy.candidates++;
    if (evaluation.eligible) policy.eligible++; else policy.rejected++;
    const category = evaluation.kind === 'SAFETY' ? entry.safety : entry.signal;
    category.candidates++;
    if (evaluation.eligible) category.eligible++;
    else {
      category.rejected++;
      const reason = sanitizeCostError(evaluation.reason).slice(0, 120);
      incrementAggregate(category.reasons, reason);
    }
    for (const condition of evaluation.conditions.slice(0,32)) {
      if (!Object.hasOwn(entry.conditions, condition.name) && Object.keys(entry.conditions).length >= 32) continue;
      const feature = entry.conditions[condition.name] ??= {
        observed: 0, missing: 0, passed: 0, failed: 0, sum: 0, min: null as number | null,
        max: null as number | null, thresholdSum: 0, thresholdCount: 0,
      };
      if (condition.value === null) feature.missing++;
      else {
        feature.observed++;
        feature.sum += condition.value;
        feature.min = feature.min === null ? condition.value : Math.min(feature.min, condition.value);
        feature.max = feature.max === null ? condition.value : Math.max(feature.max, condition.value);
      }
      if (condition.passed === true) feature.passed++;
      if (condition.passed === false) feature.failed++;
      if (condition.threshold !== null) {
        feature.thresholdSum += condition.threshold;
        feature.thresholdCount++;
      }
    }
  }
  // Cycle availability and evaluated completed candles are different denominators.
  if (minute > s.lastMinute) {
    s.lastMinute = minute;
    increment('OBSERVED_MINUTE'); increment(`CYCLE:${input.status}`);
    if (input.reason) increment(`CYCLE_REASON:${input.reason}`);
    for (const d of input.diagnostics.filter(d=>d.reason.startsWith('PAPER_EXPERIMENT_')||d.reason.startsWith('DAILY_PLAN_')
      || d.reason.startsWith('PAPER_MARKET_QUALITY') || d.reason.startsWith('PAPER_NET_REWARD_RISK'))) {
      increment(`EXPERIMENT_REJECT:${d.reason}`); incident('PAPER_EXPERIMENT_REJECT',d.symbol,d.reason,minute);
    }
    for (const stage of input.entryStages?.filter(s=>s.stage==='PAPER_EXPERIMENT_CLAIMED')??[]) increment('PAPER_EXPERIMENT_CLAIMED');
    for (const a of input.analysis) {
      if (!symbolOk(a.symbol)) continue;
      if(a.reason.startsWith('AGGRESSIVE_PAPER_EXPERIMENT:'))increment(`EXPERIMENT_CANDIDATE:${a.symbol}`);
      if(a.reason==='PAPER_EXPERIMENT_CANDLE_UNAVAILABLE'){increment(`EXPERIMENT_CANDLE_UNAVAILABLE:${a.symbol}`);incident('PAPER_EXPERIMENT_CANDLE_UNAVAILABLE',a.symbol,a.reason,minute);}
      if (a.reason.includes('COST_UNAVAILABLE')) {
        increment('ANALYSIS_COST_UNAVAILABLE');
        increment(`ANALYSIS_COST_UNAVAILABLE:${a.symbol}`);
        incident('ANALYSIS_COST_UNAVAILABLE', a.symbol, a.reason, minute);
      }
      const record = input.records.find(r => r.symbol === a.symbol);
      if (!record && a.reason.startsWith('ANALYSIS_')) {
        increment(`ANALYSIS_NOT_EVALUATED:${a.symbol}`);
        const newestAcceptedClose = Math.max(0, ...input.records
          .filter(r => finite(r.sourceCandleCloseTime) && r.sourceCandleCloseTime <= input.now)
          .map(r => r.sourceCandleCloseTime));
        const lastAcceptedClose = s.cursors[a.symbol] ?? 0;
        if (newestAcceptedClose > lastAcceptedClose) {
          increment(`SOURCE_CANDLE_NOT_ACCEPTED:${a.symbol}`);
          incident('SOURCE_CANDLE_NOT_ACCEPTED', a.symbol,
            `lastAcceptedClose=${lastAcceptedClose || 'NONE'}; newestBatchClose=${newestAcceptedClose}; ${a.reason}`, minute);
        }
      }
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
    for (const d of input.diagnostics.filter(d => d.symbol === r.symbol)) {
      increment(`ENTRY_REJECT:${d.reason}`);
      incident('ENTRY_REJECT', r.symbol, d.reason, Math.floor(input.now / 60_000));
    }
  }
  const totals: Counts = {};
  for (const b of s.buckets) for (const [key,value] of Object.entries(b.counts)) totals[key] = (totals[key] ?? 0) + value;
  const recentIncidents = s.buckets.flatMap(b => b.incidents ?? []).slice(-24).map(row => ({
    at: new Date(row.minute * 60_000).toISOString(), kind: row.kind, symbol: row.symbol, detail: row.detail,
  }));
  const recentReasons = input.analysis.slice(0, 3).map(a => ({ symbol: a.symbol,
    reason: sanitizeCostError(a.reason).slice(0, 500),
    strategies: input.records.find(r => r.symbol === a.symbol)?.rejectedStrategies?.slice(0, 3).map(r => ({
      strategy: r.strategyId, reasons: r.reasons.slice(0, 8).map(reason => sanitizeCostError(reason).slice(0, 180)),
    })) ?? [],
  }));
  const emptyCategory = () => ({ candidates: 0, eligible: 0, rejected: 0, reasons: {} as Counts });
  const entryTotals: EntryAggregate = { candidates: 0, eligible: 0, rejected: 0, byPolicy: {}, reasons: {},
    legacy: { candidates: 0, eligible: 0, rejected: 0, reasons: {} },
    signal: emptyCategory(), safety: emptyCategory(), conditions: {} };
  for (const b of s.buckets) {
    const entry = b.entryEvaluations;
    if (!entry) continue;
    entryTotals.candidates += entry.candidates; entryTotals.eligible += entry.eligible; entryTotals.rejected += entry.rejected;
    entryTotals.legacy.candidates += entry.legacy.candidates;
    entryTotals.legacy.eligible += entry.legacy.eligible;
    entryTotals.legacy.rejected += entry.legacy.rejected;
    for (const type of ['signal', 'safety'] as const) {
      entryTotals[type].candidates += entry[type].candidates;
      entryTotals[type].eligible += entry[type].eligible;
      entryTotals[type].rejected += entry[type].rejected;
      for (const [key, value] of Object.entries(entry[type].reasons))
        entryTotals[type].reasons[key] = (entryTotals[type].reasons[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(entry.reasons)) entryTotals.reasons[key] = (entryTotals.reasons[key] ?? 0) + value;
    for (const [key, value] of Object.entries(entry.legacy.reasons)) entryTotals.legacy.reasons[key] = (entryTotals.legacy.reasons[key] ?? 0) + value;
    for (const [version, value] of Object.entries(entry.byPolicy)) {
      const total = entryTotals.byPolicy[version] ??= { candidates: 0, eligible: 0, rejected: 0 };
      total.candidates += value.candidates; total.eligible += value.eligible; total.rejected += value.rejected;
    }
    for (const [name, value] of Object.entries(entry.conditions)) {
      const total = entryTotals.conditions[name] ??= {
        observed: 0, missing: 0, passed: 0, failed: 0, sum: 0, min: null, max: null, thresholdSum: 0, thresholdCount: 0,
      };
      total.observed += value.observed; total.missing += value.missing;
      total.passed += value.passed; total.failed += value.failed; total.sum += value.sum;
      if (value.min !== null) total.min = total.min === null ? value.min : Math.min(total.min, value.min);
      if (value.max !== null) total.max = total.max === null ? value.max : Math.max(total.max, value.max);
      total.thresholdSum += value.thresholdSum; total.thresholdCount += value.thresholdCount;
    }
  }
  const evaluationSummary = {
    status: entryTotals.candidates ? 'OBSERVED' as const : 'EMPTY' as const,
    windowBasis: 'UP_TO_24_UTC_HOURLY_BUCKETS' as const,
    candidates: entryTotals.candidates, eligible: entryTotals.eligible, rejected: entryTotals.rejected,
    signal: { ...entryTotals.signal, reasons: Object.entries(entryTotals.signal.reasons).sort((a,b)=>b[1]-a[1])
      .slice(0,8).map(([reason,count])=>({reason,count})) },
    safety: { ...entryTotals.safety, reasons: Object.entries(entryTotals.safety.reasons).sort((a,b)=>b[1]-a[1])
      .slice(0,8).map(([reason,count])=>({reason,count})) },
    legacy: { ...entryTotals.legacy, reasons: Object.entries(entryTotals.legacy.reasons)
      .sort((a,b)=>b[1]-a[1]).slice(0,8).map(([reason,count])=>({reason,count})) },
    byPolicy: Object.entries(entryTotals.byPolicy).map(([version, counts])=>({version,...counts})),
    rejectionReasons: Object.entries(entryTotals.reasons).sort((a,b)=>b[1]-a[1]).slice(0,8)
      .map(([reason,count])=>({reason,count})),
    conditions: Object.entries(entryTotals.conditions).map(([name, metric])=>({
      name, observed: metric.observed, missing: metric.missing, passed: metric.passed, failed: metric.failed,
      mean: metric.observed ? metric.sum / metric.observed : null,
      minimum: metric.min, maximum: metric.max,
      meanThreshold: metric.thresholdCount ? metric.thresholdSum / metric.thresholdCount : null,
    })).sort((a,b)=>b.failed-a.failed || b.missing-a.missing).slice(0,12),
    nextEvaluationAt: finite(input.nextEvaluationAt) && input.nextEvaluationAt >= input.now
      ? new Date(input.nextEvaluationAt).toISOString() : null,
  };
  return { state: s, summary: { status: 'OBSERVED', observedAt: new Date(input.now).toISOString(),
    recordingStartedAt: new Date(s.since).toISOString(),
    windowStart: new Date(Math.max(s.since, hour - 23 * HOUR)).toISOString(),
    windowBasis: 'UP_TO_24_UTC_HOURLY_BUCKETS', historyReconstructed: false,
    counts: totals, recentReasons, recentIncidents, ledger: { opens: input.openCount, closes: input.closeCount },
    minutesWithoutNewEntry: Math.max(0, Math.floor((input.now - (input.lastOpenAtMs ?? input.sessionStartedAtMs)) / 60_000)),
     entryEvaluations: [...latestEntryEvaluations.values()].slice(-24),
    adaptiveEvaluations: evaluationSummary,
  } };
}
