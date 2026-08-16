/**
 * AI 5-State 엔진 — 서버 측 결정론적 단위 테스트
 *
 * runAiEngine()은 순수 함수이므로 외부 의존성이 없습니다.
 * 모든 5개 상태(SPOT/LONG/SHORT/HEDGE/CASH)를 통제된 입력으로 검증합니다.
 */
import { describe, it, expect } from 'vitest';
import { runAiEngine } from '../workers/stateEngine';
import {
  makeInput,
  makeAnalysis,
  makePosition,
  CASH_ANALYSIS,
  LONG_ANALYSIS,
  SHORT_ANALYSIS,
  SPOT_ANALYSIS,
  HEDGE_ANALYSIS,
  HEDGE_POSITION,
  BASE_LIMITS,
  T,
} from './fixtures';

// ── CASH 상태 ──────────────────────────────────────────────────────────────────

describe('CASH 상태', () => {
  it('신호가 CASH_MAX_SIGNAL(44) 미만일 때 CASH를 반환한다', () => {
    const result = runAiEngine(makeInput({ analyses: [CASH_ANALYSIS] }));
    expect(result.operatingState).toBe('CASH');
  });

  it('avgATR > HIGH_VOL_ATR_PCT(8%) 일 때 CASH를 반환한다', () => {
    const analysis = makeAnalysis({
      bullishScore: 70,
      opportunityScore: 80,
      indicators: { ...LONG_ANALYSIS.indicators, atrPct: 9.0 },
    });
    const result = runAiEngine(makeInput({ analyses: [analysis] }));
    expect(result.operatingState).toBe('CASH');
  });

  it('analyses가 비어 있으면 CASH를 반환한다', () => {
    const result = runAiEngine(makeInput({ analyses: [] }));
    expect(result.operatingState).toBe('CASH');
  });

  it('prevState가 CASH이면 stateChanged = false', () => {
    const result = runAiEngine(makeInput({ analyses: [CASH_ANALYSIS], prevState: 'CASH' }));
    expect(result.stateChanged).toBe(false);
  });
});

// ── LONG 상태 ──────────────────────────────────────────────────────────────────

describe('LONG 상태', () => {
  it('bullishScore ≥ 68 이고 ATR ≥ 1.5% 이면 LONG을 반환한다', () => {
    const result = runAiEngine(makeInput({ analyses: [LONG_ANALYSIS] }));
    expect(result.operatingState).toBe('LONG');
  });

  it('LONG 결정은 leverage를 포함한다', () => {
    const result = runAiEngine(makeInput({ analyses: [LONG_ANALYSIS] }));
    expect(typeof result.leverage).toBe('number');
    expect((result.leverage ?? 0) > 0).toBe(true);
  });

  it('LONG 결정은 sizeUsd를 포함한다', () => {
    const result = runAiEngine(makeInput({ analyses: [LONG_ANALYSIS] }));
    expect(typeof result.sizeUsd).toBe('number');
    expect((result.sizeUsd ?? 0) > 0).toBe(true);
  });

  it('LONG 결정은 executionType perp_long_open 또는 scale_in', () => {
    const result = runAiEngine(makeInput({ analyses: [LONG_ANALYSIS] }));
    expect(['perp_long_open', 'scale_in']).toContain(result.executionType);
  });

  it('LONG이면 stateChanged = true (prevState = CASH)', () => {
    const result = runAiEngine(makeInput({ analyses: [LONG_ANALYSIS], prevState: 'CASH' }));
    expect(result.stateChanged).toBe(true);
  });

  it('bullishScore = 67 (임계값 미만) 이면 LONG이 아니다', () => {
    const analysis = makeAnalysis({
      bullishScore: 67,
      opportunityScore: 80,
      indicators: { ...LONG_ANALYSIS.indicators, atrPct: 2.0 },
    });
    const result = runAiEngine(makeInput({ analyses: [analysis] }));
    expect(result.operatingState).not.toBe('LONG');
  });
});

// ── SHORT 상태 ─────────────────────────────────────────────────────────────────

describe('SHORT 상태', () => {
  it('bearishScore ≥ 68 이고 ATR ≥ 1.5% 이면 SHORT를 반환한다', () => {
    const result = runAiEngine(makeInput({ analyses: [SHORT_ANALYSIS] }));
    expect(result.operatingState).toBe('SHORT');
  });

  it('SHORT 결정은 executionType perp_short_open 또는 scale_in', () => {
    const result = runAiEngine(makeInput({ analyses: [SHORT_ANALYSIS] }));
    expect(['perp_short_open', 'scale_in']).toContain(result.executionType);
  });

  it('SHORT 결정은 leverage와 sizeUsd를 포함한다', () => {
    const result = runAiEngine(makeInput({ analyses: [SHORT_ANALYSIS] }));
    expect((result.leverage ?? 0) > 0).toBe(true);
    expect((result.sizeUsd ?? 0) > 0).toBe(true);
  });

  it('bearishScore = 67 (임계값 미만) 이면 SHORT가 아니다', () => {
    const analysis = makeAnalysis({
      bearishScore: 67,
      bullishScore: 20,
      opportunityScore: 80,
      indicators: { ...SHORT_ANALYSIS.indicators, atrPct: 2.0 },
    });
    const result = runAiEngine(makeInput({ analyses: [analysis] }));
    expect(result.operatingState).not.toBe('SHORT');
  });
});

// ── SPOT 상태 ──────────────────────────────────────────────────────────────────

describe('SPOT 상태', () => {
  it('bullishScore ≥ 60 이고 ATR < 1.5% 이면 SPOT을 반환한다', () => {
    const result = runAiEngine(makeInput({ analyses: [SPOT_ANALYSIS] }));
    expect(result.operatingState).toBe('SPOT');
  });

  it('SPOT 결정은 executionType spot_swap이다', () => {
    const result = runAiEngine(makeInput({ analyses: [SPOT_ANALYSIS] }));
    expect(result.executionType).toBe('spot_swap');
  });

  it('SPOT은 레버리지 없이 sizeUsd를 포함한다', () => {
    const result = runAiEngine(makeInput({ analyses: [SPOT_ANALYSIS] }));
    expect((result.sizeUsd ?? 0) > 0).toBe(true);
    // SPOT은 레버리지 포지션이 아님
    expect(result.leverage).toBeFalsy();
  });

  it('ATR ≥ 1.5% 이면 SPOT이 아니라 LONG/CASH', () => {
    const analysis = makeAnalysis({
      bullishScore: 65,
      bearishScore: 20,
      opportunityScore: 70,
      indicators: { ...SPOT_ANALYSIS.indicators, atrPct: 2.0 },
    });
    const result = runAiEngine(makeInput({ analyses: [analysis] }));
    // ATR >= SPOT_ATR_MAX 이면 SPOT이 아님 (LONG 또는 CASH)
    expect(result.operatingState).not.toBe('SPOT');
  });

  it('bullishScore = 59 (임계값 미만) 이면 SPOT이 아니다', () => {
    const analysis = makeAnalysis({
      bullishScore: 59,
      bearishScore: 20,
      opportunityScore: 60,
      indicators: { ...SPOT_ANALYSIS.indicators, atrPct: 0.8 },
    });
    const result = runAiEngine(makeInput({ analyses: [analysis] }));
    expect(result.operatingState).not.toBe('SPOT');
  });
});

// ── HEDGE 상태 ─────────────────────────────────────────────────────────────────

describe('HEDGE 상태', () => {
  it('포지션 드로다운 ≥ 4% + 역신호 ≥ 55 이면 HEDGE를 반환한다', () => {
    const result = runAiEngine(makeInput({
      analyses:  [HEDGE_ANALYSIS],
      positions: [HEDGE_POSITION],
    }));
    expect(result.operatingState).toBe('HEDGE');
  });

  it('HEDGE 결정은 executionType hedge_open이다', () => {
    const result = runAiEngine(makeInput({
      analyses:  [HEDGE_ANALYSIS],
      positions: [HEDGE_POSITION],
    }));
    expect(result.executionType).toBe('hedge_open');
  });

  it('HEDGE 결정은 hedgeParams를 포함한다', () => {
    const result = runAiEngine(makeInput({
      analyses:  [HEDGE_ANALYSIS],
      positions: [HEDGE_POSITION],
    }));
    expect(result.hedgeParams).toBeDefined();
    expect(result.hedgeParams?.direction).toMatch(/^(LONG|SHORT)$/);
    expect((result.hedgeParams?.sizeUsd ?? 0) > 0).toBe(true);
  });

  it('HEDGE는 우선순위 1이다 — LONG/SHORT 신호보다 먼저 평가된다', () => {
    // bullishScore=70 (LONG 임계값 이상) 이지만 HEDGE 조건이 충족되면 HEDGE가 선택됨
    const analysis = makeAnalysis({
      bullishScore:     70,
      bearishScore:     55, // 역신호
      opportunityScore: 80,
      indicators: makeAnalysis().indicators,
    });
    const result = runAiEngine(makeInput({
      analyses:  [analysis],
      positions: [HEDGE_POSITION],
    }));
    expect(result.operatingState).toBe('HEDGE');
  });

  it('포지션이 없으면 HEDGE가 아니다', () => {
    const result = runAiEngine(makeInput({
      analyses:  [HEDGE_ANALYSIS],
      positions: [],           // 포지션 없음
    }));
    expect(result.operatingState).not.toBe('HEDGE');
  });

  it('드로다운 < 4% 이면 HEDGE가 아니다', () => {
    const safePosition = makePosition({
      unrealizedPnl: -30,   // 30/1000 * 100 = 3% < 4%
      collateralUsd: 1_000,
    });
    const result = runAiEngine(makeInput({
      analyses:  [HEDGE_ANALYSIS],
      positions: [safePosition],
    }));
    expect(result.operatingState).not.toBe('HEDGE');
  });

  it('역신호 < 55 이면 HEDGE가 아니다', () => {
    const weakSignalAnalysis = makeAnalysis({
      bullishScore:     54, // < HEDGE_COUNTER_SIGNAL
      bearishScore:     54, // < HEDGE_COUNTER_SIGNAL
      opportunityScore: 55,
      indicators: makeAnalysis().indicators,
    });
    const result = runAiEngine(makeInput({
      analyses:  [weakSignalAnalysis],
      positions: [HEDGE_POSITION],
    }));
    expect(result.operatingState).not.toBe('HEDGE');
  });
});

// ── 공통 출력 구조 검증 ────────────────────────────────────────────────────────

describe('결정 출력 구조', () => {
  it.each([
    ['CASH',  makeInput({ analyses: [CASH_ANALYSIS] })],
    ['LONG',  makeInput({ analyses: [LONG_ANALYSIS] })],
    ['SHORT', makeInput({ analyses: [SHORT_ANALYSIS] })],
    ['SPOT',  makeInput({ analyses: [SPOT_ANALYSIS] })],
    ['HEDGE', makeInput({ analyses: [HEDGE_ANALYSIS], positions: [HEDGE_POSITION] })],
  ] as const)('%s 결정은 필수 필드를 모두 포함한다', (_label, input) => {
    const result = runAiEngine(input);
    expect(typeof result.operatingState).toBe('string');
    expect(typeof result.cycleNumber).toBe('number');
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.stateChanged).toBe('boolean');
    expect(Array.isArray(result.selectedSymbols)).toBe(true);
    expect(typeof result.stateRationale).toBe('string');
    expect(Array.isArray(result.reasoning)).toBe(true);
    expect(result.reasoning.length).toBeGreaterThan(0);
    expect(result.profitLockStage).toBeGreaterThanOrEqual(0);
  });

  it('Worker 재시작 복구: prevState는 출력에 보존된다', () => {
    for (const state of ['SPOT', 'LONG', 'SHORT', 'HEDGE', 'CASH'] as const) {
      const result = runAiEngine(makeInput({
        analyses:  [CASH_ANALYSIS],
        prevState: state,
      }));
      expect(result.prevState).toBe(state);
    }
  });

  it('cycleNumber는 입력값을 그대로 전달한다', () => {
    const result = runAiEngine(makeInput({ analyses: [LONG_ANALYSIS], cycleNumber: 42 }));
    expect(result.cycleNumber).toBe(42);
  });
});

// ── 5-State 경계값 검증 (임계값 정확성) ───────────────────────────────────────

describe('임계값 경계 검증', () => {
  it(`bullishScore = ${T.LONG_BULLISH_MIN} (정확한 임계값)이면 LONG`, () => {
    const analysis = makeAnalysis({
      bullishScore:     T.LONG_BULLISH_MIN,
      bearishScore:     20,
      opportunityScore: 80,
      indicators:       makeAnalysis().indicators,
    });
    // indicators.atrPct = 2.0 >= SPOT_ATR_MAX(1.5) 이므로 LONG 경로
    const result = runAiEngine(makeInput({ analyses: [analysis] }));
    expect(result.operatingState).toBe('LONG');
  });

  it(`bullishScore = ${T.SPOT_BULLISH_MIN} (정확한 임계값)이면 SPOT (ATR < 1.5%)`, () => {
    const analysis = makeAnalysis({
      bullishScore:     T.SPOT_BULLISH_MIN,
      bearishScore:     20,
      opportunityScore: 70,
      indicators:       makeAnalysis({ indicators: makeAnalysis().indicators }).indicators,
    });
    // ATR을 0.8%로 설정
    analysis.indicators.atrPct = 0.8;
    const result = runAiEngine(makeInput({ analyses: [analysis] }));
    expect(result.operatingState).toBe('SPOT');
  });
});
