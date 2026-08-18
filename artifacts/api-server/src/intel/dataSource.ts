/**
 * 6I-1 §3·§4 + 6I-2 §4·§6 — 런타임 데이터 소스 (read-only, cache·예산·계측).
 *  - 조회 실패 = UNAVAILABLE (0 대체·이전 값 위장 금지)
 *  - 모든 fetcher는 주입 가능 — 테스트는 전부 mock (외부 호출 0회)
 *  - candle cache: 해당 timeframe의 새 candle이 닫힌 뒤에만 재요청 (닫히기 전 재요청 0회)
 *  - 동일 (symbol,timeframe) in-flight dedupe · cycle당 요청 예산 · 429 backoff
 *  - 1e30 수치는 usd30.ts BigInt 경로로만 변환 (Number 조기 변환 금지)
 */
import { Candle, Timeframe, TIMEFRAME_MS } from './types';
import { RawMarketRow } from './universe';
import { usd30SumToNumber, rate30PerSecToPerHour } from './usd30';

export interface IntelFetchers {
  /** 공식 GMX markets 목록 + 유동성/OI 지표 (실패=null) */
  fetchMarketRows(nowMs: number): Promise<{ rows: RawMarketRow[]; complete: boolean; failureReason: string | null }>;
  /** 검증 전 원시 캔들 (실패=null — 합성 생성 금지) */
  fetchCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[] | null>;
  /** 현재가 (oracle ticker) */
  fetchPrice(symbol: string): Promise<{ price: number; observedAtMs: number } | null>;
  /** 24h 변화율 (%) */
  fetch24hChange(symbol: string): Promise<number | null>;
  /** funding/borrowing (시간당 비율) — 실측 없으면 null */
  fetchFundingBorrowing(marketAddress: string): Promise<{ fundingPerHour: number; borrowingPerHour: number; observedAtMs: number } | null>;
}

/** bounded concurrency 실행기 */
export async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** stats API prices[][] → Candle[] (t: 초→ms) */
export function pricesToCandles(prices: number[][]): Candle[] {
  return prices.map(p => ({
    t: p[0] * 1000, o: p[1], h: p[2], l: p[3], c: p[4],
    v: p.length > 5 && typeof p[5] === 'number' && Number.isFinite(p[5]) ? p[5] : null,
  }));
}

const GMX_API = 'https://arbitrum-api.gmxinfra.io';

/** markets/info 캐시 TTL — 경량 universe scan은 수분 단위면 충분 */
export const MARKETS_CACHE_TTL_MS = 4 * 60_000;
/** funding/borrowing 캐시 TTL */
export const RATES_CACHE_TTL_MS = 5 * 60_000;
/** cycle당 candle 요청 예산 — 초과 시 fail-closed (요청 폭주 방지) */
export const CYCLE_CANDLE_REQUEST_BUDGET = 40;
/** 429 이후 backoff — 이 시간 동안 신규 외부 candle 요청 차단 */
export const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

export interface DataSourceStats {
  candleRequests: number;         // 실제 외부 요청 수 (누적)
  candleCacheHits: number;
  candleCacheMisses: number;
  candleDeduped: number;          // in-flight dedupe로 흡수된 요청
  marketsRequests: number;
  marketsCacheHits: number;
  budgetExceededCount: number;
  backoffSkips: number;
  lastCycleCandleRequests: number;
}

/** 예산 초과를 사이클에 알리는 전용 오류 */
export class RequestBudgetExceededError extends Error {
  constructor(budget: number) { super(`cycle candle 요청 예산 초과 (${budget}) — fail-closed`); this.name = 'RequestBudgetExceededError'; }
}
export class RateLimitBackoffError extends Error {
  constructor() { super('429 backoff 중 — 외부 candle 요청 차단 (fail-closed)'); this.name = 'RateLimitBackoffError'; }
}

export interface ProductionFetchersHandle {
  fetchers: IntelFetchers;
  stats: Readonly<DataSourceStats>;
  /** 사이클 시작 시 호출 — cycle 예산 카운터 리셋 */
  beginCycle(): void;
  /** 429 관측 통지 (gmx.ts 계측과 연동) */
  noteRateLimited(atMs: number): void;
}

interface CandleCacheEntry {
  candles: Candle[];
  /** 마지막 폐쇄 캔들 open time (ms) — source timestamp */
  sourceLastOpenMs: number;
  fetchedAtMs: number;
  count: number;
}

/**
 * 프로덕션 fetcher 구현 — 전부 read-only.
 * 반환된 handle의 stats/beginCycle로 요청 예산·계측을 관리한다.
 */
export function createProductionFetchers(deps: {
  getCachedPrices: () => { tokenSymbol: string; priceUsd: number; updatedAt?: number }[] | null;
  getCachedChange24h: () => Record<string, number> | null;
  fetchGmxCandles: (symbol: string, period: string, countBack: number) => Promise<{ prices: number[][] } | null>;
  /** gmx.ts candle 계측의 last429AtMs — candle 429를 backoff에 연결 (미제공 시 미연동) */
  getLast429AtMs?: () => number | null;
  nowFn?: () => number;
}): ProductionFetchersHandle {
  const now = deps.nowFn ?? Date.now;
  let marketRowsCache: { at: number; value: { rows: RawMarketRow[]; complete: boolean; failureReason: string | null } } | null = null;
  let ratesCache: { at: number; value: Map<string, { fundingPerHour: number; borrowingPerHour: number }> } | null = null;
  const candleCache = new Map<string, CandleCacheEntry>();
  const inFlight = new Map<string, Promise<Candle[] | null>>();
  let cycleCandleRequests = 0;
  let backoffUntilMs = 0;

  const stats: DataSourceStats = {
    candleRequests: 0, candleCacheHits: 0, candleCacheMisses: 0, candleDeduped: 0,
    marketsRequests: 0, marketsCacheHits: 0, budgetExceededCount: 0, backoffSkips: 0,
    lastCycleCandleRequests: 0,
  };

  async function fetchCandlesCached(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[] | null> {
    const key = `${symbol}:${timeframe}`;
    const step = TIMEFRAME_MS[timeframe];
    const nowMs = now();
    const cached = candleCache.get(key);
    // 새 candle이 닫히기 전엔 재요청 금지: 다음 close = sourceLastOpen + 2*step
    // (마지막 폐쇄 캔들 open + step = 그 close, +step = 다음 캔들 close)
    if (cached && cached.count >= count && nowMs < cached.sourceLastOpenMs + 2 * step) {
      stats.candleCacheHits++;
      return cached.candles;
    }
    stats.candleCacheMisses++;
    // in-flight dedupe — 동일 key 동시 요청은 1회로 병합
    const existing = inFlight.get(key);
    if (existing) { stats.candleDeduped++; return existing; }
    // 429 backoff — 신규 외부 요청 차단 (stale cache는 반환하지 않음: 실행 판단에 사용 금지)
    if (nowMs < backoffUntilMs) { stats.backoffSkips++; throw new RateLimitBackoffError(); }
    // cycle 요청 예산
    if (cycleCandleRequests >= CYCLE_CANDLE_REQUEST_BUDGET) {
      stats.budgetExceededCount++;
      throw new RequestBudgetExceededError(CYCLE_CANDLE_REQUEST_BUDGET);
    }
    cycleCandleRequests++;
    stats.candleRequests++;
    const p = (async () => {
      // candle 429는 fetchGmxCandles가 null로 소거하므로 계측(last429AtMs) 전후 비교로 감지
      const before429 = deps.getLast429AtMs?.() ?? null;
      const r = await deps.fetchGmxCandles(symbol, timeframe, count);
      const after429 = deps.getLast429AtMs?.() ?? null;
      if (after429 !== null && after429 !== before429) {
        backoffUntilMs = Math.max(backoffUntilMs, after429 + RATE_LIMIT_BACKOFF_MS);
      }
      if (!r) return null;
      const all = pricesToCandles(r.prices);
      // 진행 중(미폐쇄) 캔들 제외 — close time(t+step) > now인 캔들은 판단 입력 금지
      const closed = all.filter(c => c.t + step <= now());
      if (closed.length === 0) return null;
      candleCache.set(key, {
        candles: closed,
        sourceLastOpenMs: closed[closed.length - 1].t,
        fetchedAtMs: now(),
        count,
      });
      return closed;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  const fetchers: IntelFetchers = {
    async fetchMarketRows(nowMs) {
      if (marketRowsCache && nowMs - marketRowsCache.at < MARKETS_CACHE_TTL_MS) {
        stats.marketsCacheHits++;
        return marketRowsCache.value;
      }
      try {
        stats.marketsRequests++;
        // /markets/info — 유동성·OI·funding/borrowing 실측 포함 (전부 1e30 스케일 문자열)
        const r = await fetch(`${GMX_API}/markets/info`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (!r.ok) {
          if (r.status === 429) backoffUntilMs = now() + RATE_LIMIT_BACKOFF_MS;
          throw new Error(`HTTP ${r.status}`);
        }
        const data = await r.json() as { markets?: Record<string, unknown>[] } | Record<string, unknown>[];
        const list = Array.isArray(data) ? data : (data.markets ?? []);
        const ticks = deps.getCachedPrices();
        const rates = new Map<string, { fundingPerHour: number; borrowingPerHour: number }>();
        const rows: RawMarketRow[] = list.map(m => {
          const symbolRaw = (m['indexTokenSymbol'] ?? m['name'] ?? '') as string;
          const symbol = String(symbolRaw).split('/')[0].trim();
          const tick = ticks?.find(t => t.tokenSymbol === symbol) ?? null;
          const marketToken = String(m['marketToken'] ?? '');
          // 1e30 문자열 → BigInt 합산 → 1회 변환 (usd30.ts). 실패=null (0 위장 금지)
          const liquidityUsd = usd30SumToNumber(m['availableLiquidityLong'], m['availableLiquidityShort']);
          const openInterestUsd = usd30SumToNumber(m['openInterestLong'], m['openInterestShort']);
          // funding/borrowing: per-second 1e30 → 시간당. 파싱 실패=미기록(UNAVAILABLE)
          const f = rate30PerSecToPerHour(m['fundingRateLong']);
          const b = rate30PerSecToPerHour(m['borrowingRateLong']);
          if (f !== null && b !== null) {
            rates.set(marketToken.toLowerCase(), { fundingPerHour: f, borrowingPerHour: b });
          }
          return {
            marketToken,
            indexToken: typeof m['indexToken'] === 'string' ? m['indexToken'] as string : null,
            symbol,
            isListed: m['isListed'] !== false,
            isDisabled: m['isDisabled'] === true,
            liquidityUsd,
            openInterestUsd,
            lastPriceAtMs: tick ? (tick.updatedAt ?? nowMs) : null,
            impactDataAvailable: tick !== null,
          };
        });
        ratesCache = { at: nowMs, value: rates };
        const value = { rows, complete: true, failureReason: null };
        marketRowsCache = { at: nowMs, value };
        return value;
      } catch (e) {
        return { rows: [], complete: false, failureReason: `markets 조회 실패: ${e instanceof Error ? e.message : 'unknown'}` };
      }
    },

    fetchCandles: fetchCandlesCached,

    async fetchPrice(symbol) {
      const ticks = deps.getCachedPrices();
      const t = ticks?.find(x => x.tokenSymbol === symbol);
      if (!t || !Number.isFinite(t.priceUsd) || t.priceUsd <= 0) return null;
      return { price: t.priceUsd, observedAtMs: t.updatedAt ?? now() };
    },

    async fetch24hChange(symbol) {
      const map = deps.getCachedChange24h();
      const v = map?.[symbol];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    },

    async fetchFundingBorrowing(marketAddress) {
      // /markets/info에서 실측 캐시 (fetchMarketRows가 채움). 만료/부재=UNAVAILABLE (0 위장 금지).
      if (!ratesCache || now() - ratesCache.at > RATES_CACHE_TTL_MS) return null;
      const r = ratesCache.value.get(marketAddress.toLowerCase());
      if (!r) return null;
      return { fundingPerHour: r.fundingPerHour, borrowingPerHour: r.borrowingPerHour, observedAtMs: ratesCache.at };
    },
  };

  return {
    fetchers,
    stats,
    beginCycle() {
      stats.lastCycleCandleRequests = cycleCandleRequests;
      cycleCandleRequests = 0;
    },
    noteRateLimited(atMs) { backoffUntilMs = atMs + RATE_LIMIT_BACKOFF_MS; },
  };
}
