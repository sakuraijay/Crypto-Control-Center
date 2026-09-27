/**
 * 6H-2 §13 — 회귀/정산 (6) 장애 주입 테스트.
 * DB 불필요 (CI db-free) — computeNetPnl/pnlForTargets 순수 로직만 검증.
 * recordTradeSettlement의 DB 경로(중복 tx 금지·조건부 UPDATE)는 통합 환경에서 검증.
 */
import { describe, it, expect } from 'vitest';
import { computeNetPnl, pnlForTargets } from '../lib/tradeSettlement';

describe('§13 정산/회귀', () => {
  it('38. 순 PnL = gross − 모든 수수료 − impact', () => {
    const r = computeNetPnl({
      grossPnlUsd: 10, positionFeeUsd: 0.5, executionFeeUsd: 0.2,
      priceImpactUsd: 0.3, fundingFeeUsd: 0.1, borrowingFeeUsd: 0.1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.netPnlUsd).toBeCloseTo(10 - 0.5 - 0.2 - 0.3 - 0.1 - 0.1, 8);
  });

  it('39. 음수 수수료/NaN → 정산 거부', () => {
    expect(computeNetPnl({ grossPnlUsd: 10, positionFeeUsd: -1, executionFeeUsd: 0, priceImpactUsd: 0, fundingFeeUsd: 0, borrowingFeeUsd: 0 }).ok).toBe(false);
    expect(computeNetPnl({ grossPnlUsd: NaN, positionFeeUsd: 0, executionFeeUsd: 0, priceImpactUsd: 0, fundingFeeUsd: 0, borrowingFeeUsd: 0 }).ok).toBe(false);
  });

  it('40. UNSETTLED 이익은 목표 산정 미반영, 손실은 즉시 반영 (보수적 비대칭)', () => {
    const r = pnlForTargets([
      { pnl: 100, settlementStatus: 'UNSETTLED' },      // 이익·미정산 → 제외
      { pnl: 50,  settlementStatus: 'SETTLED' },        // 이익·정산 → 포함
      // 6H-2A §2 — legacy PAPER_ZERO_FEE는 더 이상 이익 적격 아님 (손실만 반영)
      { pnl: 30,  settlementStatus: 'PAPER_ZERO_FEE' },
      { pnl: -20, settlementStatus: 'UNSETTLED' },      // 손실·미정산 → 즉시 포함
    ]);
    expect(r.profitEligibleUsd).toBe(50);
    expect(r.lossAwareUsd).toBe(-20);
  });

  it('40b. PAPER_ESTIMATED는 net 추정값 기준으로 이익/손실 모두 반영', () => {
    const r = pnlForTargets([
      { pnl: 10, settlementStatus: 'PAPER_ESTIMATED', netPnlEstimatedUsd: 8 },   // net 이익 반영
      { pnl: -5, settlementStatus: 'PAPER_ESTIMATED', netPnlEstimatedUsd: -6 },  // net 손실 반영
      { pnl: 7,  settlementStatus: 'PAPER_ESTIMATED', netPnlEstimatedUsd: null }, // net 없음 → 이익 미반영
      { pnl: -3, settlementStatus: 'PAPER_ESTIMATED', netPnlEstimatedUsd: null }, // net 없음 → gross 손실 반영
    ]);
    expect(r.profitEligibleUsd).toBe(8);
    expect(r.lossAwareUsd).toBe(-9);
  });

  it('41. settlementStatus null(legacy) → UNSETTLED로 취급 (이익 미반영)', () => {
    const r = pnlForTargets([{ pnl: 100, settlementStatus: null }]);
    expect(r.profitEligibleUsd).toBe(0);
  });

  it('42. NaN pnl 행은 무시 (가짜 0 합산 금지)', () => {
    const r = pnlForTargets([
      { pnl: NaN, settlementStatus: 'SETTLED' },
      { pnl: 5, settlementStatus: 'SETTLED' },
    ]);
    expect(r.profitEligibleUsd).toBe(5);
  });
});
