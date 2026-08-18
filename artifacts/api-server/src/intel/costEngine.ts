/**
 * 6I-3 §2 — 후보별 실측 비용 breakdown 조립 (db-free 순수 모듈).
 *
 * 데이터 출처 (전부 read-only 실측 — 합성/고정 fallback 금지):
 *  - 수수료·impact 계수·gas 파라미터: GMX DataStore getUint (RPC, gmxCostReader가 주입)
 *  - funding/borrowing per-side rate + OI(1e30): 공식 GMX /markets/info (dataSource)
 *  - ETH 가격: oracle ticker 캐시 (gas wei→USD 변환)
 *
 * 원칙:
 *  - 어떤 성분이든 실측 확보 실패 = 해당 성분 null → totalCostUsd null → ENV null
 *    (0 대체·이전 값 위장·부분합 위장 금지)
 *  - 시장·방향·명목가치 결속: 입력 그대로 산정 — 다른 시장/방향/노치널 재사용 불가 구조
 *  - price impact: GMX 공식 applyFactor 경로(1e30 BigInt). exponent가 정확히 2.0(2e30)이
 *    아니면 근사 금지 → null. 유리(rebate) 방향은 0으로 clamp (보수적).
 *  - funding: API 부호 규약을 단정하지 않는다 — |rate|를 비용 상한으로 사용 (보수적, basis 기록)
 *  - slippage: GMX 시장가 주문은 oracle 가격 체결 + impact로 표현되므로 별도 slippage 성분은
 *    메커니즘상 0 — MECHANISM_ZERO로 명시 (누락 0 위장이 아니라 근거 있는 0)
 *  - latency/failure reserve: frozen 정책 상수 (실측 아님을 basis에 명시)
 */
import { CostBreakdownUsd } from './candidate';
import { usd30ToNumber } from './usd30';

/** GMX PRECISION (1e30) */
const P30 = 10n ** 30n;
/** exponent 2.0 (1e30 스케일) — 이 값일 때만 impact 산출 (근사 금지) */
export const IMPACT_EXPONENT_2_0 = 2n * P30;

/** §2 frozen 정책 예비비 — 실측이 아닌 명시적 보수 정책 상수 */
export const INTEL_COST_POLICY = Object.freeze({
  /** 지연 위험 예비비 — 명목 대비 5bp */
  latencyRiskReserveFraction: 0.0005,
  /** 실행 실패(재시도 gas·기회손실) 예비비 — 명목 대비 2bp */
  failureRiskReserveFraction: 0.0002,
});

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** DataStore 실측 수수료/gas 파라미터 (gmxCostReader 반환) */
export interface MarketFeeParams {
  /** POSITION_FEE_FACTOR(market, forPositiveImpact=false) — 보수적(높은) 요율, 1e30 */
  positionFeeFactorNegative: bigint;
  /** POSITION_IMPACT_FACTOR(market, isPositive=false) — 1e30 */
  negativeImpactFactor: bigint;
  /** POSITION_IMPACT_EXPONENT_FACTOR(market) — 1e30 */
  impactExponentFactor: bigint;
  /** 주문 keeper 실행비 추정 파라미터 (전역 키) */
  estimatedGasFeeBaseAmount: bigint;          // ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1
  estimatedGasFeeMultiplierFactor: bigint;    // ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR (1e30)
  increaseOrderGasLimit: bigint;              // INCREASE_ORDER_GAS_LIMIT
  decreaseOrderGasLimit: bigint;              // DECREASE_ORDER_GAS_LIMIT
  gasPriceWei: bigint;                        // eth_gasPrice 실측
  /** 조회 시각 (ms) — freshness 결속 */
  observedAtMs: number;
}

/**
 * 6I-4 — 공식 /v1/markets/tickers 실측 rate·OI (dataSource 반환).
 * 단위 계약 (@gmx-io/sdk@1.7.0 MarketTicker): rate = per-HOUR 비율 (1e30 → Number 변환 완료),
 * funding 부호: 음수=해당 사이드 지불, 양수=수취. borrowing ≥0 (항상 비용). OI = 1e30 USD.
 */
export interface MarketRateInputs {
  fundingLongPerHour: number;    // 부호 있음 (음수=LONG 지불)
  fundingShortPerHour: number;   // 부호 있음 (음수=SHORT 지불)
  borrowingLongPerHour: number;  // ≥0
  borrowingShortPerHour: number;
  /** OI (1e30 BigInt) — impact imbalance 산정용 */
  openInterestLong30: bigint;
  openInterestShort30: bigint;
  observedAtMs: number;
  /** 출처 pin (endpoint+SDK 버전+단위 계약) — API/UI 노출용 */
  sourcePin: string;
}

export interface CandidateCostInput {
  marketToken: string;
  isLong: boolean;
  notionalUsd: number;
  holdingHours: number;
  feeParams: MarketFeeParams | null;   // 조회 실패 = null
  rates: MarketRateInputs | null;      // 조회 실패 = null
  ethPriceUsd: number | null;          // oracle 캐시 실패 = null
  /** ETH 가격 관측 시각 — freshness 결속. 미상(null)이면 gas 성분 산출 금지 (stale 은폐 방지) */
  ethPriceObservedAtMs: number | null;
  nowMs: number;
}

/** applyFactor — value×factor/1e30 (bigint 내림, GMX 공식) */
const applyFactor = (value: bigint, factor: bigint): bigint => (value * factor) / P30;

/**
 * exponent=2.0 전용 impact 함수: f(d) = applyFactor(d²/1e30, factor)  (전부 1e30 도메인)
 * GMX applyExponentFactor(d, 2e30) = (d/1e30)² × 1e30 = d²/1e30 과 동일.
 */
function impactFn(d30: bigint, factor: bigint): bigint {
  const dAbs = d30 < 0n ? -d30 : d30;
  return applyFactor((dAbs * dAbs) / P30, factor);
}

/** USD Number → 1e30 BigInt (micro-USD 정밀) */
function usdTo30(v: number): bigint | null {
  if (!fin(v) || v < 0 || v > 1e15) return null;
  return BigInt(Math.round(v * 1e6)) * 10n ** 24n;
}

/**
 * 진입+청산 price impact 비용 (USD, ≥0). 유리 방향은 0 clamp (보수적).
 * exponent ≠ 2.0 → null (근사 금지).
 */
export function computeRoundTripImpactUsd(args: {
  isLong: boolean; notionalUsd: number;
  oiLong30: bigint; oiShort30: bigint;
  negativeImpactFactor: bigint; impactExponentFactor: bigint;
}): number | null {
  if (args.impactExponentFactor !== IMPACT_EXPONENT_2_0) return null;
  if (args.negativeImpactFactor < 0n) return null;
  const n30 = usdTo30(args.notionalUsd);
  if (n30 === null || n30 <= 0n) return null;
  if (args.oiLong30 < 0n || args.oiShort30 < 0n) return null;

  const before = args.oiLong30 - args.oiShort30;
  const afterEntry = args.isLong ? before + n30 : before - n30;
  // 진입: 불균형 악화분만 비용 (개선=rebate → 0 clamp, 보수적)
  const entryCost30 = impactFn(afterEntry, args.negativeImpactFactor) - impactFn(before, args.negativeImpactFactor);
  // 청산: 진입 후 상태에서 반대 주문 — 악화분만 비용
  const afterExit = before; // 청산하면 원상 복귀
  const exitCost30 = impactFn(afterExit, args.negativeImpactFactor) - impactFn(afterEntry, args.negativeImpactFactor);
  const total30 = (entryCost30 > 0n ? entryCost30 : 0n) + (exitCost30 > 0n ? exitCost30 : 0n);
  const usd = usd30ToNumber(total30);
  if (usd === null || usd < 0) return null;
  return usd;
}

/** keeper 실행비 (entry+exit) wei → USD. 파라미터 비정상/ETH 가격 없음 = null */
export function computeExecutionFeeUsd(p: MarketFeeParams, ethPriceUsd: number | null): number | null {
  if (ethPriceUsd === null || !fin(ethPriceUsd) || ethPriceUsd <= 0) return null;
  if (p.gasPriceWei <= 0n || p.estimatedGasFeeMultiplierFactor <= 0n) return null;
  if (p.increaseOrderGasLimit <= 0n || p.decreaseOrderGasLimit <= 0n) return null;
  if (p.estimatedGasFeeBaseAmount < 0n) return null;
  // adjustedGasLimit = base + gasLimit×multiplier/1e30 (GMX estimateExecutionFee 경로)
  const adjIncrease = p.estimatedGasFeeBaseAmount + applyFactor(p.increaseOrderGasLimit, p.estimatedGasFeeMultiplierFactor);
  const adjDecrease = p.estimatedGasFeeBaseAmount + applyFactor(p.decreaseOrderGasLimit, p.estimatedGasFeeMultiplierFactor);
  const totalWei = (adjIncrease + adjDecrease) * p.gasPriceWei;
  if (totalWei <= 0n || totalWei > 10n ** 21n) return null; // >1000 ETH = 비정상
  const eth = Number(totalWei) / 1e18;
  const usd = eth * ethPriceUsd;
  return fin(usd) && usd >= 0 ? usd : null;
}

/**
 * 후보 비용 breakdown 조립 — 성분별 실측, 확보 실패 성분은 null 유지.
 * costSnapshotFetchedAtMs = 모든 실측 성분 관측 시각 중 가장 오래된 것 (stale 은폐 금지).
 */
export function buildCandidateCostBreakdown(input: CandidateCostInput): CostBreakdownUsd {
  const { feeParams: fp, rates, notionalUsd } = input;
  const basisParts: string[] = [];

  let entryFee: number | null = null;
  let exitFee: number | null = null;
  let impact: number | null = null;
  let gas: number | null = null;
  let funding: number | null = null;
  let borrowing: number | null = null;

  if (fp !== null && fin(notionalUsd) && notionalUsd > 0) {
    if (fp.positionFeeFactorNegative > 0n && fp.positionFeeFactorNegative < P30) {
      const rate = Number(fp.positionFeeFactorNegative) / 1e30;
      entryFee = notionalUsd * rate;
      exitFee = notionalUsd * rate;
      basisParts.push('fee=DataStore POSITION_FEE_FACTOR(negativeImpact, 보수)');
    }
    // ETH 가격 관측 시각 미상 = freshness 결속 불가 → gas 성분 산출 금지 (stale 은폐 방지)
    gas = input.ethPriceObservedAtMs !== null && fin(input.ethPriceObservedAtMs)
      ? computeExecutionFeeUsd(fp, input.ethPriceUsd)
      : null;
    if (gas !== null) basisParts.push('gas=DataStore 추정 파라미터×실측 gasPrice×oracle ETH가');
    if (rates !== null) {
      impact = computeRoundTripImpactUsd({
        isLong: input.isLong, notionalUsd,
        oiLong30: rates.openInterestLong30, oiShort30: rates.openInterestShort30,
        negativeImpactFactor: fp.negativeImpactFactor, impactExponentFactor: fp.impactExponentFactor,
      });
      if (impact !== null) basisParts.push('impact=공식 f=factor·d² (악화분만, rebate 0 clamp)');
    }
  }

  if (rates !== null && fin(input.holdingHours) && input.holdingHours > 0 && fin(notionalUsd) && notionalUsd > 0) {
    const fRate = input.isLong ? rates.fundingLongPerHour : rates.fundingShortPerHour;
    const bRate = input.isLong ? rates.borrowingLongPerHour : rates.borrowingShortPerHour;
    if (fin(fRate) && Math.abs(fRate) < 1) {
      // 공식 부호 계약: 음수=지불(비용), 양수=수취(rebate). 수취는 보수적으로 0 계상 —
      // 문서화된 정책이며 단위 추측/clamp가 아님 (funding rebate를 수익으로 넣지 않는다).
      funding = fRate < 0 ? -fRate * input.holdingHours * notionalUsd : 0;
      basisParts.push(fRate < 0
        ? 'funding=공식 per-hour rate(음수=지불)×보유시간'
        : 'funding=0 (양수 rate=수취 — rebate 미계상, 보수 정책)');
    }
    if (fin(bRate) && bRate >= 0 && bRate < 1) {
      borrowing = bRate * input.holdingHours * notionalUsd;
      basisParts.push('borrowing=공식 per-hour rate×보유시간');
    }
  }

  const slippage = 0;   // MECHANISM_ZERO — oracle 체결, 별도 slippage 성분 없음 (impact에 포함)
  basisParts.push('slippage=MECHANISM_ZERO(oracle 체결)');
  const latency = fin(notionalUsd) && notionalUsd > 0 ? notionalUsd * INTEL_COST_POLICY.latencyRiskReserveFraction : null;
  const failure = fin(notionalUsd) && notionalUsd > 0 ? notionalUsd * INTEL_COST_POLICY.failureRiskReserveFraction : null;
  basisParts.push(`reserve=정책상수(지연 ${INTEL_COST_POLICY.latencyRiskReserveFraction * 1e4}bp+실패 ${INTEL_COST_POLICY.failureRiskReserveFraction * 1e4}bp, 실측 아님)`);

  // freshness 결속 — 실측 성분(관측 시각 보유) 중 가장 오래된 시각. 실측 성분 없으면 null.
  const observed: number[] = [];
  if (fp !== null && (entryFee !== null || gas !== null || impact !== null)) observed.push(fp.observedAtMs);
  if (rates !== null && (funding !== null || borrowing !== null || impact !== null)) observed.push(rates.observedAtMs);
  if (gas !== null && input.ethPriceObservedAtMs !== null && fin(input.ethPriceObservedAtMs)) observed.push(input.ethPriceObservedAtMs);
  const fetchedAtMs = observed.length > 0 ? Math.min(...observed) : null;

  const missing: string[] = [];
  if (entryFee === null) missing.push('entryFee');
  if (exitFee === null) missing.push('exitFee');
  if (funding === null) missing.push('funding');
  if (borrowing === null) missing.push('borrowing');
  if (impact === null) missing.push('priceImpact');
  if (gas === null) missing.push('gasExecution');

  return {
    entryFeeUsd: entryFee,
    estimatedExitFeeUsd: exitFee,
    fundingCostUsd: funding,
    borrowingCostUsd: borrowing,
    priceImpactUsd: impact,
    slippageUsd: slippage,
    gasExecutionFeeUsd: gas,
    latencyRiskReserveUsd: latency,
    failureRiskReserveUsd: failure,
    holdingHoursAssumed: fin(input.holdingHours) ? input.holdingHours : null,
    costBasis: missing.length > 0
      ? `UNAVAILABLE 성분: ${missing.join(',')} — 0 대체 금지; ${basisParts.join('; ')}`
      : basisParts.join('; '),
    costSource: 'GMX_MEASURED_READONLY',
    costSnapshotFetchedAtMs: fetchedAtMs,
    // 6I-4 — 출처 pin + 성분별 관측 시각 (API/UI 노출: stale·출처 감사 가능)
    sourcePin: rates !== null ? rates.sourcePin : null,
    componentObservedAtMs: {
      feeParamsAtMs: fp !== null ? fp.observedAtMs : null,
      ratesAtMs: rates !== null ? rates.observedAtMs : null,
      ethPriceAtMs: input.ethPriceObservedAtMs !== null && fin(input.ethPriceObservedAtMs) ? input.ethPriceObservedAtMs : null,
    },
  };
}
