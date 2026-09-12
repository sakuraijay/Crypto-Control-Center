/**
 * 6H-1 §16 — $1,000 최종 운용 정책 RiskEngine 테스트.
 * 순수 모듈만 검증 (DB-free) — riskPolicy/riskCapital/riskPnl/
 * riskStateMachine/riskSizing/manilaTime/riskEngineState.
 */
import { describe, it, expect } from 'vitest';
import {
  RISK_POLICY, CANARY_POLICY, CAPITAL_PLAN, CAPITAL_TIER_LADDER,
  deriveDailyTargets, deriveWeeklyMaxLossUsd, deriveTradeRiskUsd,
  evaluateCanaryGate, evaluateCapitalPromotion, isAutoPromotionAllowed,
} from '../lib/riskPolicy';
import { dailyRiskCapital, weeklyRiskCapital, positionSizingCapital } from '../lib/riskCapital';
import { realizedNetPnl, estimatedExitNetPnl, lossAwareNetPnl } from '../lib/riskPnl';
import {
  evaluateRiskState, resetDailyLocks, resetWeeklyLocks, EMPTY_LOCKS,
  type RiskEvaluationInput, type PersistedLocks,
} from '../lib/riskStateMachine';
import { computePositionSize, allowedMaxLeverage } from '../lib/riskSizing';
import {
  manilaDayStartIso, manilaWeekStartIso, msUntilNextManilaDay,
} from '../lib/manilaTime';
import {
  initialRiskEngineState, rollRiskPeriods, parseRiskEngineState,
} from '../lib/riskEngineState';

const NOW = new Date('2026-08-18T04:00:00Z'); // Manila 화요일 12:00

function obs(equityUsd: number, recordedAt = manilaDayStartIso(NOW)) {
  return { equityUsd, recordedAt };
}
const MAX_AGE = 8 * 24 * 3600 * 1000;

function baseInput(overrides: Partial<RiskEvaluationInput> = {}): RiskEvaluationInput {
  return {
    dailyRiskCapitalUsd: 1000,
    weeklyRiskCapitalUsd: 1000,
    currentEquityUsd: 1000,
    dailyRealizedNetPnlUsd: 0,
    dailyLossAwareNetPnlUsd: 0,
    estimatedExitNetPnlUsd: null,
    weeklyRealizedNetPnlUsd: 0,
    dailyEntryCount: 0,
    consecutiveLossCount: 0,
    openPositionCount: 0,
    dbOk: true,
    feeDataOk: true,
    marketDataFresh: true,
    locks: { ...EMPTY_LOCKS },
    ...overrides,
  };
}

// ── 파생값 (§16 #1-3) ──────────────────────────────────────────────────────────
describe('policy derivations', () => {
  it('Active $1,000 → 과열 50/100, 일손실 10, 보호 35, 주간 80, 위험 2.50/5', () => {
    const t = deriveDailyTargets(1000);
    expect(t.primaryProfitTargetUsd).toBe(50);
    expect(t.absoluteProfitCapUsd).toBe(100);
    expect(t.dailyMaxLossUsd).toBe(10);
    expect(t.protectedProfitFloorUsd).toBe(35);
    expect(t.defensiveModeLossUsd).toBe(5);
    expect(deriveWeeklyMaxLossUsd(1000)).toBe(80);
    const r = deriveTradeRiskUsd(1000);
    expect(r.baseRiskUsd).toBe(2.5);
    expect(r.absoluteMaxRiskUsd).toBe(5);
  });

  it('equity $900 → 45/90/9 (기준 자본 축소)', () => {
    const cap = dailyRiskCapital(obs(900), NOW, MAX_AGE);
    expect(cap.ok && cap.capitalUsd).toBe(900);
    const t = deriveDailyTargets(900);
    expect(t.primaryProfitTargetUsd).toBe(45);
    expect(t.absoluteProfitCapUsd).toBe(90);
    expect(t.dailyMaxLossUsd).toBe(9);
  });

  it('equity $1,200 → 자본은 $1,000으로 캡 (복리 금지 — 50/100/30 유지)', () => {
    const cap = dailyRiskCapital(obs(1200), NOW, MAX_AGE);
    expect(cap.ok && cap.capitalUsd).toBe(1000);
    const w = weeklyRiskCapital(obs(1200), NOW, MAX_AGE);
    expect(w.ok && w.capitalUsd).toBe(1000);
    const p = positionSizingCapital(obs(5000, NOW.toISOString()), NOW, MAX_AGE);
    expect(p.ok && p.capitalUsd).toBe(1000);
  });

  it('비정상 equity 관측값은 전부 거부 (fail-closed)', () => {
    expect(dailyRiskCapital(obs(NaN), NOW, MAX_AGE).ok).toBe(false);
    expect(dailyRiskCapital(obs(-1), NOW, MAX_AGE).ok).toBe(false);
    expect(dailyRiskCapital(obs(Infinity), NOW, MAX_AGE).ok).toBe(false);
    expect(dailyRiskCapital(null, NOW, MAX_AGE).ok).toBe(false);
    // 미래 timestamp 거부
    expect(dailyRiskCapital(obs(1000, '2026-08-19T00:00:00Z'), NOW, MAX_AGE).ok).toBe(false);
    // stale 거부
    expect(dailyRiskCapital(obs(1000, '2026-07-01T00:00:00Z'), NOW, MAX_AGE).ok).toBe(false);
  });
});

// ── 순수익 계산 (§16 #5-6) ─────────────────────────────────────────────────────
describe('net PnL fail-closed', () => {
  it('fee 차감 후 순수익 — gross +$52, 비용 $4 → net $48 (목표 $50 미달)', () => {
    const r = realizedNetPnl({
      grossRealizedPnlUsd: 52, positionFeesUsd: 2, executionFeesUsd: 1,
      priceImpactUsd: 0.5, fundingFeesUsd: 0.3, borrowingFeesUsd: 0.2, otherSettlementCostsUsd: 0,
    });
    expect(r.ok && r.pnlUsd).toBe(48);
    const t = deriveDailyTargets(1000);
    expect((r.ok ? r.pnlUsd : 0) >= t.primaryProfitTargetUsd).toBe(false);
  });

  it('비용 필드 하나라도 결측 → 실패 (가짜 0 금지)', () => {
    expect(realizedNetPnl({ grossRealizedPnlUsd: 52 }).ok).toBe(false);
    expect(realizedNetPnl(null).ok).toBe(false);
  });

  it('unrealized로 목표 달성 금지 — realized $10 + unrealized $45는 realized 기준 미달', () => {
    const realized = realizedNetPnl({
      grossRealizedPnlUsd: 10, positionFeesUsd: 0, executionFeesUsd: 0,
      priceImpactUsd: 0, fundingFeesUsd: 0, borrowingFeesUsd: 0, otherSettlementCostsUsd: 0,
    });
    expect(realized.ok && realized.pnlUsd).toBe(10);
    // PROFIT_TARGET_LOCKED는 realized 기준에서만 발동
    const r = evaluateRiskState(baseInput({
      dailyRealizedNetPnlUsd: 10, estimatedExitNetPnlUsd: 45, openPositionCount: 1,
      dailyLossAwareNetPnlUsd: 10,
    }));
    expect(r.state).not.toBe('PROFIT_TARGET_LOCKED');
  });

  it('lossAware = min(realized, estimated); 포지션 있는데 estimated 실패 → 실패', () => {
    const ok = (v: number) => ({ ok: true as const, pnlUsd: v });
    const la = lossAwareNetPnl(ok(5), ok(-12), true);
    expect(la.ok && la.pnlUsd).toBe(-12);
    expect(lossAwareNetPnl(ok(5), { ok: false, reason: 'x' }, true).ok).toBe(false);
    expect(lossAwareNetPnl(ok(5), null, true).ok).toBe(false);
    const noPos = lossAwareNetPnl(ok(5), null, false);
    expect(noPos.ok && noPos.pnlUsd).toBe(5);
  });

  it('estimatedExitNetPnl은 exit 비용 보수적 차감', () => {
    const e = estimatedExitNetPnl({
      realizedNetPnlUsd: 10, unrealizedPnlUsd: 50,
      estimatedExitFeeUsd: 3, estimatedNegativeImpactUsd: 2, accruedFundingBorrowingUsd: 1,
    });
    expect(e.ok && e.pnlUsd).toBe(54);
    expect(estimatedExitNetPnl({ realizedNetPnlUsd: 10 }).ok).toBe(false);
  });
});

// ── 상태 머신 (§16 #7-14) ─────────────────────────────────────────────────────
describe('risk state machine', () => {
  it('+5% estimated → PROFIT_PROTECTED: 70% 축소 + 신규 진입 금지 + floor 3.5%', () => {
    const r = evaluateRiskState(baseInput({
      estimatedExitNetPnlUsd: 51, openPositionCount: 1, dailyLossAwareNetPnlUsd: 0,
    }));
    expect(r.state).toBe('PROFIT_PROTECTED');
    expect(r.entryAllowed).toBe(false);
    expect(r.actions).toContain('REDUCE_POSITION_70PCT');
    expect(r.locks.protectedProfitFloorUsd).toBe(35);
  });

  it('+3.5% floor 후퇴 → 잔여 전량 종료', () => {
    const locks: PersistedLocks = {
      ...EMPTY_LOCKS, dailyLockState: 'PROFIT_PROTECTED',
      dailyLockReason: 'test', protectedProfitFloorUsd: 35, profitReductionDone: true,
    };
    const r = evaluateRiskState(baseInput({
      estimatedExitNetPnlUsd: 34, openPositionCount: 1, locks,
    }));
    expect(r.state).toBe('PROFIT_PROTECTED');
    expect(r.actions).toContain('CLOSE_ALL_POSITIONS');
  });

  it('+5% realized → PROFIT_TARGET_LOCKED: 부분청산으로 5% 미만 되어도 재진입 금지', () => {
    const r = evaluateRiskState(baseInput({ dailyRealizedNetPnlUsd: 50 }));
    expect(r.state).toBe('PROFIT_TARGET_LOCKED');
    expect(r.entryAllowed).toBe(false);
    // 이월: realized가 다시 낮아져도 잠금 유지
    const r2 = evaluateRiskState(baseInput({ dailyRealizedNetPnlUsd: 40, locks: r.locks }));
    expect(r2.state).toBe('PROFIT_TARGET_LOCKED');
    expect(r2.entryAllowed).toBe(false);
  });

  it('+10% → PROFIT_CAP_LOCKED: 전량 종료+취소+당일 잠금, 종료 비용 후 재진입 금지', () => {
    const r = evaluateRiskState(baseInput({ dailyRealizedNetPnlUsd: 100 }));
    expect(r.state).toBe('PROFIT_CAP_LOCKED');
    expect(r.actions).toEqual(expect.arrayContaining(['CLOSE_ALL_POSITIONS', 'CANCEL_ALL_ORDERS']));
    // 종료 비용으로 realized $97로 하락해도 잠금 유지
    const r2 = evaluateRiskState(baseInput({ dailyRealizedNetPnlUsd: 97, locks: r.locks }));
    expect(r2.state).toBe('PROFIT_CAP_LOCKED');
    expect(r2.entryAllowed).toBe(false);
    // estimated 기준으로도 발동
    const r3 = evaluateRiskState(baseInput({ estimatedExitNetPnlUsd: 101, openPositionCount: 1 }));
    expect(r3.state).toBe('PROFIT_CAP_LOCKED');
  });

  it('-0.5% → DEFENSIVE: size 50%·2x·잔여 1회', () => {
    const r = evaluateRiskState(baseInput({ dailyLossAwareNetPnlUsd: -5 }));
    expect(r.state).toBe('DEFENSIVE');
    expect(r.entryAllowed).toBe(true);
    expect(r.sizeFactor).toBe(0.5);
    expect(r.maxLeverage).toBe(2);
    // 잔여 1회 소진 후 차단
    const usedLocks = { ...r.locks, defensiveEntriesUsed: 1 };
    const r2 = evaluateRiskState(baseInput({ dailyLossAwareNetPnlUsd: -20, locks: usedLocks }));
    expect(r2.entryAllowed).toBe(false);
  });

  it('-3% → DAILY_LOSS_LOCKED (전량 종료+취소)', () => {
    const r = evaluateRiskState(baseInput({ dailyLossAwareNetPnlUsd: -30 }));
    expect(r.state).toBe('DAILY_LOSS_LOCKED');
    expect(r.actions).toEqual(expect.arrayContaining(['CLOSE_ALL_POSITIONS', 'CANCEL_ALL_ORDERS']));
  });

  it('-8% 주간 → WEEKLY_LOSS_LOCKED; 일일 reset으로 해제 안 됨', () => {
    const r = evaluateRiskState(baseInput({ weeklyRealizedNetPnlUsd: -80 }));
    expect(r.state).toBe('WEEKLY_LOSS_LOCKED');
    const afterDaily = resetDailyLocks(r.locks);
    expect(afterDaily.weeklyLockReason).not.toBeNull();
    const afterWeekly = resetWeeklyLocks(afterDaily);
    expect(afterWeekly.weeklyLockReason).toBeNull();
  });

  it('equity ≤ $850 → HARD_STOPPED (영구 — 어떤 reset으로도 해제 금지)', () => {
    const r = evaluateRiskState(baseInput({ currentEquityUsd: 850 }));
    expect(r.state).toBe('HARD_STOPPED');
    expect(r.actions).toEqual(expect.arrayContaining(['CLOSE_ALL_POSITIONS', 'CANCEL_ALL_ORDERS']));
    const after = resetWeeklyLocks(resetDailyLocks(r.locks));
    expect(after.hardStopReason).not.toBeNull();
    const r2 = evaluateRiskState(baseInput({ currentEquityUsd: 1000, locks: after }));
    expect(r2.state).toBe('HARD_STOPPED');
  });

  it('연속 손실 3회 → CONSECUTIVE_LOSS_LOCKED', () => {
    const r = evaluateRiskState(baseInput({ consecutiveLossCount: 3 }));
    expect(r.state).toBe('CONSECUTIVE_LOSS_LOCKED');
    expect(r.entryAllowed).toBe(false);
  });

  it('일일 진입 3회 도달 → 진입 차단; 동시 포지션 1개 초과 차단', () => {
    expect(evaluateRiskState(baseInput({ dailyEntryCount: 3 })).entryAllowed).toBe(false);
    expect(evaluateRiskState(baseInput({ dailyEntryCount: 2 })).entryAllowed).toBe(true);
    expect(evaluateRiskState(baseInput({ openPositionCount: 1 })).entryAllowed).toBe(false);
  });

  it('DB 실패 → UNRESOLVED + 진입 0회; fee/시장데이터 결측 → 진입 차단', () => {
    expect(evaluateRiskState(baseInput({ dbOk: false })).state).toBe('UNRESOLVED');
    expect(evaluateRiskState(baseInput({ feeDataOk: false })).entryAllowed).toBe(false);
    expect(evaluateRiskState(baseInput({ marketDataFresh: false })).entryAllowed).toBe(false);
    expect(evaluateRiskState(baseInput({ dailyRealizedNetPnlUsd: null })).entryAllowed).toBe(false);
    expect(evaluateRiskState(baseInput({
      locks: { ...EMPTY_LOCKS, unresolvedReason: '검증 실패' },
    })).state).toBe('UNRESOLVED');
  });

  it('NORMAL: 진입 허용, 3x', () => {
    const r = evaluateRiskState(baseInput());
    expect(r.state).toBe('NORMAL');
    expect(r.entryAllowed).toBe(true);
    expect(r.maxLeverage).toBe(3);
    expect(r.sizeFactor).toBe(1);
  });
});

// ── 사이징 (§16 #15-18) ────────────────────────────────────────────────────────
describe('risk-based sizing', () => {
  const base = {
    positionSizingCapitalUsd: 1000,
    stopDistanceFraction: 0.01,
    roundTripFeesFraction: 0.001,
    adverseImpactBufferFraction: 0.0005,
    fundingBorrowingBufferFraction: 0.0005,
    requestedLeverage: 3,
    liquidityCapUsd: 100_000,
    tierNotionalCapUsd: 100_000,
  };

  it('notional 역산: risk $7.50 / effective 1.2% → $625, 최종 min과 3x cap', () => {
    const r = computePositionSize(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.baseRiskUsd).toBe(2.5);
      expect(r.absoluteMaxRiskUsd).toBe(5);
      expect(r.effectiveStopLossFraction).toBeCloseTo(0.012);
      expect(r.maxNotionalByRisk).toBeCloseTo(208.333333);
      expect(r.finalNotionalUsd).toBeCloseTo(208.333333); // < 1000×3
      expect(r.allowedLeverage).toBe(3);
    }
  });

  it('stop 없으면 진입 금지; 비용 결측 fail-closed; 유동성 불명 fail-closed', () => {
    expect(computePositionSize({ ...base, stopDistanceFraction: 0 }).ok).toBe(false);
    expect(computePositionSize({ ...base, roundTripFeesFraction: NaN }).ok).toBe(false);
    expect(computePositionSize({ ...base, liquidityCapUsd: null }).ok).toBe(false);
  });

  it('5x 요청 무조건 거부; 3x 초과는 3x로 클램프; defensive 2x·50%', () => {
    expect(computePositionSize({ ...base, requestedLeverage: 5 }).ok).toBe(false);
    const r4 = computePositionSize({ ...base, requestedLeverage: 4 });
    expect(r4.ok && r4.allowedLeverage).toBe(3);
    expect(allowedMaxLeverage(false)).toBe(3);
    expect(allowedMaxLeverage(true)).toBe(2);
    const rd = computePositionSize({ ...base, stopDistanceFraction: 0.05, defensiveMode: true });
    const rn = computePositionSize({ ...base, stopDistanceFraction: 0.05 });
    expect(rd.ok && rn.ok && rd.finalNotionalUsd === rn.finalNotionalUsd * 0.5).toBe(true);
  });

  it('물타기/revenge 사이징 금지 — 손실 후에도 위험 산정은 capital 기준 고정', () => {
    // 남은 일일 목표나 직전 손실이 입력에 존재하지 않음 → 구조적으로 불가능.
    const after = computePositionSize({ ...base, useAbsoluteMaxRisk: false });
    expect(after.ok && after.allowedRiskUsd).toBe(2.5);
  });
});

// ── Manila 경계 (§16 #19-20) ───────────────────────────────────────────────────
describe('Manila time boundaries', () => {
  it('Manila 자정 직전/직후 거래일 구분', () => {
    const before = new Date('2026-08-18T15:59:00Z'); // Manila 23:59
    const after  = new Date('2026-08-18T16:01:00Z'); // Manila 다음날 00:01
    expect(manilaDayStartIso(before)).toBe('2026-08-17T16:00:00.000Z');
    expect(manilaDayStartIso(after)).toBe('2026-08-18T16:00:00.000Z');
    expect(msUntilNextManilaDay(before)).toBe(60_000);
  });

  it('Manila 월요일 00:00 주간 경계', () => {
    const sun = new Date('2026-08-16T15:59:00Z'); // Manila 일 23:59
    const mon = new Date('2026-08-16T16:00:00Z'); // Manila 월 00:00
    expect(manilaWeekStartIso(sun)).toBe('2026-08-09T16:00:00.000Z');
    expect(manilaWeekStartIso(mon)).toBe('2026-08-16T16:00:00.000Z');
  });

  it('rollRiskPeriods: 새 날 → daily reset (weekly/hard 유지); 새 주 → weekly reset', () => {
    const mondayNoon = new Date('2026-08-17T04:00:00Z');
    let st = initialRiskEngineState(mondayNoon, 1000);
    st = {
      ...st, dailyEntryCount: 3, consecutiveLossCount: 2,
      dailyRealizedNetPnlUsd: -25, weeklyRealizedNetPnlUsd: -60,
      locks: {
        ...EMPTY_LOCKS,
        dailyLockState: 'DAILY_LOSS_LOCKED', dailyLockReason: 'x',
        weeklyLockReason: 'w', hardStopReason: 'h',
      },
    };
    // 다음날 (같은 주)
    const tue = new Date('2026-08-18T04:00:00Z');
    const r1 = rollRiskPeriods(st, tue, 970);
    expect(r1.rolledDay).toBe(true);
    expect(r1.rolledWeek).toBe(false);
    expect(r1.state.dailyEntryCount).toBe(0);
    expect(r1.state.dailyRealizedNetPnlUsd).toBe(0);
    expect(r1.state.startOfDayEquityUsd).toBe(970);
    expect(r1.state.locks.dailyLockReason).toBeNull();
    expect(r1.state.locks.weeklyLockReason).toBe('w');   // 일일 reset이 weekly 해제 금지
    expect(r1.state.locks.hardStopReason).toBe('h');     // hard stop 유지
    expect(r1.state.weeklyRealizedNetPnlUsd).toBe(-60);
    // 다음 주 월요일
    const nextMon = new Date('2026-08-24T04:00:00Z');
    const r2 = rollRiskPeriods(r1.state, nextMon, 950);
    expect(r2.rolledWeek).toBe(true);
    expect(r2.state.weeklyRealizedNetPnlUsd).toBe(0);
    expect(r2.state.locks.weeklyLockReason).toBeNull();
    expect(r2.state.locks.hardStopReason).toBe('h');     // hard stop은 주간 reset도 못 풂
  });
});

// ── 영속 상태 (§16 #21) ────────────────────────────────────────────────────────
describe('persisted state parse (재시작 복구)', () => {
  it('저장 JSON round-trip — 잠금 복구', () => {
    const st = initialRiskEngineState(NOW, 1000);
    const withLock = { ...st, locks: { ...st.locks, hardStopReason: 'equity 840' } };
    const parsed = parseRiskEngineState(JSON.stringify(withLock));
    expect(parsed).not.toBeNull();
    expect(parsed!.locks.hardStopReason).toBe('equity 840');
    expect(parsed!.dayPeriodStart).toBe(st.dayPeriodStart);
  });

  it('손상 JSON/결측 필드 → null (fail-closed)', () => {
    expect(parseRiskEngineState('not json')).toBeNull();
    expect(parseRiskEngineState('{}')).toBeNull();
    expect(parseRiskEngineState(null)).toBeNull();
  });
});

// ── Canary (§16 #22-23) ───────────────────────────────────────────────────────
describe('Canary hardcaps & promotion', () => {
  it('Canary 하드캡: $15 자본 / $3 누적손실 / 2x / 1포지션 / 수동 승인 — 정책 자체 비활성', () => {
    expect(CANARY_POLICY.canaryEnabled).toBe(false);
    expect(CANARY_POLICY.canaryMaxCapitalAtRiskUsd).toBe(15);
    expect(CANARY_POLICY.canaryMaxCumulativeLossUsd).toBe(3);
    expect(CANARY_POLICY.canaryMaxLeverage).toBe(2);
    expect(CANARY_POLICY.canaryMaxConcurrentPositions).toBe(1);
    expect(CANARY_POLICY.canaryRequiresManualApproval).toBe(true);
    // 완벽한 입력이라도 canaryEnabled=false인 동안 항상 차단 (fail-closed)
    const perfect = {
      serverCanaryEnabled: true, operatorApprovalRecorded: true,
      entriesUsed: 0, cumulativeLossUsd: 0, requestedLeverage: 2,
      requestedCapitalUsd: 10, openPositionCount: 0,
    };
    expect(evaluateCanaryGate(perfect).allowed).toBe(false);
    // 개별 하드캡 위반도 전부 차단
    for (const bad of [
      { requestedCapitalUsd: 16 }, { cumulativeLossUsd: 3 }, { requestedLeverage: 3 },
      { openPositionCount: 1 }, { entriesUsed: 99 },
      { serverCanaryEnabled: false }, { operatorApprovalRecorded: false },
    ]) {
      expect(evaluateCanaryGate({ ...perfect, ...bad }).allowed).toBe(false);
    }
  });

  it('자동 승급 0회 — isAutoPromotionAllowed()는 상수 false', () => {
    expect(isAutoPromotionAllowed()).toBe(false);
  });
});

// ── 정책 상수 회귀 (§16 #24) ───────────────────────────────────────────────────
describe('policy constants regression', () => {
  it('정책 값 고정 — 임의 변경 감지', () => {
    expect(RISK_POLICY.initialCapitalUsd).toBe(1000);
    expect(RISK_POLICY.maxRiskCapitalUsd).toBe(1000);
    expect(RISK_POLICY.hardStopEquityUsd).toBe(920);
    expect(RISK_POLICY.baseRiskPerTradePercent).toBe(0.25);
    expect(RISK_POLICY.maxRiskPerTradePercent).toBe(0.5);
    expect(RISK_POLICY.dailyMaxLossPercent).toBe(1);
    expect(RISK_POLICY.baseMaxLeverage).toBe(3);
    expect(RISK_POLICY.conditional5xEnabled).toBe(false);
    expect(RISK_POLICY.maxConcurrentPositions).toBe(1);
    expect(RISK_POLICY.maxDailyEntries).toBe(3);
    expect(RISK_POLICY.maxConsecutiveLosses).toBe(3);
    expect(RISK_POLICY.martingaleEnabled).toBe(false);
    expect(RISK_POLICY.averagingDownEnabled).toBe(false);
    expect(RISK_POLICY.autoCompoundingEnabled).toBe(false);
    expect(RISK_POLICY.tradingTimezone).toBe('Asia/Manila');
  });

  it('Planned Seed는 Active/Reserve와 분리되고 증액 권한이 아니다', () => {
    expect(CAPITAL_PLAN.plannedSeedCapitalUsd).toBe(10_000);
    expect(CAPITAL_PLAN.activeTradingCapitalUsd).toBe(1_000);
    expect(CAPITAL_PLAN.reserveCapitalUsd).toBe(200);
    expect(CAPITAL_PLAN.deployableActiveCapitalUsd).toBe(800);
    expect(CAPITAL_PLAN.plannedSeedAuthorizesFunding).toBe(false);
    expect(CAPITAL_PLAN.plannedSeedAuthorizesPromotion).toBe(false);
    expect(CAPITAL_TIER_LADDER.map(t => t.capitalUsd)).toEqual([15, 1_000, 2_500, 5_000, 10_000]);
  });

  it('Active Capital 승격은 순차 단계와 모든 증거 및 사용자 승인을 요구한다', () => {
    const complete = {
      fromCapitalUsd: 1_000 as const,
      toCapitalUsd: 2_500 as const,
      positiveNetExpectancyAfterCosts: true,
      gmxOrderExecutionSettlementMatched: true,
      stopLossExecutable: true,
      emergencyCloseExecutable: true,
      unresolvedCount: 0,
      drawdownWithinLimit: true,
      dailyLossWithinLimit: true,
      stageCanaryVerified: true,
      userReportReviewed: true,
      userExplicitlyApproved: true,
    };
    expect(evaluateCapitalPromotion(complete)).toEqual({ allowed: true });
    expect(evaluateCapitalPromotion({ ...complete, userExplicitlyApproved: false }).allowed).toBe(false);
    expect(evaluateCapitalPromotion({ ...complete, unresolvedCount: null }).allowed).toBe(false);
    expect(evaluateCapitalPromotion({ ...complete, toCapitalUsd: 5_000 }).allowed).toBe(false);
  });
});
