/**
 * 6I-5 — SHADOW Opportunity Ranking position price impact 완성 (임의 exponent 지원).
 *
 * 계산 계약: @gmx-io/sdk@1.7.0 utils/fees/priceImpact 공식 함수를 **직접 호출**한다
 * (getPriceImpactForPosition / capPositionImpactUsdByMaxPriceImpactFactor /
 *  capPositionImpactUsdByMaxImpactPool). 자체 근사 재구현 금지 — SDK와의 동등성은
 * 골든 테스트로 강제한다.
 *
 * 데이터 소스 pin:
 *  - 시장 impact 입력(OI·factor·exponent·virtual inventory·impact pool·cap):
 *    공식 GMX API /v1/markets/info (SDK fetchApiMarketsInfo와 동일 endpoint) — dataSource가 주입
 *  - index token decimals: SDK configs registry (indexTokenDecimals.lookupSdkIndexToken)
 *  - index 가격: oracle ticker 캐시 (min=max=mid로 사용 — 단일 oracle가, basis에 명시)
 *  - DataStore 교차검증: gmxCostReader가 읽은 POSITION_IMPACT_FACTOR(neg)·
 *    POSITION_IMPACT_EXPONENT_FACTOR(neg)와 API 값 불일치 = null (부분 계산 금지)
 *
 * 원칙 (fail-closed):
 *  - 필수 입력 누락·stale·범위 밖·불일치 = null + 명시 reason (0 대체·부분 계산 금지)
 *  - applyImpactFactor float pow의 비유한 결과가 0n으로 위장되지 않도록 입력 범위를
 *    사전 검증한다 (exponent·OI·notional 상한 — 상한 내에서는 pow가 항상 유한)
 *  - 유리(rebate) 방향: 공식 cap(maxPositionImpactFactor→impact pool) 적용 후
 *    기존 보수 정책 상한(0 USD)과 비교해 더 엄격한 값 채택 → 실질 0 계상 (과대평가 금지)
 *  - SHADOW_ONLY: 본 모듈은 순수 계산 + read-only 파싱만 — 주문/서명/POST 경로 없음
 */
import { createRequire } from 'node:module';
import { usd30ToNumber, parseBigIntStr } from './usd30';

// SDK는 CJS require로 로드 (ESM build는 확장자 없는 내부 import 때문에 로드 실패 — 6G-1 함정)
const _require = createRequire(import.meta.url ?? __filename);
// 타입은 로컬 정의 (SDK 내부 타입 의존 금지 — 필요한 함수 시그니처만 결속)
interface SdkPriceImpactResult { priceImpactDeltaUsd: bigint; balanceWasImproved: boolean }
interface SdkFees {
  getPriceImpactForPosition(mi: unknown, sizeDeltaUsd: bigint, isLong: boolean, opts?: { sizeDeltaInTokens?: bigint }): SdkPriceImpactResult;
  capPositionImpactUsdByMaxPriceImpactFactor(mi: unknown, sizeDeltaUsd: bigint, impact: bigint): bigint;
  capPositionImpactUsdByMaxImpactPool(mi: unknown, impact: bigint): bigint;
  applyImpactFactor(diff: bigint, factor: bigint, exponent: bigint): bigint;
}
interface SdkTokens {
  convertToTokenAmountForIncrease(usd: bigint, decimals: number, price: bigint, isLong: boolean): bigint | undefined;
  convertToUsd(amount: bigint, decimals: number, price: bigint): bigint | undefined;
}
const sdkFees = _require('@gmx-io/sdk/utils/fees') as SdkFees;
const sdkTokens = _require('@gmx-io/sdk/utils/tokens') as SdkTokens;

const P30 = 10n ** 30n;
const ZERO_HASH = '0x' + '0'.repeat(64);

/** 출처 pin — API/UI 노출용 (endpoint + SDK 계산 계약) */
export const IMPACT_SOURCE_PIN =
  'arbitrum.gmxapi.io/v1/markets/info@sdk1.7.0(getPriceImpactForPosition·cap 공식 함수 직접 호출)';

/** 기존 보수 정책 — rebate(유리 방향) 계상 상한 (USD). 공식 cap과 min 결합 (더 엄격한 값) */
export const POLICY_REBATE_CAP_USD = 0;

// ── 입력 범위 상한 (float pow 유한성 보장 + 명백한 비정상 거부) ─────────────────
/** exponent 허용 범위 (1e30 스케일): 0.5 ≤ e ≤ 5.0 — 범위 밖 = null (프로덕션 실측 1.7~2.0) */
export const IMPACT_EXPONENT_MIN_30 = 5n * 10n ** 29n;
export const IMPACT_EXPONENT_MAX_30 = 5n * P30;
/** OI/diff 상한: 1e13 USD (1e43 @1e30) — (diff/1e30)^5 ≤ 1e65 로 pow 항상 유한 */
const MAX_OI_30 = 10n ** 43n;
/** impact factor 상한 (1e30 스케일) — 프로덕션 실측 ~e21..e22, 1e27(=1e-3) 초과는 비정상 */
const MAX_IMPACT_FACTOR_30 = 10n ** 27n;
/** |virtual inventory| 상한 */
const MAX_VI_30 = 10n ** 44n;
/** impact pool 상한 (token amount, decimals ≤30 기준 여유 상한) */
const MAX_POOL_AMOUNT = 10n ** 40n;

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 시장별 impact 입력 — 공식 /v1/markets/info 실측 (전부 1e30/토큰 단위 BigInt) */
export interface ImpactMarketInputs {
  marketTokenAddress: string;
  indexTokenAddress: string;
  useOpenInterestInTokensForBalance: boolean;
  longInterestUsd: bigint;                 // 1e30
  shortInterestUsd: bigint;                // 1e30
  longInterestInTokens: bigint;            // index token 단위
  shortInterestInTokens: bigint;
  positionImpactFactorPositive: bigint;    // 1e30
  positionImpactFactorNegative: bigint;
  positionImpactExponentFactorPositive: bigint;
  positionImpactExponentFactorNegative: bigint;
  maxPositionImpactFactorPositive: bigint;
  maxPositionImpactFactorNegative: bigint;
  positionImpactPoolAmount: bigint;        // index token 단위
  virtualIndexTokenId: string;             // bytes32; zeroHash = VI 미구성
  virtualInventoryForPositions: bigint;    // signed 1e30
  virtualInventoryForPositionsInTokens: bigint; // signed token 단위
  observedAtMs: number;
  sourcePin: string;
}

/**
 * /v1/markets/info 응답 → impact 입력 파서 (순수 함수, 테스트 대상).
 * 필수 필드 누락·형식 위반·범위 밖 record는 폐기 (부분 채택·clamp 금지).
 */
export function parseMarketsImpactInfo(raw: unknown): {
  entries: Map<string, Omit<ImpactMarketInputs, 'observedAtMs' | 'sourcePin'>>;
  rejects: { count: number; reasons: string[] };
} {
  const entries = new Map<string, Omit<ImpactMarketInputs, 'observedAtMs' | 'sourcePin'>>();
  const reasons: string[] = [];
  let count = 0;
  const reject = (why: string) => { count++; if (reasons.length < 8) reasons.push(why); };
  if (!Array.isArray(raw)) return { entries, rejects: { count: 1, reasons: ['응답이 배열이 아님'] } };
  for (const rec of raw) {
    if (rec === null || typeof rec !== 'object') { reject('record가 객체 아님'); continue; }
    const m = rec as Record<string, unknown>;
    const market = typeof m['marketTokenAddress'] === 'string' ? m['marketTokenAddress'] : '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(market)) { reject('marketTokenAddress 비정상'); continue; }
    const indexToken = typeof m['indexTokenAddress'] === 'string' ? m['indexTokenAddress'] : '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(indexToken)) { reject(`${market}: indexTokenAddress 비정상`); continue; }
    const flag = m['useOpenInterestInTokensForBalance'];
    if (typeof flag !== 'boolean') { reject(`${market}: useOpenInterestInTokensForBalance 비boolean`); continue; }
    const vid = typeof m['virtualIndexTokenId'] === 'string' ? m['virtualIndexTokenId'] : '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(vid)) { reject(`${market}: virtualIndexTokenId 비정상`); continue; }
    // signed 필드 (virtual inventory 등) — JSON 문자열/safe-integer 숫자만 허용
    const s = (k: string): bigint | null => {
      const v = m[k];
      if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null;
      return parseBigIntStr(v);
    };
    // unsigned 필드
    const u = (k: string): bigint | null => {
      const v = s(k);
      return v !== null && v >= 0n ? v : null;
    };
    const oiLU = u('longInterestUsd'), oiSU = u('shortInterestUsd');
    const oiLT = u('longInterestInTokens'), oiST = u('shortInterestInTokens');
    const fP = u('positionImpactFactorPositive'), fN = u('positionImpactFactorNegative');
    const eP = u('positionImpactExponentFactorPositive'), eN = u('positionImpactExponentFactorNegative');
    const mP = u('maxPositionImpactFactorPositive'), mN = u('maxPositionImpactFactorNegative');
    const pool = u('positionImpactPoolAmount');
    const vi = s('virtualInventoryForPositions'), viT = s('virtualInventoryForPositionsInTokens');
    if (oiLU === null || oiSU === null || oiLT === null || oiST === null) { reject(`${market}: OI 파싱 실패/음수`); continue; }
    if (fP === null || fN === null || eP === null || eN === null) { reject(`${market}: impact factor/exponent 파싱 실패`); continue; }
    if (mP === null || mN === null || pool === null) { reject(`${market}: max factor/pool 파싱 실패`); continue; }
    if (vi === null || viT === null) { reject(`${market}: virtual inventory 파싱 실패`); continue; }
    entries.set(market.toLowerCase(), {
      marketTokenAddress: market, indexTokenAddress: indexToken,
      useOpenInterestInTokensForBalance: flag,
      longInterestUsd: oiLU, shortInterestUsd: oiSU,
      longInterestInTokens: oiLT, shortInterestInTokens: oiST,
      positionImpactFactorPositive: fP, positionImpactFactorNegative: fN,
      positionImpactExponentFactorPositive: eP, positionImpactExponentFactorNegative: eN,
      maxPositionImpactFactorPositive: mP, maxPositionImpactFactorNegative: mN,
      positionImpactPoolAmount: pool,
      virtualIndexTokenId: vid,
      virtualInventoryForPositions: vi, virtualInventoryForPositionsInTokens: viT,
    });
  }
  return { entries, rejects: { count, reasons } };
}

/** oracle float USD가 → 1e(30-decimals) 스케일 BigInt (SDK 가격 표현). 비정상 = null */
export function usdPriceToTokenPrice30(priceUsd: number, decimals: number): bigint | null {
  if (!fin(priceUsd) || priceUsd <= 0 || priceUsd > 1e12) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
  const p12 = BigInt(Math.round(priceUsd * 1e12));  // 12자리 소수 정밀
  if (p12 <= 0n) return null;
  const scale = 30 - decimals;
  return scale >= 12 ? p12 * 10n ** BigInt(scale - 12) : p12 / 10n ** BigInt(12 - scale);
}

/** USD Number → 1e30 BigInt (micro-USD 정밀). 비정상/범위 밖 = null */
function usdTo30(v: number): bigint | null {
  if (!fin(v) || v <= 0 || v > 1e12) return null;
  const micro = Math.round(v * 1e6);
  if (!Number.isSafeInteger(micro) || micro <= 0) return null;
  return BigInt(micro) * 10n ** 24n;
}

export interface ImpactComputationDetail {
  /** 진입/청산 impact (USD, 부호 있음 — 공식 cap 적용 후) */
  entryImpactUsd: number;
  exitImpactUsd: number;
  /** 최종 round-trip 비용 (≥0) — rebate는 min(공식 cap, 정책 0) 계상 */
  impactCostUsd: number;
  rebateCountedUsd: number;
  exponentPositiveRaw: string;
  exponentNegativeRaw: string;
  factorPositiveRaw: string;
  factorNegativeRaw: string;
  virtualInventoryConfigured: boolean;
  /** VI 재계산이 실제로 더 나쁜(작은) 값을 채택했는가 (entry/exit 어느 쪽이든) */
  virtualInventoryApplied: boolean;
  /** 평가된 cap 목록 (적용 여부 포함) */
  capsEvaluated: string[];
  sourcePin: string;
  observedAtMs: number;
}

export type ImpactResult =
  | { ok: true; detail: ImpactComputationDetail }
  | { ok: false; reason: string };

/** DataStore 교차검증 입력 (gmxCostReader 실측) — negative 측 factor/exponent */
export interface ImpactCrossCheck {
  negativeImpactFactor: bigint;
  impactExponentFactor: bigint;
}

interface MarketInfoLike {
  marketTokenAddress: string;
  useOpenInterestInTokensForBalance: boolean;
  longInterestUsd: bigint; shortInterestUsd: bigint;
  longInterestInTokens: bigint; shortInterestInTokens: bigint;
  positionImpactFactorPositive: bigint; positionImpactFactorNegative: bigint;
  positionImpactExponentFactorPositive: bigint; positionImpactExponentFactorNegative: bigint;
  maxPositionImpactFactorPositive: bigint; maxPositionImpactFactorNegative: bigint;
  positionImpactPoolAmount: bigint;
  virtualIndexTokenId: string;
  virtualInventoryForPositions: bigint;
  virtualInventoryForPositionsInTokens: bigint;
  indexToken: { address: string; decimals: number; prices: { minPrice: bigint; maxPrice: bigint } };
}

/** 한 주문의 공식 impact (+cap) — SDK 함수 직접 호출. throw = 호출부에서 reason 변환 */
function officialImpactForOrder(
  mi: MarketInfoLike, sizeDeltaUsd: bigint, isLong: boolean,
  opts: { sizeDeltaInTokens?: bigint }, caps: string[], tag: string,
): { counted: bigint; official: bigint; viApplied: boolean } {
  const { priceImpactDeltaUsd } = sdkFees.getPriceImpactForPosition(mi, sizeDeltaUsd, isLong, opts);
  // VI 적용 여부 관측 — VI 미구성 사본과 비교 (값 채택 로직은 SDK 내부 그대로)
  let viApplied = false;
  if (mi.virtualIndexTokenId !== ZERO_HASH) {
    const noVi = { ...mi, virtualIndexTokenId: ZERO_HASH };
    const { priceImpactDeltaUsd: withoutVi } = sdkFees.getPriceImpactForPosition(noVi, sizeDeltaUsd, isLong, opts);
    viApplied = withoutVi !== priceImpactDeltaUsd;
  }
  if (priceImpactDeltaUsd <= 0n) {
    // 악화(비용) 방향 — 공식 기본 경로는 negative impact를 cap하지 않음 (보수적 그대로 채택)
    return { counted: priceImpactDeltaUsd, official: priceImpactDeltaUsd, viApplied };
  }
  // 유리(rebate) 방향 — 공식 cap 순서: maxPositionImpactFactor → impact pool
  const afterFactorCap = sdkFees.capPositionImpactUsdByMaxPriceImpactFactor(mi, sizeDeltaUsd, priceImpactDeltaUsd);
  caps.push(`${tag}:maxFactorCap ${afterFactorCap < priceImpactDeltaUsd ? '적용' : '통과'}`);
  const afterPoolCap = sdkFees.capPositionImpactUsdByMaxImpactPool(mi, afterFactorCap);
  caps.push(`${tag}:impactPoolCap ${afterPoolCap < afterFactorCap ? '적용' : '통과'}`);
  // 정책 상한(0)과 공식 cap 중 더 엄격한 값 (rebate 과대평가 금지)
  const policyCap30 = usdTo30(POLICY_REBATE_CAP_USD) ?? 0n;
  const counted = afterPoolCap < policyCap30 ? afterPoolCap : policyCap30;
  caps.push(`${tag}:policyRebateCap(${POLICY_REBATE_CAP_USD}USD) 적용`);
  return { counted, official: afterPoolCap, viApplied };
}

/**
 * 진입+청산 round-trip price impact — SDK 1.7.0 공식 계약 (임의 exponent 지원).
 * 필수 입력 누락·범위 밖·교차검증 불일치 = { ok: false, reason } (0 대체·부분 계산 금지).
 */
export function computeRoundTripImpactSdk(args: {
  inputs: ImpactMarketInputs;
  indexTokenDecimals: number;
  indexPriceUsd: number;
  isLong: boolean;
  notionalUsd: number;
  /** DataStore 실측 교차검증 (null = 교차검증 불가 → 차단) */
  crossCheck: ImpactCrossCheck | null;
}): ImpactResult {
  const m = args.inputs;
  const fail = (reason: string): ImpactResult => ({ ok: false, reason });

  // ── 필수 입력·범위 검증 (fail-closed) ────────────────────────────────────
  const n30 = usdTo30(args.notionalUsd);
  if (n30 === null) return fail('notional 비정상(비유한/≤0/상한 초과)');
  for (const [name, e] of [
    ['exponentPositive', m.positionImpactExponentFactorPositive],
    ['exponentNegative', m.positionImpactExponentFactorNegative],
  ] as const) {
    if (e < IMPACT_EXPONENT_MIN_30 || e > IMPACT_EXPONENT_MAX_30) {
      return fail(`${name} 범위 밖 (0.5e30..5e30): raw=${e.toString()}`);
    }
  }
  if (m.positionImpactFactorPositive < 0n || m.positionImpactFactorPositive > MAX_IMPACT_FACTOR_30) return fail('factorPositive 범위 밖');
  if (m.positionImpactFactorNegative <= 0n || m.positionImpactFactorNegative > MAX_IMPACT_FACTOR_30) return fail('factorNegative 범위 밖(≤0 포함)');
  if (m.maxPositionImpactFactorPositive < 0n || m.maxPositionImpactFactorPositive >= P30) return fail('maxFactorPositive 범위 밖');
  if (m.maxPositionImpactFactorNegative < 0n || m.maxPositionImpactFactorNegative >= P30) return fail('maxFactorNegative 범위 밖');
  if (m.longInterestUsd > MAX_OI_30 || m.shortInterestUsd > MAX_OI_30) return fail('OI 상한 초과');
  if (m.positionImpactPoolAmount > MAX_POOL_AMOUNT) return fail('impact pool 상한 초과');
  const viAbs = m.virtualInventoryForPositions < 0n ? -m.virtualInventoryForPositions : m.virtualInventoryForPositions;
  if (viAbs > MAX_VI_30) return fail('virtual inventory 상한 초과');

  // ── DataStore 교차검증 (negative 측 factor/exponent) ─────────────────────
  if (args.crossCheck === null) return fail('DataStore 교차검증 불가 (feeParams 미확보)');
  if (args.crossCheck.negativeImpactFactor !== m.positionImpactFactorNegative) {
    return fail('불일치: API factorNegative ≠ DataStore POSITION_IMPACT_FACTOR(neg)');
  }
  if (args.crossCheck.impactExponentFactor !== m.positionImpactExponentFactorNegative) {
    return fail('불일치: API exponentNegative ≠ DataStore POSITION_IMPACT_EXPONENT_FACTOR(neg)');
  }

  // ── index token 가격 (oracle 단일가 → min=max) ───────────────────────────
  const price30 = usdPriceToTokenPrice30(args.indexPriceUsd, args.indexTokenDecimals);
  if (price30 === null) return fail('index 가격/decimals 비정상');

  // ── 토큰 단위 OI/VI 경계 (fail-closed) — token-OI 시장은 SDK가 이 값을 USD로
  // 환산해 float pow에 투입하므로, 환산 USD가 MAX_OI_30을 넘으면 pow 비유한 →
  // SDK가 0n을 반환해 $0 impact로 위장될 수 있다. 사전 차단 (0 위장 금지).
  if (m.longInterestInTokens < 0n || m.shortInterestInTokens < 0n) return fail('토큰 OI 음수 — 차단');
  if (m.longInterestInTokens * price30 > MAX_OI_30 || m.shortInterestInTokens * price30 > MAX_OI_30) {
    return fail('토큰 OI 환산 USD 상한 초과 (pow overflow 사전 차단)');
  }
  const viTokAbs = m.virtualInventoryForPositionsInTokens < 0n
    ? -m.virtualInventoryForPositionsInTokens : m.virtualInventoryForPositionsInTokens;
  if (viTokAbs * price30 > MAX_VI_30) return fail('토큰 VI 환산 USD 상한 초과 (pow overflow 사전 차단)');

  const baseInfo: MarketInfoLike = {
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
    indexToken: {
      address: m.indexTokenAddress, decimals: args.indexTokenDecimals,
      prices: { minPrice: price30, maxPrice: price30 },
    },
  };

  const caps: string[] = [];
  try {
    // ── 진입 (increase, sizeDeltaUsd=+n30) ──────────────────────────────────
    const entry = officialImpactForOrder(baseInfo, n30, args.isLong, {}, caps, 'entry');

    // 진입 토큰 수량 — SDK increase 변환과 동일 (token-OI 시장의 decrease opts에 필요)
    const entryPrice = args.isLong ? baseInfo.indexToken.prices.maxPrice : baseInfo.indexToken.prices.minPrice;
    const sizeDeltaInTokens = sdkTokens.convertToTokenAmountForIncrease(n30, args.indexTokenDecimals, entryPrice, args.isLong);
    if (m.useOpenInterestInTokensForBalance && (sizeDeltaInTokens === undefined || sizeDeltaInTokens <= 0n)) {
      return fail('sizeDeltaInTokens 산출 실패 (token-OI 시장)');
    }

    // ── 진입 후 상태 (로컬 시뮬레이션 — 자기 주문 반영) ─────────────────────
    const dTok = sizeDeltaInTokens ?? 0n;
    const post: MarketInfoLike = {
      ...baseInfo,
      longInterestUsd: baseInfo.longInterestUsd + (args.isLong ? n30 : 0n),
      shortInterestUsd: baseInfo.shortInterestUsd + (args.isLong ? 0n : n30),
      longInterestInTokens: baseInfo.longInterestInTokens + (args.isLong ? dTok : 0n),
      shortInterestInTokens: baseInfo.shortInterestInTokens + (args.isLong ? 0n : dTok),
      // VI 규약: >0=net short 우세 — long 증가는 VI 감소, short 증가는 VI 증가 (contract applyDelta 규약)
      virtualInventoryForPositions: baseInfo.virtualInventoryForPositions + (args.isLong ? -n30 : n30),
      virtualInventoryForPositionsInTokens: baseInfo.virtualInventoryForPositionsInTokens + (args.isLong ? -dTok : dTok),
    };

    // ── 청산 (decrease, sizeDeltaUsd=-n30, 동일 토큰 수량) ─────────────────
    const exit = officialImpactForOrder(post, -n30, args.isLong, { sizeDeltaInTokens: dTok > 0n ? dTok : undefined }, caps, 'exit');

    // ── 합산 — counted(정책 결합) 기준 비용 (≥0 보장: rebate counted ≤0) ────
    const cost30 = -(entry.counted + exit.counted);
    const costUsd = usd30ToNumber(cost30 < 0n ? 0n : cost30);
    const entryUsd = usd30ToNumber(entry.official < 0n ? -entry.official : entry.official);
    const exitUsd = usd30ToNumber(exit.official < 0n ? -exit.official : exit.official);
    if (costUsd === null || entryUsd === null || exitUsd === null) return fail('USD 변환 실패');
    const rebate30 = (entry.counted > 0n ? entry.counted : 0n) + (exit.counted > 0n ? exit.counted : 0n);
    const rebateUsd = usd30ToNumber(rebate30) ?? 0;

    return {
      ok: true,
      detail: {
        entryImpactUsd: (entry.official < 0n ? -1 : 1) * entryUsd,
        exitImpactUsd: (exit.official < 0n ? -1 : 1) * exitUsd,
        impactCostUsd: costUsd,
        rebateCountedUsd: rebateUsd,
        exponentPositiveRaw: m.positionImpactExponentFactorPositive.toString(),
        exponentNegativeRaw: m.positionImpactExponentFactorNegative.toString(),
        factorPositiveRaw: m.positionImpactFactorPositive.toString(),
        factorNegativeRaw: m.positionImpactFactorNegative.toString(),
        virtualInventoryConfigured: m.virtualIndexTokenId !== ZERO_HASH,
        virtualInventoryApplied: entry.viApplied || exit.viApplied,
        capsEvaluated: caps,
        sourcePin: m.sourcePin,
        observedAtMs: m.observedAtMs,
      },
    };
  } catch (e) {
    // SDK throw (음수 pool 등) — 상세는 시장 주소만 포함 가능, URL/키 없음이지만 고정 메시지로 sanitize
    return fail(`SDK 계산 거부: ${e instanceof Error && /Negative pool amount|Missing/.test(e.message) ? e.message : '내부 오류'}`);
  }
}
