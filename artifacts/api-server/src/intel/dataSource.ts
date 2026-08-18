/**
 * 6I-1 §3·§4 — 런타임 데이터 소스 (read-only, bounded concurrency, cache).
 *  - 조회 실패 = UNAVAILABLE (0 대체·이전 값 위장 금지)
 *  - 모든 fetcher는 주입 가능 — 테스트는 전부 mock (외부 호출 0회)
 */
import { Candle, Timeframe, DataPoint, availablePoint, unavailablePoint } from './types';
import { RawMarketRow } from './universe';

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

/** 방어적 숫자 파싱 — 문자열/1e30 스케일 wei 값도 수용, 비정상=null */
function toUsdNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    // GMX 온체인 USD 값은 1e30 스케일 문자열인 경우가 있음
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return v.length > 20 ? n / 1e30 : n;
  }
  return null;
}

/** per-second rate 파싱 — 1e30 스케일 문자열 전용, 비정상=null (음수 funding 허용) */
function toRateNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n / 1e30;
  }
  return null;
}

/**
 * 프로덕션 fetcher 구현 — 전부 read-only.
 * markets 목록: /markets + /prices/tickers 결합. 유동성 지표는 markets/info 계열이
 * 없거나 실패하면 null (해당 시장 제외 — 0 위장 금지).
 */
export function createProductionFetchers(deps: {
  getCachedPrices: () => { tokenSymbol: string; priceUsd: number; updatedAt?: number }[] | null;
  getCachedChange24h: () => Record<string, number> | null;
  fetchGmxCandles: (symbol: string, period: string, countBack: number) => Promise<{ prices: number[][] } | null>;
}): IntelFetchers {
  let marketRowsCache: { at: number; value: { rows: RawMarketRow[]; complete: boolean; failureReason: string | null } } | null = null;
  let ratesCache: { at: number; value: Map<string, { fundingPerHour: number; borrowingPerHour: number }> } | null = null;

  return {
    async fetchMarketRows(nowMs) {
      if (marketRowsCache && nowMs - marketRowsCache.at < 60_000) return marketRowsCache.value;
      try {
        // /markets/info — 유동성·OI·funding/borrowing 실측 포함 (전부 1e30 스케일 문자열)
        const r = await fetch(`${GMX_API}/markets/info`, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json() as { markets?: Record<string, unknown>[] } | Record<string, unknown>[];
        const list = Array.isArray(data) ? data : (data.markets ?? []);
        const ticks = deps.getCachedPrices();
        const rates = new Map<string, { fundingPerHour: number; borrowingPerHour: number }>();
        const rows: RawMarketRow[] = list.map(m => {
          const symbolRaw = (m['indexTokenSymbol'] ?? m['name'] ?? '') as string;
          const symbol = String(symbolRaw).split('/')[0].trim();
          const tick = ticks?.find(t => t.tokenSymbol === symbol) ?? null;
          const liqLong = toUsdNumber(m['availableLiquidityLong']);
          const liqShort = toUsdNumber(m['availableLiquidityShort']);
          const oiLong = toUsdNumber(m['openInterestLong']);
          const oiShort = toUsdNumber(m['openInterestShort']);
          const marketToken = String(m['marketToken'] ?? '');
          // funding/borrowing: per-second 1e30 스케일 → 시간당 비율. 파싱 실패=미기록(UNAVAILABLE)
          const f = toRateNumber(m['fundingRateLong']);
          const b = toRateNumber(m['borrowingRateLong']);
          if (f !== null && b !== null) {
            rates.set(marketToken.toLowerCase(), { fundingPerHour: f * 3600, borrowingPerHour: b * 3600 });
          }
          return {
            marketToken,
            indexToken: typeof m['indexToken'] === 'string' ? m['indexToken'] as string : null,
            symbol,
            isListed: m['isListed'] !== false,
            isDisabled: m['isDisabled'] === true,
            liquidityUsd: liqLong !== null && liqShort !== null ? liqLong + liqShort : null,
            openInterestUsd: oiLong !== null && oiShort !== null ? oiLong + oiShort : null,
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

    async fetchCandles(symbol, timeframe, count) {
      const r = await deps.fetchGmxCandles(symbol, timeframe, count);
      if (!r) return null;
      return pricesToCandles(r.prices);
    },

    async fetchPrice(symbol) {
      const ticks = deps.getCachedPrices();
      const t = ticks?.find(x => x.tokenSymbol === symbol);
      if (!t || !Number.isFinite(t.priceUsd) || t.priceUsd <= 0) return null;
      return { price: t.priceUsd, observedAtMs: t.updatedAt ?? Date.now() };
    },

    async fetch24hChange(symbol) {
      const map = deps.getCachedChange24h();
      const v = map?.[symbol];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    },

    async fetchFundingBorrowing(marketAddress) {
      // /markets/info에서 실측 캐시 (fetchMarketRows가 채움). 만료/부재=UNAVAILABLE (0 위장 금지).
      if (!ratesCache || Date.now() - ratesCache.at > 120_000) return null;
      const r = ratesCache.value.get(marketAddress.toLowerCase());
      if (!r) return null;
      return { fundingPerHour: r.fundingPerHour, borrowingPerHour: r.borrowingPerHour, observedAtMs: ratesCache.at };
    },
  };
}
