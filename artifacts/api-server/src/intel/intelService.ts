/**
 * 6I-1 §14·§15 + 6I-2 §3·§4 — intel 사이클 실행 서비스 (worker 배선 + API 상태 보관).
 *  - SHADOW_ONLY: 주문 실행 경로 호출 없음. LIVE 자율 실행 구조적 불가.
 *  - single-flight: 실행 중 재진입 = SKIPPED_IN_FLIGHT (fire-and-forget 호출 안전)
 *  - 결정적 cycleWindowKey: 같은 관측 시간창은 재시작 후에도 같은 cycleId
 *    (snapshot PK + cycle_id unique index로 중복 저장 구조적 차단)
 *  - cycle timeout: 초과 시 TIMEOUT 기록, 늦게 도착한 결과의 persist/상태 반영 차단
 *  - shutdown: stopIntelService() 이후 신규 사이클/enrichment 진입 차단
 *  - 실패를 성공으로 위장하지 않음 — 마지막 성공 스냅샷은 lastRecordStale로 구분
 */
import { runIntelCycle, IntelCycleRecord } from './intelCycle';
import { createProductionFetchers, ProductionFetchersHandle, RequestBudgetExceededError, RateLimitBackoffError } from './dataSource';
import { persistIntelCycle, getCompletedSampleCount, enrichShadowOutcomes, EnrichmentSummary } from './shadowStore';
import { RankingGates } from './ranking';
import { getCachedPrices, getCachedChange24h, fetchGmxCandles, getCandleFetchStats } from '../routes/gmx';

export type CycleLifecycleStatus = 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'BLOCKED' | 'SKIPPED_IN_FLIGHT' | 'SKIPPED_INTERVAL' | 'SKIPPED_SHUTDOWN' | 'SKIPPED_BACKOFF';

export interface CycleAttempt {
  cycleId: string;
  windowKey: number;
  status: CycleLifecycleStatus;
  startedAtMs: number;
  finishedAtMs: number | null;
  error: string | null;
}

interface IntelServiceState {
  lastRecord: IntelCycleRecord | null;
  /** lastRecord가 최신 시도가 아닌(이후 시도 실패) 경우 true — stale 위장 금지 */
  lastRecordStale: boolean;
  lastError: string | null;
  lastRunAtMs: number | null;
  cycleCount: number;
  noTradeCycles: number;
  lastEnrichment: (EnrichmentSummary & { atMs: number }) | null;
  // 6I-2 §3·§11 — 수명주기 관측치
  inFlight: boolean;
  currentCycleId: string | null;
  skippedInFlight: number;
  timeoutCount: number;
  failedCount: number;
  shutdownRequested: boolean;
  lastAttempt: CycleAttempt | null;
  lastWindowKey: number | null;
  enrichInFlight: boolean;
}

const state: IntelServiceState = {
  lastRecord: null, lastRecordStale: false, lastError: null, lastRunAtMs: null,
  cycleCount: 0, noTradeCycles: 0, lastEnrichment: null,
  inFlight: false, currentCycleId: null, skippedInFlight: 0,
  timeoutCount: 0, failedCount: 0, shutdownRequested: false,
  lastAttempt: null, lastWindowKey: null, enrichInFlight: false,
};

let handle: ProductionFetchersHandle | null = null;
function getHandle(): ProductionFetchersHandle {
  handle ??= createProductionFetchers({
    getCachedPrices, getCachedChange24h, fetchGmxCandles,
    // candle 429는 gmx.ts가 null로 소거 — 계측 last429AtMs를 backoff에 연결
    getLast429AtMs: () => getCandleFetchStats().last429AtMs,
  });
  return handle;
}

/** intel 사이클 최소 간격 — 매매 사이클(60s)보다 낮은 빈도 (외부 조회 절약) */
export const INTEL_CYCLE_MIN_INTERVAL_MS = 5 * 60_000;
/** enrichment 실행 간격 */
export const ENRICHMENT_MIN_INTERVAL_MS = 15 * 60_000;
/** cycle 전체 timeout — 초과 시 TIMEOUT 기록 + 결과 폐기 */
export const INTEL_CYCLE_TIMEOUT_MS = 90_000;
let lastEnrichAtMs = 0;

/** 결정적 cycle window key — 같은 5분 창은 프로세스 재시작 후에도 같은 키 */
export function computeCycleWindowKey(nowMs: number): number {
  return Math.floor(nowMs / INTEL_CYCLE_MIN_INTERVAL_MS);
}
export function cycleIdForWindow(windowKey: number): string {
  return `w${windowKey}`;
}

/**
 * worker 사이클에서 호출 — 간격 미달/재진입/shutdown이면 skip.
 * 어떤 예외도 밖으로 던지지 않는다 (기존 매매 루프 보호).
 */
export async function runIntelServiceCycle(input: { cycleNum: number; gates: RankingGates }): Promise<void> {
  const nowMs = input.gates.nowMs;
  const windowKey = computeCycleWindowKey(nowMs);
  const cycleId = cycleIdForWindow(windowKey);

  // shutdown — 신규 진입 차단
  if (state.shutdownRequested) {
    state.lastAttempt = { cycleId, windowKey, status: 'SKIPPED_SHUTDOWN', startedAtMs: nowMs, finishedAtMs: nowMs, error: null };
    return;
  }
  // single-flight — 실행 중 재진입 즉시 skip (동시 실행 구조적 차단)
  if (state.inFlight) {
    state.skippedInFlight++;
    state.lastAttempt = { cycleId, windowKey, status: 'SKIPPED_IN_FLIGHT', startedAtMs: nowMs, finishedAtMs: nowMs, error: null };
    return;
  }
  // 같은 관측 시간창 재실행 방지 (재시작 시에는 DB cycle_id unique가 최종 방어)
  if (state.lastWindowKey === windowKey || (state.lastRunAtMs !== null && nowMs - state.lastRunAtMs < INTEL_CYCLE_MIN_INTERVAL_MS)) {
    return;
  }

  state.inFlight = true;
  state.currentCycleId = cycleId;
  state.lastRunAtMs = nowMs;
  state.lastWindowKey = windowKey;
  const startedAtMs = Date.now();
  let timedOut = false;

  try {
    const h = getHandle();
    h.beginCycle();
    // persist 게이트 — timeout/shutdown 후 늦게 도착한 결과의 저장 차단
    const gatedPersist = async (record: IntelCycleRecord) => {
      if (timedOut) throw new Error('cycle timeout 이후 persist 차단');
      if (state.shutdownRequested) throw new Error('shutdown 이후 persist 차단');
      await persistIntelCycle(record, { status: record.decision === 'BLOCKED' ? 'BLOCKED' : 'SUCCESS', startedAtMs, finishedAtMs: Date.now() });
    };

    const cyclePromise = runIntelCycle({
      fetchers: h.fetchers,
      getCompletedSampleCount,
      persist: gatedPersist,
      gates: input.gates,
      nowMs,
      cycleId,
    });
    const record = await Promise.race([
      cyclePromise,
      new Promise<'TIMEOUT'>(resolve => setTimeout(() => resolve('TIMEOUT'), INTEL_CYCLE_TIMEOUT_MS).unref?.()),
    ]);

    if (record === 'TIMEOUT') {
      timedOut = true;
      state.timeoutCount++;
      state.lastError = `cycle ${cycleId} TIMEOUT (${INTEL_CYCLE_TIMEOUT_MS}ms 초과) — 결과 폐기`;
      state.lastRecordStale = state.lastRecord !== null;
      state.lastAttempt = { cycleId, windowKey, status: 'TIMEOUT', startedAtMs, finishedAtMs: Date.now(), error: state.lastError };
      console.warn(`[Intel] ${state.lastError}`);
      // flight ownership 유지 — 늦게 실행 중인 작업이 끝날 때까지 새 사이클/예산 리셋과 겹치지 않게 함
      // (persist는 gatedPersist가 차단; settle 후 finally에서 inFlight 해제)
      void cyclePromise.catch(() => {}).finally(() => {
        state.inFlight = false;
        state.currentCycleId = null;
      });
      return;
    }

    if (record) {
      state.lastRecord = record;
      state.lastRecordStale = false;
      state.lastError = null;
      state.cycleCount++;
      if (record.decision === 'NO_TRADE') state.noTradeCycles++;
      state.lastAttempt = {
        cycleId, windowKey,
        status: record.decision === 'BLOCKED' ? 'BLOCKED' : 'SUCCESS',
        startedAtMs, finishedAtMs: Date.now(), error: record.blockedReason,
      };
      if (record.decision === 'BLOCKED') {
        console.warn(`[Intel] 사이클 ${record.cycleId} BLOCKED — ${record.blockedReason}`);
      } else {
        console.info(`[Intel] 사이클 ${record.cycleId} — universe=${record.universeCount} shortlist=${record.shortlistCount} 결정=${record.decision} (candle req=${h.stats.candleRequests} cacheHit=${h.stats.candleCacheHits})`);
      }
    } else {
      // runIntelCycle 내부 lock에 걸림 (정상적으론 도달 불가 — single-flight가 먼저 차단)
      state.lastAttempt = { cycleId, windowKey, status: 'SKIPPED_IN_FLIGHT', startedAtMs, finishedAtMs: Date.now(), error: null };
    }
  } catch (e) {
    const isBudget = e instanceof RequestBudgetExceededError;
    const isBackoff = e instanceof RateLimitBackoffError;
    state.failedCount++;
    state.lastError = e instanceof Error ? e.message : 'unknown';
    state.lastRecordStale = state.lastRecord !== null;    // 이전 성공 스냅샷은 stale로만 제공
    state.lastAttempt = {
      cycleId, windowKey,
      status: isBackoff ? 'SKIPPED_BACKOFF' : 'FAILED',
      startedAtMs, finishedAtMs: Date.now(), error: state.lastError,
    };
    console.warn(`[Intel] 사이클 실패 (매매 루프 영향 없음)${isBudget ? ' [예산 초과 fail-closed]' : ''}: ${state.lastError}`);
  } finally {
    if (!timedOut) {                 // timeout 시에는 cyclePromise settle 후 해제 (위 finally)
      state.inFlight = false;
      state.currentCycleId = null;
    }
  }

  // outcome enrichment — horizon 경과 후보 별도 처리 (비치명, single-flight)
  try {
    if (!state.shutdownRequested && !state.enrichInFlight && nowMs - lastEnrichAtMs >= ENRICHMENT_MIN_INTERVAL_MS) {
      state.enrichInFlight = true;
      lastEnrichAtMs = nowMs;
      try {
        const summary = await enrichShadowOutcomes({
          fetchCandles: (symbol, timeframe, count) => getHandle().fetchers.fetchCandles(symbol, timeframe, count),
          nowMs,
          shouldAbort: () => state.shutdownRequested,   // stop 이후 잔여 write 차단
        });
        state.lastEnrichment = { ...summary, atMs: nowMs };
        if (summary.scanned > 0) {
          console.info(`[Intel] enrichment — scanned=${summary.scanned} enriched=${summary.enriched} 1h=${summary.enriched1h} ambiguous=${summary.ambiguous} incomplete=${summary.incomplete}`);
        }
      } finally {
        state.enrichInFlight = false;
      }
    }
  } catch (e) {
    console.warn(`[Intel] enrichment 실패: ${e instanceof Error ? e.message : 'unknown'}`);
  }
}

/** shutdown — 이후 신규 사이클/enrichment 진입 차단 (worker stop 시 호출) */
export function stopIntelService(): void {
  state.shutdownRequested = true;
}
export function resumeIntelService(): void {
  state.shutdownRequested = false;
}

export function getIntelServiceState(): Readonly<IntelServiceState> {
  return state;
}

/** §11 — 요청/캐시 계측 (저장된 관측치만, 외부 호출 0회) */
export function getIntelRuntimeStats() {
  const h = handle;
  return {
    dataSource: h ? { ...h.stats } : null,
    candleFetch: { ...getCandleFetchStats() },
  };
}

/** 테스트 전용 초기화 */
export function __resetIntelServiceForTests(): void {
  if (!(process.env.VITEST || process.env.NODE_ENV === 'test')) return;
  state.lastRecord = null; state.lastRecordStale = false; state.lastError = null; state.lastRunAtMs = null;
  state.cycleCount = 0; state.noTradeCycles = 0; state.lastEnrichment = null;
  state.inFlight = false; state.currentCycleId = null; state.skippedInFlight = 0;
  state.timeoutCount = 0; state.failedCount = 0; state.shutdownRequested = false;
  state.lastAttempt = null; state.lastWindowKey = null; state.enrichInFlight = false;
  lastEnrichAtMs = 0;
  handle = null;
}

/** 테스트 전용 — fetchers handle 주입 */
export function __setIntelHandleForTests(h: ProductionFetchersHandle | null): void {
  if (!(process.env.VITEST || process.env.NODE_ENV === 'test')) return;
  handle = h;
}
