/**
 * 6I-1 §15 — Market Intelligence read-only API.
 *  - GET /api/market-intelligence/status — 마지막 사이클 상태 (메모리 스냅샷, 외부 호출 0회)
 *  - GET /api/opportunities/latest — 최근 후보 목록 (DB)
 *  - GET /api/shadow/metrics — shadow 성과 지표 (표본 부족=INSUFFICIENT_SAMPLE)
 * 조회 실패 = 오류 응답 (가짜 0/NORMAL 금지). 쓰기/실행 엔드포인트 없음.
 */
import { Router, type IRouter } from 'express';
import { getIntelServiceState } from '../intel/intelService';
import { loadShadowOutcomeRows } from '../intel/shadowStore';
import { computeShadowMetrics } from '../intel/shadowMetrics';
import { db, marketIntelligenceSnapshotsTable, opportunityCandidatesTable } from '@workspace/db';
import { desc, eq } from 'drizzle-orm';

const router: IRouter = Router();

router.get('/market-intelligence/status', (_req, res) => {
  const s = getIntelServiceState();
  if (!s.lastRecord) {
    return res.status(200).json({
      available: false,
      reason: s.lastError ?? 'intel 사이클 미실행 — Worker 기동 후 첫 사이클 대기',
      cycleCount: s.cycleCount,
    });
  }
  const r = s.lastRecord;
  return res.json({
    available: true,
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
  });
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
      candidates: candidates.map(c => ({
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
        rank: c.rank, selected: c.selected, decision: c.decision,
        rejectionReasons: c.rejectionReasons ? JSON.parse(c.rejectionReasons) : [],
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: '후보 조회 실패', reason: e instanceof Error ? e.message : 'unknown' });
  }
});

router.get('/shadow/metrics', async (_req, res) => {
  try {
    const rows = await loadShadowOutcomeRows();
    const s = getIntelServiceState();
    const metrics = computeShadowMetrics(rows, { cycleCount: s.cycleCount, noTradeCycles: s.noTradeCycles });
    return res.json(metrics);
  } catch (e) {
    return res.status(500).json({ error: 'shadow metrics 조회 실패', reason: e instanceof Error ? e.message : 'unknown' });
  }
});

export default router;
