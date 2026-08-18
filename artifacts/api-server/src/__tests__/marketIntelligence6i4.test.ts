/**
 * 6I-4 §테스트 — 공식 GMX 소스 pin 비용 성분 교정 (funding·borrowing·priceImpact).
 *  1. rate30PerHourToNumber: per-hour 1e30 계약 파서 (부호 유지, ≥1/h 거부)
 *  2. parseMarketsTickers: 골든 fixture 정상 파싱 + adversarial 계약 위반 폐기
 *  3. costEngine 골든: 실 프로덕션 값 → 전 성분 non-null·totalCost·ENV 산출, 부호 규약,
 *     rebate(양수 funding) 0 계상, 성분 결손 시 null (부분합 금지)
 *  4. dataSource fetchMarketCostInputs 런타임: GET 전용, 캐시/만료/dedupe/429 backoff/실패 fail-closed
 * 외부 네트워크·DB 0회 (fetch 전부 mock — Response 객체 재사용 금지).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rate30PerHourToNumber } from '../intel/usd30';
import {
  parseMarketsTickers, createProductionFetchers, COST_SOURCE_PIN, GMX_OFFICIAL_API,
  COST_TICKERS_PATH, RATES_CACHE_TTL_MS, RATE_LIMIT_BACKOFF_MS,
} from '../intel/dataSource';
import {
  buildCandidateCostBreakdown, IMPACT_EXPONENT_2_0, MarketFeeParams, MarketRateInputs,
} from '../intel/costEngine';
import { totalCostUsd, computeExpectedNetValueUsd, CostBreakdownUsd } from '../intel/candidate';

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(HERE, 'fixtures', 'gmxMarketsTickersGolden.json'), 'utf8')) as {
  records: Record<string, string>[];
};
const SOL = '0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9';
const BTC = '0x47c031236e19d024b42f8AE6780E44A573170703';
const NOW = 1_800_000_000_000;
const P30 = 10n ** 30n;

// ── 1. per-hour 1e30 파서 ────────────────────────────────────────────────────
describe('6I-4 §1 rate30PerHourToNumber (공식 단위 계약)', () => {
  it('골든 SOL fundingRateLong → −2.0134e−5/h (부호 유지)', () => {
    expect(rate30PerHourToNumber('-20133947528265847430278800')).toBeCloseTo(-2.0133947528e-5, 12);
    expect(rate30PerHourToNumber('22076886797965905200535600')).toBeCloseTo(2.2076886798e-5, 12);
    expect(rate30PerHourToNumber('0')).toBe(0);
  });
  it('per-second 값을 per-hour로 오인해 3600배 하는 혼동 금지 — 함수는 곱하지 않는다', () => {
    // 1e25 → 1e-5/h. per-sec 오인(×3600)이면 3.6e-2가 되어야 하는데 그렇지 않음을 고정.
    expect(rate30PerHourToNumber((10n ** 25n).toString())).toBeCloseTo(1e-5, 12);
  });
  it('|rate/h| ≥ 1 = 계약 위반 → null (clamp 금지)', () => {
    expect(rate30PerHourToNumber(P30.toString())).toBeNull();          // 100%/h
    expect(rate30PerHourToNumber((-P30).toString())).toBeNull();
    expect(rate30PerHourToNumber((10n ** 40n).toString())).toBeNull(); // overflow
  });
  it('정수 문자열 외 전부 null (지수 표기·소수·공백·비문자열)', () => {
    expect(rate30PerHourToNumber('1e25')).toBeNull();
    expect(rate30PerHourToNumber('1.5')).toBeNull();
    expect(rate30PerHourToNumber(' 123')).toBeNull();
    expect(rate30PerHourToNumber(123)).toBeNull();
    expect(rate30PerHourToNumber(undefined)).toBeNull();
  });
});

// ── 2. parseMarketsTickers ───────────────────────────────────────────────────
describe('6I-4 §2 parseMarketsTickers — 골든 + adversarial', () => {
  it('골든 fixture 3개 시장 전부 채택, 값·부호·OI 정확', () => {
    const { entries, rejects } = parseMarketsTickers(golden.records);
    expect(rejects.count).toBe(0);
    expect(entries.size).toBe(3);
    const sol = entries.get(SOL.toLowerCase())!;
    expect(sol.fundingLongPerHour).toBeCloseTo(-2.0133947528e-5, 12);  // LONG 지불
    expect(sol.fundingShortPerHour).toBeCloseTo(2.2076886798e-5, 12); // SHORT 수취
    expect(sol.borrowingLongPerHour).toBeCloseTo(5.620640987e-6, 12);
    expect(sol.borrowingShortPerHour).toBe(0);
    expect(sol.openInterestLong30).toBe(853279964187529952923764658438425616n);
    const btc = entries.get(BTC.toLowerCase())!;
    expect(btc.fundingLongPerHour).toBeGreaterThan(0);                 // LONG 수취
    expect(btc.fundingShortPerHour).toBeLessThan(0);                   // SHORT 지불
    expect(btc.borrowingLongPerHour).toBe(0);
  });
  it('legacy /markets/info 스케일 값(1e29대)은 <1/h라 파싱은 되지만 — 방어는 source pin (endpoint 고정)', () => {
    // 단위 혼동은 크기만으로 항상 감별 불가 → 소스 자체를 pin (코드 상수)한다는 계약을 고정
    expect(COST_SOURCE_PIN).toContain('arbitrum.gmxapi.io/v1/markets/tickers');
    expect(COST_SOURCE_PIN).toContain('per-hour');
    expect(`${GMX_OFFICIAL_API}${COST_TICKERS_PATH}`).toBe('https://arbitrum.gmxapi.io/v1/markets/tickers');
  });
  const base = () => JSON.parse(JSON.stringify(golden.records[0])) as Record<string, unknown>;
  it.each([
    ['필드 누락', (r: Record<string, unknown>) => { delete r['fundingRateShort']; }],
    ['소수점 문자열', (r: Record<string, unknown>) => { r['fundingRateLong'] = '1.5e25'; }],
    ['|rate|≥1/h overflow', (r: Record<string, unknown>) => { r['borrowingRateLong'] = P30.toString(); }],
    ['borrowing 음수', (r: Record<string, unknown>) => { r['borrowingRateShort'] = '-1000000000000000000000000'; }],
    ['OI 음수', (r: Record<string, unknown>) => { r['longInterestUsd'] = '-1'; }],
    ['OI 누락', (r: Record<string, unknown>) => { delete r['shortInterestUsd']; }],
    ['주소 비정상', (r: Record<string, unknown>) => { r['marketTokenAddress'] = 'not-an-address'; }],
  ])('adversarial: %s → record 폐기 (부분 채택 금지)', (_name, mutate) => {
    const r = base();
    mutate(r);
    const { entries, rejects } = parseMarketsTickers([r]);
    expect(entries.size).toBe(0);
    expect(rejects.count).toBe(1);
  });
  it('배열 아님/객체 아님 → 전량 거부', () => {
    expect(parseMarketsTickers({ markets: [] }).entries.size).toBe(0);
    expect(parseMarketsTickers({ markets: [] }).rejects.count).toBe(1);
    expect(parseMarketsTickers([null, 42]).rejects.count).toBe(2);
  });
  it('부분 응답: 위반 record만 폐기, 정상 record는 채택', () => {
    const bad = base(); bad['fundingRateLong'] = 'abc';
    const { entries, rejects } = parseMarketsTickers([bad, golden.records[1]]);
    expect(entries.size).toBe(1);
    expect(entries.has(BTC.toLowerCase())).toBe(true);
    expect(rejects.count).toBe(1);
  });
});

// ── 3. costEngine 골든 (실 프로덕션 값 결속) ─────────────────────────────────
describe('6I-4 §3 비용 breakdown 골든 — 부호 규약·완전 산출·결손 null', () => {
  const feeParams = (): MarketFeeParams => ({
    positionFeeFactorNegative: 6n * 10n ** 26n,           // 6bp (실측 대역)
    negativeImpactFactor: 10n ** 20n,
    impactExponentFactor: IMPACT_EXPONENT_2_0,
    estimatedGasFeeBaseAmount: 1_000_000n,
    estimatedGasFeeMultiplierFactor: P30,
    increaseOrderGasLimit: 4_000_000n,
    decreaseOrderGasLimit: 4_000_000n,
    gasPriceWei: 100_000_000n,
    observedAtMs: NOW - 60_000,
  });
  const solRates = (): MarketRateInputs => {
    const { entries } = parseMarketsTickers(golden.records);
    return { ...entries.get(SOL.toLowerCase())!, observedAtMs: NOW - 90_000, sourcePin: COST_SOURCE_PIN };
  };
  const input = (over?: object) => ({
    marketToken: SOL, isLong: true, notionalUsd: 1_000, holdingHours: 4,
    feeParams: feeParams(), rates: solRates(), ethPriceUsd: 3_000, ethPriceObservedAtMs: NOW - 30_000, nowMs: NOW,
    ...over,
  });

  it('골든 SOL LONG(지불 사이드) → 전 성분 non-null, totalCost non-null, funding=−rate×h×명목', () => {
    const c = buildCandidateCostBreakdown(input());
    expect(c.fundingCostUsd).toBeCloseTo(2.0133947528e-5 * 4 * 1000, 9);
    expect(c.borrowingCostUsd).toBeCloseTo(5.620640987e-6 * 4 * 1000, 9);
    expect(c.priceImpactUsd).not.toBeNull();
    expect(c.entryFeeUsd).toBeCloseTo(0.6);
    expect(c.gasExecutionFeeUsd).toBeGreaterThan(0);
    expect(totalCostUsd(c)).not.toBeNull();
    expect(c.costBasis).not.toContain('UNAVAILABLE');
    expect(c.sourcePin).toBe(COST_SOURCE_PIN);
    expect(c.componentObservedAtMs).toEqual({
      feeParamsAtMs: NOW - 60_000, ratesAtMs: NOW - 90_000, ethPriceAtMs: NOW - 30_000,
    });
    expect(c.costSnapshotFetchedAtMs).toBe(NOW - 90_000); // min = rates
  });

  it('골든 SOL SHORT(수취 사이드, rate 양수) → funding=0 (rebate 미계상 보수 정책), totalCost는 산출', () => {
    const c = buildCandidateCostBreakdown(input({ isLong: false }));
    expect(c.fundingCostUsd).toBe(0);
    expect(c.costBasis).toContain('rebate 미계상');
    expect(c.borrowingCostUsd).toBe(0); // SOL borrowingShort=0 (실측 0 — 위장 아님)
    expect(totalCostUsd(c)).not.toBeNull();
  });

  it('CALIBRATED p + 완전 비용 → ENV non-null; 성분 하나라도 결손 → ENV null', () => {
    const full = buildCandidateCostBreakdown(input());
    const env = computeExpectedNetValueUsd({
      calibratedWinProbability: 0.6, calibrationStatus: 'CALIBRATED',
      expectedGrossWinUsd: 30, expectedGrossLossUsd: 20, cost: full,
    });
    expect(env).not.toBeNull();
    expect(env!).toBeCloseTo(0.6 * 30 - 0.4 * 20 - totalCostUsd(full)!, 9);
    const partial: CostBreakdownUsd = { ...full, fundingCostUsd: null };
    expect(totalCostUsd(partial)).toBeNull();
    expect(computeExpectedNetValueUsd({
      calibratedWinProbability: 0.6, calibrationStatus: 'CALIBRATED',
      expectedGrossWinUsd: 30, expectedGrossLossUsd: 20, cost: partial,
    })).toBeNull();
  });

  it('|rate| ≥ 1/h 이 유입되면 성분 null (파서 뚫려도 2차 방어)', () => {
    const c = buildCandidateCostBreakdown(input({ rates: { ...solRates(), fundingLongPerHour: -1.5 } }));
    expect(c.fundingCostUsd).toBeNull();
    expect(totalCostUsd(c)).toBeNull();
  });

  it('명목 overflow(>1e15) → impact null (clamp 금지)', () => {
    const c = buildCandidateCostBreakdown(input({ notionalUsd: 2e15 }));
    expect(c.priceImpactUsd).toBeNull();
  });
});

// ── 4. dataSource 런타임 (fetch mock — 외부 호출 0회) ────────────────────────
describe('6I-4 §4 fetchMarketCostInputs — GET 전용·캐시·backoff fail-closed', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const mkResponse = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => JSON.parse(JSON.stringify(body)),
  });
  const deps = { getCachedPrices: () => null, getCachedChange24h: () => null, fetchGmxCandles: async () => null };

  it('정상 응답 → 캐시 채움·sourcePin 결속·후속 조회는 cache hit (요청 1회)', async () => {
    let t = NOW;
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return mkResponse(golden.records);
    }));
    const h = createProductionFetchers({ ...deps, nowFn: () => t });
    const a = await h.fetchers.fetchMarketCostInputs!(SOL);
    expect(a).not.toBeNull();
    expect(a!.sourcePin).toBe(COST_SOURCE_PIN);
    expect(a!.fundingLongPerHour).toBeCloseTo(-2.0133947528e-5, 12);
    expect(a!.observedAtMs).toBe(NOW);
    const b = await h.fetchers.fetchMarketCostInputs!(BTC);
    expect(b!.fundingLongPerHour).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);                               // 캐시 hit
    expect(h.stats.tickersRequests).toBe(1);
    expect(h.stats.tickersCacheHits).toBe(1);
    // read-only GET 강제 — method/body 지정 없음 (주문·서명·POST 경로 0)
    expect(calls[0].url).toBe(`${GMX_OFFICIAL_API}${COST_TICKERS_PATH}`);
    expect((calls[0].init as Record<string, unknown> | undefined)?.['method']).toBeUndefined();
    expect((calls[0].init as Record<string, unknown> | undefined)?.['body']).toBeUndefined();
  });

  it('TTL 만료 → 재조회; 재조회 실패 시 만료 캐시 반환 금지 (stale 위장 금지)', async () => {
    let t = NOW;
    let fail = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (fail) throw new Error('network');
      return mkResponse(golden.records);
    }));
    const h = createProductionFetchers({ ...deps, nowFn: () => t });
    expect(await h.fetchers.fetchMarketCostInputs!(SOL)).not.toBeNull();
    t = NOW + RATES_CACHE_TTL_MS; // 정확히 TTL 경계 — 이미 stale로 취급
    fail = true;
    expect(await h.fetchers.fetchMarketCostInputs!(SOL)).toBeNull(); // 만료 캐시 미반환
    expect(h.stats.tickersRequests).toBe(2);
    t = NOW + RATES_CACHE_TTL_MS + 1;
    expect(await h.fetchers.fetchMarketCostInputs!(SOL)).toBeNull();
    expect(h.stats.tickersRequests).toBe(3);
  });

  it('429 → backoff 설정, backoff 동안 신규 요청 0회·null (fail-closed)', async () => {
    let t = NOW;
    const fetchMock = vi.fn(async () => mkResponse({ message: 'rate limited' }, 429));
    vi.stubGlobal('fetch', fetchMock);
    const h = createProductionFetchers({ ...deps, nowFn: () => t });
    expect(await h.fetchers.fetchMarketCostInputs!(SOL)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    t = NOW + 1_000; // backoff 내
    expect(await h.fetchers.fetchMarketCostInputs!(SOL)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);                  // 신규 요청 차단
    t = NOW + RATE_LIMIT_BACKOFF_MS + 1_000;
    fetchMock.mockImplementation(async () => mkResponse(golden.records) as never);
    expect(await h.fetchers.fetchMarketCostInputs!(SOL)).not.toBeNull();
  });

  it('스키마 위반 record는 폐기 계측, 존재하지 않는 시장 = null', async () => {
    const bad = { ...golden.records[0], borrowingRateLong: '-5' };
    vi.stubGlobal('fetch', vi.fn(async () => mkResponse([bad, golden.records[1]])));
    const h = createProductionFetchers({ ...deps, nowFn: () => NOW });
    expect(await h.fetchers.fetchMarketCostInputs!(SOL)).toBeNull();   // 위반으로 폐기됨
    expect(await h.fetchers.fetchMarketCostInputs!(BTC)).not.toBeNull();
    expect(h.stats.tickersSchemaRejects).toBe(1);
  });

  it('동시 조회 in-flight dedupe — 외부 요청 1회 병합', async () => {
    let resolveFetch: ((v: unknown) => void) | null = null;
    const fetchMock = vi.fn(() => new Promise(res => { resolveFetch = res; }));
    vi.stubGlobal('fetch', fetchMock);
    const h = createProductionFetchers({ ...deps, nowFn: () => NOW });
    const p1 = h.fetchers.fetchMarketCostInputs!(SOL);
    const p2 = h.fetchers.fetchMarketCostInputs!(BTC);
    resolveFetch!(mkResponse(golden.records));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetchFundingBorrowing은 공식 tickers LONG 사이드에서 파생 (legacy 단위 미사용)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mkResponse(golden.records)));
    const h = createProductionFetchers({ ...deps, nowFn: () => NOW });
    const fb = await h.fetchers.fetchFundingBorrowing(SOL);
    expect(fb!.fundingPerHour).toBeCloseTo(-2.0133947528e-5, 12);
    expect(fb!.borrowingPerHour).toBeCloseTo(5.620640987e-6, 12);
  });
});
