/**
 * 6I-5 테스트 공용 impact fixture — BTC-like 시장 (exponent 2.0e30, VI 미구성 기본).
 * negativeImpactFactor/exponentNegative는 각 테스트의 feeParams fixture와 일치해야
 * DataStore 교차검증을 통과한다.
 */
import type { CandidateImpactInput } from '../../intel/costEngine';
import { IMPACT_SOURCE_PIN, type ImpactMarketInputs } from '../../intel/impactEngine';

const P30 = 10n ** 30n;
export const ZERO_HASH = '0x' + '0'.repeat(64);
export const FIXTURE_INDEX_TOKEN = '0x47904963fc8b2340414262125aF798B9655E58Cd'; // BTC (synthetic index)

export function impactInputsFixture(over: Partial<ImpactMarketInputs> = {}): ImpactMarketInputs {
  return {
    marketTokenAddress: '0x47c031236e19d024b42f8AE6780E44A573170703',
    indexTokenAddress: FIXTURE_INDEX_TOKEN,
    useOpenInterestInTokensForBalance: false,
    longInterestUsd: 50_000_000n * P30,
    shortInterestUsd: 40_000_000n * P30,
    longInterestInTokens: 833n * 10n ** 8n,
    shortInterestInTokens: 666n * 10n ** 8n,
    positionImpactFactorPositive: 5n * 10n ** 19n,
    positionImpactFactorNegative: 10n ** 20n,
    positionImpactExponentFactorPositive: 2n * P30,
    positionImpactExponentFactorNegative: 2n * P30,
    maxPositionImpactFactorPositive: 5n * 10n ** 26n,   // 5bp
    maxPositionImpactFactorNegative: 5n * 10n ** 26n,
    positionImpactPoolAmount: 10n ** 8n,                // 1 BTC
    virtualIndexTokenId: ZERO_HASH,                     // VI 미구성 기본
    virtualInventoryForPositions: 0n,
    virtualInventoryForPositionsInTokens: 0n,
    observedAtMs: 0,                                    // 호출부에서 설정
    sourcePin: IMPACT_SOURCE_PIN,
    ...over,
  };
}

export function impactInputFixture(args: {
  nowMs: number;
  inputsOver?: Partial<ImpactMarketInputs>;
  over?: Partial<CandidateImpactInput>;
}): CandidateImpactInput {
  return {
    inputs: impactInputsFixture({ observedAtMs: args.nowMs - 20_000, ...args.inputsOver }),
    indexTokenDecimals: 8,
    sdkIndexTokenAddress: FIXTURE_INDEX_TOKEN,
    indexPriceUsd: 60_000,
    indexPriceObservedAtMs: args.nowMs - 10_000,
    ...args.over,
  };
}
