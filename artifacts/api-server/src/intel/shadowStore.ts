/**
 * 6I-1 §12 — Shadow 영속화 (migration 0026 테이블).
 *  - snapshot/candidate 저장 실패 = throw (intelCycle이 BLOCKED 처리)
 *  - outcome enrichment: horizon 경과 후 별도 실행, candidateId unique로 idempotent
 *  - 미확보 outcome = complete=false + null (0 기록 금지)
 */
import {
  db, marketIntelligenceSnapshotsTable, opportunityCandidatesTable, shadowOutcomesTable,
} from '@workspace/db';
import { and, desc, eq, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { IntelCycleRecord } from './intelCycle';
import { computeShadowOutcome } from './shadowOutcome';
import { validateCandleSeries } from './candles';
import { Candle, Timeframe } from './types';
import { ShadowOutcomeRow } from './shadowMetrics';

/**
 * 컬럼 정밀도 경계 직렬화 — pg `numeric field overflow` 방지.
 * 경계 초과 값은 null(UNAVAILABLE)로 강등한다 — 반올림·클램프로 가짜 값을 만들지 않는다.
 * maxAbs = 10^(precision-scale) (해당 컬럼이 표현 가능한 정수부 상한).
 */
export const boundedNum = (v: number | null | undefined, maxAbs: number, scale: number): string | null => {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const s = v.toFixed(scale);
  // 반올림 결과가 경계를 넘으면 null 강등 (경계값 반올림 overflow 방지)
  if (Math.abs(Number(s)) >= maxAbs) return null;
  return s;
};
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

export async function persistIntelCycle(record: IntelCycleRecord): Promise<void> {
  const snapshotId = `mi:${record.cycleId}`;
  await db.insert(marketIntelligenceSnapshotsTable).values({
    id: snapshotId,
    cycleId: record.cycleId,
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

export interface EnrichmentSummary {
  scanned: number;
  enriched: number;
  incomplete: number;
  errors: string[];
}

/**
 * horizon 경과 후 outcome enrichment — lookahead 없음(결정 이후 캔들만),
 * candidateId unique index로 중복 기록 방지, 실패 후보는 다음 실행에서 재시도(idempotent).
 */
export async function enrichShadowOutcomes(deps: {
  fetchCandles: (symbol: string, timeframe: Timeframe, count: number) => Promise<Candle[] | null>;
  nowMs: number;
  limit?: number;
}): Promise<EnrichmentSummary> {
  const summary: EnrichmentSummary = { scanned: 0, enriched: 0, incomplete: 0, errors: [] };
  const cutoff = deps.nowMs - OUTCOME_HORIZON_4H_MS;

  // 4h horizon 경과 + 아직 complete outcome 없는 후보 (가격/방향 결정된 것만)
  const done = db.select({ cid: shadowOutcomesTable.candidateId })
    .from(shadowOutcomesTable).where(eq(shadowOutcomesTable.complete, true));
  const rows = await db.select().from(opportunityCandidatesTable)
    .where(and(
      lt(opportunityCandidatesTable.decidedAtMs, String(cutoff)),
      notInArray(opportunityCandidatesTable.id, done),
    ))
    .orderBy(desc(opportunityCandidatesTable.decidedAtMs))
    .limit(deps.limit ?? 50);

  for (const row of rows) {
    summary.scanned++;
    const decidedAtMs = parseNum(row.decidedAtMs);
    const entry = parseNum(row.expectedEntryPrice);
    const notional = parseNum(row.finalNotionalUsd);
    if (decidedAtMs === null || entry === null || notional === null) {
      // 가격 미상 후보(DATA_UNAVAILABLE 등)는 outcome 산출 불가 — incomplete로 1회 기록
      await db.insert(shadowOutcomesTable).values({
        id: `so:${row.id}`, candidateId: row.id, measuredAtMs: String(deps.nowMs),
        complete: false, incompleteReason: '결정 시점 가격/명목 미상 — outcome 산출 불가',
      }).onConflictDoNothing();
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

      const complete = o4h.complete && o1h.complete;
      await db.insert(shadowOutcomesTable).values({
        id: `so:${row.id}`,
        candidateId: row.id,
        measuredAtMs: String(deps.nowMs),
        outcome1hNetUsd: numOrNull(o1h.hypotheticalNetPnlUsd),
        outcome4hNetUsd: numOrNull(o4h.hypotheticalNetPnlUsd),
        grossPnl4hUsd: numOrNull(o4h.hypotheticalGrossPnlUsd),
        totalCostUsd: numOrNull(o4h.hypotheticalTotalCostUsd),
        maxFavorableExcursionPct: scoreOrNull(o4h.maxFavorableExcursionPct),
        maxAdverseExcursionPct: scoreOrNull(o4h.maxAdverseExcursionPct),
        firstTouch: o4h.firstTouch,
        complete,
        incompleteReason: complete ? null : (o4h.incompleteReason ?? o1h.incompleteReason),
      }).onConflictDoUpdate({
        target: shadowOutcomesTable.candidateId,
        set: {
          measuredAtMs: String(deps.nowMs),
          outcome1hNetUsd: numOrNull(o1h.hypotheticalNetPnlUsd),
          outcome4hNetUsd: numOrNull(o4h.hypotheticalNetPnlUsd),
          grossPnl4hUsd: numOrNull(o4h.hypotheticalGrossPnlUsd),
          totalCostUsd: numOrNull(o4h.hypotheticalTotalCostUsd),
          maxFavorableExcursionPct: scoreOrNull(o4h.maxFavorableExcursionPct),
          maxAdverseExcursionPct: scoreOrNull(o4h.maxAdverseExcursionPct),
          firstTouch: o4h.firstTouch,
          complete,
          incompleteReason: complete ? null : (o4h.incompleteReason ?? o1h.incompleteReason),
        },
        // 이미 complete=true인 행은 다시 계산하지 않도록 위 done 필터에서 제외됨
      });
      if (complete) summary.enriched++; else summary.incomplete++;
    } catch (e) {
      summary.errors.push(`${row.id}: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }
  return summary;
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
    winProbability: opportunityCandidatesTable.winProbability,
    expectedRMultiple: opportunityCandidatesTable.expectedRMultiple,
    outcome1h: shadowOutcomesTable.outcome1hNetUsd,
    outcome4h: shadowOutcomesTable.outcome4hNetUsd,
    gross4h: shadowOutcomesTable.grossPnl4hUsd,
    totalCost: shadowOutcomesTable.totalCostUsd,
    mfe: shadowOutcomesTable.maxFavorableExcursionPct,
    mae: shadowOutcomesTable.maxAdverseExcursionPct,
    complete: shadowOutcomesTable.complete,
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
    calibratedProbability: parseNum(r.winProbability),
    expectedRMultiple: parseNum(r.expectedRMultiple),
    outcome1hNetUsd: parseNum(r.outcome1h),
    outcome4hNetUsd: parseNum(r.outcome4h),
    hypotheticalGrossPnlUsd: parseNum(r.gross4h),
    hypotheticalTotalCostUsd: parseNum(r.totalCost),
    maxFavorableExcursionPct: parseNum(r.mfe),
    maxAdverseExcursionPct: parseNum(r.mae),
    complete: r.complete,
  }));
}
