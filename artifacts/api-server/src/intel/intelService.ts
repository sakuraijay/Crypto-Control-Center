/**
 * 6I-1 §14·§15 — intel 사이클 실행 서비스 (worker 배선 + API 상태 보관).
 *  - SHADOW_ONLY: 주문 실행 경로 호출 없음. LIVE 자율 실행 구조적 불가.
 *  - worker가 매 사이클 호출; 실패해도 기존 매매 루프에 영향 없음(격리).
 *  - API는 마지막 사이클의 메모리 스냅샷 + DB만 읽는다 (외부 호출 0회).
 */
import { runIntelCycle, IntelCycleRecord } from './intelCycle';
import { createProductionFetchers, IntelFetchers } from './dataSource';
import { persistIntelCycle, getCompletedSampleCount, enrichShadowOutcomes, EnrichmentSummary } from './shadowStore';
import { RankingGates } from './ranking';
import { getCachedPrices, getCachedChange24h, fetchGmxCandles } from '../routes/gmx';

interface IntelServiceState {
  lastRecord: IntelCycleRecord | null;
  lastError: string | null;
  lastRunAtMs: number | null;
  cycleCount: number;
  noTradeCycles: number;
  lastEnrichment: (EnrichmentSummary & { atMs: number }) | null;
}

const state: IntelServiceState = {
  lastRecord: null, lastError: null, lastRunAtMs: null,
  cycleCount: 0, noTradeCycles: 0, lastEnrichment: null,
};

let fetchers: IntelFetchers | null = null;
function getFetchers(): IntelFetchers {
  fetchers ??= createProductionFetchers({ getCachedPrices, getCachedChange24h, fetchGmxCandles });
  return fetchers;
}

/** intel 사이클 최소 간격 — 매매 사이클(60s)보다 낮은 빈도 (외부 조회 절약) */
export const INTEL_CYCLE_MIN_INTERVAL_MS = 5 * 60_000;
/** enrichment 실행 간격 */
export const ENRICHMENT_MIN_INTERVAL_MS = 15 * 60_000;
let lastEnrichAtMs = 0;

/**
 * worker 사이클에서 호출 — 간격 미달이면 skip.
 * 어떤 예외도 밖으로 던지지 않는다 (기존 매매 루프 보호).
 */
export async function runIntelServiceCycle(input: { cycleNum: number; gates: RankingGates }): Promise<void> {
  const nowMs = input.gates.nowMs;
  try {
    if (state.lastRunAtMs !== null && nowMs - state.lastRunAtMs < INTEL_CYCLE_MIN_INTERVAL_MS) return;
    state.lastRunAtMs = nowMs;
    const record = await runIntelCycle({
      fetchers: getFetchers(),
      getCompletedSampleCount,
      persist: persistIntelCycle,
      gates: input.gates,
      nowMs,
      cycleId: `c${input.cycleNum}-${nowMs}`,
    });
    if (record) {
      state.lastRecord = record;
      state.lastError = null;
      state.cycleCount++;
      if (record.decision === 'NO_TRADE') state.noTradeCycles++;
      if (record.decision === 'BLOCKED') {
        console.warn(`[Intel] 사이클 ${record.cycleId} BLOCKED — ${record.blockedReason}`);
      } else {
        console.info(`[Intel] 사이클 ${record.cycleId} — universe=${record.universeCount} shortlist=${record.shortlistCount} 결정=${record.decision}`);
      }
    }
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : 'unknown';
    console.warn(`[Intel] 사이클 실패 (매매 루프 영향 없음): ${state.lastError}`);
  }

  // outcome enrichment — horizon 경과 후보 별도 처리 (비치명)
  try {
    if (nowMs - lastEnrichAtMs >= ENRICHMENT_MIN_INTERVAL_MS) {
      lastEnrichAtMs = nowMs;
      const summary = await enrichShadowOutcomes({
        fetchCandles: (symbol, timeframe, count) => getFetchers().fetchCandles(symbol, timeframe, count),
        nowMs,
      });
      state.lastEnrichment = { ...summary, atMs: nowMs };
      if (summary.scanned > 0) {
        console.info(`[Intel] enrichment — scanned=${summary.scanned} enriched=${summary.enriched} incomplete=${summary.incomplete}`);
      }
    }
  } catch (e) {
    console.warn(`[Intel] enrichment 실패: ${e instanceof Error ? e.message : 'unknown'}`);
  }
}

export function getIntelServiceState(): Readonly<IntelServiceState> {
  return state;
}

/** 테스트 전용 초기화 */
export function __resetIntelServiceForTests(): void {
  if (!(process.env.VITEST || process.env.NODE_ENV === 'test')) return;
  state.lastRecord = null; state.lastError = null; state.lastRunAtMs = null;
  state.cycleCount = 0; state.noTradeCycles = 0; state.lastEnrichment = null;
  lastEnrichAtMs = 0;
}
