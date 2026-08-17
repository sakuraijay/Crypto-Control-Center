/**
 * 6H-2 §13 — 사이징 강제 (9) + 비용 스냅샷 (6) 장애 주입 테스트.
 * DB 불필요 (CI db-free) — 순수 모듈만 검증.
 */
import { describe, it, expect } from 'vitest';
import {
  enforceOrderSizing, MIN_ORDER_NOTIONAL_USD, type EnforcementInput,
} from '../lib/orderSizingEnforcement';
import {
  buildPaperCostSnapshot, validateCostSnapshot, fetchLiveCostSnapshot,
  sanitizeCostError, COST_DATA_UNAVAILABLE, type CostSnapshot,
} from '../lib/costSnapshot';
import { CANARY_POLICY } from '../lib/riskPolicy';

const NOW = new Date('2026-08-18T03:00:00Z');
const MARKET = '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336';

function snap(notional: number, over: Partial<CostSnapshot> = {}): CostSnapshot {
  return { ...buildPaperCostSnapshot({ market: MARKET, isLong: true, orderType: 'MarketIncrease', notionalUsd: notional, now: NOW }), ...over };
}

function baseInput(over: Partial<EnforcementInput> = {}): EnforcementInput {
  return {
    requestedSizeUsd: 100,
    requestedCollateralUsd: 50,
    requestedLeverage: 2,
    positionSizingCapitalUsd: 1000,
    stopDistanceFraction: 0.01,
    costSnapshot: snap(100),
    liquidityCapUsd: 50_000,
    tierNotionalCapUsd: 3000,
    defensiveMode: false,
    liveMode: false,
    canaryActive: false,
    expected: { market: MARKET, isLong: true, orderType: 'MarketIncrease' },
    now: NOW,
    ...over,
  };
}

describe('§13 사이징 강제', () => {
  it('1. 요청 sizeUsd가 서버 계산 최대의 3배 → clamp + 감사 세부 기록', () => {
    const r = enforceOrderSizing(baseInput({ requestedSizeUsd: 3000, costSnapshot: snap(3000) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.finalNotionalUsd).toBeLessThan(3000);
    expect(r.finalNotionalUsd).toBeLessThanOrEqual(r.serverMaxNotionalUsd + 1e-9);
    expect(r.clamped).toBe(true);
    expect(r.clampDetails.join()).toContain('서버 상한');
  });

  it('2. 요청 leverage 10x → 정책 상한으로 clamp/거부 (5x 경로 비활성)', () => {
    const r = enforceOrderSizing(baseInput({ requestedLeverage: 10, costSnapshot: snap(100) }));
    expect(r.ok).toBe(false); // computePositionSize가 3x 초과 요청 거부 (fail-closed)
  });

  it('3. stop distance 미제공 → 주문 0회', () => {
    const r = enforceOrderSizing(baseInput({ stopDistanceFraction: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('stop');
  });

  it('4. 비용 스냅샷 없음 → 주문 0회 (COST_DATA_UNAVAILABLE)', () => {
    const r = enforceOrderSizing(baseInput({ costSnapshot: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain(COST_DATA_UNAVAILABLE);
  });

  it('5. 유동성 상한 불명(null) → 주문 0회', () => {
    const r = enforceOrderSizing(baseInput({ liquidityCapUsd: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('유동성');
  });

  it('6. 최종 산정값이 GMX 최소 주문 미달 → 거래하지 않음 (부풀리기 금지)', () => {
    const r = enforceOrderSizing(baseInput({
      requestedSizeUsd: 1, requestedCollateralUsd: 0.5, costSnapshot: snap(1),
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('최소 주문');
    expect(MIN_ORDER_NOTIONAL_USD).toBeGreaterThan(1);
  });

  it('7. Canary 활성 시 final = min(RiskEngine, Canary) — $1,000 기준 주문 금지', () => {
    const r = enforceOrderSizing(baseInput({
      requestedSizeUsd: 1000, requestedLeverage: 2, canaryActive: true, costSnapshot: snap(1000),
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.finalCollateralUsd).toBeLessThanOrEqual(CANARY_POLICY.canaryMaxCapitalAtRiskUsd + 1e-9);
    expect(r.finalNotionalUsd).toBeLessThanOrEqual(CANARY_POLICY.canaryMaxCapitalAtRiskUsd * CANARY_POLICY.canaryMaxLeverage + 1e-9);
    expect(r.finalLeverage).toBeLessThanOrEqual(CANARY_POLICY.canaryMaxLeverage);
  });

  it('8. 요청값이 서버 계산값보다 작으면 요청값 유지 (clamp 없음)', () => {
    const r = enforceOrderSizing(baseInput({ requestedSizeUsd: 10, requestedCollateralUsd: 5, costSnapshot: snap(10) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.finalNotionalUsd).toBeCloseTo(10, 6);
    expect(r.clamped).toBe(false);
  });

  it('9. LIVE 경로에 PAPER_MODEL 비용 → 거부', () => {
    const r = enforceOrderSizing(baseInput({ liveMode: true }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('PAPER_MODEL');
  });

  it('9b. DEFENSIVE 모드 → 서버 최대 명목 50% 축소 반영', () => {
    const n = enforceOrderSizing(baseInput({ requestedSizeUsd: 5000, costSnapshot: snap(5000) }));
    const d = enforceOrderSizing(baseInput({ requestedSizeUsd: 5000, defensiveMode: true, costSnapshot: snap(5000) }));
    expect(n.ok && d.ok).toBe(true);
    if (!n.ok || !d.ok) return;
    expect(d.serverMaxNotionalUsd).toBeLessThanOrEqual(n.serverMaxNotionalUsd * 0.5 + 1e-9);
  });
});

describe('§13 비용 스냅샷', () => {
  const expected = { market: MARKET, isLong: true, orderType: 'MarketIncrease' as const, notionalUsd: 100 };

  it('10. stale snapshot (expiresAt 경과) → 거부', () => {
    const s = snap(100);
    const later = new Date(NOW.getTime() + 10 * 60_000).getTime();
    const v = validateCostSnapshot(s, expected, later);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('stale');
  });

  it('11. 다른 market의 quote 재사용 → 거부', () => {
    const v = validateCostSnapshot(snap(100), { ...expected, market: '0x' + 'a'.repeat(40) }, NOW.getTime());
    expect(v.ok).toBe(false);
  });

  it('12. 작은 주문 quote를 큰 주문에 재사용 → 거부', () => {
    const v = validateCostSnapshot(snap(100), { ...expected, notionalUsd: 500 }, NOW.getTime());
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain('재사용 금지');
  });

  it('13. 음수 수수료/NaN → 거부', () => {
    expect(validateCostSnapshot(snap(100, { positionFeeUsd: -1 }), expected, NOW.getTime()).ok).toBe(false);
    expect(validateCostSnapshot(snap(100, { executionFeeUsd: NaN }), expected, NOW.getTime()).ok).toBe(false);
  });

  it('14. positive impact는 다른 비용의 20%까지만 상쇄', () => {
    const s = snap(100);
    const otherCosts = s.positionFeeUsd + s.executionFeeUsd + s.fundingFeeUsd + s.borrowingFeeUsd + s.estimatedExitFeeUsd;
    const v = validateCostSnapshot(snap(100, { estimatedPriceImpactUsd: -otherCosts * 5 }), expected, NOW.getTime());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.effectiveRoundTripCostUsd).toBeCloseTo(otherCosts * 0.8, 6);
  });

  it('15. readonly 플래그 꺼짐 → COST_DATA_UNAVAILABLE (가짜 성공 금지)', async () => {
    const r = await fetchLiveCostSnapshot(
      { market: MARKET, isLong: true, orderType: 'MarketIncrease', notionalUsd: 100, now: NOW },
      { readonlyEnabled: false },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain(COST_DATA_UNAVAILABLE);
  });

  it('16. 조회 실패 시 사유 새니타이즈 (URL 미노출)', async () => {
    const r = await fetchLiveCostSnapshot(
      { market: MARKET, isLong: true, orderType: 'MarketIncrease', notionalUsd: 100, now: NOW },
      {
        readonlyEnabled: true,
        fetchCosts: async () => { throw new Error('fetch failed: https://secret.example.com/api?apiKey=abc123'); },
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).not.toContain('secret.example.com');
    expect(r.reason).not.toContain('abc123');
    expect(sanitizeCostError('x https://a.b/c?token=zz')).not.toContain('a.b');
  });
});
