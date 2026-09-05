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
import { persistIntelCycle, getCompletedSampleCount, enrichShadowOutcomes, EnrichmentSummary, getCalibrationBucketStats } from './shadowStore';
import { RankingGates } from './ranking';
import { getCachedPrices, getCachedChange24h, fetchGmxCandles, getCandleFetchStats } from '../routes/gmx';
import { calibrateBuckets, BucketCalibration } from './calibration';
import { buildCandidateCostBreakdown } from './costEngine';
import {
  clearPaperEconomicEdgeEvidence,
  setPaperEconomicEdgeEvidenceFromIntelCycle,
} from '../lib/paperRuntimeReadiness';
import { lookupSdkIndexToken, ARBITRUM_CHAIN_ID } from '../lib/indexTokenDecimals';
import { createGmxCostReader, createProductionCostReaderClient, GmxCostReader } from './gmxCostReader';
import type { CostBreakdownUsd } from './candidate';
import { StrategyShadowMtfFrameCoordinator } from './strategyShadowMtfFrameCoordinatorV2';
import {
  buildStrategyShadowWorkerBatch,
  type StrategyShadowCostPair,
} from './strategyShadowWorkerBatchV2';
import {
  buildStrategyShadowWorkerEnvelope,
  type ExistingWorkerAiSummary,
  type StrategyShadowWorkerEnvelope,
} from './strategyShadowWorkerEnvelopeV2';
import {
  buildSignalLifecycleSnapshot,
  restoreSignalLifecycleSnapshot,
} from './signalLifecycleSnapshotV2';

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
  /** MTF SHADOW external read ownership; Intel refreshes join by skipping, never reset the shared budget. */
  shadowReadInFlight: boolean;
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
  inFlight: false, shadowReadInFlight: false, currentCycleId: null, skippedInFlight: 0,
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

let strategyShadowMtfCoordinator: StrategyShadowMtfFrameCoordinator | null = null;

let costReader: GmxCostReader | null = null;
function getCostReader(): GmxCostReader {
  costReader ??= createGmxCostReader({ client: createProductionCostReaderClient() });
  return costReader;
}

/**
 * 6I-3 — regime×방향 bucket 보정 조회 (DB 집계 → db-free 판정).
 * 조회 실패 = null (전 bucket 미보정 취급, 전역 표본 대체 금지).
 */
async function loadCalibrationBuckets(nowMs: number): Promise<Map<string, BucketCalibration> | null> {
  try {
    const raws = await getCalibrationBucketStats();
    return calibrateBuckets(raws, nowMs);
  } catch (e) {
    console.warn(`[Intel] bucket 보정 조회 실패 — 전 bucket 미보정 취급: ${e instanceof Error ? e.message : 'unknown'}`);
    return null;
  }
}

/**
 * 6I-3 — 후보별 실측 비용 (시장·방향·명목 결속). 성분 확보 실패 = null 유지 (fail-closed).
 */
async function buildCandidateCost(args: { marketToken: string; symbol: string; isLong: boolean; notionalUsd: number; holdingHours: number }): Promise<CostBreakdownUsd | null> {
  const nowMs = Date.now();
  const h = getHandle();
  const [feeParams, rates, ethTick, impactInputs, indexTick] = await Promise.all([
    getCostReader().readMarketFeeParams(args.marketToken, nowMs),
    h.fetchers.fetchMarketCostInputs ? h.fetchers.fetchMarketCostInputs(args.marketToken) : Promise.resolve(null),
    h.fetchers.fetchPrice('ETH'),
    h.fetchers.fetchMarketImpactInputs ? h.fetchers.fetchMarketImpactInputs(args.marketToken) : Promise.resolve(null),
    h.fetchers.fetchPrice(args.symbol),
  ]);
  // 6I-5 — index token 결속: SDK registry (조회 전용, 외부 호출 0회). 실패 = impact null.
  const sdkIdx = lookupSdkIndexToken(ARBITRUM_CHAIN_ID, args.marketToken);
  return buildCandidateCostBreakdown({
    marketToken: args.marketToken,
    isLong: args.isLong,
    notionalUsd: args.notionalUsd,
    holdingHours: args.holdingHours,
    feeParams,
    rates,
    ethPriceUsd: ethTick?.price ?? null,
    ethPriceObservedAtMs: ethTick?.observedAtMs ?? null,   // freshness=min 결속 (stale 은폐 방지)
    impact: {
      inputs: impactInputs,
      indexTokenDecimals: sdkIdx.ok ? sdkIdx.sdkDecimals : null,
      sdkIndexTokenAddress: sdkIdx.ok ? sdkIdx.indexTokenAddress : null,
      indexPriceUsd: indexTick?.price ?? null,
      indexPriceObservedAtMs: indexTick?.observedAtMs ?? null,
    },
    nowMs,
  });
}


/** intel 사이클 최소 간격 — 매매 사이클(60s)보다 낮은 빈도 (외부 조회 절약) */
export const INTEL_CYCLE_MIN_INTERVAL_MS = 5 * 60_000;
/** enrichment 실행 간격 */
export const ENRICHMENT_MIN_INTERVAL_MS = 15 * 60_000;
/** cycle 전체 timeout — 초과 시 TIMEOUT 기록 + 결과 폐기 */
export const INTEL_CYCLE_TIMEOUT_MS = 90_000;
let lastEnrichAtMs = 0;
let lifecycleGeneration = 0;

/** 결정적 cycle window key — 같은 5분 창은 프로세스 재시작 후에도 같은 키 */
export function computeCycleWindowKey(nowMs: number): number {
  return Math.floor(nowMs / INTEL_CYCLE_MIN_INTERVAL_MS);
}
export function cycleIdForWindow(windowKey: number): string {
  return `w${windowKey}`;
}

export interface StrategyShadowWorkerReadOnlyInput {
  cycleNumber: number;
  evaluatedAt: number;
  expectedSymbols: string[];
  existingAi: ExistingWorkerAiSummary;
  lifecycleSnapshot?: import('./signalLifecycleSnapshotV2').SignalLifecycleSnapshotV2 | null;
  /** Caller-supplied, direction-bound read-only evidence. Missing pairs remain NOT_EVALUATED. */
  costsBySymbol?: Readonly<Record<string, StrategyShadowCostPair | null>>;
}

function buildNotEvaluatedStrategyShadowEnvelope(
  input: StrategyShadowWorkerReadOnlyInput,
  reason: string,
): StrategyShadowWorkerEnvelope {
  return buildStrategyShadowWorkerEnvelope({
    cycleNumber: input.cycleNumber,
    generatedAt: input.evaluatedAt,
    expectedSymbols: input.expectedSymbols,
    records: [],
    existingAi: input.existingAi,
    lifecycleSnapshot: input.lifecycleSnapshot,
    notEvaluatedReason: reason,
  });
}

/**
 * Existing Intel cache/budget/backoff를 재사용하는 주문 없는 Worker SHADOW read.
 * 동일 cycle은 coordinator single-flight에 합류하고, 다른 cycle은 큐 없이 차단한다.
 * 어떤 결과도 Risk/approval/PAPER/LIVE 권한을 부여하지 않는다.
 */
export async function runStrategyShadowWorkerReadOnly(
  input: StrategyShadowWorkerReadOnlyInput,
): Promise<StrategyShadowWorkerEnvelope> {
  let ownsRead = false;
  try {
    const restoredLifecycle = input.lifecycleSnapshot === undefined || input.lifecycleSnapshot === null
      ? null : restoreSignalLifecycleSnapshot(input.lifecycleSnapshot, input.evaluatedAt);
    const lifecycle = restoredLifecycle === null
      ? buildSignalLifecycleSnapshot([], [], input.evaluatedAt)
      : restoredLifecycle.ok ? restoredLifecycle.snapshot : null;
    if (!lifecycle) {
      return buildNotEvaluatedStrategyShadowEnvelope(input,
        'SHADOW lifecycle snapshot 복원 실패 — fail-closed');
    }
    if (state.shutdownRequested) {
      return buildNotEvaluatedStrategyShadowEnvelope(input,
        'Intel shutdown 중 — MTF SHADOW external read 미제출');
    }
    if (state.inFlight) {
      return buildNotEvaluatedStrategyShadowEnvelope(input,
        'Intel refresh external read 진행 중 — 합류 불가·큐 생성 없음');
    }

    const h = getHandle();
    strategyShadowMtfCoordinator ??= new StrategyShadowMtfFrameCoordinator({
      fetchCandles: h.fetchers.fetchCandles,
      concurrency: 8,
    });

    if (!state.shadowReadInFlight) {
      state.shadowReadInFlight = true;
      ownsRead = true;
      // external read 소유권을 확보한 뒤에만 shared request budget을 reset한다.
      h.beginCycle();
    }

    const read = await strategyShadowMtfCoordinator.read({
      cycleKey: `worker-${input.cycleNumber}`,
      symbols: input.expectedSymbols,
      requestedAtMs: input.evaluatedAt,
    });
    if (read.schemaVersion === 'INVALID' || read.status === 'BUSY_DIFFERENT_CYCLE') {
      return buildNotEvaluatedStrategyShadowEnvelope(input,
        read.status === 'BUSY_DIFFERENT_CYCLE'
          ? '다른 MTF SHADOW cycle 진행 중 — 미제출/큐 생성 없음'
          : 'MTF SHADOW coordinator 입력 INVALID — fail-closed');
    }

    return buildStrategyShadowWorkerBatch({
      cycleNumber: input.cycleNumber,
      evaluatedAt: input.evaluatedAt,
      expectedSymbols: input.expectedSymbols,
      framesBySymbol: read.framesBySymbol,
      costsBySymbol: input.costsBySymbol ?? {},
      previousRegimes: {},
      lifecycleRecords: lifecycle.records,
      historyEvents: lifecycle.historyEvents,
      existingAi: input.existingAi,
    }).envelope;
  } catch (error) {
    return buildNotEvaluatedStrategyShadowEnvelope(input,
      `MTF SHADOW read 실패(${error instanceof Error ? error.name : 'unknown'}) — fail-closed`);
  } finally {
    if (ownsRead) state.shadowReadInFlight = false;
  }
}

/**
 * worker 사이클에서 호출 — 간격 미달/재진입/shutdown이면 skip.
 * 어떤 예외도 밖으로 던지지 않는다 (기존 매매 루프 보호).
 */
export async function runIntelServiceCycle(input: {
  cycleNum: number;
  gates: RankingGates;
  shouldContinue?: () => boolean;
}): Promise<void> {
  const nowMs = input.gates.nowMs;
  const windowKey = computeCycleWindowKey(nowMs);
  const cycleId = cycleIdForWindow(windowKey);
  const capturedGeneration = lifecycleGeneration;
  const shouldContinue = () =>
    capturedGeneration === lifecycleGeneration
    && !state.shutdownRequested
    && (input.shouldContinue?.() ?? true);

  // shutdown — 신규 진입 차단
  if (!shouldContinue()) {
    state.lastAttempt = { cycleId, windowKey, status: 'SKIPPED_SHUTDOWN', startedAtMs: nowMs, finishedAtMs: nowMs, error: null };
    return;
  }
  // single-flight — Intel/Worker SHADOW external read 중 재진입 즉시 skip
  if (state.inFlight || state.shadowReadInFlight) {
    state.skippedInFlight++;
    state.lastAttempt = { cycleId, windowKey, status: 'SKIPPED_IN_FLIGHT', startedAtMs: nowMs, finishedAtMs: nowMs, error: null };
    return;
  }
  // 같은 관측 시간창 재실행 방지 (재시작 시에는 DB cycle_id unique가 최종 방어)
  if (state.lastWindowKey === windowKey || (state.lastRunAtMs !== null && nowMs - state.lastRunAtMs < INTEL_CYCLE_MIN_INTERVAL_MS)) {
    return;
  }

  state.inFlight = true;
  // An edge is valid only for an accepted current Intel cycle; never display a
  // previous cycle while this one can fail, time out, or be lifecycle-cancelled.
  clearPaperEconomicEdgeEvidence();
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
      if (!shouldContinue()) throw new Error('lifecycle 종료 이후 persist 차단');
      await persistIntelCycle(record, { status: record.decision === 'BLOCKED' ? 'BLOCKED' : 'SUCCESS', startedAtMs, finishedAtMs: Date.now() });
      if (!shouldContinue()) throw new Error('lifecycle 종료 이후 persist 후속 처리 차단');
    };

    const cyclePromise = runIntelCycle({
      fetchers: h.fetchers,
      getCompletedSampleCount,
      getCalibrationBuckets: loadCalibrationBuckets,
      buildCandidateCost,
      persist: gatedPersist,
      gates: input.gates,
      nowMs,
      cycleId,
    });
    const record = await Promise.race([
      cyclePromise,
      new Promise<'TIMEOUT'>(resolve => setTimeout(() => resolve('TIMEOUT'), INTEL_CYCLE_TIMEOUT_MS).unref?.()),
    ]);
    if (!shouldContinue()) return;

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
        if (state.currentCycleId === cycleId) {
          state.inFlight = false;
          state.currentCycleId = null;
        }
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
        clearPaperEconomicEdgeEvidence();
        console.warn(`[Intel] 사이클 ${record.cycleId} BLOCKED — ${record.blockedReason}`);
      } else {
        setPaperEconomicEdgeEvidenceFromIntelCycle({
          cycleId: record.cycleId,
          recordNowMs: record.nowMs,
          generation: capturedGeneration + 1,
          decision: record.decision,
          candidates: record.candidates,
        });
        console.info(`[Intel] 사이클 ${record.cycleId} — universe=${record.universeCount} shortlist=${record.shortlistCount} 결정=${record.decision} (candle req=${h.stats.candleRequests} cacheHit=${h.stats.candleCacheHits})`);
      }
    } else {
      // runIntelCycle 내부 lock에 걸림 (정상적으론 도달 불가 — single-flight가 먼저 차단)
      state.lastAttempt = { cycleId, windowKey, status: 'SKIPPED_IN_FLIGHT', startedAtMs, finishedAtMs: Date.now(), error: null };
    }
  } catch (e) {
    clearPaperEconomicEdgeEvidence();
    if (!shouldContinue()) return;
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
    if (!timedOut && state.currentCycleId === cycleId) {
      // timeout 시에는 cyclePromise settle 후 해제 (위 finally)
      state.inFlight = false;
      state.currentCycleId = null;
    }
  }

  // outcome enrichment — horizon 경과 후보 별도 처리 (비치명, single-flight)
  try {
    if (shouldContinue() && !state.enrichInFlight && nowMs - lastEnrichAtMs >= ENRICHMENT_MIN_INTERVAL_MS) {
      state.enrichInFlight = true;
      lastEnrichAtMs = nowMs;
      try {
        const summary = await enrichShadowOutcomes({
          fetchCandles: (symbol, timeframe, count) => getHandle().fetchers.fetchCandles(symbol, timeframe, count),
          nowMs,
          shouldAbort: () => !shouldContinue(),
        });
        if (!shouldContinue()) return;
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
  lifecycleGeneration += 1;
  state.shutdownRequested = true;
  clearPaperEconomicEdgeEvidence();
}
export function resumeIntelService(): void {
  lifecycleGeneration += 1;
  state.shutdownRequested = false;
  clearPaperEconomicEdgeEvidence();
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
  lifecycleGeneration += 1;
  state.lastRecord = null; state.lastRecordStale = false; state.lastError = null; state.lastRunAtMs = null;
  state.cycleCount = 0; state.noTradeCycles = 0; state.lastEnrichment = null;
  state.inFlight = false; state.shadowReadInFlight = false; state.currentCycleId = null; state.skippedInFlight = 0;
  state.timeoutCount = 0; state.failedCount = 0; state.shutdownRequested = false;
  state.lastAttempt = null; state.lastWindowKey = null; state.enrichInFlight = false;
  lastEnrichAtMs = 0;
  handle = null;
  strategyShadowMtfCoordinator = null;
  costReader = null;
  clearPaperEconomicEdgeEvidence();
}

/** 테스트 전용 — cost reader 주입 */
export function __setIntelCostReaderForTests(r: GmxCostReader | null): void {
  if (!(process.env.VITEST || process.env.NODE_ENV === 'test')) return;
  costReader = r;
}

/** 테스트 전용 — fetchers handle 주입 */
export function __setIntelHandleForTests(h: ProductionFetchersHandle | null): void {
  if (!(process.env.VITEST || process.env.NODE_ENV === 'test')) return;
  handle = h;
}
