/**
 * 6I-4 수정 검증 — priceImpact exponent DataStore 키 스킴 (태스크 #117).
 *
 *  §A 골든: 자체 키 3종이 공식 @gmx-io/sdk@1.7.0 configs/dataStore 키 함수와
 *     byte-for-byte 동일 (bool 미포함 회귀 재발 차단).
 *  §B production-like fixture: exponent=2e30 → priceImpact·totalCost non-null.
 *  §C adversarial fail-closed: 0·2.2e30·누락·stale·RPC 실패 = null 유지 + 미지원 reason.
 *  §D 읽기 전용 강제: reader는 getUint eth_call + eth_gasPrice만 — 쓰기/서명/주문 경로 0.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  positionFeeFactorKey,
  positionImpactFactorKey,
  positionImpactExponentFactorKey,
  createGmxCostReader,
} from '../intel/gmxCostReader';
import {
  buildCandidateCostBreakdown,
  computeRoundTripImpactUsd,
  IMPACT_EXPONENT_2_0,
  IMPACT_EXPONENT_KEY_SCHEMA_PIN,
  type MarketFeeParams,
  type MarketRateInputs,
} from '../intel/costEngine';
import { totalCostUsd } from '../intel/candidate';
import { impactInputFixture } from './fixtures/impactFixture';

// SDK CJS require (ESM 빌드는 vitest 해석 불가 — 6H-2C 패턴)
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdkDataStore = require('@gmx-io/sdk/configs/dataStore') as {
  positionFeeFactorKey: (m: string, b: boolean) => string;
  positionImpactFactorKey: (m: string, b: boolean) => string;
  positionImpactExponentFactorKey: (m: string, b: boolean) => string;
};

const P30 = 10n ** 30n;
const NOW = 1_787_000_000_000;
// 실 시장 주소 골든 (BTC/USD [BTC-USDC], ETH/USD, SOL/USD — 배포 manifest와 무관한 순수 해시 대조)
const MARKETS = [
  '0x47c031236e19d024b42f8AE6780E44A573170703',
  '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
  '0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9',
] as const;

describe('6I-4 impact exponent 키 — SDK 1.7.0 골든 동등성 (§A)', () => {
  it('positionImpactExponentFactorKey(market, isPositive) — byte-for-byte 일치 (pos/neg)', () => {
    for (const m of MARKETS) {
      expect(positionImpactExponentFactorKey(m, false)).toBe(sdkDataStore.positionImpactExponentFactorKey(m, false));
      expect(positionImpactExponentFactorKey(m, true)).toBe(sdkDataStore.positionImpactExponentFactorKey(m, true));
    }
  });

  it('positionImpactFactorKey — byte-for-byte 일치 (pos/neg)', () => {
    for (const m of MARKETS) {
      expect(positionImpactFactorKey(m, false)).toBe(sdkDataStore.positionImpactFactorKey(m, false));
      expect(positionImpactFactorKey(m, true)).toBe(sdkDataStore.positionImpactFactorKey(m, true));
    }
  });

  it('positionFeeFactorKey — byte-for-byte 일치 (pos/neg)', () => {
    for (const m of MARKETS) {
      expect(positionFeeFactorKey(m, false)).toBe(sdkDataStore.positionFeeFactorKey(m, false));
      expect(positionFeeFactorKey(m, true)).toBe(sdkDataStore.positionFeeFactorKey(m, true));
    }
  });

  it('exponent 키는 pos/neg가 서로 다르고, 과거(bool 미포함) 키와도 다르다', () => {
    const m = MARKETS[0];
    const neg = positionImpactExponentFactorKey(m, false);
    const pos = positionImpactExponentFactorKey(m, true);
    expect(neg).not.toBe(pos);
    // 과거 회귀 키 (bool 미포함) — 재발 시 이 값과 같아진다
    const legacyBroken = '0xbe60fcfd99ab63b9f7c2a82da310aa88958ee0146cbc9ea008d8cc16a97ac70f';
    expect(neg).not.toBe(legacyBroken);
    expect(pos).not.toBe(legacyBroken);
  });
});

// ── production-like fixture ──────────────────────────────────────────────────
const feeParams = (over: Partial<MarketFeeParams> = {}): MarketFeeParams => ({
  positionFeeFactorNegative: 6n * 10n ** 26n,        // 6bp
  negativeImpactFactor: 10n ** 20n,
  impactExponentFactor: IMPACT_EXPONENT_2_0,         // 2.0e30
  estimatedGasFeeBaseAmount: 600_000n,
  estimatedGasFeeMultiplierFactor: P30,
  increaseOrderGasLimit: 4_000_000n,
  decreaseOrderGasLimit: 4_000_000n,
  gasPriceWei: 10_000_000n,
  observedAtMs: NOW - 60_000,
  ...over,
});
const rates = (over: Partial<MarketRateInputs> = {}): MarketRateInputs => ({
  fundingLongPerHour: -2e-5,
  fundingShortPerHour: 2e-5,
  borrowingLongPerHour: 5e-6,
  borrowingShortPerHour: 0,
  openInterestLong30: 50_000_000n * P30,
  openInterestShort30: 40_000_000n * P30,
  observedAtMs: NOW - 30_000,
  sourcePin: 'arbitrum.gmxapi.io/v1/markets/tickers@sdk1.7.0(MarketTicker per-hour 1e30, 음수=지불)',
  ...over,
});
const input = (fpOver: Partial<MarketFeeParams> = {}, fp: MarketFeeParams | null = feeParams(fpOver)) => ({
  marketToken: MARKETS[0],
  isLong: true,
  notionalUsd: 1000,
  holdingHours: 4,
  feeParams: fp,
  rates: rates(),
  ethPriceUsd: 3000,
  ethPriceObservedAtMs: NOW - 45_000,
  nowMs: NOW,
  // 6I-5 — SDK 계약 impact 입력 (교차검증: feeParams와 factorNeg/exponentNeg 일치)
  impact: impactInputFixture({
    nowMs: NOW,
    inputsOver: {
      positionImpactFactorNegative: fp?.negativeImpactFactor ?? 10n ** 20n,
      positionImpactExponentFactorNegative: fp?.impactExponentFactor ?? IMPACT_EXPONENT_2_0,
      positionImpactExponentFactorPositive: fp?.impactExponentFactor ?? IMPACT_EXPONENT_2_0,
    },
  }),
});

describe('6I-4 impact fixture — exponent=2e30 → non-null 연쇄 (§B)', () => {
  it('priceImpact non-null·≥0, totalCost non-null, basis에 keySchema pin 노출', () => {
    const c = buildCandidateCostBreakdown(input());
    expect(c.priceImpactUsd).not.toBeNull();
    expect(c.priceImpactUsd!).toBeGreaterThanOrEqual(0);
    expect(totalCostUsd(c)).not.toBeNull();
    expect(totalCostUsd(c)!).toBeGreaterThan(0);
    expect(c.costBasis).toContain(IMPACT_EXPONENT_KEY_SCHEMA_PIN);
    expect(c.costBasis).not.toContain('priceImpact');   // missing 목록에 없음
  });

  it('sourcePin·componentObservedAtMs 결속 유지 (freshness=min)', () => {
    const c = buildCandidateCostBreakdown(input());
    expect(c.sourcePin).toContain('arbitrum.gmxapi.io/v1/markets/tickers');
    expect(c.costSnapshotFetchedAtMs).toBe(NOW - 60_000); // feeParams가 최고령
  });
});

describe('6I-4 adversarial fail-closed (§C)', () => {
  it('exponent=0 (미설정 슬롯 시나리오) → impact null + 범위 밖 reason (fail-closed)', () => {
    const c = buildCandidateCostBreakdown(input({ impactExponentFactor: 0n }));
    expect(c.priceImpactUsd).toBeNull();
    expect(totalCostUsd(c)).toBeNull();
    expect(c.costBasis).toContain('범위 밖');
    expect(c.costBasis).toContain(IMPACT_EXPONENT_KEY_SCHEMA_PIN);
  });

  it('exponent=2.2e30 → 6I-5부터 지원 (SDK float pow 계약) — non-null 산출', () => {
    const c = buildCandidateCostBreakdown(input({ impactExponentFactor: 22n * 10n ** 29n }));
    expect(c.priceImpactUsd).not.toBeNull();
    expect(c.priceImpactUsd!).toBeGreaterThanOrEqual(0);
    expect(c.costBasis).toContain('SDK1.7.0 getPriceImpactForPosition');
    // legacy 2.0 전용 헬퍼는 여전히 임의 exponent 거부 (근사 금지 계약 유지)
    expect(computeRoundTripImpactUsd({
      isLong: true, notionalUsd: 1000, oiLong30: 0n, oiShort30: 0n,
      negativeImpactFactor: 10n ** 20n, impactExponentFactor: 22n * 10n ** 29n,
    })).toBeNull();
  });

  it('feeParams 누락 → impact null (0 대체 금지)', () => {
    const c = buildCandidateCostBreakdown(input({}, null));
    expect(c.priceImpactUsd).toBeNull();
    expect(totalCostUsd(c)).toBeNull();
  });

  it('reader RPC 실패 → readMarketFeeParams null (성분 위장 금지)', async () => {
    const r = createGmxCostReader({
      client: {
        readContract: async () => { throw new Error('boom'); },
        getGasPrice: async () => 1n,
      } as never,
      nowFn: () => NOW,
    });
    expect(await r.readMarketFeeParams(MARKETS[0], NOW)).toBeNull();
  });

  it('캐시 hit 후 gasPrice 재조회 실패 → null (stale 캐시 위장 금지)', async () => {
    let gasFail = false;
    const r = createGmxCostReader({
      client: {
        readContract: async () => 5n * 10n ** 26n,
        getGasPrice: async () => { if (gasFail) throw new Error('rpc down'); return 100n; },
      } as never,
      nowFn: () => NOW,
    });
    expect(await r.readMarketFeeParams(MARKETS[0], NOW)).not.toBeNull();
    gasFail = true;
    expect(await r.readMarketFeeParams(MARKETS[0], NOW + 60_000)).toBeNull();
  });
});

describe('6I-4 읽기 전용 강제 (§D)', () => {
  it('reader는 getUint(dataStore)와 getGasPrice만 호출 — exponent 키는 SDK neg 키와 정확히 일치', async () => {
    const calls: { fn: string; key: string }[] = [];
    const r = createGmxCostReader({
      client: {
        readContract: async (args: { functionName: string; args: readonly [string] }) => {
          calls.push({ fn: args.functionName, key: args.args[0] });
          return 5n * 10n ** 26n;
        },
        getGasPrice: async () => 100n,
      } as never,
      nowFn: () => NOW,
    });
    await r.readMarketFeeParams(MARKETS[0], NOW);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.fn === 'getUint')).toBe(true);
    const expectedExpKey = sdkDataStore.positionImpactExponentFactorKey(MARKETS[0], false);
    expect(calls.some((c) => c.key.toLowerCase() === expectedExpKey.toLowerCase())).toBe(true);
  });

  it('gmxCostReader 소스에 쓰기/서명/주문 경로 문자열 부재 (정적)', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../intel/gmxCostReader.ts'),
      'utf8',
    );
    for (const banned of ['writeContract', 'sendTransaction', 'signTypedData', 'signMessage', 'createOrder', "method: 'POST'", 'method: "POST"']) {
      expect(src.includes(banned)).toBe(false);
    }
  });
});
