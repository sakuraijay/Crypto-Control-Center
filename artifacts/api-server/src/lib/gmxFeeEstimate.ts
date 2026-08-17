/**
 * gmxFeeEstimate — GMX 공식 relay fee 산정 (6F-2 §6, 방안 D).
 *
 * 공식 pin (PROJECT_STATE.md §GMX pin):
 *  - gmx-interface commit e27759a2835c7dc2197f41b6a6043bf07b935621 (2026-08-13)
 *  - @gmx-io/sdk v1.7.0
 *  - 참조: sdk/src/utils/express/utils/estimateExpressParams.ts:306
 *      relayerFeeAmount = applyFactor(gasLimit × gasPrice, gasLimits.gelatoRelayFeeMultiplierFactor)
 *    sdk/src/utils/numbers/utils.ts:132  applyFactor(value, factor) = value*factor/PRECISION (1e30, 내림)
 *    src/domain/multichain/arbitraryRelayParams.ts:283
 *      buffer = mulDiv(relayerFeeAmount, bufferBps, 10000)  (내림) → fee += buffer
 *    sdk/src/configs/dataStore.ts:114
 *      GELATO_RELAY_FEE_MULTIPLIER_FACTOR_KEY = hashString("GELATO_RELAY_FEE_MULTIPLIER_FACTOR")
 *    sdk/src/configs/chains.ts:79  Arbitrum defaultExecutionFeeBufferBps = 3000 (30%)
 *  - Gelato relayer_getFeeQuote는 GMX가 사용하지 않는다 — 혼합 금지.
 *
 * 원칙 (§6):
 *  - gasLimit: 호출측이 estimateGas/simulation으로 확보한 값만 — 추정 실패 시
 *    fallback·고정값 생성 금지 (fail-closed).
 *  - gasPrice: Arbitrum read-only RPC eth_gasPrice — 실패 시 0/임의값 금지.
 *  - multiplierFactor: DataStore.getUint(공식 키) — 실패·0·비정상 범위는 거부.
 *  - 산출 quote는 payloadHash/chainId/relayRouter/feeToken에 결속되고
 *    freshness(QUOTE_MAX_AGE_MS)·상한(MAX_FEE_ABSOLUTE_WEI 등)을 그대로 적용받는다.
 */

import type { Address } from 'viem';
import { hashKeyString, type DataStoreClient } from './gmxDataStore';
import { WETH_ARBITRUM, type RelayFeeQuote } from './relayFeeQuote';

/** 공식 DataStore 키 — sdk/src/configs/dataStore.ts:114과 동일 스킴 */
export const KEY_GELATO_RELAY_FEE_MULTIPLIER_FACTOR = hashKeyString('GELATO_RELAY_FEE_MULTIPLIER_FACTOR');

/** GMX PRECISION = 1e30 (applyFactor 분모) */
export const GMX_PRECISION = 10n ** 30n;
export const BASIS_POINTS_DIVISOR = 10_000n;
/** Arbitrum 공식 기본 buffer — chains.ts [ARBITRUM].defaultExecutionFeeBufferBps */
export const ARBITRUM_EXECUTION_FEE_BUFFER_BPS = 3000n;
/** fee 산정 source 명칭 — mock과 구조적으로 구분 */
export const GMX_OFFICIAL_ESTIMATE_SOURCE = 'gmx_official_estimate' as const;

/** gasPrice sanity 상한 — 10,000 gwei (Arbitrum에서 비정상) */
export const MAX_SANE_GAS_PRICE_WEI = 10_000_000_000_000n;
/** multiplierFactor sanity 상한 — 100e30 (100배 초과는 비정상으로 거부) */
export const MAX_SANE_MULTIPLIER_FACTOR = 100n * GMX_PRECISION;

/** 공식 applyFactor — value*factor/1e30, bigint 내림 (utils.ts:132와 동일) */
export function applyFactor(value: bigint, factor: bigint): bigint {
  return (value * factor) / GMX_PRECISION;
}

export type FeeInputValidation = { ok: true } | { ok: false; reason: string };

export function validateGasPrice(gasPrice: bigint): FeeInputValidation {
  if (gasPrice <= 0n) return { ok: false, reason: 'gasPrice 0 이하 — 거부 (fail-closed)' };
  if (gasPrice > MAX_SANE_GAS_PRICE_WEI) return { ok: false, reason: `gasPrice 비정상 상한 초과 (${gasPrice} wei)` };
  return { ok: true };
}

export function validateMultiplierFactor(factor: bigint): FeeInputValidation {
  if (factor <= 0n) return { ok: false, reason: 'gelatoRelayFeeMultiplierFactor 0 이하 — 거부 (fail-closed)' };
  if (factor > MAX_SANE_MULTIPLIER_FACTOR) return { ok: false, reason: 'gelatoRelayFeeMultiplierFactor 비정상 상한 초과' };
  return { ok: true };
}

export function validateGasLimit(gasLimit: bigint): FeeInputValidation {
  if (gasLimit <= 0n) return { ok: false, reason: 'gasLimit 0 이하 — estimateGas 결과 필수 (fallback 금지)' };
  if (gasLimit > 1_000_000_000n) return { ok: false, reason: 'gasLimit 비정상 상한 초과' };
  return { ok: true };
}

/**
 * 공식 산정 (순수 bigint, 내림 순서까지 공식과 일치):
 *  fee = applyFactor(gasLimit×gasPrice, multiplierFactor); fee += fee×bufferBps/10000
 */
export function computeGmxRelayFeeWei(params: {
  gasLimit: bigint; gasPrice: bigint; multiplierFactor: bigint; bufferBps: bigint;
}): { ok: true; feeWei: bigint } | { ok: false; reason: string } {
  const gl = validateGasLimit(params.gasLimit);
  if (!gl.ok) return gl;
  const gp = validateGasPrice(params.gasPrice);
  if (!gp.ok) return gp;
  const mf = validateMultiplierFactor(params.multiplierFactor);
  if (!mf.ok) return mf;
  if (params.bufferBps < 0n || params.bufferBps > BASIS_POINTS_DIVISOR) {
    return { ok: false, reason: 'bufferBps 범위 오류 (0–10000)' };
  }
  const base = applyFactor(params.gasLimit * params.gasPrice, params.multiplierFactor);
  if (base <= 0n) return { ok: false, reason: '산정 fee 0 이하 — 거부 (fail-closed)' };
  const buffer = (base * params.bufferBps) / BASIS_POINTS_DIVISOR;
  return { ok: true, feeWei: base + buffer };
}

/**
 * GMX 공식 산정 quote 생성 — 결속 필드(payloadHash/chainId/router) 필수.
 * 검증(freshness·상한·결속 일치)은 relayFeeQuote.validateFeeQuote가 수행한다.
 */
export function buildGmxOfficialFeeQuote(params: {
  gasLimit: bigint; gasPrice: bigint; multiplierFactor: bigint; bufferBps?: bigint;
  nowMs: number;
  boundChainId: number; boundRelayRouter: Address; boundPayloadHash: string;
}): { ok: true; quote: RelayFeeQuote } | { ok: false; reason: string } {
  const bufferBps = params.bufferBps ?? ARBITRUM_EXECUTION_FEE_BUFFER_BPS;
  const fee = computeGmxRelayFeeWei({
    gasLimit: params.gasLimit, gasPrice: params.gasPrice,
    multiplierFactor: params.multiplierFactor, bufferBps,
  });
  if (!fee.ok) return fee;
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.boundPayloadHash)) {
    return { ok: false, reason: 'boundPayloadHash 형식 오류 — 결속 불가 (fail-closed)' };
  }
  return {
    ok: true,
    quote: {
      feeToken: WETH_ARBITRUM,          // 공식 getRelayerFeeToken = WNT(WETH) 고정
      feeAmount: fee.feeWei,
      gasLimit: params.gasLimit,
      gasPrice: params.gasPrice,
      feeSwapPath: [],
      quotedAtMs: params.nowMs,
      source: GMX_OFFICIAL_ESTIMATE_SOURCE,
      boundChainId: params.boundChainId,
      boundRelayRouter: params.boundRelayRouter,
      boundPayloadHash: params.boundPayloadHash,
    },
  };
}

export type FeeEstimateInputs =
  | { ok: true; gasPrice: bigint; multiplierFactor: bigint }
  | { ok: false; reason: string };

/** fee 산정 입력용 read-only 능력 — eth_gasPrice + DataStore.getUint */
export interface FeeEstimateReadClient extends Pick<DataStoreClient, 'readContract'> {
  getGasPrice(): Promise<bigint>;
}

/**
 * fee 산정 입력 취득 (읽기 전용):
 *  - eth_gasPrice (read-only RPC)
 *  - DataStore.getUint(GELATO_RELAY_FEE_MULTIPLIER_FACTOR)
 * 어느 하나라도 실패·비정상이면 산정 불가 (fallback 없음).
 */
export async function fetchGmxFeeEstimateInputs(params: {
  client: FeeEstimateReadClient;
  dataStore: Address;
}): Promise<FeeEstimateInputs> {
  let gasPrice: bigint;
  try {
    gasPrice = await params.client.getGasPrice();
  } catch {
    return { ok: false, reason: 'eth_gasPrice 조회 실패 — fee 산정 불가 (fail-closed)' };
  }
  const gp = validateGasPrice(gasPrice);
  if (!gp.ok) return { ok: false, reason: gp.reason };

  let factor: unknown;
  try {
    factor = await params.client.readContract({
      address: params.dataStore,
      abi: [{ type: 'function', name: 'getUint', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] }],
      functionName: 'getUint',
      args: [KEY_GELATO_RELAY_FEE_MULTIPLIER_FACTOR],
    });
  } catch {
    return { ok: false, reason: 'DataStore gelatoRelayFeeMultiplierFactor 조회 실패 — fee 산정 불가 (fail-closed)' };
  }
  if (typeof factor !== 'bigint') return { ok: false, reason: 'multiplierFactor decode 오류 (uint256 아님)' };
  const mf = validateMultiplierFactor(factor);
  if (!mf.ok) return { ok: false, reason: mf.reason };
  return { ok: true, gasPrice, multiplierFactor: factor };
}
