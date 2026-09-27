/**
 * 6H-2 §13 — 70% 축소 (7) + 보호 stop (6) + close-all (8) 장애 주입 테스트.
 * DB 불필요 (CI db-free) — 순수 모듈만 검증.
 */
import { describe, it, expect } from 'vitest';
import {
  computeReduction, buildProfitProtectKey, manilaDayKey,
  canExecuteReduction, canPlaceFollowUpOrders, type ProfitProtectRecord,
} from '../lib/profitProtection';
import {
  computeStopTrigger, validateStopVsLiquidation, computeProtectiveFloorStop,
  listUncovered, canCreateStopOrder, DEFAULT_STOP_DISTANCE_FRACTION,
  type StopCoverageMap,
} from '../lib/stopLossPlan';
import {
  buildCloseAllPlan, validateCloseOrder, summarizeCloseAll,
} from '../lib/closeAllOrchestrator';

const NOW = new Date('2026-08-18T03:00:00Z'); // Manila 11:00

function record(over: Partial<ProfitProtectRecord> = {}): ProfitProtectRecord {
  return {
    idempotencyKey: 'risk:profit-protect:2026-08-18:pos1', positionKey: 'pos1',
    dayKey: '2026-08-18', reduceSizeUsd: 70, fullClose: false, status: 'CONFIRMED',
    orderKey: '0xabc', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...over,
  };
}

describe('§13 70% 축소', () => {
  it('17. 70% 보수적 내림 — rounding 후에도 70% 초과 금지', () => {
    const r = computeReduction({ openSizeUsd: 100.0037, minPositionNotionalUsd: 2.2 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.fullClose) return;
    expect(r.reduceSizeUsd).toBeLessThanOrEqual(100.0037 * 0.7 + 1e-9);
    // $0.01 precision (부동소수 오차 허용)
    const cents = r.reduceSizeUsd * 100;
    expect(Math.abs(cents - Math.round(cents))).toBeLessThan(1e-6);
  });

  it('18. 잔여 30%가 최소 포지션 미만 → 100% 종료 전환', () => {
    const r = computeReduction({ openSizeUsd: 5, minPositionNotionalUsd: 2.2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fullClose).toBe(true);
    expect(r.reduceSizeUsd).toBe(5);
  });

  it('19. idempotency key 결정성 — risk:profit-protect:<dayKey>:<positionKey>', () => {
    const day = manilaDayKey(NOW); // Manila 거래일 시작의 UTC 날짜부 (결정적)
    const k = buildProfitProtectKey(day, 'posX');
    expect(k).toBe(`risk:profit-protect:${day}:posX`);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(day)).toBe(true);
    expect(buildProfitProtectKey(manilaDayKey(NOW), 'posX')).toBe(k); // 재실행 동일
  });

  it('20. 기존 기록 존재 → 동일 포지션 재축소 금지 (재시작 내구성)', () => {
    const r = canExecuteReduction(record());
    expect(r.ok).toBe(false);
  });

  it('21. 축소 CANCELLED/FAILED/UNRESOLVED → 신규 진입도 차단', () => {
    for (const status of ['CANCELLED', 'FAILED', 'UNRESOLVED'] as const) {
      const r = canExecuteReduction(record({ status }));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.blocksNewEntries).toBe(true);
    }
    const confirmed = canExecuteReduction(record({ status: 'CONFIRMED' }));
    expect(confirmed.ok).toBe(false);
    if (!confirmed.ok) expect(confirmed.blocksNewEntries).toBe(false);
  });

  it('22. 축소 결과 확인 전(SUBMITTED/UNRESOLVED) 후속 주문 금지', () => {
    expect(canPlaceFollowUpOrders(record({ status: 'SUBMITTED' }))).toBe(false);
    expect(canPlaceFollowUpOrders(record({ status: 'UNRESOLVED' }))).toBe(false);
    expect(canPlaceFollowUpOrders(record({ status: 'CONFIRMED' }))).toBe(true);
  });

  it('23. open size 비정상 → 축소 계획 자체 거부 (fail-closed)', () => {
    expect(computeReduction({ openSizeUsd: NaN, minPositionNotionalUsd: 2.2 }).ok).toBe(false);
    expect(computeReduction({ openSizeUsd: 0, minPositionNotionalUsd: 2.2 }).ok).toBe(false);
  });
});

describe('§13 보호 stop', () => {
  it('24. 진입 전 stop trigger 계산 — LONG 아래 / SHORT 위', () => {
    const l = computeStopTrigger({ entryPriceUsd: 100, isLong: true });
    const s = computeStopTrigger({ entryPriceUsd: 100, isLong: false });
    expect(l.ok && s.ok).toBe(true);
    if (!l.ok || !s.ok) return;
    expect(l.plan.triggerPriceUsd).toBeCloseTo(100 * (1 - DEFAULT_STOP_DISTANCE_FRACTION), 8);
    expect(s.plan.triggerPriceUsd).toBeCloseTo(100 * (1 + DEFAULT_STOP_DISTANCE_FRACTION), 8);
  });

  it('25. stop이 청산가와 미분리/청산가 불명 → OPEN 금지', () => {
    expect(validateStopVsLiquidation({ triggerPriceUsd: 99, liquidationPriceUsd: 98.9, isLong: true }).ok).toBe(false);
    expect(validateStopVsLiquidation({ triggerPriceUsd: 99, liquidationPriceUsd: null, isLong: true }).ok).toBe(false);
    expect(validateStopVsLiquidation({ triggerPriceUsd: 99, liquidationPriceUsd: 90, isLong: true }).ok).toBe(true);
  });

  it('26. +3.5% floor stop — 당일 순수익 보장 trigger 역산 (비용 포함)', () => {
    const r = computeProtectiveFloorStop({
      dailyRealizedNetPnlUsd: 50, floorUsd: 35, remainingSizeUsd: 300,
      remainingEntryPriceUsd: 100, currentPriceUsd: 110, isLong: true, estimatedExitCostUsd: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 필요한 포지션 PnL = 35 − 50 + 1 = −14 → trigger = 100 × (1 − 14/300)
    expect(r.triggerPriceUsd).toBeCloseTo(100 * (1 - 14 / 300), 8);
  });

  it('27. trigger가 시장가의 잘못된 방향 → 잔여 전량 종료', () => {
    const r = computeProtectiveFloorStop({
      dailyRealizedNetPnlUsd: 0, floorUsd: 35, remainingSizeUsd: 100,
      remainingEntryPriceUsd: 100, currentPriceUsd: 101, isLong: true, estimatedExitCostUsd: 1,
    });
    // 필요한 trigger = 136% 지점 > 시장가 → 방향 오류
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.action).toBe('CLOSE_REMAINING');
  });

  it('28. 계산 입력 NaN → 잔여 전량 종료 (모호 상태 방치 금지)', () => {
    const r = computeProtectiveFloorStop({
      dailyRealizedNetPnlUsd: NaN, floorUsd: 35, remainingSizeUsd: 100,
      remainingEntryPriceUsd: 100, currentPriceUsd: 110, isLong: true, estimatedExitCostUsd: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.action).toBe('CLOSE_REMAINING');
  });

  it('29. coverage 상태 머신 — COVERED 아닌 기록 존재 시 신규 주문 차단 근거', () => {
    const map: StopCoverageMap = {
      a: { positionRef: 'a', status: 'COVERED', stopOrderKey: '0x1', triggerPriceUsd: 99, updatedAt: NOW.toISOString() },
      b: { positionRef: 'b', status: 'PENDING', stopOrderKey: null, triggerPriceUsd: null, updatedAt: NOW.toISOString() },
    };
    expect(listUncovered(map).map(r => r.positionRef)).toEqual(['b']);
    // stop orderKey 이미 존재 → 중복 생성 금지
    expect(canCreateStopOrder(map.a).ok).toBe(false);
    expect(canCreateStopOrder(map.b).ok).toBe(true);
    expect(canCreateStopOrder({ ...map.b, status: 'UNRESOLVED' }).ok).toBe(false);
  });
});

describe('§13 close-all orchestration', () => {
  const positions = [
    { positionKey: 'p1', marketAddress: '0x1', isLong: true, sizeUsd: 100 },
    { positionKey: 'p2', marketAddress: '0x2', isLong: false, sizeUsd: 50 },
  ];

  it('30. 포지션별 결정적 intent id — 재실행에도 동일', () => {
    const a = buildCloseAllPlan({ dayKey: '2026-08-18', positions });
    const b = buildCloseAllPlan({ dayKey: '2026-08-18', positions });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.intents.map(i => i.intentId)).toEqual(b.intents.map(i => i.intentId));
    expect(a.intents[0].intentId).toBe('risk:close-all:2026-08-18:p1');
    expect(a.intents.every(i => i.reduceOnly)).toBe(true);
  });

  it('31. 포지션 size 불명 → 계획 수립 자체 거부 (fail-closed)', () => {
    const r = buildCloseAllPlan({ dayKey: '2026-08-18', positions: [{ positionKey: 'x', marketAddress: '0x1', isLong: true, sizeUsd: NaN }] });
    expect(r.ok).toBe(false);
  });

  it('32. close size > open size → 반대 포지션 생성 금지, 거부', () => {
    const r = validateCloseOrder({ closeSizeUsd: 150, openSizeUsd: 100, closeTargetIsLong: true, openIsLong: true });
    expect(r.ok).toBe(false);
  });

  it('33. close 방향 불일치 (방향 반전) → 거부', () => {
    const r = validateCloseOrder({ closeSizeUsd: 50, openSizeUsd: 100, closeTargetIsLong: false, openIsLong: true });
    expect(r.ok).toBe(false);
  });

  it('34. open size 불명 → close 검증 불가, 거부 (fail-closed)', () => {
    expect(validateCloseOrder({ closeSizeUsd: 50, openSizeUsd: NaN, closeTargetIsLong: true, openIsLong: true }).ok).toBe(false);
  });

  it('35. 부분 실패 (1 CONFIRMED + 1 FAILED) → allTerminal이지만 잠금 유지', () => {
    const s = summarizeCloseAll([
      { intentId: 'i1', positionKey: 'p1', status: 'CONFIRMED' },
      { intentId: 'i2', positionKey: 'p2', status: 'FAILED' },
    ]);
    expect(s.allTerminal).toBe(true);
    expect(s.allConfirmed).toBe(false);
    expect(s.lockRequired).toBe(true); // 부분 실패 → 신규 진입 잠금 유지
  });

  it('36. UNRESOLVED close 존재 → rollover에 의한 잠금 해제 금지', () => {
    const s = summarizeCloseAll([
      { intentId: 'i1', positionKey: 'p1', status: 'CONFIRMED' },
      { intentId: 'i2', positionKey: 'p2', status: 'UNRESOLVED' },
    ]);
    expect(s.rolloverAllowed).toBe(false);
    expect(s.lockRequired).toBe(true);
  });

  it('37. 전부 CONFIRMED → 잠금 해제 가능 + rollover 허용', () => {
    const s = summarizeCloseAll([
      { intentId: 'i1', positionKey: 'p1', status: 'CONFIRMED' },
      { intentId: 'i2', positionKey: 'p2', status: 'CONFIRMED' },
    ]);
    expect(s.allConfirmed).toBe(true);
    expect(s.lockRequired).toBe(false);
    expect(s.rolloverAllowed).toBe(true);
  });
});
