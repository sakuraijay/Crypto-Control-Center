/**
 * 6I-1 §12 — Shadow 영속화 (migration 0026 테이블).
 *  - snapshot/candidate 저장 실패 = throw (intelCycle이 BLOCKED 처리)
 *  - outcome enrichment: horizon 경과 후 별도 실행, candidateId unique로 idempotent
 *  - 미확보 outcome = complete=false + null (0 기록 금지)
 */
import {
  db, marketIntelligenceSnapshotsTable, opportunityCandidatesTable, shadowOutcomesTable,
} from '@workspace/db';
import { and, asc, desc, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import { IntelCycleRecord } from './intelCycle';
import { computeShadowOutcome } from './shadowOutcome';
import { validateCandleSeries } from './candles';
import { Candle, Timeframe } from './types';
import { ShadowOutcomeRow } from './shadowMetrics';

// 컬럼 정밀도 경계 직렬화 — serialize.ts(db-free) 참조. 초과=null 강등, 위장 금지.
import { boundedNum } from './serialize';
const numOrNull = (v: number | null | undefined): string | null =>
  boundedNum(v, 1e12, 6);                        // numeric(18,6) USD 컬럼 기본
const priceOrNull = (v: number | null | undefined): string | null =>
  boundedNum(v, 1e10, 8);                        // numeric(18,8) 가격 컬럼
const scoreOrNull = (v: number | null | undefined): string | null =>
  boundedNum(v, 1e6, 4);                         // numeric(10,4) 점수/배수 컬럼
const probOrNull = (v: number | null | undefined): string | null =>
  v !== null && v !== undefined && Number.isFinite(v) && v >= 0 && v <= 1
    ? v.toFixed(6) : null;                       // numeric(8,6) 확률(0..1만 유효)
const parseNum = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function persistIntelCycle(record: IntelCycleRecord, lifecycle?: { status: string; startedAtMs: number; finishedAtMs: number }): Promise<void> {
  const snapshotId = `mi:${record.cycleId}`;
  await db.insert(marketIntelligenceSnapshotsTable).values({
    id: snapshotId,
    cycleId: record.cycleId,
    status: lifecycle?.status ?? (record.decision === 'BLOCKED' ? 'BLOCKED' : 'SUCCESS'),
    startedAtMs: lifecycle ? String(lifecycle.startedAtMs) : String(record.nowMs),
    finishedAtMs: lifecycle ? String(lifecycle.finishedAtMs) : null,
    universeCount: record.universeCount,
    shortlistCount: record.shortlistCount,
    regimeJson: JSON.stringify([...record.regimes.entries()].map(([market, r]) => ({
      market, regime: r.regime, strength: r.strength, dataQuality: r.dataQuality, basis: r.basis,
    }))),
    dataQuality: record.dataQuality,
    degradedReason: record.degradedReason,
    decision: record.decision,
    noTradeReasons: record.noTradeReasons.length > 0 ? JSON.stringify(record.noTradeReasons) : null,
    snapshotHash: record.snapshotHash,
    fullJson: JSON.stringify({ shortlistSymbols: record.shortlistSymbols }),
  }).onConflictDoNothing();

  if (record.candidates.length > 0) {
    await db.insert(opportunityCandidatesTable).values(record.candidates.map(c => ({
      id: `oc:${record.cycleId}:${c.market}:${c.direction}`,
      snapshotId,
      cycleId: record.cycleId,
      decidedAtMs: String(record.nowMs),
      symbol: c.symbol,
      marketAddress: c.market,
      direction: c.direction,
      regime: c.regime,
      dataQuality: c.dataQuality,
      rawSignalScore: (Number.isFinite(c.rawSignalScore) ? Math.max(0, Math.min(100, c.rawSignalScore)) : 0).toFixed(4),
      winProbability: probOrNull(c.winProbability),
      calibrationStatus: c.probabilityCalibrationStatus,
      expectedEntryPrice: priceOrNull(c.expectedEntryPrice),
      stopPrice: priceOrNull(c.stopPrice),
      takeProfitPrice: priceOrNull(c.takeProfitPrice),
      finalNotionalUsd: boundedNum(c.finalNotionalUsd, 1e14, 4),
      expectedNetValueUsd: numOrNull(c.expectedNetValueUsd),
      expectedRMultiple: scoreOrNull(c.expectedRMultiple),
      uncalibratedRankingScore: scoreOrNull(c.uncalibratedRankingScore),
      totalExpectedCostUsd: numOrNull(c.totalExpectedCostUsd),
      costBreakdownJson: JSON.stringify(c.cost),
      featureJson: JSON.stringify({
        trendScore: c.trendScore, momentumScore: c.momentumScore,
        multiTimeframeAlignment: c.multiTimeframeAlignment, liquidityScore: c.liquidityScore,
        volatilityRisk: c.volatilityRisk, executionRisk: c.executionRisk,
      }),
      rank: c.rank,
      selected: record.selected !== null && record.selected.market === c.market && record.selected.direction === c.direction,
      decision: c.decision,
      rejectionReasons: c.rejectionReasons.length > 0 ? JSON.stringify(c.rejectionReasons) : null,
    }))).onConflictDoNothing();
  }
}

export const OUTCOME_HORIZON_1H_MS = 3_600_000;
export const OUTCOME_HORIZON_4H_MS = 14_400_000;
const ENRICH_TIMEFRAME: Timeframe = '15m';
/** 후보당 enrichment 시도 상한 — 초과 시 DATA_UNAVAILABLE 종결 (무한 재시도 금지) */
export const ENRICH_MAX_ATTEMPTS = 12;

export interface EnrichmentSummary {
  scanned: number;
  enriched: number;        // 4h COMPLETE 종결
  enriched1h: number;      // 1h COMPLETE (4h와 독립)
  ambiguous: number;       // AMBIGUOUS_INTRABAR 종결
  incomplete: number;      // 다음 실행에서 재시도
  exhausted: number;       // 시도 상한 초과 종결
  errors: string[];
}

/** 4h 관점에서 더 이상 재시도하지 않는 종결 상태 */
const TERMINAL_4H = ['COMPLETE', 'AMBIGUOUS_INTRABAR', 'DATA_UNAVAILABLE'];

/**
 * 시도 카운트 정책 (순수 — 테스트 가능):
 * 4h horizon 경과 후 시도만 카운트 — 4h 도달 전 조기 DATA_UNAVAILABLE 종결 구조적 불가.
 */
export function computeEnrichAttempt(args: { prevAttempts: number; nowMs: number; decidedAtMs: number | null }): {
  attempts: number; past4h: boolean; exhaustEligible: boolean;
} {
  const past4h = args.decidedAtMs !== null && args.nowMs >= args.decidedAtMs + OUTCOME_HORIZON_4H_MS;
  const attempts = past4h ? args.prevAttempts + 1 : args.prevAttempts;
  return { attempts, past4h, exhaustEligible: past4h && attempts >= ENRICH_MAX_ATTEMPTS };
}

/**
 * 6I-2 §7 — horizon 경과 후 outcome enrichment.
 *  - lookahead 없음(결정 이후 폐쇄 캔들만) · candidateId unique로 idempotent upsert
 *  - 1h/4h 독립 상태 (1h horizon 경과 시점부터 처리 — 4h 대기 불필요)
 *  - 오래된 후보 우선(asc) + 시도 상한(ENRICH_MAX_ATTEMPTS) — 무한 재시도 금지
 *  - AMBIGUOUS_INTRABAR = 종결 상태 (보정 표본 제외, 임의 방향 선택 금지)
 */
export async function enrichShadowOutcomes(deps: {
  fetchCandles: (symbol: string, timeframe: Timeframe, count: number) => Promise<Candle[] | null>;
  nowMs: number;
  limit?: number;
  /** shutdown/timeout 게이트 — true면 남은 write를 중단 (부분 결과 반환) */
  shouldAbort?: () => boolean;
}): Promise<EnrichmentSummary> {
  const summary: EnrichmentSummary = { scanned: 0, enriched: 0, enriched1h: 0, ambiguous: 0, incomplete: 0, exhausted: 0, errors: [] };
  // 1h horizon 경과부터 처리 대상 (1h/4h 독립 — 4h까지 기다리지 않음)
  const cutoff = deps.nowMs - OUTCOME_HORIZON_1H_MS;

  // 종결(4h terminal 또는 legacy complete=true 또는 시도 상한 초과) outcome 보유 후보 제외
  const terminal = db.select({ cid: shadowOutcomesTable.candidateId })
    .from(shadowOutcomesTable)
    .where(or(
      eq(shadowOutcomesTable.complete, true),
      inArray(shadowOutcomesTable.outcomeStatus4h, TERMINAL_4H),
      sql`${shadowOutcomesTable.attempts} >= ${ENRICH_MAX_ATTEMPTS}`,
    ));
  // 오래된 결정부터(asc) — 최신 편향으로 오래된 pending이 굶지 않도록
  const rows = await db.select().from(opportunityCandidatesTable)
    .where(and(
      lt(opportunityCandidatesTable.decidedAtMs, String(cutoff)),
      notInArray(opportunityCandidatesTable.id, terminal),
    ))
    .orderBy(asc(opportunityCandidatesTable.decidedAtMs))
    .limit(deps.limit ?? 50);

  // 기존 attempts 로드 (upsert 시 증가)
  const existing = rows.length > 0
    ? await db.select({ cid: shadowOutcomesTable.candidateId, attempts: shadowOutcomesTable.attempts })
      .from(shadowOutcomesTable)
      .where(inArray(shadowOutcomesTable.candidateId, rows.map(r => r.id)))
    : [];
  const attemptsMap = new Map(existing.map(e => [e.cid, e.attempts]));

  for (const row of rows) {
    if (deps.shouldAbort?.()) {
      summary.errors.push('shutdown/timeout 게이트 — 잔여 enrichment write 중단');
      break;
    }
    summary.scanned++;
    const prevAttempts = attemptsMap.get(row.id) ?? 0;
    const decidedAtMs = parseNum(row.decidedAtMs);
    // 시도 카운트는 4h horizon 경과 후에만 소진 — 4h 도달 전 조기 DATA_UNAVAILABLE 종결 방지
    // (1h-only 구간의 재계산은 상한과 무관; 4h 표본을 체계적으로 누락시키지 않음)
    const { attempts, past4h } = computeEnrichAttempt({ prevAttempts, nowMs: deps.nowMs, decidedAtMs });
    const entry = parseNum(row.expectedEntryPrice);
    const notional = parseNum(row.finalNotionalUsd);
    if (decidedAtMs === null || entry === null || notional === null) {
      // 가격 미상 후보(DATA_UNAVAILABLE 등)는 outcome 산출 영구 불가 — 종결 기록
      await db.insert(shadowOutcomesTable).values({
        id: `so:${row.id}`, candidateId: row.id, measuredAtMs: String(deps.nowMs),
        complete: false, incompleteReason: '결정 시점 가격/명목 미상 — outcome 산출 불가',
        outcomeStatus1h: 'DATA_UNAVAILABLE', outcomeStatus4h: 'DATA_UNAVAILABLE',
        decisionObservedAtMs: row.decidedAtMs, attempts,
      }).onConflictDoUpdate({
        target: shadowOutcomesTable.candidateId,
        set: { outcomeStatus1h: 'DATA_UNAVAILABLE', outcomeStatus4h: 'DATA_UNAVAILABLE', attempts, measuredAtMs: String(deps.nowMs) },
      });
      summary.incomplete++;
      continue;
    }
    try {
      const raw = await deps.fetchCandles(row.symbol, ENRICH_TIMEFRAME, 96);
      const val = raw === null
        ? null
        : validateCandleSeries(raw, ENRICH_TIMEFRAME, { nowMs: deps.nowMs, expectedCount: 96, minCount: 4 });
      const candlesAfter = val?.ok ? val.candles!.filter(c => c.t > decidedAtMs) : [];

      const base = {
        direction: row.direction as 'LONG' | 'SHORT',
        entryPrice: entry,
        stopPrice: parseNum(row.stopPrice),
        takeProfitPrice: parseNum(row.takeProfitPrice),
        notionalUsd: notional,
        totalCostUsd: parseNum(row.totalExpectedCostUsd),
        decidedAtMs,
        candlesAfter,
        nowMs: deps.nowMs,
      };
      const o1h = computeShadowOutcome({ ...base, horizonMs: OUTCOME_HORIZON_1H_MS });
      const o4h = computeShadowOutcome({ ...base, horizonMs: OUTCOME_HORIZON_4H_MS });

      // 시도 상한 초과 + 여전히 미완이면 DATA_UNAVAILABLE 종결 (성공 위장 없음 — 사유 기록)
      // 상한은 4h 경과 후 시도만 카운트하므로 4h 도달 전 종결은 구조적으로 불가
      const exhaust = past4h && attempts >= ENRICH_MAX_ATTEMPTS;
      const status1h = o1h.status === 'INCOMPLETE' && exhaust ? 'DATA_UNAVAILABLE' : o1h.status;
      const status4h = o4h.status === 'INCOMPLETE' && exhaust ? 'DATA_UNAVAILABLE' : o4h.status;
      const complete = o4h.status === 'COMPLETE';   // 보정 표본 = 4h COMPLETE만 (1h 혼합 금지)
      const set = {
        measuredAtMs: String(deps.nowMs),
        outcome1hNetUsd: numOrNull(o1h.hypotheticalNetPnlUsd),
        outcome4hNetUsd: numOrNull(o4h.hypotheticalNetPnlUsd),
        grossPnl4hUsd: numOrNull(o4h.hypotheticalGrossPnlUsd),
        outcome1hGrossUsd: numOrNull(o1h.hypotheticalGrossPnlUsd),
        totalCostUsd: numOrNull(o4h.hypotheticalTotalCostUsd),
        maxFavorableExcursionPct: scoreOrNull(o4h.maxFavorableExcursionPct),
        maxAdverseExcursionPct: scoreOrNull(o4h.maxAdverseExcursionPct),
        firstTouch: o4h.firstTouch,
        firstTouch1h: o1h.firstTouch,
        outcomeStatus1h: status1h,
        outcomeStatus4h: status4h,
        complete,
        incompleteReason: complete ? null : (o4h.incompleteReason ?? o1h.incompleteReason),
        decisionObservedAtMs: row.decidedAtMs,
        horizonEnd1hMs: String(o1h.horizonEndMs),
        horizonEnd4hMs: String(o4h.horizonEndMs),
        sourceCandleFromMs: o4h.sourceCandleFromMs !== null ? String(o4h.sourceCandleFromMs) : null,
        sourceCandleToMs: o4h.sourceCandleToMs !== null ? String(o4h.sourceCandleToMs) : null,
        entryReferencePrice: priceOrNull(entry),
        dataCoverage: probOrNull(o4h.dataCoverage),
        attempts,
        completedAt: complete || status4h === 'AMBIGUOUS_INTRABAR' || status4h === 'DATA_UNAVAILABLE' ? new Date(deps.nowMs) : null,
      };
      await db.insert(shadowOutcomesTable).values({ id: `so:${row.id}`, candidateId: row.id, ...set })
        .onConflictDoUpdate({ target: shadowOutcomesTable.candidateId, set });
      if (complete) { summary.enriched++; }
      else if (status4h === 'AMBIGUOUS_INTRABAR') summary.ambiguous++;
      else if (exhaust) summary.exhausted++;
      else summary.incomplete++;
      if (o1h.status === 'COMPLETE') summary.enriched1h++;
    } catch (e) {
      summary.errors.push(`${row.id}: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }
  return summary;
}

export interface EnrichmentBacklog {
  dueCount: number;              // 1h horizon 경과 + 미종결
  oldestPendingDecidedAtMs: number | null;
  terminalCount: number;
  ambiguousCount: number;
  complete4hCount: number;
}

/** §11 — enrichment 백로그 (저장 상태만 조회, 외부 호출 0회) */
export async function getEnrichmentBacklog(nowMs: number): Promise<EnrichmentBacklog> {
  const cutoff = nowMs - OUTCOME_HORIZON_1H_MS;
  const terminal = db.select({ cid: shadowOutcomesTable.candidateId })
    .from(shadowOutcomesTable)
    .where(or(
      eq(shadowOutcomesTable.complete, true),
      inArray(shadowOutcomesTable.outcomeStatus4h, TERMINAL_4H),
      sql`${shadowOutcomesTable.attempts} >= ${ENRICH_MAX_ATTEMPTS}`,
    ));
  const dueRows = await db.select({
    count: sql<number>`count(*)::int`,
    oldest: sql<string | null>`min(decided_at_ms)`,
  }).from(opportunityCandidatesTable)
    .where(and(
      lt(opportunityCandidatesTable.decidedAtMs, String(cutoff)),
      notInArray(opportunityCandidatesTable.id, terminal),
    ));
  const statusRows = await db.select({
    ambiguous: sql<number>`count(*) filter (where outcome_status_4h = 'AMBIGUOUS_INTRABAR')::int`,
    complete4h: sql<number>`count(*) filter (where outcome_status_4h = 'COMPLETE' or complete = true)::int`,
    terminalCount: sql<number>`count(*) filter (where complete = true or outcome_status_4h in ('COMPLETE','AMBIGUOUS_INTRABAR','DATA_UNAVAILABLE') or attempts >= ${ENRICH_MAX_ATTEMPTS})::int`,
  }).from(shadowOutcomesTable);
  return {
    dueCount: dueRows[0]?.count ?? 0,
    oldestPendingDecidedAtMs: dueRows[0]?.oldest ? Number(dueRows[0].oldest) : null,
    terminalCount: statusRows[0]?.terminalCount ?? 0,
    ambiguousCount: statusRows[0]?.ambiguous ?? 0,
    complete4hCount: statusRows[0]?.complete4h ?? 0,
  };
}

/** 보정 표본 수 — complete=true outcome */
export async function getCompletedSampleCount(): Promise<{ count: number; lastAtMs: number | null }> {
  const rows = await db.select({
    count: sql<number>`count(*)::int`,
    lastAt: sql<string | null>`max(measured_at_ms)`,
  }).from(shadowOutcomesTable).where(eq(shadowOutcomesTable.complete, true));
  const r = rows[0];
  return { count: r?.count ?? 0, lastAtMs: r?.lastAt ? Number(r.lastAt) : null };
}

/** metrics 계산용 outcome+candidate join 로드 */
export async function loadShadowOutcomeRows(limit = 2000): Promise<ShadowOutcomeRow[]> {
  const rows = await db.select({
    candidateId: shadowOutcomesTable.candidateId,
    direction: opportunityCandidatesTable.direction,
    regime: opportunityCandidatesTable.regime,
    decision: opportunityCandidatesTable.decision,
    selected: opportunityCandidatesTable.selected,
    rank: opportunityCandidatesTable.rank,
    winProbability: opportunityCandidatesTable.winProbability,
    expectedRMultiple: opportunityCandidatesTable.expectedRMultiple,
    outcome1h: shadowOutcomesTable.outcome1hNetUsd,
    outcome4h: shadowOutcomesTable.outcome4hNetUsd,
    gross4h: shadowOutcomesTable.grossPnl4hUsd,
    totalCost: shadowOutcomesTable.totalCostUsd,
    mfe: shadowOutcomesTable.maxFavorableExcursionPct,
    mae: shadowOutcomesTable.maxAdverseExcursionPct,
    complete: shadowOutcomesTable.complete,
    outcomeStatus4h: shadowOutcomesTable.outcomeStatus4h,
    firstTouch: shadowOutcomesTable.firstTouch,
  })
    .from(shadowOutcomesTable)
    .innerJoin(opportunityCandidatesTable, eq(shadowOutcomesTable.candidateId, opportunityCandidatesTable.id))
    .orderBy(desc(shadowOutcomesTable.createdAt))
    .limit(limit);
  return rows.map(r => ({
    candidateId: r.candidateId,
    direction: r.direction as 'LONG' | 'SHORT',
    regime: r.regime,
    decision: r.decision,
    selected: r.selected,
    rank: r.rank,
    calibratedProbability: parseNum(r.winProbability),
    expectedRMultiple: parseNum(r.expectedRMultiple),
    outcome1hNetUsd: parseNum(r.outcome1h),
    outcome4hNetUsd: parseNum(r.outcome4h),
    hypotheticalGrossPnlUsd: parseNum(r.gross4h),
    hypotheticalTotalCostUsd: parseNum(r.totalCost),
    maxFavorableExcursionPct: parseNum(r.mfe),
    maxAdverseExcursionPct: parseNum(r.mae),
    complete: r.complete,
    outcomeStatus4h: r.outcomeStatus4h,
    firstTouch: r.firstTouch,
  }));
}
