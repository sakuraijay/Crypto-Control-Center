/**
 * 6I-1 §4 — 시장 Universe 선정 (2단계, 순수 모듈).
 *  - 1차 경량 스캔: 공식 GMX markets 목록 기반 필터 (거래 가능/상태/유동성/freshness)
 *  - 2차 bounded shortlist: 유동성·데이터 품질·기회 점수 기준
 *  - 특정 7개 종목 하드코딩 금지 — 입력 목록 전체를 평가
 *  - 심볼만 믿지 않음 — market/indexToken address 결속
 *  - 부분 실패 시 universe 전체가 정상인 것처럼 표시 금지 (degraded 명시)
 */

export interface RawMarketRow {
  marketToken: string;
  indexToken: string | null;
  symbol: string;               // index token symbol (예: 'ETH')
  isListed: boolean;
  isDisabled?: boolean;
  /** 유동성/OI 지표 (USD) — 출처 없으면 null (0 위장 금지) */
  liquidityUsd: number | null;
  openInterestUsd: number | null;
  /** 가격 freshness — 마지막 가격 관측 시각 (ms). null=미상 */
  lastPriceAtMs: number | null;
  /** price impact/spread 데이터 가용 여부 */
  impactDataAvailable: boolean;
}

export interface UniverseScanResult {
  universeCount: number;
  passedStage1: ScannedMarket[];
  excluded: { marketToken: string; symbol: string; reason: string }[];
  /** 목록 조회 부분 실패/불완전 여부 — true면 universe가 완전하지 않음 */
  degraded: boolean;
  degradedReason: string | null;
}

export interface ScannedMarket {
  marketToken: string;
  indexToken: string | null;
  symbol: string;
  liquidityUsd: number;
  openInterestUsd: number | null;
  lastPriceAtMs: number;
}

export const MIN_LIQUIDITY_USD = 1_000_000;   // 신규·저유동성 시장 제외 (비용/위험)
export const PRICE_FRESHNESS_MAX_MS = 120_000;
export const SHORTLIST_MAX = 8;
/** 기준시장 — 시장 방향/상관관계 산정을 위해 가용하면 항상 shortlist 포함 */
export const BENCHMARK_SYMBOLS: readonly string[] = ['BTC', 'ETH'];

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function scanUniverse(rows: RawMarketRow[] | null, opts: { nowMs: number; listComplete: boolean; listFailureReason?: string | null }): UniverseScanResult {
  if (!rows || rows.length === 0) {
    return {
      universeCount: 0, passedStage1: [], excluded: [],
      degraded: true, degradedReason: opts.listFailureReason ?? 'markets 목록 없음',
    };
  }
  const passed: ScannedMarket[] = [];
  const excluded: UniverseScanResult['excluded'] = [];
  for (const r of rows) {
    const ex = (reason: string) => excluded.push({ marketToken: r.marketToken, symbol: r.symbol, reason });
    if (!ADDR_RE.test(r.marketToken)) { ex('market address 형식 오류'); continue; }
    if (r.indexToken !== null && !ADDR_RE.test(r.indexToken)) { ex('indexToken address 형식 오류'); continue; }
    if (!r.isListed) { ex('미상장'); continue; }
    if (r.isDisabled) { ex('비활성 시장'); continue; }
    if (r.liquidityUsd === null) { ex('유동성 데이터 없음 (0 위장 금지 — 제외)'); continue; }
    if (!Number.isFinite(r.liquidityUsd) || r.liquidityUsd < 0) { ex('유동성 값 비정상'); continue; }
    if (r.liquidityUsd < MIN_LIQUIDITY_USD) { ex(`저유동성: $${Math.round(r.liquidityUsd).toLocaleString()} < $${MIN_LIQUIDITY_USD.toLocaleString()}`); continue; }
    if (r.lastPriceAtMs === null || opts.nowMs - r.lastPriceAtMs > PRICE_FRESHNESS_MAX_MS) { ex('가격 freshness 미달'); continue; }
    if (r.lastPriceAtMs > opts.nowMs + 5_000) { ex('미래 가격 시각'); continue; }
    if (!r.impactDataAvailable) { ex('price impact/spread 데이터 없음'); continue; }
    passed.push({
      marketToken: r.marketToken, indexToken: r.indexToken, symbol: r.symbol,
      liquidityUsd: r.liquidityUsd, openInterestUsd: r.openInterestUsd, lastPriceAtMs: r.lastPriceAtMs,
    });
  }
  return {
    universeCount: rows.length, passedStage1: passed, excluded,
    degraded: !opts.listComplete, degradedReason: opts.listComplete ? null : (opts.listFailureReason ?? 'markets 목록 불완전'),
  };
}

export interface ShortlistResult {
  shortlist: ScannedMarket[];
  shortlistCount: number;
  universeCount: number;
  benchmarksIncluded: string[];
  degraded: boolean;
}

/**
 * 2차 — bounded shortlist: 유동성 내림차순, 기준시장(BTC/ETH)은 1차 통과 시 항상 포함.
 * dataQualityScore(0..1)가 주어지면 liquidity×quality로 정렬한다.
 */
export function selectShortlist(
  scan: UniverseScanResult,
  opts: { maxSize?: number; dataQualityScore?: (m: ScannedMarket) => number },
): ShortlistResult {
  const max = opts.maxSize ?? SHORTLIST_MAX;
  const q = opts.dataQualityScore ?? (() => 1);
  const sorted = [...scan.passedStage1].sort((a, b) => b.liquidityUsd * q(b) - a.liquidityUsd * q(a));
  const benchmarks = sorted.filter(m => BENCHMARK_SYMBOLS.includes(m.symbol));
  const rest = sorted.filter(m => !BENCHMARK_SYMBOLS.includes(m.symbol));
  const shortlist = [...benchmarks, ...rest].slice(0, Math.max(max, benchmarks.length)).slice(0, max + BENCHMARK_SYMBOLS.length);
  // bounded: 기준시장 포함 후 max 초과분은 잘라내되 기준시장은 유지
  const final = shortlist.length > max
    ? [...benchmarks, ...shortlist.filter(m => !BENCHMARK_SYMBOLS.includes(m.symbol))].slice(0, max)
    : shortlist;
  return {
    shortlist: final, shortlistCount: final.length, universeCount: scan.universeCount,
    benchmarksIncluded: benchmarks.map(b => b.symbol).filter(s => final.some(f => f.symbol === s)),
    degraded: scan.degraded,
  };
}
