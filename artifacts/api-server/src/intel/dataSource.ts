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
import { usd30SumToNumber, rate30PerHourToNumber, rate30PerSecToPerHour, parseBigIntStr } from './usd30';
import type { MarketRateInputs } from './costEngine';
import { parseMarketsImpactInfo, IMPACT_SOURCE_PIN, type ImpactMarketInputs } from './impactEngine';

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
  /**
   * 6I-3 — 비용 산정용 per-side rate + OI(1e30 BigInt) 실측 (markets/info 캐시).
   * 부분 파싱 실패/만료 = null (부분 데이터 위장 금지). 미구현 fetcher = 비용 UNAVAILABLE.
   */
  fetchMarketCostInputs?(marketAddress: string): Promise<MarketRateInputs | null>;
  /**
   * 6I-5 — 공식 /v1/markets/info impact 입력 (OI·factor·exponent·VI·pool·cap, 전부 BigInt).
   * 부분 파싱 실패/만료 = null (부분 데이터 위장 금지). read-only GET 전용.
   */
  fetchMarketImpactInputs?(marketAddress: string): Promise<ImpactMarketInputs | null>;
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

/**
 * 6I-4 — 비용 입력 공식 소스 pin.
 * @gmx-io/sdk@1.7.0 configs/api.ts API_URLS.production[ARBITRUM] = https://arbitrum.gmxapi.io,
 * utils/markets/api.ts fetchApiMarketsTickers = GET /v1/markets/tickers → MarketTicker.
 * 단위 계약 (SDK utils/markets/utils.ts getMarketTicker 실측):
 *  - fundingRateLong/Short  = getFundingFactorPerPeriod(marketInfo, isLong, 3600) — per-HOUR, 1e30,
 *    부호: 음수=해당 사이드 지불, 양수=수취
 *  - borrowingRateLong/Short = factorPerSecond×3600 — per-HOUR, 1e30, 항상 ≥0 (비용)
 *  - longInterestUsd/shortInterestUsd = 1e30 USD
 * legacy gmxinfra /markets/info 의 rate 필드는 이 계약과 불일치(부호·스케일 상이 실측 확인) —
 * 비용 입력으로 사용 금지.
 */
export const GMX_OFFICIAL_API = 'https://arbitrum.gmxapi.io';
export const COST_TICKERS_PATH = '/v1/markets/tickers';
export const COST_SOURCE_PIN =
  'arbitrum.gmxapi.io/v1/markets/tickers@sdk1.7.0(MarketTicker per-hour 1e30, 음수=지불)';
/** 6I-5 — 공식 impact 입력 endpoint (SDK fetchApiMarketsInfo와 동일) */
export const IMPACT_INFO_PATH = '/v1/markets/info';

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
  /** 6I-4 — 공식 tickers 비용 입력 계측 */
  tickersRequests: number;
  tickersCacheHits: number;
  tickersSchemaRejects: number;   // 스키마/단위 계약 위반으로 버린 record 수 (누적)
  /** 6I-5 — 공식 /v1/markets/info impact 입력 계측 */
  impactInfoRequests: number;
  impactInfoCacheHits: number;
  impactInfoSchemaRejects: number;
}

/**
 * 6I-4 — /v1/markets/tickers 응답 record → 비용 입력 파서 (순수 함수, 테스트 대상).
 * 계약 위반(필드 누락·정수 문자열 아님·|rate/h|≥1·borrowing<0·OI<0·주소 비정상)은
 * 해당 record 폐기 (rejects에 사유 집계). 부분 채택·근사·clamp 금지.
 */
export function parseMarketsTickers(raw: unknown): {
  entries: Map<string, Omit<MarketRateInputs, 'observedAtMs' | 'sourcePin'>>;
  rejects: { count: number; reasons: string[] };
} {
  const entries = new Map<string, Omit<MarketRateInputs, 'observedAtMs' | 'sourcePin'>>();
  const reasons: string[] = [];
  let count = 0;
  const reject = (why: string) => { count++; if (reasons.length < 8) reasons.push(why); };
  if (!Array.isArray(raw)) return { entries, rejects: { count: 1, reasons: ['응답이 배열이 아님'] } };
  for (const rec of raw) {
    if (rec === null || typeof rec !== 'object') { reject('record가 객체 아님'); continue; }
    const m = rec as Record<string, unknown>;
    const addr = typeof m['marketTokenAddress'] === 'string' ? m['marketTokenAddress'] : '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { reject('marketTokenAddress 비정상'); continue; }
    const fL = rate30PerHourToNumber(m['fundingRateLong']);
    const fS = rate30PerHourToNumber(m['fundingRateShort']);
    const bL = rate30PerHourToNumber(m['borrowingRateLong']);
    const bS = rate30PerHourToNumber(m['borrowingRateShort']);
    if (fL === null || fS === null || bL === null || bS === null) { reject(`${addr}: rate 파싱/단위 계약 위반`); continue; }
    if (bL < 0 || bS < 0) { reject(`${addr}: borrowing 음수 (계약 위반)`); continue; }
    const oiL = parseBigIntStr(m['longInterestUsd']);
    const oiS = parseBigIntStr(m['shortInterestUsd']);
    if (oiL === null || oiS === null || oiL < 0n || oiS < 0n) { reject(`${addr}: OI 파싱 실패/음수`); continue; }
    entries.set(addr.toLowerCase(), {
      fundingLongPerHour: fL, fundingShortPerHour: fS,
      borrowingLongPerHour: bL, borrowingShortPerHour: bS,
      openInterestLong30: oiL, openInterestShort30: oiS,
    });
  }
  return { entries, rejects: { count, reasons } };
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
  /** 실행 적격 비용 조회는 hardened GMX API transport를 주입한다. 미제공 시 기존 readonly fetch 사용. */
  fetchOfficialJson?: (path: string) => Promise<{ ok: true; data: unknown } | { ok: false; rateLimited: boolean }>;
  /** gmx.ts candle 계측의 last429AtMs — candle 429를 backoff에 연결 (미제공 시 미연동) */
  getLast429AtMs?: () => number | null;
  nowFn?: () => number;
}): ProductionFetchersHandle {
  const now = deps.nowFn ?? Date.now;
  let marketRowsCache: { at: number; value: { rows: RawMarketRow[]; complete: boolean; failureReason: string | null } } | null = null;
  /** 6I-4 — 공식 /v1/markets/tickers 비용 입력 캐시 (계약 검증 통과 record만 기록) */
  let tickersCache: { at: number; value: Map<string, Omit<MarketRateInputs, 'observedAtMs' | 'sourcePin'>> } | null = null;
  let tickersInFlight: Promise<void> | null = null;
  /** 6I-5 — /v1/markets/info impact 입력 캐시 (계약 검증 통과 record만) */
  let impactCache: { at: number; value: Map<string, Omit<ImpactMarketInputs, 'observedAtMs' | 'sourcePin'>> } | null = null;
  let impactInFlight: Promise<void> | null = null;
  const candleCache = new Map<string, CandleCacheEntry>();
  const inFlight = new Map<string, Promise<Candle[] | null>>();
  let cycleCandleRequests = 0;
  let backoffUntilMs = 0;

  const stats: DataSourceStats = {
    candleRequests: 0, candleCacheHits: 0, candleCacheMisses: 0, candleDeduped: 0,
    marketsRequests: 0, marketsCacheHits: 0, budgetExceededCount: 0, backoffSkips: 0,
    lastCycleCandleRequests: 0,
    tickersRequests: 0, tickersCacheHits: 0, tickersSchemaRejects: 0,
    impactInfoRequests: 0, impactInfoCacheHits: 0, impactInfoSchemaRejects: 0,
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
        const rows: RawMarketRow[] = list.map(m => {
          const symbolRaw = (m['indexTokenSymbol'] ?? m['name'] ?? '') as string;
          const symbol = String(symbolRaw).split('/')[0].trim();
          const tick = ticks?.find(t => t.tokenSymbol === symbol) ?? null;
          const marketToken = String(m['marketToken'] ?? '');
          // 1e30 문자열 → BigInt 합산 → 1회 변환 (usd30.ts). 실패=null (0 위장 금지)
          // 주의: 이 endpoint의 rate 필드는 공식 SDK 계약과 불일치 (6I-4 실측) — 비용 입력 사용 금지.
          const liquidityUsd = usd30SumToNumber(m['availableLiquidityLong'], m['availableLiquidityShort']);
          const openInterestUsd = usd30SumToNumber(m['openInterestLong'], m['openInterestShort']);
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
      // 6I-4 — 공식 tickers 비용 입력에서 파생 (LONG 사이드 rate). 확보 실패 = null.
      const c = await fetchers.fetchMarketCostInputs!(marketAddress);
      if (!c) return null;
      return { fundingPerHour: c.fundingLongPerHour, borrowingPerHour: c.borrowingLongPerHour, observedAtMs: c.observedAtMs };
    },

    async fetchMarketCostInputs(marketAddress) {
      const nowMs = now();
      // 캐시 fresh → 조회 (만료 캐시 반환 금지 — TTL 경계 포함 stale 위장 금지)
      if (!tickersCache || nowMs - tickersCache.at >= RATES_CACHE_TTL_MS) {
        // 429 backoff 중 신규 외부 요청 차단 (fail-closed)
        if (nowMs < backoffUntilMs) { stats.backoffSkips++; return null; }
        let flight = tickersInFlight;
        if (!flight) {
          flight = (async () => {
            stats.tickersRequests++;
            try {
              const r = deps.fetchOfficialJson
                ? await deps.fetchOfficialJson(COST_TICKERS_PATH)
                : await (async () => {
                    const response = await fetch(`${GMX_OFFICIAL_API}${COST_TICKERS_PATH}`, {
                      signal: AbortSignal.timeout(10_000), redirect: 'error',
                    });
                    return response.ok
                      ? { ok: true as const, data: await response.json() }
                      : { ok: false as const, rateLimited: response.status === 429 };
                  })();
              if (!r.ok) {
                if (r.rateLimited) backoffUntilMs = now() + RATE_LIMIT_BACKOFF_MS;
                return; // 실패 = 캐시 미갱신 (만료 캐시는 아래에서 null 처리)
              }
              const { entries, rejects } = parseMarketsTickers(r.data);
              stats.tickersSchemaRejects += rejects.count;
              if (rejects.count > 0) {
                console.warn(`[Intel] tickers 계약 위반 record ${rejects.count}건 폐기: ${rejects.reasons.join(' | ')}`);
              }
              // 전 record 위반(빈 결과)이라도 관측 사실은 기록 — 개별 조회는 부재로 null
              tickersCache = { at: now(), value: entries };
            } catch {
              // 네트워크/파싱 실패 = 캐시 미갱신 (오류 상세는 외부 URL 포함 가능 — 로그 미출력)
            }
          })().finally(() => { tickersInFlight = null; });
          tickersInFlight = flight;
        } else {
          stats.tickersCacheHits++; // in-flight 병합
        }
        await flight.catch(() => undefined);
      } else {
        stats.tickersCacheHits++;
      }
      if (!tickersCache || now() - tickersCache.at >= RATES_CACHE_TTL_MS) return null;
      const c = tickersCache.value.get(marketAddress.toLowerCase());
      if (!c) return null;
      return { ...c, observedAtMs: tickersCache.at, sourcePin: COST_SOURCE_PIN };
    },

    async fetchMarketImpactInputs(marketAddress) {
      const nowMs = now();
      if (!impactCache || nowMs - impactCache.at >= RATES_CACHE_TTL_MS) {
        if (nowMs < backoffUntilMs) { stats.backoffSkips++; return null; }
        let flight = impactInFlight;
        if (!flight) {
          flight = (async () => {
            stats.impactInfoRequests++;
            try {
              const r = deps.fetchOfficialJson
                ? await deps.fetchOfficialJson(IMPACT_INFO_PATH)
                : await (async () => {
                    const response = await fetch(`${GMX_OFFICIAL_API}${IMPACT_INFO_PATH}`, {
                      signal: AbortSignal.timeout(10_000), redirect: 'error',
                    });
                    return response.ok
                      ? { ok: true as const, data: await response.json() }
                      : { ok: false as const, rateLimited: response.status === 429 };
                  })();
              if (!r.ok) {
                if (r.rateLimited) backoffUntilMs = now() + RATE_LIMIT_BACKOFF_MS;
                return; // 실패 = 캐시 미갱신 (만료 캐시는 아래에서 null 처리)
              }
              const { entries, rejects } = parseMarketsImpactInfo(r.data);
              stats.impactInfoSchemaRejects += rejects.count;
              if (rejects.count > 0) {
                console.warn(`[Intel] markets/info impact 계약 위반 record ${rejects.count}건 폐기: ${rejects.reasons.join(' | ')}`);
              }
              impactCache = { at: now(), value: entries };
            } catch {
              // 네트워크/파싱 실패 = 캐시 미갱신 (오류 상세는 외부 URL 포함 가능 — 로그 미출력)
            }
          })().finally(() => { impactInFlight = null; });
          impactInFlight = flight;
        } else {
          stats.impactInfoCacheHits++; // in-flight 병합
        }
        await flight.catch(() => undefined);
      } else {
        stats.impactInfoCacheHits++;
      }
      if (!impactCache || now() - impactCache.at >= RATES_CACHE_TTL_MS) return null;
      const c = impactCache.value.get(marketAddress.toLowerCase());
      if (!c) return null;
      return { ...c, observedAtMs: impactCache.at, sourcePin: IMPACT_SOURCE_PIN };
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
