/**
 * AI 5-State 엔진 — 브라우저 측 결정론적 단위 테스트
 *
 * 브라우저 stateEngine은 순수 함수입니다 (import type만 사용, 런타임 의존성 없음).
 * 서버 측과 동일한 임계값과 로직을 사용합니다.
 *
 * 핵심 구현 세부사항:
 *  - maxMarginPerTrade: 2000으로 설정해야 secondary risk gate 통과 가능
 *  - maxTotalExposureUSDT: 50000 (넉넉하게)
 *  - maxRiskPerSymbolPct: 0 (비활성화)
 *  - 일간 손실 = account.realizedPnlToday + account.unrealizedPnl (deriveRiskLevel 내부)
 */
import { describe, it, expect } from 'vitest';
import { runAiEngine } from '../lib/ai/stateEngine';
import type { SymbolAnalysis } from '../lib/ai/types';

// ── 임계값 상수 ────────────────────────────────────────────────────────────────
const T = {
  SPOT_BULLISH_MIN:     60,
  LONG_BULLISH_MIN:     68,
  SHORT_BEARISH_MIN:    68,
  HEDGE_COUNTER_SIGNAL: 55,
  HEDGE_DRAWDOWN_PCT:   4,
  CASH_MAX_SIGNAL:      44,
  HIGH_VOL_ATR_PCT:     8,
  SPOT_ATR_MAX:         1.5,
} as const;

// ── 팩토리 함수 ────────────────────────────────────────────────────────────────

function makeIndicators(atrPct = 2.0, emaCross: 'bullish'|'bearish'|'neutral' = 'neutral') {
  return {
    rsi14: 50, ema9: 50_000, ema21: 50_000, emaCross,
    atrPct, priceChange24h: 0, priceChange1h: 0, momentum: 0, trend: 'sideways' as const,
  };
}

function makeAnalysis(overrides: Partial<SymbolAnalysis> = {}): SymbolAnalysis {
  return {
    symbol: 'BTC', displaySymbol: 'BTC/USD', price: 50_000,
    indicators: makeIndicators(),
    bullishScore: 50, bearishScore: 50, directionalBias: 0, opportunityScore: 50,
    ...overrides,
  };
}

function makePosition(unrealizedPnl = 0, collateralUsd = 1_000) {
  return {
    symbol: 'BTC', side: 'LONG' as const,
    sizeInUsd: 5_000, collateralUsd, unrealizedPnl, entryPrice: 50_000, leverage: 5,
  };
}

// maxMarginPerTrade=2000, maxTotalExposureUSDT=50000, maxRiskPerSymbolPct=0
// 이 값 없이는 SPOT/HEDGE의 secondary risk gate가 CASH를 반환함
const BASE_LIMITS = {
  dailyLossLimitUSDT: 500, maxDrawdownPercent: 20,
  consecutiveLossLimit: 5, maxLeverage: 10,
  maxMarginPerTrade: 2_000,    // ← 중요: SPOT 통과를 위해 2000 이상 필요
  maxTotalExposureUSDT: 50_000, // ← 중요: HEDGE 포지션 합산 통과
  tradingCapital: 10_000, reserveCashPct: 20,
  profitLockThresholdPct: 1, maxSimultaneousPositions: 5,
  maxRiskPerSymbolPct: 0,      // ← 중요: 0 = 비활성화
  weeklyLossLimitUSDT: 1_500, rolling24hLossLimitUSDT: 0,
};

const BASE_ACCOUNT = {
  balance: 10_000, availableBalance: 8_000,
  unrealizedPnl: 0, realizedPnlToday: 0,
};

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    cycleNumber: 1, prevState: 'CASH' as const,
    analyses: [], positions: [],
    account: BASE_ACCOUNT, limits: BASE_LIMITS,
    engineState: 'PAPER_TRADING',
    consecutiveLosses: 0, dataFreshMs: 1_000,
    dailyRealizedPnlUsd: 0, tradingCapital: 10_000,
    weeklyRealizedPnlUsd: 0, rolling24hRealizedPnlUsd: 0,
    accountDrawdownPct: 0,
    ...overrides,
  };
}

// ── CASH 상태 ─────────────────────────────────────────────────────────────────

describe('[브라우저] CASH 상태', () => {
  it('신호가 CASH_MAX_SIGNAL(44) 미만이면 CASH를 반환한다', () => {
    const analysis = makeAnalysis({ bullishScore: 30, bearishScore: 30, opportunityScore: 30 });
    expect(runAiEngine(makeInput({ analyses: [analysis] })).operatingState).toBe('CASH');
  });

  it('analyses가 비어 있으면 CASH를 반환한다', () => {
    expect(runAiEngine(makeInput({ analyses: [] })).operatingState).toBe('CASH');
  });

  it('EMERGENCY_STOP 이면 CASH를 반환한다', () => {
    const analysis = makeAnalysis({ bullishScore: 70, opportunityScore: 80,
                                    indicators: makeIndicators(2.0, 'bullish') });
    expect(runAiEngine(makeInput({ analyses: [analysis], engineState: 'EMERGENCY_STOP' }))
      .operatingState).toBe('CASH');
  });

  it('데이터가 60초 이상 지났으면 CASH를 반환한다', () => {
    const analysis = makeAnalysis({ bullishScore: 70, opportunityScore: 80,
                                    indicators: makeIndicators(2.0, 'bullish') });
    expect(runAiEngine(makeInput({ analyses: [analysis], dataFreshMs: 65_000 }))
      .operatingState).toBe('CASH');
  });

  it('prevState가 CASH이면 stateChanged = false', () => {
    const analysis = makeAnalysis({ bullishScore: 30, bearishScore: 30, opportunityScore: 30 });
    expect(runAiEngine(makeInput({ analyses: [analysis], prevState: 'CASH' }))
      .stateChanged).toBe(false);
  });
});

// ── LONG 상태 ─────────────────────────────────────────────────────────────────

describe('[브라우저] LONG 상태', () => {
  const longAnalysis = makeAnalysis({
    bullishScore: 70, bearishScore: 20, directionalBias: 50, opportunityScore: 80,
    indicators: makeIndicators(2.0, 'bullish'),
  });

  it('bullishScore ≥ 68 이고 ATR ≥ 1.5% 이면 LONG을 반환한다', () => {
    expect(runAiEngine(makeInput({ analyses: [longAnalysis] })).operatingState).toBe('LONG');
  });

  it('LONG 결정의 executionType은 perp_long_open 또는 scale_in이다', () => {
    const result = runAiEngine(makeInput({ analyses: [longAnalysis] }));
    expect(['perp_long_open', 'scale_in']).toContain(result.executionType);
  });

  it('LONG 결정은 leverage와 sizeUsd를 포함한다', () => {
    const result = runAiEngine(makeInput({ analyses: [longAnalysis] }));
    expect((result.leverage ?? 0) > 0).toBe(true);
    expect((result.sizeUsd ?? 0) > 0).toBe(true);
  });

  it('LONG이면 stateChanged = true (prevState=CASH)', () => {
    expect(runAiEngine(makeInput({ analyses: [longAnalysis], prevState: 'CASH' }))
      .stateChanged).toBe(true);
  });
});

// ── SHORT 상태 ────────────────────────────────────────────────────────────────

describe('[브라우저] SHORT 상태', () => {
  const shortAnalysis = makeAnalysis({
    bearishScore: 70, bullishScore: 20, directionalBias: -50, opportunityScore: 80,
    indicators: makeIndicators(2.0, 'bearish'),
  });

  it('bearishScore ≥ 68 이고 ATR ≥ 1.5% 이면 SHORT를 반환한다', () => {
    expect(runAiEngine(makeInput({ analyses: [shortAnalysis] })).operatingState).toBe('SHORT');
  });

  it('SHORT 결정의 executionType은 perp_short_open 또는 scale_in이다', () => {
    const result = runAiEngine(makeInput({ analyses: [shortAnalysis] }));
    expect(['perp_short_open', 'scale_in']).toContain(result.executionType);
  });

  it('SHORT 결정은 leverage와 sizeUsd를 포함한다', () => {
    const result = runAiEngine(makeInput({ analyses: [shortAnalysis] }));
    expect((result.leverage ?? 0) > 0).toBe(true);
    expect((result.sizeUsd ?? 0) > 0).toBe(true);
  });
});

// ── SPOT 상태 ─────────────────────────────────────────────────────────────────

describe('[브라우저] SPOT 상태', () => {
  const spotAnalysis = makeAnalysis({
    bullishScore: 65, bearishScore: 20, directionalBias: 30, opportunityScore: 70,
    indicators: makeIndicators(0.8, 'bullish'),
  });

  it('bullishScore ≥ 60 이고 ATR < 1.5% 이면 SPOT을 반환한다', () => {
    expect(runAiEngine(makeInput({ analyses: [spotAnalysis] })).operatingState).toBe('SPOT');
  });

  it('SPOT 결정의 executionType은 spot_swap이다', () => {
    expect(runAiEngine(makeInput({ analyses: [spotAnalysis] })).executionType).toBe('spot_swap');
  });

  it('SPOT은 sizeUsd를 포함한다 (레버리지 없음)', () => {
    const result = runAiEngine(makeInput({ analyses: [spotAnalysis] }));
    expect((result.sizeUsd ?? 0) > 0).toBe(true);
    expect(result.leverage).toBeFalsy();
  });

  it('ATR ≥ 1.5% 이면 SPOT이 아니다', () => {
    const highAtrAnalysis = makeAnalysis({
      bullishScore: 65, bearishScore: 20, opportunityScore: 70,
      indicators: makeIndicators(2.0, 'bullish'),
    });
    expect(runAiEngine(makeInput({ analyses: [highAtrAnalysis] })).operatingState).not.toBe('SPOT');
  });
});

// ── HEDGE 상태 ────────────────────────────────────────────────────────────────

describe('[브라우저] HEDGE 상태', () => {
  const hedgeAnalysis = makeAnalysis({
    bullishScore: 55, bearishScore: 30, opportunityScore: 60,
    indicators: makeIndicators(1.0),
  });
  const hedgePosition = makePosition(-40, 1_000);  // 4% drawdown

  it('포지션 드로다운 ≥ 4% + 역신호 ≥ 55 이면 HEDGE를 반환한다', () => {
    expect(runAiEngine(makeInput({ analyses: [hedgeAnalysis], positions: [hedgePosition] }))
      .operatingState).toBe('HEDGE');
  });

  it('HEDGE의 executionType은 hedge_open이다', () => {
    expect(runAiEngine(makeInput({ analyses: [hedgeAnalysis], positions: [hedgePosition] }))
      .executionType).toBe('hedge_open');
  });

  it('HEDGE는 hedgeParams를 포함한다', () => {
    const result = runAiEngine(makeInput({ analyses: [hedgeAnalysis], positions: [hedgePosition] }));
    expect(result.hedgeParams).toBeDefined();
    expect(result.hedgeParams?.direction).toMatch(/^(LONG|SHORT)$/);
    expect((result.hedgeParams?.sizeUsd ?? 0) > 0).toBe(true);
  });

  it('포지션이 없으면 HEDGE가 아니다', () => {
    expect(runAiEngine(makeInput({ analyses: [hedgeAnalysis], positions: [] }))
      .operatingState).not.toBe('HEDGE');
  });

  it('드로다운 < 4% 이면 HEDGE가 아니다', () => {
    const safePosition = makePosition(-30, 1_000);  // 3% drawdown
    expect(runAiEngine(makeInput({ analyses: [hedgeAnalysis], positions: [safePosition] }))
      .operatingState).not.toBe('HEDGE');
  });
});

// ── 공통 구조 검증 ─────────────────────────────────────────────────────────────

describe('[브라우저] 공통 결정 구조', () => {
  it.each([
    ['CASH',  makeAnalysis({ bullishScore: 30, bearishScore: 30, opportunityScore: 30 }),         [], 'CASH'],
    ['LONG',  makeAnalysis({ bullishScore: 70, bearishScore: 20, opportunityScore: 80,
                             directionalBias: 50, indicators: makeIndicators(2.0,'bullish') }), [], 'LONG'],
    ['SHORT', makeAnalysis({ bearishScore: 70, bullishScore: 20, opportunityScore: 80,
                             directionalBias: -50, indicators: makeIndicators(2.0,'bearish') }), [], 'SHORT'],
    ['SPOT',  makeAnalysis({ bullishScore: 65, bearishScore: 20, opportunityScore: 70,
                             directionalBias: 30, indicators: makeIndicators(0.8,'bullish') }), [], 'SPOT'],
  ] as const)('%s: 필수 필드를 모두 포함한다', (_label, analysis, positions, expected) => {
    const result = runAiEngine(makeInput({ analyses: [analysis], positions }));
    expect(result.operatingState).toBe(expected);
    expect(typeof result.confidence).toBe('number');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.reasoning)).toBe(true);
    expect(typeof result.stateRationale).toBe('string');
    expect(result.reasoning.length).toBeGreaterThan(0);
  });
});

// ── Worker 재시작 복구: prevState 보존 ────────────────────────────────────────

describe('[브라우저] Worker 재시작 복구', () => {
  it('prevState는 출력에 그대로 보존된다 (DB에서 복원 후 다음 사이클)', () => {
    const states = ['SPOT', 'LONG', 'SHORT', 'HEDGE', 'CASH'] as const;
    const analysis = makeAnalysis({ bullishScore: 30, bearishScore: 30, opportunityScore: 30 });
    for (const state of states) {
      expect(runAiEngine(makeInput({ analyses: [analysis], prevState: state })).prevState)
        .toBe(state);
    }
  });

  it('cycleNumber는 입력값을 그대로 전달한다', () => {
    const analysis = makeAnalysis({ bullishScore: 70, opportunityScore: 80,
                                    indicators: makeIndicators(2.0,'bullish') });
    expect(runAiEngine(makeInput({ analyses: [analysis], cycleNumber: 99 })).cycleNumber).toBe(99);
  });
});

// ── 위험 한도 게이트 ─────────────────────────────────────────────────────────

describe('[브라우저] 위험 한도 게이트', () => {
  const longAnalysis = makeAnalysis({
    bullishScore: 70, bearishScore: 20, opportunityScore: 80,
    indicators: makeIndicators(2.0, 'bullish'),
  });

  it('account.realizedPnlToday가 일간 한도의 90% 초과이면 CASH를 반환한다', () => {
    // deriveRiskLevel은 account.realizedPnlToday + account.unrealizedPnl을 사용함
    const result = runAiEngine(makeInput({
      analyses: [longAnalysis],
      account:  { ...BASE_ACCOUNT, realizedPnlToday: -451 },
      limits:   { ...BASE_LIMITS, dailyLossLimitUSDT: 500 },
    }));
    expect(result.operatingState).toBe('CASH');
  });

  it('consecutiveLosses ≥ consecutiveLossLimit 이면 CRITICAL → CASH', () => {
    expect(runAiEngine(makeInput({
      analyses:          [longAnalysis],
      consecutiveLosses: 5,
      limits:            { ...BASE_LIMITS, consecutiveLossLimit: 5 },
    })).operatingState).toBe('CASH');
  });

  // 참고: accountDrawdownPct(HWM 드로다운)는 서버 stateEngine 전용 필드입니다.
  // 브라우저 EngineInput에는 이 필드가 없으므로 여기서는 검증하지 않습니다.
  // 서버 측 HWM 드로다운 게이트는 api-server/src/__tests__/riskGates.test.ts에서 검증합니다.
  it('ATR이 HIGH_VOL_ATR_PCT(8%) 초과이면 CRITICAL → CASH', () => {
    const highVolAnalysis = makeAnalysis({
      bullishScore: 70, bearishScore: 20, opportunityScore: 80,
      indicators: makeIndicators(9.0, 'bullish'),  // 9% ATR > 8%
    });
    expect(runAiEngine(makeInput({ analyses: [highVolAnalysis] }))
      .operatingState).toBe('CASH');
  });
});
