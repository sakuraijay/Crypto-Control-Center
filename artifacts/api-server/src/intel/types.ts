/**
 * 6I-1 §3 — Market Intelligence 데이터 계약.
 *
 * 원칙:
 *  - 출처 없는 값 생성 금지, 0 대체 금지 — 사용 불가는 UNAVAILABLE로 명시
 *  - 서로 다른 시각의 데이터를 동일 snapshot처럼 위장 금지 (값마다 메타데이터)
 *  - 미래 시각·NaN·Infinity·비정상 음수 거부
 *  - 데이터 품질 미달이면 LIVE 후보 금지 (fail-closed)
 */

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h';
export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000,
};

export const UNAVAILABLE = 'UNAVAILABLE' as const;

/** 모든 관측값에 붙는 메타데이터 — 값마다 개별 시각/출처/신선도 */
export interface DataMeta {
  source: string;                    // 예: 'gmx-oracle', 'gmx-stats', 'gmx-markets'
  symbol: string;
  marketAddress: string | null;      // 심볼만 믿지 않음 — market address 결속
  observedAtMs: number;              // 우리가 관측을 확정한 시각
  sourceTimestampMs: number | null;  // 출처가 주장하는 시각 (없으면 null)
  receivedAtMs: number;              // 수신 시각
  ageMs: number;                     // observedAt 기준 나이 (스냅샷 조립 시각 대비)
  timeframe: Timeframe | null;
  /** 0..1 — 기대 대비 확보 비율 (캔들 수 등). 단일값은 1 */
  completeness: number;
  stale: boolean;
  unavailableReason: string | null;  // null=가용
}

/** value=null ⇔ UNAVAILABLE (meta.unavailableReason 필수) */
export interface DataPoint<T> {
  meta: DataMeta;
  value: T | null;
}

export interface Candle {
  t: number;   // open time (ms)
  o: number; h: number; l: number; c: number;
  v: number | null; // 거래량 — 출처가 없으면 null (0 위장 금지)
}

export type DataQuality = 'GOOD' | 'DEGRADED' | 'UNAVAILABLE';

/** 시장 1개의 정밀 스냅샷 — 각 값이 독립 메타데이터를 가짐 */
export interface MarketSnapshot {
  symbol: string;
  marketAddress: string | null;
  indexTokenAddress: string | null;
  assembledAtMs: number;
  price: DataPoint<number>;
  candles: Partial<Record<Timeframe, DataPoint<Candle[]>>>;
  volume24hUsd: DataPoint<number>;
  atrPct: DataPoint<number>;            // 실현 변동성/ATR 계열 (가격 대비 %)
  trendShort: DataPoint<number>;        // -1..1
  trendMedium: DataPoint<number>;       // -1..1
  momentum: DataPoint<number>;          // -1..1
  fundingRatePerHour: DataPoint<number>;
  borrowingRatePerHour: DataPoint<number>;
  openInterestLongUsd: DataPoint<number>;
  openInterestShortUsd: DataPoint<number>;
  longShortImbalance: DataPoint<number>; // -1..1
  liquidityUsd: DataPoint<number>;
  expectedPriceImpactPct: DataPoint<number>;
  change24hPct: DataPoint<number>;
  dataQuality: DataQuality;
  qualityIssues: string[];
}

/** 스냅샷 조립 공통 컨텍스트 */
export interface IntelContext {
  btcDirection: DataPoint<number>;      // -1..1 (BTC 기준 시장 방향)
  correlationToBtc: Record<string, DataPoint<number>>;
  apiLatencyMs: DataPoint<number>;
  rpcLatencyMs: DataPoint<number>;
  recentFetchFailureRate: DataPoint<number>; // 0..1
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 메타데이터 조립 헬퍼 — 가용 값 */
export function availablePoint<T>(value: T, meta: Omit<DataMeta, 'unavailableReason' | 'ageMs'> & { ageMs?: number }): DataPoint<T> {
  return {
    value,
    meta: { ageMs: meta.ageMs ?? Math.max(0, meta.receivedAtMs - meta.observedAtMs), ...meta, unavailableReason: null },
  };
}

/** UNAVAILABLE 포인트 — 값 생성/0 대체 금지 원칙의 유일한 표현 */
export function unavailablePoint<T>(reason: string, base: { source: string; symbol: string; marketAddress?: string | null; timeframe?: Timeframe | null; nowMs: number }): DataPoint<T> {
  return {
    value: null,
    meta: {
      source: base.source, symbol: base.symbol, marketAddress: base.marketAddress ?? null,
      observedAtMs: base.nowMs, sourceTimestampMs: null, receivedAtMs: base.nowMs, ageMs: 0,
      timeframe: base.timeframe ?? null, completeness: 0, stale: true, unavailableReason: reason,
    },
  };
}

/**
 * 스칼라 관측값 검증 — 미래 시각·NaN·Infinity·(비음수 필드의) 음수 거부.
 * 실패 시 UNAVAILABLE로 강등 (0 대체 아님).
 */
export function validateScalarPoint(p: DataPoint<number>, opts: { nowMs: number; allowNegative?: boolean; maxAgeMs?: number }): DataPoint<number> {
  if (p.value === null) return p;
  const m = p.meta;
  if (!finite(p.value)) return unavailablePoint('비정상 값(NaN/Infinity)', { source: m.source, symbol: m.symbol, marketAddress: m.marketAddress, timeframe: m.timeframe, nowMs: opts.nowMs });
  if (!opts.allowNegative && p.value < 0) return unavailablePoint('음수 불가 필드의 음수 값', { source: m.source, symbol: m.symbol, marketAddress: m.marketAddress, timeframe: m.timeframe, nowMs: opts.nowMs });
  if (m.sourceTimestampMs !== null && m.sourceTimestampMs > opts.nowMs + 5_000) {
    return unavailablePoint('미래 sourceTimestamp', { source: m.source, symbol: m.symbol, marketAddress: m.marketAddress, timeframe: m.timeframe, nowMs: opts.nowMs });
  }
  if (m.observedAtMs > opts.nowMs + 5_000) {
    return unavailablePoint('미래 observedAt', { source: m.source, symbol: m.symbol, marketAddress: m.marketAddress, timeframe: m.timeframe, nowMs: opts.nowMs });
  }
  const stale = opts.maxAgeMs !== undefined && (opts.nowMs - m.observedAtMs) > opts.maxAgeMs;
  return stale ? { ...p, meta: { ...m, stale: true } } : p;
}
