/**
 * 6I-3 §테스트 — bucket 승률 캘리브레이션 + 실측 비용 결속 + ENV ranking 완성.
 *  1. calibration: 표본 임계(200/30), 신선도(14일), 미래 시각 오염, bucket 오염 방지
 *  2. costEngine: 성분 null 전파, exponent≠2 거부, rebate 0 clamp, freshness=min 결속
 *  3. intelCycle 통합: bucket p 결속, 비용 실측 결속, 조회 실패=fail-closed
 *  4. SHADOW_ONLY 불변: 신규 intel 모듈 실행 경로 import 금지 (정적)
 * 외부 네트워크·DB 0회 (전부 mock/순수 모듈).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  calibrateBucket, calibrateBuckets, bucketKeyOf, emptyBucket, CalibrationBucketRaw,
} from '../intel/calibration';
import { MIN_CALIBRATION_SAMPLES, MIN_CALIBRATING_SAMPLES, totalCostUsd } from '../intel/candidate';
import {
  buildCandidateCostBreakdown, computeRoundTripImpactUsd, computeExecutionFeeUsd,
  IMPACT_EXPONENT_2_0, INTEL_COST_POLICY, MarketFeeParams, MarketRateInputs,
} from '../intel/costEngine';
import { createGmxCostReader } from '../intel/gmxCostReader';
import { runIntelCycle, __resetIntelCycleLockForTests, CANDIDATE_ASSUMPTIONS } from '../intel/intelCycle';
import { IntelFetchers } from '../intel/dataSource';
import { RankingGates } from '../intel/ranking';
import { Candle } from '../intel/types';
import { CostBreakdownUsd } from '../intel/candidate';

const NOW = 1_800_000_000_000;
const ADDR = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const DAY = 86_400_000;

function mkCandles(count: number, opts?: { stepMs?: number; start?: number; drift?: number; base?: number }): Candle[] {
  const step = opts?.stepMs ?? 900_000;
  const start = opts?.start ?? NOW - count * step;
  const drift = opts?.drift ?? 0;
  const base = opts?.base ?? 100;
  const out: Candle[] = [];
  let p = base;
  for (let i = 0; i < count; i++) {
    const o = p;
    p = p * (1 + drift);
    const c = p;
    out.push({ t: start + i * step, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1000 });
  }
  return out;
}

// ── 1. bucket 캘리브레이션 ───────────────────────────────────────────────────
describe('6I-3 §1 bucket 승률 캘리브레이션', () => {
  const raw = (over?: Partial<CalibrationBucketRaw>): CalibrationBucketRaw => ({
    regime: 'TREND_UP', direction: 'LONG',
    targetCount: 120, stopCount: 80, noneCount: 40, lastDecisiveAtMs: NOW - DAY,
    ...over,
  });

  it('decisive ≥200 + 신선 → CALIBRATED, p=target/decisive (NONE 분모 제외)', () => {
    const b = calibrateBucket(raw(), NOW);
    expect(b.status).toBe('CALIBRATED');
    expect(b.winProbability).toBeCloseTo(120 / 200);
    expect(b.decisiveSamples).toBe(200);
    expect(b.noneCount).toBe(40); // 관측만 — 분모 미포함
  });

  it('decisive 199 = CALIBRATING/UNCALIBRATED — p는 null (가짜 50% 금지)', () => {
    const b = calibrateBucket(raw({ targetCount: 119 }), NOW); // 199 decisive
    expect(b.status).toBe('CALIBRATING');
    expect(b.winProbability).toBeNull();
    expect(b.reason).toContain(`${MIN_CALIBRATION_SAMPLES}`);
    const u = calibrateBucket(raw({ targetCount: 10, stopCount: 10 }), NOW); // 20 < 30
    expect(u.status).toBe('UNCALIBRATED');
    expect(u.winProbability).toBeNull();
    expect(u.reason).toContain(`${MIN_CALIBRATING_SAMPLES}`);
  });

  it('마지막 decisive 표본 14일 초과 = STALE, p=null (오래된 보정 사용 금지)', () => {
    const b = calibrateBucket(raw({ lastDecisiveAtMs: NOW - 15 * DAY }), NOW);
    expect(b.status).toBe('STALE');
    expect(b.winProbability).toBeNull();
  });

  it('미래 시각 표본 = 데이터 오염 → p 사용 금지 (lookahead/시계 오류 방어)', () => {
    const b = calibrateBucket(raw({ lastDecisiveAtMs: NOW + 3_600_000 }), NOW);
    expect(b.status).toBe('STALE');
    expect(b.winProbability).toBeNull();
    expect(b.reason).toContain('미래');
  });

  it('bucket 오염 방지 — 키는 regime×방향 정확 결합, 다른 bucket과 혼합 없음', () => {
    const map = calibrateBuckets([
      raw(),
      raw({ regime: 'TREND_UP', direction: 'SHORT', targetCount: 10, stopCount: 190 }),
    ], NOW);
    expect(map.get(bucketKeyOf('TREND_UP', 'LONG'))!.winProbability).toBeCloseTo(0.6);
    expect(map.get(bucketKeyOf('TREND_UP', 'SHORT'))!.winProbability).toBeCloseTo(0.05);
    expect(map.get(bucketKeyOf('RANGE', 'LONG'))).toBeUndefined();
  });

  it('emptyBucket = 표본 0 UNCALIBRATED (조회 실패 null과 구분)', () => {
    const b = emptyBucket('RANGE', 'SHORT', NOW);
    expect(b.status).toBe('UNCALIBRATED');
    expect(b.winProbability).toBeNull();
    expect(b.decisiveSamples).toBe(0);
  });
});

// ── 2. costEngine ────────────────────────────────────────────────────────────
describe('6I-3 §2 실측 비용 breakdown', () => {
  const P30 = 10n ** 30n;
  const fee = (over?: Partial<MarketFeeParams>): MarketFeeParams => ({
    positionFeeFactorNegative: 5n * 10n ** 26n,           // 5bp
    negativeImpactFactor: 10n ** 20n,
    impactExponentFactor: IMPACT_EXPONENT_2_0,
    estimatedGasFeeBaseAmount: 1_000_000n,
    estimatedGasFeeMultiplierFactor: P30,                 // ×1
    increaseOrderGasLimit: 4_000_000n,
    decreaseOrderGasLimit: 4_000_000n,
    gasPriceWei: 100_000_000n,                            // 0.1 gwei
    observedAtMs: NOW - 60_000,
    ...over,
  });
  const rates = (over?: Partial<MarketRateInputs>): MarketRateInputs => ({
    fundingLongPerHour: -0.00002, fundingShortPerHour: 0.00001,
    borrowingLongPerHour: 0.00003, borrowingShortPerHour: 0.00001,
    openInterestLong30: 10_000_000n * P30, openInterestShort30: 9_000_000n * P30,
    observedAtMs: NOW - 120_000,
    ...over,
  });
  const input = (over?: object) => ({
    marketToken: ADDR(1), isLong: true, notionalUsd: 1_000, holdingHours: 4,
    feeParams: fee(), rates: rates(), ethPriceUsd: 3_000, ethPriceObservedAtMs: NOW - 30_000, nowMs: NOW, ...over,
  });

  it('전 성분 실측 확보 → 전부 non-null, totalCostUsd 산출 가능', () => {
    const c = buildCandidateCostBreakdown(input());
    expect(c.entryFeeUsd).toBeCloseTo(0.5);   // 5bp × $1000
    expect(c.estimatedExitFeeUsd).toBeCloseTo(0.5);
    expect(c.fundingCostUsd).toBeCloseTo(0.00002 * 4 * 1000); // |rate| 보수 상한
    expect(c.borrowingCostUsd).toBeCloseTo(0.00003 * 4 * 1000);
    expect(c.priceImpactUsd).not.toBeNull();
    expect(c.slippageUsd).toBe(0);            // MECHANISM_ZERO — 근거 있는 0
    expect(c.gasExecutionFeeUsd).toBeGreaterThan(0);
    expect(c.latencyRiskReserveUsd).toBeCloseTo(1000 * INTEL_COST_POLICY.latencyRiskReserveFraction);
    expect(c.failureRiskReserveUsd).toBeCloseTo(1000 * INTEL_COST_POLICY.failureRiskReserveFraction);
    expect(totalCostUsd(c)).not.toBeNull();
    expect(c.costBasis).not.toContain('UNAVAILABLE');
  });

  it('freshness = 실측 성분 관측 시각의 최솟값 (가장 오래된 것 — stale 은폐 금지)', () => {
    const c = buildCandidateCostBreakdown(input());
    expect(c.costSnapshotFetchedAtMs).toBe(NOW - 120_000); // rates가 더 오래됨
  });

  it('rates 조회 실패 → funding/borrowing/impact null → totalCost null (부분합 위장 금지)', () => {
    const c = buildCandidateCostBreakdown(input({ rates: null }));
    expect(c.fundingCostUsd).toBeNull();
    expect(c.borrowingCostUsd).toBeNull();
    expect(c.priceImpactUsd).toBeNull();
    expect(totalCostUsd(c)).toBeNull();
    expect(c.costBasis).toContain('UNAVAILABLE');
  });

  it('feeParams 실패 → 수수료/gas/impact null; ETH 가격 실패 → gas null', () => {
    const noFee = buildCandidateCostBreakdown(input({ feeParams: null }));
    expect(noFee.entryFeeUsd).toBeNull();
    expect(noFee.gasExecutionFeeUsd).toBeNull();
    expect(totalCostUsd(noFee)).toBeNull();
    const noEth = buildCandidateCostBreakdown(input({ ethPriceUsd: null }));
    expect(noEth.gasExecutionFeeUsd).toBeNull();
    expect(noEth.entryFeeUsd).not.toBeNull();
    expect(totalCostUsd(noEth)).toBeNull();
  });

  it('impact exponent ≠ 2.0 → impact null (근사 금지)', () => {
    expect(computeRoundTripImpactUsd({
      isLong: true, notionalUsd: 1000,
      oiLong30: 0n, oiShort30: 0n,
      negativeImpactFactor: 10n ** 20n, impactExponentFactor: IMPACT_EXPONENT_2_0 + 1n,
    })).toBeNull();
  });

  it('불균형 개선(rebate) 방향은 0 clamp — 음수 비용/보상 위장 금지', () => {
    // SHORT 진입이 long-heavy 불균형을 개선 → entry rebate → 0 clamp, 청산 악화분만 비용
    const v = computeRoundTripImpactUsd({
      isLong: false, notionalUsd: 1000,
      oiLong30: 10_000_000n * P30, oiShort30: 9_000_000n * P30,
      negativeImpactFactor: 10n ** 20n, impactExponentFactor: IMPACT_EXPONENT_2_0,
    });
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThanOrEqual(0);
  });

  it('gas 파라미터 비정상(0/음수/폭주) = null', () => {
    expect(computeExecutionFeeUsd(fee({ gasPriceWei: 0n }), 3000)).toBeNull();
    expect(computeExecutionFeeUsd(fee({ increaseOrderGasLimit: 0n }), 3000)).toBeNull();
    expect(computeExecutionFeeUsd(fee({ gasPriceWei: 10n ** 18n }), 3000)).toBeNull(); // >1000 ETH
    expect(computeExecutionFeeUsd(fee(), 3000)).toBeGreaterThan(0);
  });

  it('freshness — ETH 가격이 가장 오래된 실측이면 그 시각이 min으로 결속 (stale 은폐 금지)', () => {
    const c = buildCandidateCostBreakdown(input({ ethPriceObservedAtMs: NOW - 600_000 }));
    expect(c.gasExecutionFeeUsd).not.toBeNull();
    expect(c.costSnapshotFetchedAtMs).toBe(NOW - 600_000);
  });

  it('ETH 가격 관측 시각 미상 → gas 성분 산출 금지 (freshness 결속 불가)', () => {
    const c = buildCandidateCostBreakdown(input({ ethPriceObservedAtMs: null }));
    expect(c.gasExecutionFeeUsd).toBeNull();
    expect(totalCostUsd(c)).toBeNull();
  });

  it('costReader 캐시 hit + gasPrice 재조회 시 observedAtMs는 원 관측 시각 유지 (현재 시각 위장 금지)', async () => {
    let uintCalls = 0;
    const r = createGmxCostReader({
      client: {
        readContract: async () => { uintCalls++; return 5n * 10n ** 26n; },
        getGasPrice: async () => 100_000_000n,
      } as never,
      nowFn: () => NOW,
    });
    const first = await r.readMarketFeeParams(ADDR(1), NOW);
    expect(first).not.toBeNull();
    expect(first!.observedAtMs).toBe(NOW);
    const callsAfterFirst = uintCalls;
    const second = await r.readMarketFeeParams(ADDR(1), NOW + 120_000); // TTL 내 캐시 hit
    expect(uintCalls).toBe(callsAfterFirst);              // DataStore 재조회 없음
    expect(second!.observedAtMs).toBe(NOW);               // 원 관측 시각 유지
  });

  it('costReader: RPC 미구성(client null) = fail-closed null; 잘못된 주소 = null', async () => {
    const r = createGmxCostReader({ client: null });
    expect(await r.readMarketFeeParams(ADDR(1), NOW)).toBeNull();
    const r2 = createGmxCostReader({
      client: { readDataStoreUint: async () => 1n, getGasPrice: async () => 1n },
    });
    expect(await r2.readMarketFeeParams('not-an-address', NOW)).toBeNull();
  });
});

// ── 3. intelCycle 통합 (mock — 외부 호출 0회) ────────────────────────────────
describe('6I-3 §3 intelCycle bucket+비용 결속', () => {
  const mkFetchers = (over?: Partial<IntelFetchers>): IntelFetchers => ({
    fetchMarketRows: async () => ({
      rows: [{
        marketToken: ADDR(1), indexToken: ADDR(2), symbol: 'ETH', isListed: true, isDisabled: false,
        liquidityUsd: 50_000_000, openInterestUsd: 10_000_000, lastPriceAtMs: NOW - 5_000, impactDataAvailable: true,
      }], complete: true, failureReason: null,
    }),
    fetchCandles: async () => mkCandles(96, { drift: 0.002 }),
    fetchPrice: async () => ({ price: 100, observedAtMs: NOW - 3_000 }),
    fetch24hChange: async () => 2.5,
    fetchFundingBorrowing: async () => null,
    ...over,
  });
  const gates: RankingGates = {
    riskEngineAllowsEntry: true, riskEngineBlockReason: null,
    openPositionExists: false, dailyEntryLimitReached: false, nowMs: NOW,
  };
  const fullCost = (): CostBreakdownUsd => buildCostFixture();
  function buildCostFixture(): CostBreakdownUsd {
    return {
      entryFeeUsd: 0.5, estimatedExitFeeUsd: 0.5, fundingCostUsd: 0.08, borrowingCostUsd: 0.12,
      priceImpactUsd: 0.05, slippageUsd: 0, gasExecutionFeeUsd: 0.3,
      latencyRiskReserveUsd: 0.5, failureRiskReserveUsd: 0.2,
      holdingHoursAssumed: 4, costBasis: '실측 fixture', costSource: 'GMX_MEASURED_READONLY',
      costSnapshotFetchedAtMs: NOW - 10_000,
    };
  }

  it('CALIBRATED bucket + 실측 비용 → 해당 방향만 p·ENV 산출; 다른 bucket은 null 유지', async () => {
    __resetIntelCycleLockForTests();
    const costCalls: { isLong: boolean; notionalUsd: number; holdingHours: number }[] = [];
    const rec = await runIntelCycle({
      fetchers: mkFetchers(),
      getCompletedSampleCount: async () => ({ count: 0, lastAtMs: null }),
      getCalibrationBuckets: async () => calibrateBuckets([
        // 사이클이 산출하는 regime과 무관하게 두 방향 모두 제공 — LONG만 CALIBRATED
        ...['STRONG_BULL', 'WEAK_BULL', 'STRONG_BEAR', 'WEAK_BEAR', 'RANGE', 'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'OVERHEATED', 'OVERSOLD', 'ABNORMAL', 'UNAVAILABLE'].map(regime => ({
          regime, direction: 'LONG' as const, targetCount: 130, stopCount: 90, noneCount: 5, lastDecisiveAtMs: NOW - DAY,
        })),
      ], NOW),
      buildCandidateCost: async (a) => { costCalls.push(a); return fullCost(); },
      persist: async () => {},
      gates, nowMs: NOW, cycleId: 'c-6i3-1',
    });
    expect(rec).not.toBeNull();
    const long = rec!.candidates.find(c => c.direction === 'LONG')!;
    const short = rec!.candidates.find(c => c.direction === 'SHORT')!;
    expect(long.winProbability).toBeCloseTo(130 / 220);
    expect(long.probabilityCalibrationStatus).toBe('CALIBRATED');
    expect(long.expectedNetValueUsd).not.toBeNull();     // p+비용 완전 → ENV 산출
    expect(long.totalExpectedCostUsd).toBeCloseTo(2.25);
    expect(long.calibrationBucket!.decisiveSamples).toBe(220);
    expect(short.winProbability).toBeNull();             // bucket 없음 → 미보정
    expect(short.expectedNetValueUsd).toBeNull();
    expect(short.calibrationBucket!.decisiveSamples).toBe(0);
    // 비용은 방향·명목·보유시간 결속 호출
    expect(costCalls).toHaveLength(2);
    expect(costCalls.map(c => c.isLong).sort()).toEqual([false, true]);
    for (const c of costCalls) {
      expect(c.notionalUsd).toBe(CANDIDATE_ASSUMPTIONS.shadowNotionalUsd);
      expect(c.holdingHours).toBe(CANDIDATE_ASSUMPTIONS.holdingHours);
    }
  });

  it('bucket 조회 실패(null)·비용 조회 throw → p·비용 null 유지 (fail-closed, 사이클 계속)', async () => {
    __resetIntelCycleLockForTests();
    const rec = await runIntelCycle({
      fetchers: mkFetchers(),
      getCompletedSampleCount: async () => ({ count: 0, lastAtMs: null }),
      getCalibrationBuckets: async () => null,
      buildCandidateCost: async () => { throw new Error('RPC down'); },
      persist: async () => {},
      gates, nowMs: NOW, cycleId: 'c-6i3-2',
    });
    expect(rec!.decision).toBe('NO_TRADE'); // 전 후보 미달 = 정상 결과
    for (const c of rec!.candidates) {
      expect(c.winProbability).toBeNull();
      expect(c.totalExpectedCostUsd).toBeNull();
      expect(c.expectedNetValueUsd).toBeNull();
      expect(c.calibrationBucket ?? null).toBeNull();    // 조회 실패 — 표본 0 위장 금지
    }
  });

  it('부분 비용(성분 null 포함) → totalCost null → ENV null (0 대체 금지)', async () => {
    __resetIntelCycleLockForTests();
    const partial: CostBreakdownUsd = { ...fullCost(), fundingCostUsd: null };
    const rec = await runIntelCycle({
      fetchers: mkFetchers(),
      getCompletedSampleCount: async () => ({ count: 0, lastAtMs: null }),
      getCalibrationBuckets: async () => calibrateBuckets(
        ['STRONG_BULL', 'WEAK_BULL', 'STRONG_BEAR', 'WEAK_BEAR', 'RANGE', 'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'OVERHEATED', 'OVERSOLD', 'ABNORMAL', 'UNAVAILABLE'].flatMap(regime =>
          (['LONG', 'SHORT'] as const).map(direction => ({
            regime, direction, targetCount: 130, stopCount: 90, noneCount: 0, lastDecisiveAtMs: NOW - DAY,
          }))), NOW),
      buildCandidateCost: async () => partial,
      persist: async () => {},
      gates, nowMs: NOW, cycleId: 'c-6i3-3',
    });
    for (const c of rec!.candidates) {
      expect(c.winProbability).not.toBeNull();           // p는 있으나
      expect(c.totalExpectedCostUsd).toBeNull();         // 비용 불완전 → total null
      expect(c.expectedNetValueUsd).toBeNull();          // → ENV null
    }
  });
});

// ── 4. SHADOW_ONLY 불변 (정적) ───────────────────────────────────────────────
describe('6I-3 §4 Shadow/실행 분리 — 신규 모듈 포함', () => {
  it('calibration/costEngine/gmxCostReader는 실행·서명·relay 경로를 참조하지 않는다', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'intel');
    const forbidden = [
      /from\s+['"].*executor/i, /from\s+['"].*relay/i, /from\s+['"].*delegatedSigner/i,
      /from\s+['"].*vps/i, /forwardToVps/, /placeOrder/, /executeOrder/, /gelato/i,
      /from\s+['"].*gmxApi/i, /submitOrder/, /sendRawTransaction/i, /signTransaction/i,
      /walletClient/i, /privateKey/i,
    ];
    for (const f of ['calibration.ts', 'costEngine.ts', 'gmxCostReader.ts']) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const re of forbidden) {
        expect(src, `${f}에 실행 경로 참조(${re}) 금지`).not.toMatch(re);
      }
      // db-free 규칙 (CI에서 DB 없이 import 가능해야 함)
      expect(src, `${f}는 @workspace/db import 금지`).not.toMatch(/@workspace\/db/);
    }
  });
});
