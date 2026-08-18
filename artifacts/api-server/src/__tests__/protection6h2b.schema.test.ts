/**
 * 6H-2B §13 — Stop-Loss 스키마·예산·정책 순수 검증 (네트워크·DB I/O 없음).
 *
 * 골든 고정: 공식 @gmx-io/sdk@1.7.0 OrderType enum
 *   MarketSwap=0, LimitSwap=1, MarketIncrease=2, LimitIncrease=3,
 *   MarketDecrease=4, LimitDecrease=5, StopLossDecrease=6, Liquidation=7, StopIncrease=8
 */
import { describe, expect, it, vi } from 'vitest';

// protectionOrders는 @workspace/db를 최상위 import — 순수 함수만 쓰므로 최소 mock
vi.mock('@workspace/db', () => ({
  db: {},
  protectionOrdersTable: {},
}));

import { ORDER_TYPE, buildStopLossOrderParams } from '../lib/gmxCreateOrder';
import { ZERO_ADDRESS } from '../lib/gmxContracts';
import {
  orderKindOf, usdPriceToGmxString, buildOrderPrepareBody,
  verifyOrderSemanticBinding, type GmxOrderRequest,
} from '../lib/gmxApiExecution';
import { evaluateActionBudget, MIN_SAFE_ACTION_BUDGET, ACTION_COST } from '../lib/actionBudget';
import {
  validateExecutionEligibleSnapshot, EXECUTION_ELIGIBLE_MAX_AGE_MS,
  COST_SNAPSHOT_TTL_MS, UNRESOLVED_SAFETY_EXIT, type CostSnapshot,
} from '../lib/costSnapshot';
import { PAPER_COST_BINDING_MAX_AGE_MS } from '../lib/paperCostCache';
import {
  deriveStopExecutionCapability, planFloorStopReplacement, STOP_REPLACEMENT_PROVEN_SAFE,
} from '../lib/stopExecutionCapability';
import {
  isTransitionAllowed, judgeProtection, buildProtectionId,
  PROTECTION_BLOCKING_SET, ALLOWED_TRANSITIONS,
} from '../lib/protectionOrders';

const MAIN = '0x1111111111111111111111111111111111111111' as const;
const SUB = '0x2222222222222222222222222222222222222222' as const;
const MARKET = '0x3333333333333333333333333333333333333333' as const;

// ── §13-1 골든: 공식 SDK OrderType enum ──────────────────────────────────────
describe('§2 골든 — 공식 OrderType enum (SDK 1.7.0)', () => {
  it('로컬 ORDER_TYPE 상수가 공식 enum과 정확히 일치한다', () => {
    expect(ORDER_TYPE.MarketSwap).toBe(0n);
    expect(ORDER_TYPE.LimitSwap).toBe(1n);
    expect(ORDER_TYPE.MarketIncrease).toBe(2n);
    expect(ORDER_TYPE.LimitIncrease).toBe(3n);
    expect(ORDER_TYPE.MarketDecrease).toBe(4n);
    expect(ORDER_TYPE.LimitDecrease).toBe(5n);
    expect(ORDER_TYPE.StopLossDecrease).toBe(6n);
    expect(ORDER_TYPE.Liquidation).toBe(7n);
    expect(ORDER_TYPE.StopIncrease).toBe(8n);
  });

  it('orderKindOf: STOP_LOSS → StopLossDecrease 문자열', () => {
    expect(orderKindOf({ kind: 'STOP_LOSS' })).toBe('StopLossDecrease');
    expect(orderKindOf({ kind: 'OPEN' })).toBe('MarketIncrease');
    expect(orderKindOf({ kind: 'CLOSE' })).toBe('MarketDecrease');
  });
});

// ── §2 stop 빌더 (reduce-only, triggerPrice 필수) ────────────────────────────
describe('§2 buildStopLossOrderParams', () => {
  const base = {
    mainAccount: MAIN, market: MARKET, collateralToken: SUB,
    sizeDeltaUsd: 10n ** 31n, initialCollateralDeltaAmount: 0n,
    acceptablePrice: 123n, executionFee: 1n, isLong: true,
  };
  it('정상 stop: orderType=6, triggerPrice 반영, receiver=main, autoCancel=false (6H-2D 정책)', () => {
    const p = buildStopLossOrderParams({ ...base, triggerPrice: 999n });
    expect(p.orderType).toBe(6n);
    expect(p.numbers.triggerPrice).toBe(999n);
    expect(p.addresses.receiver).toBe(MAIN);
    expect(p.addresses.cancellationReceiver).toBe(MAIN);
    expect(p.addresses.swapPath).toEqual([]);
    expect(p.autoCancel).toBe(false);
  });
  it('triggerPrice=0 → 거부 (market 주문 오인 금지)', () => {
    expect(() => buildStopLossOrderParams({ ...base, triggerPrice: 0n })).toThrow();
  });
  it('sizeDeltaUsd<=0 → 거부', () => {
    expect(() => buildStopLossOrderParams({ ...base, sizeDeltaUsd: 0n, triggerPrice: 1n })).toThrow();
  });
  it('mainAccount 부재(zero) → 거부', () => {
    expect(() => buildStopLossOrderParams({ ...base, mainAccount: ZERO_ADDRESS, triggerPrice: 1n })).toThrow();
  });
});

// ── §2 가격 정밀도 변환 (공식 convertToContractPrice 규칙) ───────────────────
describe('§2 usdPriceToGmxString', () => {
  it('18-decimals 토큰: price × 10^12', () => {
    expect(usdPriceToGmxString(2000, 18)).toBe('2000000000000000');
  });
  it('8-decimals(BTC 계열): price × 10^22', () => {
    expect(usdPriceToGmxString(65000.5, 8)).toBe('650005000000000000000000000');
  });
  it('가격 0/음수/NaN → 거부', () => {
    expect(() => usdPriceToGmxString(0, 18)).toThrow();
    expect(() => usdPriceToGmxString(-1, 18)).toThrow();
    expect(() => usdPriceToGmxString(NaN, 18)).toThrow();
  });
  it('tokenDecimals > 18 → 거부 (정밀도 손실 방지)', () => {
    expect(() => usdPriceToGmxString(1, 19)).toThrow();
  });
});

// ── §2 prepare body + 의미 결속 ───────────────────────────────────────────────
describe('§2 STOP_LOSS prepare body·semantic binding', () => {
  const stopReq: GmxOrderRequest = {
    kind: 'STOP_LOSS', symbol: 'ETH', marketAddress: MARKET, isLong: true,
    sizeUsd: 10, collateralUsd: 0, mainWallet: MAIN, subaccountAddress: SUB,
    triggerPriceGmx: '1980000000000000', acceptablePriceGmx: '1970000000000000',
  };
  it('prepare body: orderKind=StopLossDecrease + triggerPrice 동봉', () => {
    const body = buildOrderPrepareBody(stopReq);
    expect(body.orderKind).toBe('StopLossDecrease');
    expect(body.triggerPrice).toBe('1980000000000000');
    expect(body.acceptablePrice).toBe('1970000000000000');
    expect(body.initialCollateralDeltaAmount).toBe('0');
  });
  it('typed data triggerPrice 부재 → 서명 금지', () => {
    const msg = { sizeDeltaUsd: '10000000000000000000000000000000', isLong: true, market: MARKET };
    const r = verifyOrderSemanticBinding(msg, stopReq);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('triggerPrice');
  });
  it('typed data triggerPrice 불일치 → 서명 금지', () => {
    const msg = {
      sizeDeltaUsd: '10000000000000000000000000000000', isLong: true, market: MARKET,
      triggerPrice: '1', orderType: 6,
    };
    const r = verifyOrderSemanticBinding(msg, stopReq);
    expect(r.ok).toBe(false);
  });
  it('일치하는 stop typed data → 통과 (orderType=6 인정, autoCancel=false 필수)', () => {
    const msg = {
      sizeDeltaUsd: '10000000000000000000000000000000', isLong: true, market: MARKET,
      triggerPrice: '1980000000000000', orderType: 6, autoCancel: false,
    };
    expect(verifyOrderSemanticBinding(msg, stopReq).ok).toBe(true);
  });
  it('요청에 triggerPrice 부재/0인 STOP_LOSS → 서명 금지', () => {
    const bad = { ...stopReq, triggerPriceGmx: '0' };
    const msg = { sizeDeltaUsd: '10000000000000000000000000000000', isLong: true, market: MARKET, triggerPrice: '0' };
    expect(verifyOrderSemanticBinding(msg, bad).ok).toBe(false);
  });
  it('market 주문 typed data에 triggerPrice≠0 → 서명 금지', () => {
    const openReq: GmxOrderRequest = { ...stopReq, kind: 'OPEN', collateralUsd: 5, triggerPriceGmx: undefined };
    const msg = {
      sizeDeltaUsd: '10000000000000000000000000000000', isLong: true, market: MARKET,
      triggerPrice: '55', initialCollateralDeltaAmount: '5000000',
    };
    expect(verifyOrderSemanticBinding(msg, openReq).ok).toBe(false);
  });
});

// ── §7 action 예산 ────────────────────────────────────────────────────────────
describe('§7 action 예산', () => {
  const now = Date.now();
  const future = String(Math.floor(now / 1000) + 3600);
  it('작업별 소비는 전부 1 (공식 handleSubaccountAction 규칙 골든)', () => {
    expect(ACTION_COST.createOrder).toBe(1);
    expect(ACTION_COST.updateOrder).toBe(1);
    expect(ACTION_COST.cancelOrder).toBe(1);
    // 6H-2C §6 — 과거 고정 4는 과소계산: 최악 경로(+5% 이익보호 5) + 비상 예약 1 = 6
    expect(MIN_SAFE_ACTION_BUDGET).toBe(6);
  });
  it('remaining=6 → 충분, remaining=5 → 부족 (진행중 예약 0)', () => {
    expect(evaluateActionBudget({ remaining: '6', expiresAt: future, nowMs: now, inFlightReservedActions: 0 }).sufficient).toBe(true);
    const r = evaluateActionBudget({ remaining: '5', expiresAt: future, nowMs: now, inFlightReservedActions: 0 });
    expect(r.sufficient).toBe(false);
    expect(r.budgetShortfall).toBe(1);
  });
  it('현재 기본 maxAllowedCount=2 → 부족 (자동 확대 금지 보고)', () => {
    const r = evaluateActionBudget({ remaining: '2', expiresAt: future, nowMs: now, inFlightReservedActions: 0 });
    expect(r.sufficient).toBe(false);
    expect(r.budgetShortfall).toBe(4);
    expect(r.reasons.join(' ')).toContain('자동 확대 금지');
  });
  it('remaining 조회불가/만료/예약분 불명 → 차단 (fail-closed)', () => {
    expect(evaluateActionBudget({ remaining: null, expiresAt: future, nowMs: now, inFlightReservedActions: 0 }).sufficient).toBe(false);
    expect(evaluateActionBudget({ remaining: '10', expiresAt: String(Math.floor(now / 1000) - 1), nowMs: now, inFlightReservedActions: 0 }).sufficient).toBe(false);
    expect(evaluateActionBudget({ remaining: 'abc', expiresAt: future, nowMs: now, inFlightReservedActions: 0 }).sufficient).toBe(false);
    expect(evaluateActionBudget({ remaining: '10', expiresAt: future, nowMs: now }).sufficient).toBe(false);          // 예약분 미제공
    expect(evaluateActionBudget({ remaining: '10', expiresAt: future, nowMs: now, inFlightReservedActions: null }).sufficient).toBe(false);
  });
  it('진행중 예약분 가산 — remaining=6 + 예약 2 → 부족 2', () => {
    const r = evaluateActionBudget({ remaining: '6', expiresAt: future, nowMs: now, inFlightReservedActions: 2 });
    expect(r.sufficient).toBe(false);
    expect(r.budgetShortfall).toBe(2);
    expect(r.budgetBasis.length).toBeGreaterThan(0);
  });
});

// ── §10 비용 신선도 ───────────────────────────────────────────────────────────
describe('§10 실행 적격 30초 창', () => {
  const mkSnap = (ageMs: number, nowMs: number): CostSnapshot => ({
    market: MARKET, isLong: true, orderType: 'MarketIncrease',
    notionalUsd: 100, positionFeeUsd: 0.1, executionFeeUsd: 0.05,
    estimatedPriceImpactUsd: 0, estimatedExitPriceImpactUsd: 0,
    fundingFeeUsd: 0, borrowingFeeUsd: 0, estimatedExitFeeUsd: 0.1,
    fundingRatePerHourFraction: 0, borrowingRatePerHourFraction: 0,
    totalEstimatedRoundTripCostUsd: 0.25, source: 'GMX_API',
    blockNumber: null, apiTimestamp: null,
    fetchedAt: new Date(nowMs - ageMs).toISOString(),
    expiresAt: new Date(nowMs - ageMs + COST_SNAPSHOT_TTL_MS).toISOString(),
  });
  const expected = { market: MARKET, isLong: true, orderType: 'MarketIncrease' as const, notionalUsd: 100 };
  const now = Date.now();

  it('상수 계약: 표시 10분 ≠ 실행 30초', () => {
    expect(EXECUTION_ELIGIBLE_MAX_AGE_MS).toBe(30_000);
    expect(PAPER_COST_BINDING_MAX_AGE_MS).toBe(10 * 60_000);
    expect(UNRESOLVED_SAFETY_EXIT).toBe('UNRESOLVED_SAFETY_EXIT');
  });
  it('age 10s → 적격, age 31s → 부적격 (TTL 60s 이내여도)', () => {
    expect(validateExecutionEligibleSnapshot(mkSnap(10_000, now), expected, now).ok).toBe(true);
    const r = validateExecutionEligibleSnapshot(mkSnap(31_000, now), expected, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('실행 적격 초과');
  });
  it('표시용 10분 cache age(5분) → 실행 부적격', () => {
    expect(validateExecutionEligibleSnapshot(mkSnap(5 * 60_000, now), expected, now).ok).toBe(false);
  });
  it('스냅샷 없음/결속 불일치 → 부적격', () => {
    expect(validateExecutionEligibleSnapshot(null, expected, now).ok).toBe(false);
    expect(validateExecutionEligibleSnapshot(mkSnap(1_000, now), { ...expected, isLong: false }, now).ok).toBe(false);
  });
});

// ── §11 capability 파생 ──────────────────────────────────────────────────────
describe('§11 stop 실행 능력 파생', () => {
  const allOk = {
    schemaVerified: true, transportConfigured: true, signerReady: true,
    durableStoreOk: true, reconciliationOk: true,
    actionBudgetSufficient: true, actionBudgetRemaining: 10,
    freshFeeQuote: true, uncoveredCount: 0, blockingProtectionCount: 0,
    executionUnlocked: true,
    // 6H-2C §9 — 추가 조건
    decimalsSourceReady: true, priceConversionVerified: true,
    evidenceCollectorReady: true, protectionReconciliationClean: true,
    positionSnapshotFresh: true,
  };
  it('전 조건 충족 시에만 available=true', () => {
    expect(deriveStopExecutionCapability(allOk).available).toBe(true);
  });
  it('각 단일 조건 실패 → false + 사유', () => {
    for (const [k, v] of [
      ['schemaVerified', false], ['transportConfigured', false], ['signerReady', false],
      ['durableStoreOk', false], ['reconciliationOk', false], ['actionBudgetSufficient', false],
      ['freshFeeQuote', false], ['uncoveredCount', 1], ['uncoveredCount', null],
      ['blockingProtectionCount', 2], ['blockingProtectionCount', null], ['executionUnlocked', false],
    ] as const) {
      const r = deriveStopExecutionCapability({ ...allOk, [k]: v } as never);
      expect(r.available).toBe(false);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });
});

// ── §8 floor stop 교체 정책 ──────────────────────────────────────────────────
describe('§8 floor stop 교체', () => {
  it('무공백 교체 안전성 미증명 상수 = false (자동 REPLACE 금지)', () => {
    expect(STOP_REPLACEMENT_PROVEN_SAFE).toBe(false);
  });
  it('교체 증명 불가 → 잔여 전량 종료', () => {
    const r = planFloorStopReplacement({ existingStopActive: true, newTriggerComputable: true, remainingSizeUsd: 30 });
    expect(r.action).toBe('CLOSE_REMAINING');
  });
  it('trigger 계산불가/기존 stop 부재/size 비정상 → 전량 종료', () => {
    expect(planFloorStopReplacement({ existingStopActive: true, newTriggerComputable: false, remainingSizeUsd: 30 }).action).toBe('CLOSE_REMAINING');
    expect(planFloorStopReplacement({ existingStopActive: false, newTriggerComputable: true, remainingSizeUsd: 30 }).action).toBe('CLOSE_REMAINING');
    expect(planFloorStopReplacement({ existingStopActive: true, newTriggerComputable: true, remainingSizeUsd: 0 }).action).toBe('CLOSE_REMAINING');
  });
});

// ── §3 상태 머신 + §9 판정 ───────────────────────────────────────────────────
describe('§3 보호 주문 상태 머신', () => {
  it('protectionId는 결정적', () => {
    expect(buildProtectionId('intent-1', 'INITIAL_STOP')).toBe('prot:intent-1:INITIAL_STOP');
  });
  it('정순 전이 허용, 역행·건너뛰기 거부', () => {
    expect(isTransitionAllowed('PLANNED', 'PREPARED')).toBe(true);
    expect(isTransitionAllowed('PREPARED', 'SUBMITTING')).toBe(true);
    expect(isTransitionAllowed('SUBMITTING', 'SUBMITTED')).toBe(true);
    expect(isTransitionAllowed('SUBMITTED', 'ACTIVE')).toBe(true);
    expect(isTransitionAllowed('ACTIVE', 'EXECUTED')).toBe(true);
    expect(isTransitionAllowed('PLANNED', 'ACTIVE')).toBe(false); // 건너뛰기 금지
    expect(isTransitionAllowed('EXECUTED', 'ACTIVE')).toBe(false); // terminal 역행 금지
    expect(isTransitionAllowed('CANCELLED', 'SUBMITTED')).toBe(false);
    expect(isTransitionAllowed('ACTIVE', 'PLANNED')).toBe(false);
  });
  it('terminal 상태의 허용 전이는 0개', () => {
    expect(ALLOWED_TRANSITIONS.EXECUTED).toHaveLength(0);
    expect(ALLOWED_TRANSITIONS.CANCELLED).toHaveLength(0);
  });
  it('PROTECTION_BLOCKING_SET에 ACTIVE는 없다 (ACTIVE=정상 보호 상태)', () => {
    expect(PROTECTION_BLOCKING_SET).not.toContain('ACTIVE');
    expect(PROTECTION_BLOCKING_SET).toContain('UNRESOLVED');
    expect(PROTECTION_BLOCKING_SET).toContain('FROZEN');
  });
});

describe('§9 reconciliation 판정', () => {
  const base = {
    apiStatus: null, onchainOrderKey: null, onchainExecuted: false,
    onchainCancelled: false, onchainFrozen: false, positionExists: true as boolean | null,
  };
  it('온체인 orderKey 확인 → SUBMITTED에서 ACTIVE', () => {
    const j = judgeProtection({ ...base, currentStatus: 'SUBMITTED', onchainOrderKey: '0x' + 'a'.repeat(64) });
    expect(j.nextStatus).toBe('ACTIVE');
  });
  it('API status 문자열만으로는 terminal 전이 금지', () => {
    const j = judgeProtection({ ...base, currentStatus: 'SUBMITTED', apiStatus: 'executed' });
    expect(j.nextStatus).toBeNull();
    expect(j.blockNewOpens).toBe(true);
  });
  it('OrderFrozen → FROZEN + 차단 + 비상 종료 요구', () => {
    const j = judgeProtection({ ...base, currentStatus: 'ACTIVE', onchainFrozen: true });
    expect(j.nextStatus).toBe('FROZEN');
    expect(j.emergencyCloseRequired).toBe(true);
    expect(j.blockNewOpens).toBe(true);
  });
  it('stop 취소 확인 + 포지션 잔존 → CANCELLED + 비상 종료 요구', () => {
    const j = judgeProtection({ ...base, currentStatus: 'ACTIVE', onchainCancelled: true, positionExists: true });
    expect(j.nextStatus).toBe('CANCELLED');
    expect(j.emergencyCloseRequired).toBe(true);
  });
  it('stop 취소 + 포지션 없음 → CANCELLED, 비상 종료 불요', () => {
    const j = judgeProtection({ ...base, currentStatus: 'SUBMITTED', onchainCancelled: true, positionExists: false });
    expect(j.nextStatus).toBe('CANCELLED');
    expect(j.emergencyCloseRequired).toBe(false);
  });
  it('체결 확인 → EXECUTED', () => {
    expect(judgeProtection({ ...base, currentStatus: 'ACTIVE', onchainExecuted: true }).nextStatus).toBe('EXECUTED');
  });
  it('포지션 조회 실패 → 전이 없음 + 신규 OPEN 차단', () => {
    const j = judgeProtection({ ...base, currentStatus: 'SUBMITTED', positionExists: null });
    expect(j.nextStatus).toBeNull();
    expect(j.blockNewOpens).toBe(true);
  });
  it('포지션 존재 + UNRESOLVED stop → 비상 종료 요구', () => {
    const j = judgeProtection({ ...base, currentStatus: 'UNRESOLVED' });
    expect(j.emergencyCloseRequired).toBe(true);
    expect(j.blockNewOpens).toBe(true);
  });
  it('terminal 상태는 어떤 증거에도 재전이 없음', () => {
    const j = judgeProtection({ ...base, currentStatus: 'EXECUTED', onchainCancelled: true });
    expect(j.nextStatus).toBeNull();
  });
});
