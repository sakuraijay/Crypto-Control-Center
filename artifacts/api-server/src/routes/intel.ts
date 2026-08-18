/**
 * 6I-1 §15 — Market Intelligence read-only API.
 *  - GET /api/market-intelligence/status — 마지막 사이클 상태 (메모리 스냅샷, 외부 호출 0회)
 *  - GET /api/opportunities/latest — 최근 후보 목록 (DB)
 *  - GET /api/shadow/metrics — shadow 성과 지표 (표본 부족=INSUFFICIENT_SAMPLE)
 * 조회 실패 = 오류 응답 (가짜 0/NORMAL 금지). 쓰기/실행 엔드포인트 없음.
 */
import { Router, type IRouter } from 'express';
import { getIntelServiceState, getIntelRuntimeStats } from '../intel/intelService';
import { loadShadowOutcomeRows, getEnrichmentBacklog, getCalibrationBucketStats } from '../intel/shadowStore';
import { calibrateBuckets } from '../intel/calibration';
import { computeShadowMetrics, computeShadowMaturity, summarizeCounterfactuals } from '../intel/shadowMetrics';
import { db, marketIntelligenceSnapshotsTable, opportunityCandidatesTable } from '@workspace/db';
import { desc, eq } from 'drizzle-orm';

const router: IRouter = Router();

/** 6I-2 §11 — MI Runtime 관측치 (메모리 저장 상태만, 외부 호출 0회) */
function runtimeBlock() {
  const s = getIntelServiceState();
  const stats = getIntelRuntimeStats();
  return {
    mode: 'SHADOW_ONLY' as const,
    inFlight: s.inFlight,
    currentCycleId: s.currentCycleId,
    skippedInFlight: s.skippedInFlight,
    timeoutCount: s.timeoutCount,
    failedCount: s.failedCount,
    shutdownRequested: s.shutdownRequested,
    lastAttempt: s.lastAttempt,
    lastRecordStale: s.lastRecordStale,
    requestStats: stats.candleFetch,
    dataSourceStats: stats.dataSource,
  };
}

router.get('/market-intelligence/status', (_req, res) => {
  const s = getIntelServiceState();
  if (!s.lastRecord) {
    return res.status(200).json({
      available: false,
      mode: 'SHADOW_ONLY',
      reason: s.lastError ?? 'intel 사이클 미실행 — Worker 기동 후 첫 사이클 대기',
      cycleCount: s.cycleCount,
      runtime: runtimeBlock(),
    });
  }
  const r = s.lastRecord;
  return res.json({
    available: true,
    mode: 'SHADOW_ONLY',
    stale: s.lastRecordStale,
    cycleId: r.cycleId,
    at: new Date(r.nowMs).toISOString(),
    universeCount: r.universeCount,
    shortlistCount: r.shortlistCount,
    shortlistSymbols: r.shortlistSymbols,
    degraded: r.degraded,
    degradedReason: r.degradedReason,
    dataQuality: r.dataQuality,
    decision: r.decision,
    blockedReason: r.blockedReason,
    noTradeReasons: r.noTradeReasons,
    regimes: [...r.regimes.entries()].map(([market, reg]) => ({
      market, regime: reg.regime, strength: reg.strength,
      dataQuality: reg.dataQuality, basis: reg.basis, tradeAllowed: reg.tradeAllowed,
    })),
    cycleCount: s.cycleCount,
    noTradeCycles: s.noTradeCycles,
    lastError: s.lastError,
    lastEnrichment: s.lastEnrichment,
    snapshotHash: r.snapshotHash,
    runtime: runtimeBlock(),
  });
});

/** 6I-2 §11 — Outcome Enrichment 상태 (DB 저장 상태만, 외부 호출 0회) */
router.get('/shadow/enrichment', async (_req, res) => {
  try {
    const s = getIntelServiceState();
    const backlog = await getEnrichmentBacklog(Date.now());
    return res.json({
      mode: 'SHADOW_ONLY',
      lastRun: s.lastEnrichment,
      backlog,
    });
  } catch (e) {
    return res.status(500).json({ error: 'enrichment 상태 조회 실패', reason: e instanceof Error ? e.message : 'unknown' });
  }
});

router.get('/opportunities/latest', async (_req, res) => {
  try {
    const snaps = await db.select().from(marketIntelligenceSnapshotsTable)
      .orderBy(desc(marketIntelligenceSnapshotsTable.createdAt)).limit(1);
    if (snaps.length === 0) return res.json({ available: false, reason: '저장된 사이클 없음', candidates: [] });
    const snap = snaps[0];
    const candidates = await db.select().from(opportunityCandidatesTable)
      .where(eq(opportunityCandidatesTable.snapshotId, snap.id))
      .orderBy(desc(opportunityCandidatesTable.rawSignalScore));
    return res.json({
      available: true,
      cycleId: snap.cycleId,
      createdAt: snap.createdAt,
      decision: snap.decision,
      noTradeReasons: snap.noTradeReasons ? JSON.parse(snap.noTradeReasons) : [],
      dataQuality: snap.dataQuality,
      candidates: candidates.map(c => {
        // 6I-3 — 저장된 비용 breakdown/bucket 관측치를 그대로 노출 (파싱 실패=null, 가짜 0 금지)
        let costBreakdown: unknown = null;
        try { costBreakdown = c.costBreakdownJson ? JSON.parse(c.costBreakdownJson) : null; } catch { costBreakdown = null; }
        let calibrationBucket: unknown = null;
        try {
          const f = c.featureJson ? JSON.parse(c.featureJson) as { calibrationBucket?: unknown } : null;
          calibrationBucket = f?.calibrationBucket ?? null;
        } catch { calibrationBucket = null; }
        return {
          symbol: c.symbol, market: c.marketAddress, direction: c.direction, regime: c.regime,
          dataQuality: c.dataQuality,
          rawSignalScore: Number(c.rawSignalScore),
          // 보정 확률 없음=null 그대로 노출 (가짜 % 금지)
          winProbability: c.winProbability === null ? null : Number(c.winProbability),
          calibrationStatus: c.calibrationStatus,
          expectedNetValueUsd: c.expectedNetValueUsd === null ? null : Number(c.expectedNetValueUsd),
          expectedRMultiple: c.expectedRMultiple === null ? null : Number(c.expectedRMultiple),
          uncalibratedRankingScore: c.uncalibratedRankingScore === null ? null : Number(c.uncalibratedRankingScore),
          totalExpectedCostUsd: c.totalExpectedCostUsd === null ? null : Number(c.totalExpectedCostUsd),
          costBreakdown,
          calibrationBucket,
          rank: c.rank, selected: c.selected, decision: c.decision,
          rejectionReasons: c.rejectionReasons ? JSON.parse(c.rejectionReasons) : [],
        };
      }),
    });
  } catch (e) {
    return res.status(500).json({ error: '후보 조회 실패', reason: e instanceof Error ? e.message : 'unknown' });
  }
});

/**
 * 6I-3 — regime×방향 bucket 승률 보정 상태 (DB 집계, 외부 호출 0회).
 * 표본 미달 bucket은 winProbability=null + 사유 그대로 노출 (가짜 50% 금지).
 */
router.get('/shadow/calibration', async (_req, res) => {
  try {
    const nowMs = Date.now();
    const raws = await getCalibrationBucketStats();
    const buckets = [...calibrateBuckets(raws, nowMs).values()]
      .sort((a, b) => b.decisiveSamples - a.decisiveSamples);
    return res.json({
      mode: 'SHADOW_ONLY',
      atMs: nowMs,
      requiredSamplesPerBucket: buckets[0]?.requiredSamples ?? 200,
      buckets,
    });
  } catch (e) {
    return res.status(500).json({ error: 'calibration 조회 실패', reason: e instanceof Error ? e.message : 'unknown' });
  }
});

router.get('/shadow/metrics', async (_req, res) => {
  try {
    const rows = await loadShadowOutcomeRows();
    const s = getIntelServiceState();
    const metrics = computeShadowMetrics(rows, { cycleCount: s.cycleCount, noTradeCycles: s.noTradeCycles });
    // 6I-2 §8·§10 — counterfactual + 표본 성숙도 (승격 플래그는 구조적으로 항상 false)
    return res.json({
      mode: 'SHADOW_ONLY',
      ...metrics,
      maturity: computeShadowMaturity(rows),
      counterfactual: summarizeCounterfactuals(rows),
    });
  } catch (e) {
    return res.status(500).json({ error: 'shadow metrics 조회 실패', reason: e instanceof Error ? e.message : 'unknown' });
  }
});

export default router;
