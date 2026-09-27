/**
 * Read-only single-flight coordinator for Strategy Ensemble MTF candle frames.
 *
 * It owns no network client. The caller injects the existing Intel candle
 * fetcher, so cache hits, request budgets, 429 backoff and in-flight dedupe stay
 * authoritative in dataSource.ts. This adapter only coordinates one batch and
 * never queues a second, different cycle behind an active read.
 */
import {
  DEFAULT_CANDLE_FOUNDATION_CONFIG,
  STRATEGY_TIMEFRAMES,
  type CandleFrameInput,
  type StrategyTimeframe,
} from './candleFoundationV2';
import type { IntelFetchers } from './dataSource';

export const STRATEGY_SHADOW_MTF_COORDINATOR_VERSION =
  'strategy-shadow-mtf-coordinator/v1' as const;
export const STRATEGY_SHADOW_CANDLE_SOURCE = 'gmx-official-api' as const;

export interface StrategyShadowMtfReadRequest {
  cycleKey: string;
  symbols: string[];
  requestedAtMs: number;
}

export interface StrategyShadowMtfMissingSymbol {
  symbol: string;
  missingTimeframes: StrategyTimeframe[];
  reasons: string[];
}

export interface StrategyShadowMtfReadResult {
  schemaVersion: typeof STRATEGY_SHADOW_MTF_COORDINATOR_VERSION | 'INVALID';
  status: 'COMPLETE' | 'PARTIAL' | 'NOT_EVALUATED' | 'BUSY_DIFFERENT_CYCLE';
  cycleKey: string;
  startedAtMs: number;
  completedAtMs: number;
  framesBySymbol: Readonly<Record<string, Partial<Record<StrategyTimeframe, CandleFrameInput>>>>;
  missingSymbols: StrategyShadowMtfMissingSymbol[];
  joinedInFlight: boolean;
  queued: false;
  executionAuthorized: false;
  approvalCreationAllowed: false;
  paperPositionMutationAllowed: false;
  livePositionMutationAllowed: false;
  riskAuthority: 'NOT_EVALUATED';
}

export interface StrategyShadowMtfCoordinatorDeps {
  fetchCandles: IntelFetchers['fetchCandles'];
  nowMs?: () => number;
  concurrency?: number;
}

const normalizeSymbol = (value: string): string => value.trim().toUpperCase();
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function safetyResult(
  value: Omit<StrategyShadowMtfReadResult,
    'queued' | 'executionAuthorized' | 'approvalCreationAllowed'
    | 'paperPositionMutationAllowed' | 'livePositionMutationAllowed' | 'riskAuthority'>,
): StrategyShadowMtfReadResult {
  return {
    ...value,
    queued: false,
    executionAuthorized: false,
    approvalCreationAllowed: false,
    paperPositionMutationAllowed: false,
    livePositionMutationAllowed: false,
    riskAuthority: 'NOT_EVALUATED',
  };
}

export class StrategyShadowMtfFrameCoordinator {
  private readonly fetchCandles: IntelFetchers['fetchCandles'];
  private readonly nowMs: () => number;
  private readonly concurrency: number;
  private inFlight: {
    key: string;
    fingerprint: string;
    promise: Promise<StrategyShadowMtfReadResult>;
  } | null = null;

  constructor(deps: StrategyShadowMtfCoordinatorDeps) {
    this.fetchCandles = deps.fetchCandles;
    this.nowMs = deps.nowMs ?? Date.now;
    this.concurrency = Number.isInteger(deps.concurrency)
      && (deps.concurrency ?? 0) >= 1 && (deps.concurrency ?? 0) <= 8
      ? deps.concurrency as number
      : 3;
  }

  read(request: StrategyShadowMtfReadRequest): Promise<StrategyShadowMtfReadResult> {
    const validationAtMs = this.nowMs();
    const rawSymbols = Array.isArray(request.symbols) ? request.symbols : [];
    const symbols = rawSymbols
      .filter((symbol): symbol is string => typeof symbol === 'string' && symbol.trim().length > 0)
      .map(normalizeSymbol);
    const valid = typeof request.cycleKey === 'string' && request.cycleKey.trim().length > 0
      && finite(request.requestedAtMs) && request.requestedAtMs > 0
      && request.requestedAtMs <= validationAtMs + 5_000
      && symbols.length > 0
      && symbols.length === rawSymbols.length
      && new Set(symbols).size === symbols.length;
    if (!valid) {
      const at = validationAtMs;
      return Promise.resolve(safetyResult({
        schemaVersion: 'INVALID',
        status: 'NOT_EVALUATED',
        cycleKey: typeof request.cycleKey === 'string' ? request.cycleKey : '',
        startedAtMs: at,
        completedAtMs: at,
        framesBySymbol: {},
        missingSymbols: symbols.map(symbol => ({
          symbol,
          missingTimeframes: [...STRATEGY_TIMEFRAMES],
          reasons: ['MTF coordinator 요청 INVALID — fail-closed'],
        })),
        joinedInFlight: false,
      }));
    }

    const fingerprint = `${request.cycleKey}:${symbols.join(',')}`;
    if (this.inFlight) {
      if (this.inFlight.fingerprint === fingerprint) {
        return this.inFlight.promise.then(result => ({ ...result, joinedInFlight: true }));
      }
      const at = this.nowMs();
      return Promise.resolve(safetyResult({
        schemaVersion: STRATEGY_SHADOW_MTF_COORDINATOR_VERSION,
        status: 'BUSY_DIFFERENT_CYCLE',
        cycleKey: request.cycleKey,
        startedAtMs: at,
        completedAtMs: at,
        framesBySymbol: {},
        missingSymbols: symbols.map(symbol => ({
          symbol,
          missingTimeframes: [...STRATEGY_TIMEFRAMES],
          reasons: [`다른 MTF cycle ${this.inFlight!.key} 진행 중 — 미제출/큐 생성 없음`],
        })),
        joinedInFlight: false,
      }));
    }

    const promise = this.perform(request.cycleKey, symbols);
    this.inFlight = { key: request.cycleKey, fingerprint, promise };
    void promise.finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });
    return promise;
  }

  private async perform(cycleKey: string, symbols: string[]): Promise<StrategyShadowMtfReadResult> {
    const startedAtMs = this.nowMs();
    const framesBySymbol: Record<string, Partial<Record<StrategyTimeframe, CandleFrameInput>>> = {};
    const failures = new Map<string, StrategyShadowMtfMissingSymbol>();
    for (const symbol of symbols) framesBySymbol[symbol] = {};

    const requests = symbols.flatMap(symbol =>
      STRATEGY_TIMEFRAMES.map(timeframe => ({ symbol, timeframe })));
    await mapBounded(requests, this.concurrency, async ({ symbol, timeframe }) => {
      const expectedCount = DEFAULT_CANDLE_FOUNDATION_CONFIG.frames[timeframe].expectedCount;
      try {
        const candles = await this.fetchCandles(symbol, timeframe, expectedCount);
        if (!candles || candles.length === 0) {
          const entry = failures.get(symbol) ?? { symbol, missingTimeframes: [], reasons: [] };
          entry.missingTimeframes.push(timeframe);
          entry.reasons.push(`${timeframe} candle evidence 없음`);
          failures.set(symbol, entry);
          return;
        }
        framesBySymbol[symbol][timeframe] = {
          symbol,
          timeframe,
          source: STRATEGY_SHADOW_CANDLE_SOURCE,
          fetchedAtMs: this.nowMs(),
          candles,
        };
      } catch (error) {
        const entry = failures.get(symbol) ?? { symbol, missingTimeframes: [], reasons: [] };
        entry.missingTimeframes.push(timeframe);
        entry.reasons.push(`${timeframe} read 실패: ${error instanceof Error ? error.name : 'unknown'}`);
        failures.set(symbol, entry);
      }
    });

    const completedAtMs = this.nowMs();
    const missingSymbols = symbols
      .filter(symbol => failures.has(symbol))
      .map(symbol => failures.get(symbol)!);
    const completeSymbols = symbols.length - missingSymbols.length;
    return safetyResult({
      schemaVersion: STRATEGY_SHADOW_MTF_COORDINATOR_VERSION,
      status: completeSymbols === symbols.length ? 'COMPLETE'
        : completeSymbols === 0 ? 'NOT_EVALUATED' : 'PARTIAL',
      cycleKey,
      startedAtMs,
      completedAtMs,
      framesBySymbol,
      missingSymbols,
      joinedInFlight: false,
    });
  }
}
