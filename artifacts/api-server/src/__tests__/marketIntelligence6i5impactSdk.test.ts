/**
 * 6I-5 검증 — SHADOW Opportunity Ranking priceImpact SDK 1.7.0 계약 완성 (태스크 #118).
 *
 *  §A 골든: computeRoundTripImpactSdk가 공식 SDK 함수(getPriceImpactForPosition +
 *     maxFactor/pool cap)를 독립 조립 marketInfo로 직접 호출한 값과 정확히 일치.
 *  §B production 실측 exponent fixture (BTC 1.840 / ETH 1.759 / SOL 1.826 e30) →
 *     non-null 연쇄 (breakdown→totalCost), basis에 SDK 계약·exponent 노출.
 *  §C adversarial: NaN/음수/overflow notional, 범위 밖 exponent/factor, OI 초과,
 *     token-OI decrease, negative zero — 전부 null+reason 또는 정확 산출 (0 위장 금지).
 *  §D fail-closed: 입력 누락·DataStore 교차검증 불일치·index token 결속 실패 = null.
 *  §E rebate 정책: 유리 방향은 min(공식 cap, 0) — 비용 합산에 rebate 미계상.
 *  §F parser: /v1/markets/info 계약 위반 record 폐기.
 *  §G dataSource: read-only GET·캐시·429 backoff·부분 실패 fail-closed.
 *  §H 정적 read-only 강제: impactEngine에 주문/서명/POST 경로 0.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeRoundTripImpactSdk, parseMarketsImpactInfo, usdPriceToTokenPrice30,
  IMPACT_SOURCE_PIN, POLICY_REBATE_CAP_USD,
  type ImpactMarketInputs,
} from '../intel/impactEngine';
import { buildCandidateCostBreakdown, IMPACT_EXPONENT_2_0, type MarketFeeParams, type MarketRateInputs } from '../intel/costEngine';
import { totalCostUsd } from '../intel/candidate';
import { createProductionFetchers } from '../intel/dataSource';
import { usd30ToNumber } from '../intel/usd30';
import { impactInputsFixture, impactInputFixture, ZERO_HASH, FIXTURE_INDEX_TOKEN } from './fixtures/impactFixture';

const require2 = createRequire(import.meta.url);
const sdkFees = require2('@gmx-io/sdk/utils/fees') as {
  getPriceImpactForPosition: (mi: unknown, s: bigint, l: boolean, o?: { sizeDeltaInTokens?: bigint }) => { priceImpactDeltaUsd: bigint };
  capPositionImpactUsdByMaxPriceImpactFactor: (mi: unknown, s: bigint, i: bigint) => bigint;
  capPositionImpactUsdByMaxImpactPool: (mi: unknown, i: bigint) => bigint;
};
const sdkTokens = require2('@gmx-io/sdk/utils/tokens') as {
  convertToTokenAmountForIncrease: (usd: bigint, d: number, p: bigint, l: boolean) => bigint | undefined;
};

const P30 = 10n ** 30n;
const NOW = 1_787_000_000_000;

/** 독립 조립 marketInfo (SDK 필드명 계약) — 엔진 내부 조립과 별개 경로 */
function sdkMarketInfo(m: ImpactMarketInputs, decimals: number, priceUsd: number) {
  const price30 = usdPriceToTokenPrice30(priceUsd, decimals)!;
  return {
    marketTokenAddress: m.marketTokenAddress,
    useOpenInterestInTokensForBalance: m.useOpenInterestInTokensForBalance,
    longInterestUsd: m.longInterestUsd, shortInterestUsd: m.shortInterestUsd,
    longInterestInTokens: m.longInterestInTokens, shortInterestInTokens: m.shortInterestInTokens,
    positionImpactFactorPositive: m.positionImpactFactorPositive,
    positionImpactFactorNegative: m.positionImpactFactorNegative,
    positionImpactExponentFactorPositive: m.positionImpactExponentFactorPositive,
    positionImpactExponentFactorNegative: m.positionImpactExponentFactorNegative,
    maxPositionImpactFactorPositive: m.maxPositionImpactFactorPositive,
    maxPositionImpactFactorNegative: m.maxPositionImpactFactorNegative,
    positionImpactPoolAmount: m.positionImpactPoolAmount,
    virtualIndexTokenId: m.virtualIndexTokenId,
    virtualInventoryForPositions: m.virtualInventoryForPositions,
    virtualInventoryForPositionsInTokens: m.virtualInventoryForPositionsInTokens,
    indexToken: { address: m.indexTokenAddress, decimals, prices: { minPrice: price30, maxPrice: price30 } },
  };
}

const crossOk = (m: ImpactMarketInputs) => ({
  negativeImpactFactor: m.positionImpactFactorNegative,
  impactExponentFactor: m.positionImpactExponentFactorNegative,
});

function usd30(v: number): bigint { return BigInt(Math.round(v * 1e6)) * 10n ** 24n; }

// ── §A 골든 — SDK 직접 호출과 byte-equal ─────────────────────────────────────
describe('6I-5 §A SDK 골든 동등성', () => {
  const cases: Array<{ name: string; over: Partial<ImpactMarketInputs>; isLong: boolean; notional: number }> = [
    { name: 'same-side 악화 LONG (long>short)', over: {}, isLong: true, notional: 1000 },
    { name: 'same-side 개선 SHORT', over: {}, isLong: false, notional: 1000 },
    { name: 'crossover (notional > imbalance)', over: { longInterestUsd: 1_000_000n * P30, shortInterestUsd: 999_900n * P30 }, isLong: false, notional: 500 },
    {
      name: '임의 exponent 1.8257e30 + VI 악화',
      over: {
        positionImpactExponentFactorPositive: 18_257n * 10n ** 26n,
        positionImpactExponentFactorNegative: 18_257n * 10n ** 26n,
        virtualIndexTokenId: '0x' + 'ab'.repeat(32),
        virtualInventoryForPositions: -30_000_000n * P30,   // net long 우세 → LONG 진입 더 악화
      },
      isLong: true, notional: 2000,
    },
    {
      name: 'token-OI balance 시장 (flag=true, VI tokens)',
      over: {
        useOpenInterestInTokensForBalance: true,
        virtualIndexTokenId: '0x' + 'cd'.repeat(32),
        virtualInventoryForPositionsInTokens: -500n * 10n ** 8n,
        virtualInventoryForPositions: -30_000_000n * P30,
      },
      isLong: true, notional: 1500,
    },
  ];

  for (const c of cases) {
    it(`${c.name} — entry/exit 모두 SDK 직접 호출과 일치`, () => {
      const m = impactInputsFixture({ observedAtMs: NOW - 5_000, ...c.over });
      const r = computeRoundTripImpactSdk({
        inputs: m, indexTokenDecimals: 8, indexPriceUsd: 60_000,
        isLong: c.isLong, notionalUsd: c.notional, crossCheck: crossOk(m),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // 독립 재계산 — 진입
      const mi = sdkMarketInfo(m, 8, 60_000);
      const n30 = usd30(c.notional);
      const { priceImpactDeltaUsd: entryRaw } = sdkFees.getPriceImpactForPosition(mi, n30, c.isLong);
      const entryOfficial = entryRaw > 0n
        ? sdkFees.capPositionImpactUsdByMaxImpactPool(mi, sdkFees.capPositionImpactUsdByMaxPriceImpactFactor(mi, n30, entryRaw))
        : entryRaw;
      // 1e30 BigInt 수준 byte-equal — 표시 변환(usd30ToNumber, micro-USD 정밀)까지 동일 경로로 대조
      const absEntry = entryOfficial < 0n ? -entryOfficial : entryOfficial;
      expect(r.detail.entryImpactUsd).toBe((entryOfficial < 0n ? -1 : 1) * usd30ToNumber(absEntry)!);

      // 독립 재계산 — 진입 후 상태에서 청산
      const entryPrice = c.isLong ? mi.indexToken.prices.maxPrice : mi.indexToken.prices.minPrice;
      const dTok = sdkTokens.convertToTokenAmountForIncrease(n30, 8, entryPrice, c.isLong)!;
      const post = {
        ...mi,
        longInterestUsd: mi.longInterestUsd + (c.isLong ? n30 : 0n),
        shortInterestUsd: mi.shortInterestUsd + (c.isLong ? 0n : n30),
        longInterestInTokens: mi.longInterestInTokens + (c.isLong ? dTok : 0n),
        shortInterestInTokens: mi.shortInterestInTokens + (c.isLong ? 0n : dTok),
        virtualInventoryForPositions: mi.virtualInventoryForPositions + (c.isLong ? -n30 : n30),
        virtualInventoryForPositionsInTokens: mi.virtualInventoryForPositionsInTokens + (c.isLong ? -dTok : dTok),
      };
      const { priceImpactDeltaUsd: exitRaw } = sdkFees.getPriceImpactForPosition(post, -n30, c.isLong, { sizeDeltaInTokens: dTok });
      const exitOfficial = exitRaw > 0n
        ? sdkFees.capPositionImpactUsdByMaxImpactPool(post, sdkFees.capPositionImpactUsdByMaxPriceImpactFactor(post, -n30, exitRaw))
        : exitRaw;
      const absExit = exitOfficial < 0n ? -exitOfficial : exitOfficial;
      expect(r.detail.exitImpactUsd).toBe((exitOfficial < 0n ? -1 : 1) * usd30ToNumber(absExit)!);

      // round-trip 비용 = −(counted 합), rebate는 0 계상 — BigInt 합산 후 동일 변환
      const counted = (v: bigint) => (v < 0n ? v : 0n);
      const cost30 = -(counted(entryOfficial) + counted(exitOfficial));
      expect(r.detail.impactCostUsd).toBe(usd30ToNumber(cost30 < 0n ? 0n : cost30)!);
      expect(r.detail.impactCostUsd).toBeGreaterThanOrEqual(0);
      expect(r.detail.sourcePin).toBe(IMPACT_SOURCE_PIN);
    });
  }

  it('VI 악화 케이스는 virtualInventoryApplied=true로 보고된다', () => {
    const m = impactInputsFixture({
      observedAtMs: NOW,
      virtualIndexTokenId: '0x' + 'ab'.repeat(32),
      virtualInventoryForPositions: -80_000_000n * P30,  // 강한 net long → LONG impact 악화
    });
    const r = computeRoundTripImpactSdk({
      inputs: m, indexTokenDecimals: 8, indexPriceUsd: 60_000,
      isLong: true, notionalUsd: 5000, crossCheck: crossOk(m),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detail.virtualInventoryConfigured).toBe(true);
      expect(r.detail.virtualInventoryApplied).toBe(true);
    }
  });
});

// ── §B production 실측 exponent fixture — non-null 연쇄 ──────────────────────
describe('6I-5 §B production 실측 exponent (BTC/ETH/SOL) → non-null 연쇄', () => {
  // 실측 대역 (온체인/공식 API 관측): BTC 1.840e30, ETH 1.759e30, SOL 1.826e30
  const prod: Array<{ sym: string; exp: bigint; factorNeg: bigint }> = [
    { sym: 'BTC', exp: 1_840n * 10n ** 27n, factorNeg: 26n * 10n ** 20n },
    { sym: 'ETH', exp: 1_759n * 10n ** 27n, factorNeg: 47n * 10n ** 21n },
    { sym: 'SOL', exp: 18_257n * 10n ** 26n, factorNeg: 33n * 10n ** 22n },
  ];
  const fee = (over: Partial<MarketFeeParams>): MarketFeeParams => ({
    positionFeeFactorNegative: 6n * 10n ** 26n,
    negativeImpactFactor: 10n ** 20n, impactExponentFactor: IMPACT_EXPONENT_2_0,
    estimatedGasFeeBaseAmount: 600_000n, estimatedGasFeeMultiplierFactor: P30,
    increaseOrderGasLimit: 4_000_000n, decreaseOrderGasLimit: 4_000_000n,
    gasPriceWei: 10_000_000n, observedAtMs: NOW - 60_000, ...over,
  });
  const rates: MarketRateInputs = {
    fundingLongPerHour: -2e-5, fundingShortPerHour: 2e-5,
    borrowingLongPerHour: 5e-6, borrowingShortPerHour: 0,
    openInterestLong30: 50_000_000n * P30, openInterestShort30: 40_000_000n * P30,
    observedAtMs: NOW - 30_000, sourcePin: 'test-pin',
  };

  for (const p of prod) {
    it(`${p.sym} exponent=${p.exp.toString()} → priceImpact·totalCost non-null, basis에 exponent 노출`, () => {
      const c = buildCandidateCostBreakdown({
        marketToken: '0x47c031236e19d024b42f8AE6780E44A573170703',
        isLong: true, notionalUsd: 1000, holdingHours: 4,
        feeParams: fee({ negativeImpactFactor: p.factorNeg, impactExponentFactor: p.exp }),
        rates, ethPriceUsd: 3000, ethPriceObservedAtMs: NOW - 45_000, nowMs: NOW,
        impact: impactInputFixture({
          nowMs: NOW,
          inputsOver: {
            positionImpactFactorNegative: p.factorNeg,
            positionImpactExponentFactorNegative: p.exp,
            positionImpactExponentFactorPositive: p.exp,
          },
        }),
      });
      expect(c.priceImpactUsd).not.toBeNull();
      expect(c.priceImpactUsd!).toBeGreaterThanOrEqual(0);
      expect(totalCostUsd(c)).not.toBeNull();
      expect(c.costBasis).toContain('SDK1.7.0 getPriceImpactForPosition');
      expect(c.costBasis).toContain(p.exp.toString());
      expect(c.impactDetail?.exponentNegativeRaw).toBe(p.exp.toString());
      expect(c.componentObservedAtMs?.impactAtMs).toBe(NOW - 20_000);
    });
  }
});

// ── §C adversarial ───────────────────────────────────────────────────────────
describe('6I-5 §C adversarial — null+reason (0 위장 금지)', () => {
  const run = (over: Partial<ImpactMarketInputs> = {}, args: Partial<Parameters<typeof computeRoundTripImpactSdk>[0]> = {}) => {
    const m = impactInputsFixture({ observedAtMs: NOW, ...over });
    return computeRoundTripImpactSdk({
      inputs: m, indexTokenDecimals: 8, indexPriceUsd: 60_000,
      isLong: true, notionalUsd: 1000, crossCheck: crossOk(m), ...args,
    });
  };
  const failReason = (r: ReturnType<typeof computeRoundTripImpactSdk>) => (r.ok ? '' : r.reason);

  it('notional NaN/음수/-0/overflow → null', () => {
    for (const n of [NaN, -5, -0, 0, Infinity, 2e15]) {
      const r = run({}, { notionalUsd: n });
      expect(r.ok).toBe(false);
      expect(failReason(r)).toContain('notional');
    }
  });

  it('exponent 범위 밖 (0, 0.4e30, 5.1e30, 음수 유입 방지) → null+reason', () => {
    for (const e of [0n, 4n * 10n ** 29n, 51n * 10n ** 29n]) {
      const r = run({ positionImpactExponentFactorNegative: e }, { crossCheck: { negativeImpactFactor: 10n ** 20n, impactExponentFactor: e } });
      expect(r.ok).toBe(false);
      expect(failReason(r)).toContain('범위 밖');
    }
  });

  it('factorNegative=0 (미설정 슬롯) → null (impact 0 위장 금지)', () => {
    const r = run({ positionImpactFactorNegative: 0n }, { crossCheck: { negativeImpactFactor: 0n, impactExponentFactor: 2n * P30 } });
    expect(r.ok).toBe(false);
    expect(failReason(r)).toContain('factorNegative');
  });

  it('OI 상한 초과 / VI 상한 초과 / pool 상한 초과 → null (pow overflow 사전 차단)', () => {
    expect(run({ longInterestUsd: 10n ** 44n }).ok).toBe(false);
    expect(run({ virtualInventoryForPositions: -(10n ** 45n), virtualIndexTokenId: '0x' + 'ab'.repeat(32) }).ok).toBe(false);
    expect(run({ positionImpactPoolAmount: 10n ** 41n }).ok).toBe(false);
  });

  it('token-OI 시장: 토큰 OI/VI 극단값 → null (SDK 0n 위장 차단) — $0 impact로 통과 금지', () => {
    // 토큰 OI 환산 USD가 상한 초과 (8dec, $60k → price30=6e26; 1e18 토큰 ≈ 6e44 USD30 > 1e43)
    const bigTok = run({ useOpenInterestInTokensForBalance: true, longInterestInTokens: 10n ** 18n });
    expect(bigTok.ok).toBe(false);
    expect(failReason(bigTok)).toContain('토큰 OI 환산 USD 상한 초과');
    // 토큰 VI 극단값 (flag=true + VI 구성)
    const bigVi = run({
      useOpenInterestInTokensForBalance: true,
      virtualIndexTokenId: '0x' + 'ab'.repeat(32),
      virtualInventoryForPositionsInTokens: -(10n ** 19n),
    });
    expect(bigVi.ok).toBe(false);
    expect(failReason(bigVi)).toContain('토큰 VI 환산 USD 상한 초과');
    // 음수 토큰 OI 유입 (파서 우회 직접 호출 시나리오)
    expect(failReason(run({ shortInterestInTokens: -1n }))).toContain('토큰 OI 음수');
  });

  it('breakdown 연쇄: token-OI 극단값 → priceImpactUsd null·totalCost null (0 위장 없음)', () => {
    const c = buildCandidateCostBreakdown({
      marketToken: '0x47c031236e19d024b42f8AE6780E44A573170703',
      isLong: true, notionalUsd: 1000, holdingHours: 4,
      feeParams: {
        positionFeeFactorNegative: 6n * 10n ** 26n,
        negativeImpactFactor: 10n ** 20n, impactExponentFactor: 2n * P30,
        estimatedGasFeeBaseAmount: 600_000n, estimatedGasFeeMultiplierFactor: P30,
        increaseOrderGasLimit: 4_000_000n, decreaseOrderGasLimit: 4_000_000n,
        gasPriceWei: 10_000_000n, observedAtMs: NOW - 60_000,
      } as MarketFeeParams,
      rates: null, ethPriceUsd: 3000, ethPriceObservedAtMs: NOW - 45_000, nowMs: NOW,
      impact: impactInputFixture({
        nowMs: NOW,
        inputsOver: { useOpenInterestInTokensForBalance: true, longInterestInTokens: 10n ** 18n },
      }),
    });
    expect(c.priceImpactUsd).toBeNull();
    expect(c.impactDetail ?? null).toBeNull();
    expect(totalCostUsd(c)).toBeNull();
    expect(c.costBasis).toContain('토큰 OI 환산 USD 상한 초과');
  });

  it('청산 delta가 OI 초과여도 SDK 계약대로 처리 (nextOI 0 클램프) — 산출 유지', () => {
    // 자기 주문 포함 로컬 시뮬레이션이므로 청산은 항상 진입분 이하 — OI가 극소여도 non-null
    const r = run({ longInterestUsd: 100n * P30, shortInterestUsd: 50n * P30, longInterestInTokens: 10n ** 6n, shortInterestInTokens: 5n * 10n ** 5n });
    expect(r.ok).toBe(true);
  });

  it('index 가격 0/NaN/음수, decimals 비정수 → null', () => {
    expect(run({}, { indexPriceUsd: 0 }).ok).toBe(false);
    expect(run({}, { indexPriceUsd: NaN }).ok).toBe(false);
    expect(run({}, { indexPriceUsd: -100 }).ok).toBe(false);
    expect(run({}, { indexTokenDecimals: 8.5 }).ok).toBe(false);
  });

  it('usdPriceToTokenPrice30 — 스케일 정확성 (BTC 8dec, ETH 18dec, 30dec 경계)', () => {
    expect(usdPriceToTokenPrice30(60_000, 8)).toBe(60_000n * 10n ** 22n);
    expect(usdPriceToTokenPrice30(3_000, 18)).toBe(3_000n * 10n ** 12n);
    expect(usdPriceToTokenPrice30(1.5, 30)).toBe(1n);          // 10^0 스케일 — 내림 아님, 1e12 정밀 후 축소
    expect(usdPriceToTokenPrice30(NaN, 8)).toBeNull();
    expect(usdPriceToTokenPrice30(-1, 8)).toBeNull();
  });
});

// ── §D fail-closed (breakdown 결속) ─────────────────────────────────────────
describe('6I-5 §D breakdown fail-closed — 누락·불일치 = null + 명시 reason', () => {
  const base = () => ({
    marketToken: '0x47c031236e19d024b42f8AE6780E44A573170703',
    isLong: true, notionalUsd: 1000, holdingHours: 4,
    feeParams: {
      positionFeeFactorNegative: 6n * 10n ** 26n,
      negativeImpactFactor: 10n ** 20n, impactExponentFactor: 2n * P30,
      estimatedGasFeeBaseAmount: 600_000n, estimatedGasFeeMultiplierFactor: P30,
      increaseOrderGasLimit: 4_000_000n, decreaseOrderGasLimit: 4_000_000n,
      gasPriceWei: 10_000_000n, observedAtMs: NOW - 60_000,
    } as MarketFeeParams,
    rates: null, ethPriceUsd: 3000, ethPriceObservedAtMs: NOW - 45_000, nowMs: NOW,
  });

  it('impact 입력 미제공/부분 누락 → null + 각각의 reason', () => {
    const miss = [
      { impact: null, reason: '입력 미제공' },
      { impact: impactInputFixture({ nowMs: NOW, over: { inputs: null } }), reason: 'markets/info 미확보' },
      { impact: impactInputFixture({ nowMs: NOW, over: { indexTokenDecimals: null } }), reason: 'SDK registry index token 결속 실패' },
      { impact: impactInputFixture({ nowMs: NOW, over: { indexPriceUsd: null } }), reason: 'index 가격 미확보' },
    ];
    for (const m of miss) {
      const c = buildCandidateCostBreakdown({ ...base(), impact: m.impact });
      expect(c.priceImpactUsd).toBeNull();
      expect(c.impactDetail ?? null).toBeNull();
      expect(c.costBasis).toContain(m.reason);
      expect(totalCostUsd(c)).toBeNull();
    }
  });

  it('API indexToken ≠ SDK registry → 불일치 null', () => {
    const c = buildCandidateCostBreakdown({
      ...base(),
      impact: impactInputFixture({ nowMs: NOW, over: { sdkIndexTokenAddress: '0x' + '11'.repeat(20) } }),
    });
    expect(c.priceImpactUsd).toBeNull();
    expect(c.costBasis).toContain('불일치: API indexToken ≠ SDK registry');
  });

  it('DataStore 교차검증 불일치 (factor/exponent) → null + 불일치 reason', () => {
    const f = buildCandidateCostBreakdown({
      ...base(),
      impact: impactInputFixture({ nowMs: NOW, inputsOver: { positionImpactFactorNegative: 2n * 10n ** 20n } }),
    });
    expect(f.priceImpactUsd).toBeNull();
    expect(f.costBasis).toContain('불일치: API factorNegative');

    const e = buildCandidateCostBreakdown({
      ...base(),
      impact: impactInputFixture({ nowMs: NOW, inputsOver: { positionImpactExponentFactorNegative: 18n * 10n ** 29n } }),
    });
    expect(e.priceImpactUsd).toBeNull();
    expect(e.costBasis).toContain('불일치: API exponentNegative');
  });
});

// ── §E rebate 정책 ───────────────────────────────────────────────────────────
describe('6I-5 §E rebate — min(공식 cap, 정책 0) 계상', () => {
  it('개선 방향 주문(양수 impact)도 비용 합산에는 rebate 0 계상 (과대평가 금지)', () => {
    expect(POLICY_REBATE_CAP_USD).toBe(0);
    // 심한 불균형 시장에서 균형 개선 방향 → entry impact 양수
    const m = impactInputsFixture({
      observedAtMs: NOW,
      longInterestUsd: 60_000_000n * P30, shortInterestUsd: 10_000_000n * P30,
    });
    const r = computeRoundTripImpactSdk({
      inputs: m, indexTokenDecimals: 8, indexPriceUsd: 60_000,
      isLong: false, notionalUsd: 5000, crossCheck: crossOk(m),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detail.entryImpactUsd).toBeGreaterThan(0);       // 공식 계산은 양수
      expect(r.detail.rebateCountedUsd).toBe(0);                // 정책 계상 0
      // 비용은 청산(악화) 성분만 — entry 양수는 미계상
      expect(r.detail.impactCostUsd).toBeGreaterThanOrEqual(0);
      expect(r.detail.capsEvaluated.join(' ')).toContain('policyRebateCap(0USD)');
    }
  });
});

// ── §F parser ────────────────────────────────────────────────────────────────
describe('6I-5 §F parseMarketsImpactInfo — 계약 위반 record 폐기', () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    marketTokenAddress: '0x47c031236e19d024b42f8AE6780E44A573170703',
    indexTokenAddress: FIXTURE_INDEX_TOKEN,
    useOpenInterestInTokensForBalance: true,
    longInterestUsd: (50_000_000n * P30).toString(), shortInterestUsd: (40_000_000n * P30).toString(),
    longInterestInTokens: '83300000000', shortInterestInTokens: '66600000000',
    positionImpactFactorPositive: (5n * 10n ** 19n).toString(), positionImpactFactorNegative: (10n ** 20n).toString(),
    positionImpactExponentFactorPositive: (2n * P30).toString(), positionImpactExponentFactorNegative: (2n * P30).toString(),
    maxPositionImpactFactorPositive: (5n * 10n ** 26n).toString(), maxPositionImpactFactorNegative: (5n * 10n ** 26n).toString(),
    positionImpactPoolAmount: '100000000',
    virtualIndexTokenId: '0x' + 'ab'.repeat(32),
    virtualInventoryForPositions: '-31800000000000000000000000000000000',  // 실측: 음수 VI
    virtualInventoryForPositionsInTokens: '-53000000000',
    ...over,
  });

  it('정상 record 채택 — 음수 VI 포함 전 필드 BigInt 파싱', () => {
    const { entries, rejects } = parseMarketsImpactInfo([rec()]);
    expect(rejects.count).toBe(0);
    const e = entries.get('0x47c031236e19d024b42f8ae6780e44a573170703')!;
    expect(e.virtualInventoryForPositions).toBe(BigInt('-31800000000000000000000000000000000'));
    expect(e.virtualInventoryForPositions < 0n).toBe(true);
    expect(e.useOpenInterestInTokensForBalance).toBe(true);
    expect(e.positionImpactExponentFactorNegative).toBe(2n * P30);
  });

  it('위반 record 폐기: 주소 형식·필드 누락·음수 OI·소수 문자열·비boolean flag·배열 아님', () => {
    expect(parseMarketsImpactInfo([rec({ marketTokenAddress: 'xyz' })]).rejects.count).toBe(1);
    expect(parseMarketsImpactInfo([rec({ longInterestUsd: undefined })]).rejects.count).toBe(1);
    expect(parseMarketsImpactInfo([rec({ shortInterestUsd: '-5' })]).rejects.count).toBe(1);
    expect(parseMarketsImpactInfo([rec({ positionImpactFactorNegative: '1.5e20' })]).rejects.count).toBe(1);
    expect(parseMarketsImpactInfo([rec({ useOpenInterestInTokensForBalance: 'true' })]).rejects.count).toBe(1);
    expect(parseMarketsImpactInfo([rec({ virtualIndexTokenId: '0x1234' })]).rejects.count).toBe(1);
    expect(parseMarketsImpactInfo({ markets: [] }).rejects.count).toBe(1);
    // 부분 응답: 위반만 폐기
    const { entries, rejects } = parseMarketsImpactInfo([rec(), rec({ marketTokenAddress: 'bad' })]);
    expect(entries.size).toBe(1);
    expect(rejects.count).toBe(1);
  });
});

// ── §G dataSource — read-only GET·캐시·backoff ──────────────────────────────
describe('6I-5 §G fetchMarketImpactInputs — GET 전용·캐시·429 backoff', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const deps = { getCachedPrices: () => null, getCachedChange24h: () => null, fetchGmxCandles: async () => null };

  const apiRec = () => ({
    marketTokenAddress: '0x47c031236e19d024b42f8AE6780E44A573170703',
    indexTokenAddress: FIXTURE_INDEX_TOKEN,
    useOpenInterestInTokensForBalance: false,
    longInterestUsd: (50_000_000n * P30).toString(), shortInterestUsd: (40_000_000n * P30).toString(),
    longInterestInTokens: '83300000000', shortInterestInTokens: '66600000000',
    positionImpactFactorPositive: '50000000000000000000', positionImpactFactorNegative: '100000000000000000000',
    positionImpactExponentFactorPositive: (2n * P30).toString(), positionImpactExponentFactorNegative: (2n * P30).toString(),
    maxPositionImpactFactorPositive: '500000000000000000000000000', maxPositionImpactFactorNegative: '500000000000000000000000000',
    positionImpactPoolAmount: '100000000',
    virtualIndexTokenId: ZERO_HASH,
    virtualInventoryForPositions: '0', virtualInventoryForPositionsInTokens: '0',
  });

  it('성공 → 파싱·pin·캐시 재사용 (두 번째 호출 fetch 0회)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => [apiRec()] } as unknown as Response;
    });
    const ds = createProductionFetchers(deps);
    const a = await ds.fetchers.fetchMarketImpactInputs!('0x47c031236e19d024b42f8AE6780E44A573170703');
    expect(a).not.toBeNull();
    expect(a!.sourcePin).toBe(IMPACT_SOURCE_PIN);
    expect(a!.longInterestUsd).toBe(50_000_000n * P30);
    const b = await ds.fetchers.fetchMarketImpactInputs!('0x47c031236e19d024b42f8AE6780E44A573170703');
    expect(b).not.toBeNull();
    expect(calls.length).toBe(1);                              // 캐시 hit
    expect(calls[0].url).toContain('/v1/markets/info');
    expect(calls[0].init?.method ?? 'GET').toBe('GET');        // read-only — method 미지정(GET)
    expect(calls[0].init && 'body' in calls[0].init ? calls[0].init.body : undefined).toBeUndefined();
    expect(ds.stats.impactInfoRequests).toBe(1);
    expect(ds.stats.impactInfoCacheHits).toBe(1);
  });

  it('429 → backoff 기간 내 재요청 없이 null (backoffSkips 증가)', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => { n++; return { ok: false, status: 429, json: async () => ({}) } as unknown as Response; });
    const ds = createProductionFetchers(deps);
    expect(await ds.fetchers.fetchMarketImpactInputs!('0xabc0000000000000000000000000000000000abc')).toBeNull();
    expect(await ds.fetchers.fetchMarketImpactInputs!('0xabc0000000000000000000000000000000000abc')).toBeNull();
    expect(n).toBe(1);
    expect(ds.stats.backoffSkips).toBeGreaterThanOrEqual(1);
  });

  it('HTTP 실패/네트워크 오류/미지 시장 → null (부분 데이터 위장 금지)', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('network'); });
    const ds = createProductionFetchers(deps);
    expect(await ds.fetchers.fetchMarketImpactInputs!('0x47c031236e19d024b42f8AE6780E44A573170703')).toBeNull();
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => [apiRec()] } as unknown as Response));
    const ds2 = createProductionFetchers(deps);
    expect(await ds2.fetchers.fetchMarketImpactInputs!('0x' + '99'.repeat(20))).toBeNull(); // 목록에 없는 시장
  });
});

// ── §H 정적 read-only 강제 ───────────────────────────────────────────────────
describe('6I-5 §H SHADOW_ONLY 정적 강제 — 주문/서명/POST 0', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = (p: string) => readFileSync(join(here, '..', p), 'utf8');

  it('impactEngine: fetch/POST/서명/실행 모듈 import 0', () => {
    const s = src('intel/impactEngine.ts');
    for (const banned of ['fetch(', "method: 'POST'", 'eth_sendTransaction', 'signTypedData', 'signMessage', 'privateKey', "from '../gmx", "from '../relay", "from '../executor"]) {
      expect(s.includes(banned), `impactEngine에 금지 토큰: ${banned}`).toBe(false);
    }
  });

  it('dataSource impact fetcher: GET 전용 (method/body 지정 없음), 실행 경로 import 0', () => {
    const s = src('intel/dataSource.ts');
    for (const banned of ["method: 'POST'", 'method: "POST"', 'body:', 'signTypedData', 'eth_sendTransaction']) {
      expect(s.includes(banned), `dataSource에 금지 토큰: ${banned}`).toBe(false);
    }
  });

  it('impactDetail은 표시 전용 — costEngine이 실행 모듈을 import하지 않음', () => {
    const s = src('intel/costEngine.ts');
    for (const banned of ["from '../gmx", "from '../relay", "from '../executor", 'placeOrder', 'submitOrder']) {
      expect(s.includes(banned), `costEngine에 금지 토큰: ${banned}`).toBe(false);
    }
  });
});
