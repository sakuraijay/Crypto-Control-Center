/**
 * Risk Gate 테스트 — 안전 게이트 / 한도 초과 시 CASH 강제 반환 검증
 *
 * 모든 위험 게이트는 순수 함수 runAiEngine()에서 처리됩니다.
 * 외부 의존성 없음.
 *
 * 핵심 구현 세부사항:
 *  - deriveRiskLevel()은 account.realizedPnlToday + account.unrealizedPnl으로
 *    일간 손실을 계산한다 (EngineInput.dailyRealizedPnlUsd가 아님).
 *  - accountDrawdownPct는 runAiEngine() 최상위에서 별도로 체크된다.
 */
import { describe, it, expect } from 'vitest';
import { runAiEngine } from '../workers/stateEngine';
import {
  makeInput, makeAnalysis, makePosition,
  LONG_ANALYSIS, BASE_LIMITS, BASE_ACCOUNT,
} from './fixtures';

// ── 안전 게이트: 데이터 신선도 / 엔진 상태 ────────────────────────────────────

describe('안전 게이트 — 데이터 신선도 / 엔진 상태', () => {
  it('EMERGENCY_STOP 상태이면 즉시 CASH를 반환한다', () => {
    const result = runAiEngine(makeInput({
      analyses:    [LONG_ANALYSIS],
      engineState: 'EMERGENCY_STOP',
    }));
    expect(result.operatingState).toBe('CASH');
    expect(result.riskVetoReason).toMatch(/emergency/i);
  });

  it('dataFreshMs > 60000 (60초 초과) 이면 CASH를 반환한다', () => {
    const result = runAiEngine(makeInput({
      analyses:    [LONG_ANALYSIS],
      dataFreshMs: 61_000,
    }));
    expect(result.operatingState).toBe('CASH');
    expect(result.riskVetoReason).toMatch(/stale/i);
  });

  it('dataFreshMs = 59000 (60초 미만) 이면 CASH가 아니다', () => {
    const result = runAiEngine(makeInput({
      analyses:    [LONG_ANALYSIS],
      dataFreshMs: 59_000,
    }));
    expect(result.operatingState).not.toBe('CASH');
  });
});

// ── 위험 한도: 일간 손실 ───────────────────────────────────────────────────────
//
// deriveRiskLevel()에서 일간 손실 = account.realizedPnlToday + account.unrealizedPnl
// EngineInput.dailyRealizedPnlUsd가 아님에 주의.

describe('위험 한도 — 일간 손실 한도 초과 시 CASH', () => {
  it('account.realizedPnlToday가 일간 한도의 90% 초과이면 CRITICAL → CASH', () => {
    // lossLimitPct = 451/500 = 0.902 > 0.9 → CRITICAL
    const result = runAiEngine(makeInput({
      analyses: [LONG_ANALYSIS],
      account:  { ...BASE_ACCOUNT, realizedPnlToday: -451 },
      limits:   { ...BASE_LIMITS, dailyLossLimitUSDT: 500 },
    }));
    expect(result.operatingState).toBe('CASH');
    expect(result.riskLevel).toBe('CRITICAL');
  });

  it('일간 손실이 한도의 89%이면 CRITICAL이 아니다', () => {
    // 445/500 = 0.89 ≤ 0.9 → NOT CRITICAL (might be HIGH)
    const result = runAiEngine(makeInput({
      analyses: [LONG_ANALYSIS],
      account:  { ...BASE_ACCOUNT, realizedPnlToday: -445 },
      limits:   { ...BASE_LIMITS, dailyLossLimitUSDT: 500 },
    }));
    expect(result.riskLevel).not.toBe('CRITICAL');
  });
});

// ── 위험 한도: 주간/24h 손실 ─────────────────────────────────────────────────

describe('위험 한도 — 주간 / 24h 손실', () => {
  it('주간 손실이 한도 100% 초과이면 CRITICAL → CASH', () => {
    // 1600/1500 = 1.067 ≥ 1.0 → CRITICAL
    const result = runAiEngine(makeInput({
      analyses:             [LONG_ANALYSIS],
      weeklyRealizedPnlUsd: -1600,
      limits:               { ...BASE_LIMITS, weeklyLossLimitUSDT: 1_500 },
    }));
    expect(result.operatingState).toBe('CASH');
  });

  it('주간 손실 한도 = 0 이면 비활성화 (체크 스킵)', () => {
    const result = runAiEngine(makeInput({
      analyses:             [LONG_ANALYSIS],
      weeklyRealizedPnlUsd: -9999,
      limits:               { ...BASE_LIMITS, weeklyLossLimitUSDT: 0 },
    }));
    // weeklyLossLimitUSDT=0 → check disabled → proceeds to LONG
    expect(result.operatingState).toBe('LONG');
  });

  it('rolling 24h 손실이 한도 100% 초과이면 CASH (runAiEngine 초기 체크)', () => {
    // 상위 레벨 체크: rolling24hRealizedPnlUsd < -(rolling24hLossLimitUSDT)
    const result = runAiEngine(makeInput({
      analyses:                 [LONG_ANALYSIS],
      rolling24hRealizedPnlUsd: -201,
      limits:                   { ...BASE_LIMITS, rolling24hLossLimitUSDT: 200 },
    }));
    expect(result.operatingState).toBe('CASH');
  });
});

// ── 위험 한도: HWM 드로다운 ───────────────────────────────────────────────────

describe('HWM 드로다운 게이트 (accountDrawdownPct)', () => {
  it('accountDrawdownPct ≥ maxDrawdownPercent 이면 CASH', () => {
    const result = runAiEngine(makeInput({
      analyses:           [LONG_ANALYSIS],
      accountDrawdownPct: 21,   // 21% >= 20%
      limits:             { ...BASE_LIMITS, maxDrawdownPercent: 20 },
    }));
    expect(result.operatingState).toBe('CASH');
    expect(result.riskVetoReason).toMatch(/드로다운/);
  });

  it('accountDrawdownPct < maxDrawdownPercent 이면 정상 진행', () => {
    const result = runAiEngine(makeInput({
      analyses:           [LONG_ANALYSIS],
      accountDrawdownPct: 19,   // 19% < 20%
      limits:             { ...BASE_LIMITS, maxDrawdownPercent: 20 },
    }));
    expect(result.operatingState).toBe('LONG');
  });

  it('accountDrawdownPct = undefined 이면 HWM 체크 스킵 (첫 사이클)', () => {
    const input = makeInput({ analyses: [LONG_ANALYSIS] });
    delete (input as unknown as Record<string, unknown>).accountDrawdownPct;
    const result = runAiEngine(input);
    expect(result.operatingState).toBe('LONG');
  });
});

// ── 위험 수준: CRITICAL → CASH ────────────────────────────────────────────────

describe('CRITICAL 위험 수준 → CASH', () => {
  it('consecutiveLosses ≥ consecutiveLossLimit 이면 CRITICAL → CASH', () => {
    const result = runAiEngine(makeInput({
      analyses:          [LONG_ANALYSIS],
      consecutiveLosses: 5,   // = consecutiveLossLimit=5 → CRITICAL
      limits:            { ...BASE_LIMITS, consecutiveLossLimit: 5 },
    }));
    expect(result.operatingState).toBe('CASH');
    expect(result.riskLevel).toBe('CRITICAL');
  });

  it('연속 손실이 한도보다 1 적으면 CRITICAL이 아니다', () => {
    const result = runAiEngine(makeInput({
      analyses:          [LONG_ANALYSIS],
      consecutiveLosses: 4,   // 4 < 5 → NOT CRITICAL
      limits:            { ...BASE_LIMITS, consecutiveLossLimit: 5 },
    }));
    expect(result.riskLevel).not.toBe('CRITICAL');
  });
});

// ── LIVE TEST 모드 안전 제약 ──────────────────────────────────────────────────

describe('LIVE TEST 모드 안전 제약', () => {
  it('liveTestAccumLossUsd ≥ testMaxLossUsd 이면 CASH (fail-closed)', () => {
    const result = runAiEngine(makeInput({
      analyses:             [LONG_ANALYSIS],
      isLiveMode:           true,
      liveTestAccumLossUsd: 51,   // 51 > testMaxLossUsd=50
      limits: {
        ...BASE_LIMITS,
        liveTestMode:   true,
        testBudgetUsd:   100,
        testMaxLossUsd:   50,
        testMaxLeverage:   2,
      },
    }));
    expect(result.operatingState).toBe('CASH');
  });

  it('LIVE TEST 모드에서 leverage가 testMaxLeverage(2)로 제한된다', () => {
    const result = runAiEngine(makeInput({
      analyses:             [LONG_ANALYSIS],
      isLiveMode:           true,
      liveTestAccumLossUsd:   0,
      limits: {
        ...BASE_LIMITS,
        liveTestMode:    true,
        testMaxLossUsd:  1000,   // 큰 값 → 손실 한도 미도달
        testBudgetUsd:   5000,   // 충분한 예산
        testMaxLeverage:    2,
        maxLeverage:       10,
      },
    }));
    // LONG이 선택된 경우 leverage ≤ 2
    if (result.operatingState === 'LONG' && result.leverage !== undefined) {
      expect(result.leverage).toBeLessThanOrEqual(2);
    }
  });

  it('liveTestDbOk = false 이면 LIVE 모드에서 fail-closed → CASH', () => {
    const result = runAiEngine(makeInput({
      analyses:     [LONG_ANALYSIS],
      isLiveMode:   true,
      liveTestDbOk: false,
      limits: {
        ...BASE_LIMITS,
        liveTestMode:   true,
        testMaxLossUsd:  50,
      },
    }));
    expect(result.operatingState).toBe('CASH');
  });
});
