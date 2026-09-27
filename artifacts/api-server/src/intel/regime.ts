/**
 * 6I-1 §5 — Market Regime Engine (결정적 순수 모듈).
 *  - 동일 snapshot 입력 → 항상 동일 결과
 *  - 필수 feature 부족 = UNAVAILABLE, 이상 신호 = ABNORMAL
 *  - ABNORMAL/UNAVAILABLE = 신규 OPEN 차단 (tradeAllowed=false)
 *  - AI 문장으로 regime 결정 금지 — 숫자 feature만 사용
 *  - 자동 전략 변경/자가학습 없음 — allowedStrategies는 고정 매핑
 */

export type MarketRegime =
  | 'STRONG_BULL' | 'WEAK_BULL' | 'STRONG_BEAR' | 'WEAK_BEAR'
  | 'RANGE' | 'HIGH_VOLATILITY' | 'LOW_VOLATILITY'
  | 'OVERHEATED' | 'OVERSOLD' | 'ABNORMAL' | 'UNAVAILABLE';

export type RegimeStrategy = 'TREND_FOLLOW_LONG' | 'TREND_FOLLOW_SHORT' | 'MEAN_REVERT' | 'NONE';

export interface RegimeFeatures {
  /** -1..1 (null=누락) */
  trendShort: number | null;
  trendMedium: number | null;
  momentum: number | null;
  atrPct: number | null;              // 변동성 (%)
  change24hPct: number | null;
  rsi: number | null;                 // 0..100
  /** 소스 간 가격 괴리 비율(0..) — null=측정 불가 */
  sourceDivergencePct: number | null;
  latencyMs: number | null;
  observedAtMs: number;
}

export interface RegimeResult {
  regime: MarketRegime;
  /** 0..1 */
  strength: number;
  featuresUsed: string[];
  missingFeatures: string[];
  dataQuality: 'GOOD' | 'DEGRADED' | 'UNAVAILABLE';
  basis: string;
  observedAtMs: number;
  staleAtMs: number;
  tradeAllowed: boolean;
  allowedStrategies: RegimeStrategy[];
}

/** regime→허용 전략 고정 매핑 (자동 변경 금지) */
export const REGIME_ALLOWED_STRATEGIES: Record<MarketRegime, RegimeStrategy[]> = {
  STRONG_BULL: ['TREND_FOLLOW_LONG'],
  WEAK_BULL: ['TREND_FOLLOW_LONG'],
  STRONG_BEAR: ['TREND_FOLLOW_SHORT'],
  WEAK_BEAR: ['TREND_FOLLOW_SHORT'],
  RANGE: ['MEAN_REVERT'],               // RANGE에서 추세 전략 억지 실행 금지
  HIGH_VOLATILITY: ['NONE'],
  LOW_VOLATILITY: ['MEAN_REVERT'],
  OVERHEATED: ['NONE'],
  OVERSOLD: ['NONE'],
  ABNORMAL: ['NONE'],
  UNAVAILABLE: ['NONE'],
};

export const REGIME_STALE_AFTER_MS = 120_000;
export const ABNORMAL_DIVERGENCE_PCT = 1.5;   // 소스 간 1.5% 이상 괴리 = 비정상
export const ABNORMAL_LATENCY_MS = 15_000;

const REQUIRED: (keyof RegimeFeatures)[] = ['trendShort', 'trendMedium', 'momentum', 'atrPct'];

export function classifyRegime(f: RegimeFeatures): RegimeResult {
  const missing = (Object.keys(f) as (keyof RegimeFeatures)[])
    .filter(k => k !== 'observedAtMs' && f[k] === null).map(String);
  const used = (Object.keys(f) as (keyof RegimeFeatures)[])
    .filter(k => k !== 'observedAtMs' && f[k] !== null).map(String);
  const base = {
    featuresUsed: used, missingFeatures: missing,
    observedAtMs: f.observedAtMs, staleAtMs: f.observedAtMs + REGIME_STALE_AFTER_MS,
  };
  const make = (regime: MarketRegime, strength: number, basis: string, dq: RegimeResult['dataQuality']): RegimeResult => ({
    regime, strength: Math.max(0, Math.min(1, strength)), basis, dataQuality: dq,
    tradeAllowed: regime !== 'ABNORMAL' && regime !== 'UNAVAILABLE',
    allowedStrategies: REGIME_ALLOWED_STRATEGIES[regime],
    ...base,
  });

  // 필수 feature 부족 → UNAVAILABLE (성공 가정 금지)
  if (REQUIRED.some(k => f[k] === null)) {
    return make('UNAVAILABLE', 0, `필수 feature 누락: ${REQUIRED.filter(k => f[k] === null).join(', ')}`, 'UNAVAILABLE');
  }
  // 이상 신호 → ABNORMAL
  if (f.sourceDivergencePct !== null && f.sourceDivergencePct >= ABNORMAL_DIVERGENCE_PCT) {
    return make('ABNORMAL', 1, `source divergence ${f.sourceDivergencePct.toFixed(2)}% ≥ ${ABNORMAL_DIVERGENCE_PCT}%`, 'DEGRADED');
  }
  if (f.latencyMs !== null && f.latencyMs >= ABNORMAL_LATENCY_MS) {
    return make('ABNORMAL', 1, `latency ${f.latencyMs}ms ≥ ${ABNORMAL_LATENCY_MS}ms`, 'DEGRADED');
  }
  if (f.atrPct !== null && (f.atrPct < 0 || f.atrPct > 50)) {
    return make('ABNORMAL', 1, `비정상 변동성 ${f.atrPct}%`, 'DEGRADED');
  }

  const dq: RegimeResult['dataQuality'] = missing.length === 0 ? 'GOOD' : 'DEGRADED';
  const t = (f.trendShort! + f.trendMedium!) / 2;
  const atr = f.atrPct!;
  const rsi = f.rsi;

  // 과열/과매도 (RSI 가용 시)
  if (rsi !== null && rsi >= 80) return make('OVERHEATED', (rsi - 80) / 20, `RSI ${rsi} ≥ 80`, dq);
  if (rsi !== null && rsi <= 20) return make('OVERSOLD', (20 - rsi) / 20, `RSI ${rsi} ≤ 20`, dq);
  // 변동성 우선
  if (atr >= 4) return make('HIGH_VOLATILITY', Math.min(1, atr / 8), `ATR ${atr.toFixed(2)}% ≥ 4%`, dq);
  // 추세
  if (t >= 0.5) return make('STRONG_BULL', t, `평균 추세 ${t.toFixed(2)} ≥ 0.5`, dq);
  if (t >= 0.2) return make('WEAK_BULL', t, `평균 추세 ${t.toFixed(2)} ∈ [0.2,0.5)`, dq);
  if (t <= -0.5) return make('STRONG_BEAR', -t, `평균 추세 ${t.toFixed(2)} ≤ -0.5`, dq);
  if (t <= -0.2) return make('WEAK_BEAR', -t, `평균 추세 ${t.toFixed(2)} ∈ (-0.5,-0.2]`, dq);
  if (atr <= 0.5) return make('LOW_VOLATILITY', 1 - atr / 0.5, `ATR ${atr.toFixed(2)}% ≤ 0.5% + 무추세`, dq);
  return make('RANGE', 1 - Math.abs(t) / 0.2, `추세 |${t.toFixed(2)}| < 0.2`, dq);
}
