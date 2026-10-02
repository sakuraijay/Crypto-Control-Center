/**
 * Append-only, same-observation PAPER policy evidence. This is intentionally a
 * separate namespace from paper-paired-comparison/v1, whose 2,000 samples are
 * a historical archive and must not be modified or used as a collection cap.
 *
 * This module records entry-evaluation evidence only. It does not infer or
 * synthesize price paths, fills, matured outcomes, returns, or probabilities.
 */
export const CONTINUOUS_PAPER_COMPARISON_VERSION = 'paper-paired-comparison/v3' as const;
export const CONTINUOUS_PAPER_COMPARISON_PREFIX = 'virtual_paper_comparison_v3';
export const CONTINUOUS_PAPER_PAGE_LIMIT = 2000;

export interface ContinuousPaperCondition {
  name: string;
  value: number | null;
  operator: string;
  threshold: number | null;
  passed: boolean | null;
}

export interface ContinuousPaperPlanEvidence {
  entry: number;
  stop: number;
  target: number;
  notional: number;
  maxHoldHours: number;
  expiresAt: number;
}

export interface ContinuousPaperCostEvidence {
  estimatedRoundTripUsd: number;
  source: string;
  observedAt: number;
}

export interface ContinuousPaperPolicyEvidence {
  policyVersion: 'virtual400-daily/v7' | 'virtual400-daily/v9';
  accepted: boolean;
  reason: string;
  side: 'LONG' | 'SHORT' | null;
  plan: ContinuousPaperPlanEvidence | null;
  cost: ContinuousPaperCostEvidence | null;
  conditions: ContinuousPaperCondition[];
}

export interface ContinuousPaperPair {
  /** Canonical identity prevents polling the same symbol/candle twice. */
  id: string;
  symbol: string;
  closedAt: number;
  /** Time of the common quote/cost observation used by both policy evaluations. */
  observedAt: number;
  legacy: ContinuousPaperPolicyEvidence;
  adaptive: ContinuousPaperPolicyEvidence;
}

interface Page {
  version: 3;
  sessionId: string;
  day: string;
  revision: number;
  samples: ContinuousPaperPair[];
}

interface PageSummary {
  revision: number;
  candidates: number;
  legacyAccepted: number;
  adaptiveAccepted: number;
  legacyCostAvailable: number;
  adaptiveCostAvailable: number;
}

export interface ContinuousPaperComparisonState {
  version: 3;
  sessionId: string;
  startedAt: number;
  pages: Record<string, PageSummary>;
}

export interface ContinuousPaperComparisonStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  shouldContinue?: () => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day)
  && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day;

export const continuousPaperComparisonHeadKey = (sessionId: string) =>
  `${CONTINUOUS_PAPER_COMPARISON_PREFIX}_head:${sessionId}`;
export const continuousPaperComparisonPageKey = (sessionId: string, day: string) =>
  `${CONTINUOUS_PAPER_COMPARISON_PREFIX}_page:${sessionId}:${day}`;

function validateCondition(value: unknown): value is ContinuousPaperCondition {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 80
    && (value.value === null || finite(value.value))
    && typeof value.operator === 'string' && value.operator.length <= 32
    && (value.threshold === null || finite(value.threshold))
    && (value.passed === null || typeof value.passed === 'boolean');
}

function validateArm(value: unknown, version: ContinuousPaperPolicyEvidence['policyVersion'], now: number): value is ContinuousPaperPolicyEvidence {
  if (!isRecord(value) || value.policyVersion !== version || typeof value.accepted !== 'boolean'
    || typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 300
    || !(value.side === null || value.side === 'LONG' || value.side === 'SHORT')
    || !Array.isArray(value.conditions) || value.conditions.length > 32
    || !value.conditions.every(validateCondition)) return false;
  if (value.accepted && (!value.plan || !value.cost || !value.side
    || !isRecord(value.cost) || value.cost.source !== 'PAPER_GMX_ESTIMATE'
    || !positive(value.cost.estimatedRoundTripUsd))) return false;
  if (value.plan !== null) {
    if (!isRecord(value.plan)) return false;
    const plan = value.plan;
    if (![plan.entry, plan.stop, plan.target, plan.notional, plan.maxHoldHours, plan.expiresAt].every(positive)
      || (plan.maxHoldHours as number) > 168 || (plan.expiresAt as number) > now + 168 * 3_600_000) return false;
    const direction = value.side === 'LONG' ? 1 : value.side === 'SHORT' ? -1 : 0;
    if (!direction || ((plan.stop as number) - (plan.entry as number)) * direction >= 0
      || ((plan.target as number) - (plan.entry as number)) * direction <= 0) return false;
  }
  if (value.cost !== null) {
    const cost = value.cost;
    if (!isRecord(cost) || !finite(cost.estimatedRoundTripUsd) || cost.estimatedRoundTripUsd < 0
      || cost.source !== 'PAPER_GMX_ESTIMATE'
      || !finite(cost.observedAt) || cost.observedAt < 0 || cost.observedAt > now) return false;
  }
  return true;
}

function validatePair(value: unknown, sessionId: string, now: number): value is ContinuousPaperPair {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.symbol !== 'string'
    || !/^[A-Z0-9_]{1,24}$/.test(value.symbol) || value.id !== `${value.symbol}:${value.closedAt}`
    || !positive(value.closedAt) || !positive(value.observedAt) || value.closedAt > value.observedAt || value.observedAt > now
    || !validateArm(value.legacy, 'virtual400-daily/v7', now)
    || !validateArm(value.adaptive, 'virtual400-daily/v9', now)) return false;
  // Session is bound by the containing per-session key and page.
  return sessionId.length > 0;
}

function restoreHead(raw: string | null, sessionId: string, now: number): ContinuousPaperComparisonState {
  if (raw === null) return { version: 3, sessionId, startedAt: now, pages: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('PAPER_CONTINUOUS_COMPARISON_HEAD_INVALID'); }
  if (!isRecord(parsed) || parsed.version !== 3 || parsed.sessionId !== sessionId
    || !finite(parsed.startedAt) || parsed.startedAt <= 0 || parsed.startedAt > now || !isRecord(parsed.pages))
    throw new Error('PAPER_CONTINUOUS_COMPARISON_HEAD_INVALID');
  for (const [day, summary] of Object.entries(parsed.pages)) {
    if (!validDay(day) || !isRecord(summary) || !Number.isInteger(summary.revision) || Number(summary.revision) < 1
      || !Number.isInteger(summary.candidates) || Number(summary.candidates) < 1
      || Number(summary.candidates) > CONTINUOUS_PAPER_PAGE_LIMIT
      || !Number.isInteger(summary.legacyAccepted) || Number(summary.legacyAccepted) < 0
      || Number(summary.legacyAccepted) > Number(summary.candidates)
      || !Number.isInteger(summary.adaptiveAccepted) || Number(summary.adaptiveAccepted) < 0
      || Number(summary.adaptiveAccepted) > Number(summary.candidates)
      || !Number.isInteger(summary.legacyCostAvailable) || Number(summary.legacyCostAvailable) < 0
      || Number(summary.legacyCostAvailable) > Number(summary.candidates)
      || !Number.isInteger(summary.adaptiveCostAvailable) || Number(summary.adaptiveCostAvailable) < 0
      || Number(summary.adaptiveCostAvailable) > Number(summary.candidates))
      throw new Error('PAPER_CONTINUOUS_COMPARISON_HEAD_INVALID');
  }
  return parsed as unknown as ContinuousPaperComparisonState;
}

function summarizePage(samples: ContinuousPaperPair[], revision: number): PageSummary {
  return {
    revision,
    candidates: samples.length,
    legacyAccepted: samples.filter(sample => sample.legacy.accepted).length,
    adaptiveAccepted: samples.filter(sample => sample.adaptive.accepted).length,
    legacyCostAvailable: samples.filter(sample => sample.legacy.cost !== null).length,
    adaptiveCostAvailable: samples.filter(sample => sample.adaptive.cost !== null).length,
  };
}

function restorePage(raw: string | null, sessionId: string, day: string, now: number): Page {
  if (raw === null) return { version: 3, sessionId, day, revision: 0, samples: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('PAPER_CONTINUOUS_COMPARISON_PAGE_INVALID'); }
  if (!isRecord(parsed) || parsed.version !== 3 || parsed.sessionId !== sessionId || parsed.day !== day
    || !Number.isInteger(parsed.revision) || Number(parsed.revision) < 1 || !Array.isArray(parsed.samples)
    || parsed.samples.length > CONTINUOUS_PAPER_PAGE_LIMIT
    || new Set(parsed.samples.map(sample => isRecord(sample) ? sample.id : null)).size !== parsed.samples.length
    || !parsed.samples.every(sample => validatePair(sample, sessionId, now)
      && new Date(sample.closedAt).toISOString().slice(0, 10) === day))
    throw new Error('PAPER_CONTINUOUS_COMPARISON_PAGE_INVALID');
  return parsed as unknown as Page;
}

function totals(state: ContinuousPaperComparisonState) {
  const pages = Object.values(state.pages);
  return pages.reduce((sum, page) => ({
    candidates: sum.candidates + page.candidates,
    legacyAccepted: sum.legacyAccepted + page.legacyAccepted,
    adaptiveAccepted: sum.adaptiveAccepted + page.adaptiveAccepted,
    legacyCostAvailable: sum.legacyCostAvailable + page.legacyCostAvailable,
    adaptiveCostAvailable: sum.adaptiveCostAvailable + page.adaptiveCostAvailable,
  }), { candidates: 0, legacyAccepted: 0, adaptiveAccepted: 0, legacyCostAvailable: 0, adaptiveCostAvailable: 0 });
}

/**
 * Store one matched candle observation. The page write precedes the checkpoint
 * write; if a process stops between them, replaying this candle reconciles the
 * checkpoint from the already durable page without duplicating the candidate.
 */
export async function recordContinuousPaperComparison(
  store: ContinuousPaperComparisonStore,
  sessionId: string,
  pair: ContinuousPaperPair,
  now: number,
): Promise<{ recorded: boolean; candidates: number }> {
  if (store.shouldContinue && !store.shouldContinue()) throw new Error('PAPER_CONTINUOUS_COMPARISON_STOPPED');
  if (!sessionId || !finite(now) || !validatePair(pair, sessionId, now))
    throw new Error('PAPER_CONTINUOUS_COMPARISON_PAIR_INVALID');

  // Page by closed-candle date, rather than poll date, so a replay near UTC
  // midnight cannot write the same candle into two distinct daily pages.
  const day = new Date(pair.closedAt).toISOString().slice(0, 10);
  const headKey = continuousPaperComparisonHeadKey(sessionId);
  const pageKey = continuousPaperComparisonPageKey(sessionId, day);
  const state = restoreHead(await store.read(headKey), sessionId, now);
  const page = restorePage(await store.read(pageKey), sessionId, day, now);
  const existing = page.samples.find(sample => sample.id === pair.id);
  let recorded = false;
  if (!existing) {
    if (page.samples.length >= CONTINUOUS_PAPER_PAGE_LIMIT) throw new Error('PAPER_CONTINUOUS_COMPARISON_PAGE_FULL');
    if (page.samples.some(sample => sample.symbol === pair.symbol && sample.closedAt === pair.closedAt))
      throw new Error('PAPER_CONTINUOUS_COMPARISON_CANDLE_ID_CONFLICT');
    page.samples.push(pair);
    page.revision += 1;
    await store.write(pageKey, JSON.stringify(page));
    recorded = true;
  }

  const nextSummary = summarizePage(page.samples, page.revision);
  const priorSummary = state.pages[day];
  if (!priorSummary || priorSummary.revision !== nextSummary.revision) {
    state.pages[day] = nextSummary;
    if (store.shouldContinue && !store.shouldContinue()) throw new Error('PAPER_CONTINUOUS_COMPARISON_STOPPED');
    await store.write(headKey, JSON.stringify(state));
  }
  return { recorded, candidates: totals(state).candidates };
}

/**
 * Entry evidence is not a realized strategy comparison. No outcomes can be
 * reported until a separate, replayable completed-candle outcome evaluator is
 * wired in; missing cost is counted as unavailable, never treated as zero.
 */
export async function summarizeContinuousPaperComparison(
  store: Pick<ContinuousPaperComparisonStore, 'read'>,
  sessionId: string,
  now: number,
) {
  if (!sessionId || !finite(now) || now <= 0) throw new Error('PAPER_CONTINUOUS_COMPARISON_TIME_INVALID');
  const state = restoreHead(await store.read(continuousPaperComparisonHeadKey(sessionId)), sessionId, now);
  const count = totals(state);
  const latestDay = Object.keys(state.pages).sort().at(-1) ?? null;
  let pendingTimeWindow = 0;
  let maxPotentialMaturityAt: number | null = null;
  // Inspect only the newest and previous UTC day pages. Older accepted arms
  // have expired or cannot be called pending; their outcomes remain unknown.
  if (latestDay) {
    const days = [latestDay, new Date(Date.parse(`${latestDay}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)];
    for (const day of days) {
      const page = restorePage(await store.read(continuousPaperComparisonPageKey(sessionId, day)),
        sessionId, day, now);
      for (const sample of page.samples) {
        for (const arm of [sample.legacy, sample.adaptive]) {
          if (!arm.accepted || !arm.plan || !arm.cost || arm.cost.observedAt > now || arm.plan.expiresAt <= now) continue;
          pendingTimeWindow += 1;
          maxPotentialMaturityAt = Math.max(maxPotentialMaturityAt ?? 0, arm.plan.expiresAt);
        }
      }
    }
  }
  const outcomeUnknown = Math.max(0, count.candidates * 2 - pendingTimeWindow);
  return {
    version: CONTINUOUS_PAPER_COMPARISON_VERSION,
    policyVersions: { legacy: 'virtual400-daily/v7' as const, adaptive: 'virtual400-daily/v9' as const },
    status: 'COLLECTING' as const,
    startedAt: new Date(state.startedAt).toISOString(),
    pages: Object.keys(state.pages).length,
    candidates: count.candidates,
    accepted: { legacyV7: count.legacyAccepted, adaptiveV9: count.adaptiveAccepted },
    costEvidenceAvailable: { legacyV7: count.legacyCostAvailable, adaptiveV9: count.adaptiveCostAvailable },
    costEvidenceUnavailable: {
      legacyV7: count.candidates - count.legacyCostAvailable,
      adaptiveV9: count.candidates - count.adaptiveCostAvailable,
    },
    pendingTimeWindow,
    outcomeUnknown,
    outcomes: {
      status: 'NOT_EVALUATED_NO_CLOSED_CANDLE_REPLAY' as const,
      matured: 0,
      pendingTimeWindow,
      outcomeUnknown,
      opportunityArms: count.candidates * 2,
      netPnlUsd: null,
      expectancyUsd: null,
      winRate: null,
    },
    maxPotentialMaturityAt: maxPotentialMaturityAt === null ? null : new Date(maxPotentialMaturityAt).toISOString(),
    semantics: 'MATCHED_V7_V9_EVALUATION_ON_THE_SAME_SYMBOL_CLOSED_CANDLE_AND_OBSERVATION',
    selectionBias: 'OBSERVED_WHEN_PRODUCTION_DAILY_ENTRY_EVALUATES',
    outOfSampleStrategyValidated: false,
    automaticPromotion: false,
  };
}