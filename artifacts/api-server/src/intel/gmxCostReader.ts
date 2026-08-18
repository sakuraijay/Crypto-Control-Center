/**
 * 6I-3 §2 — GMX DataStore 실측 수수료/impact/gas 파라미터 reader (read-only).
 *
 *  - getUint 전용 (eth_call) + eth_gasPrice — 어떤 쓰기/서명/주문 경로도 없음.
 *  - 클라이언트는 주입 가능 (테스트=mock 전용, 외부 호출 0회).
 *  - 전 파라미터 확보 실패 = null (부분 파라미터로 비용 위장 금지).
 *  - RPC 오류 메시지는 sanitize — URL/키 노출 금지.
 *  - 사이클당 시장별 1회 조회 + 짧은 TTL 캐시 (RPC 폭주 방지).
 */
import { keccak256, encodeAbiParameters, type Address, type Hex } from 'viem';
import { hashKeyString, DATA_STORE_READ_ABI, type DataStoreClient } from '../lib/gmxDataStore';
import { GMX_DEPLOYMENT_MANIFEST } from '../lib/gmxDeploymentManifest';
import type { MarketFeeParams } from './costEngine';

// ── Keys.sol 스킴 (keccak256(abi.encode(...))) ───────────────────────────────
export const KEY_POSITION_FEE_FACTOR = hashKeyString('POSITION_FEE_FACTOR');
export const KEY_POSITION_IMPACT_FACTOR = hashKeyString('POSITION_IMPACT_FACTOR');
export const KEY_POSITION_IMPACT_EXPONENT_FACTOR = hashKeyString('POSITION_IMPACT_EXPONENT_FACTOR');
export const KEY_ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1 = hashKeyString('ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1');
export const KEY_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR = hashKeyString('ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR');
export const KEY_INCREASE_ORDER_GAS_LIMIT = hashKeyString('INCREASE_ORDER_GAS_LIMIT');
export const KEY_DECREASE_ORDER_GAS_LIMIT = hashKeyString('DECREASE_ORDER_GAS_LIMIT');

export function positionFeeFactorKey(market: Address, forPositiveImpact: boolean): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'bool' }],
    [KEY_POSITION_FEE_FACTOR, market, forPositiveImpact],
  ));
}
export function positionImpactFactorKey(market: Address, isPositive: boolean): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'bool' }],
    [KEY_POSITION_IMPACT_FACTOR, market, isPositive],
  ));
}
/**
 * SDK 1.7.0 (@gmx-io/sdk configs/dataStore) 계약: exponent 키는 positive/negative 분리 —
 * hashData(["bytes32","address","bool"], [KEY, market, isPositive]).
 * 과거 bool 미포함 해시는 미설정 슬롯을 읽어 getUint=0 → 전 시장 impact null 회귀를 유발했다.
 */
export function positionImpactExponentFactorKey(market: Address, isPositive: boolean): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'bool' }],
    [KEY_POSITION_IMPACT_EXPONENT_FACTOR, market, isPositive],
  ));
}

export interface CostReaderClient extends DataStoreClient {
  getGasPrice(): Promise<bigint>;
}

/** 파라미터 캐시 TTL — 계수류는 온체인 governance 값 (사이클 간 재사용 허용, 짧게 유지) */
export const FEE_PARAMS_CACHE_TTL_MS = 4 * 60_000;

export interface GmxCostReader {
  /** 실패 = null (부분 데이터 금지). observedAtMs = 실제 조회 시각. */
  readMarketFeeParams(market: string, nowMs: number): Promise<MarketFeeParams | null>;
}

export function createGmxCostReader(deps: {
  client: CostReaderClient | null;      // null = RPC 미구성 (fail-closed)
  dataStore?: Address;
  nowFn?: () => number;
}): GmxCostReader {
  const now = deps.nowFn ?? Date.now;
  const dataStore = deps.dataStore ?? (GMX_DEPLOYMENT_MANIFEST.addresses.dataStore as Address);
  const cache = new Map<string, { at: number; value: MarketFeeParams }>();

  async function getUint(key: Hex): Promise<bigint> {
    const v = await deps.client!.readContract({
      address: dataStore, abi: DATA_STORE_READ_ABI, functionName: 'getUint', args: [key],
    });
    if (typeof v !== 'bigint') throw new Error('getUint 반환 타입 비정상');
    return v;
  }

  return {
    async readMarketFeeParams(market, nowMs) {
      if (deps.client === null) return null;
      if (!/^0x[0-9a-fA-F]{40}$/.test(market)) return null;
      const keyLc = market.toLowerCase();
      const hit = cache.get(keyLc);
      if (hit && nowMs - hit.at < FEE_PARAMS_CACHE_TTL_MS) {
        // gasPrice만 매 사이클 실측 재조회 (변동 큼) — 실패 시 캐시 재사용 금지
        try {
          const gasPriceWei = await deps.client.getGasPrice();
          if (gasPriceWei <= 0n) return null;
          // observedAtMs는 캐시된 DataStore 파라미터의 실제 관측 시각 유지 —
          // gasPrice만 신선하다고 전체를 현재 시각으로 위장하면 freshness=min 결속이 깨진다.
          return { ...hit.value, gasPriceWei };
        } catch { return null; }
      }
      try {
        const m = market as Address;
        const [feeNeg, impactNeg, impactExp, gasBase, gasMult, incGas, decGas, gasPriceWei] = await Promise.all([
          getUint(positionFeeFactorKey(m, false)),
          getUint(positionImpactFactorKey(m, false)),
          getUint(positionImpactExponentFactorKey(m, false)), // 비용(악화) 방향 = negative 측
          getUint(KEY_ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1),
          getUint(KEY_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR),
          getUint(KEY_INCREASE_ORDER_GAS_LIMIT),
          getUint(KEY_DECREASE_ORDER_GAS_LIMIT),
          deps.client.getGasPrice(),
        ]);
        const value: MarketFeeParams = {
          positionFeeFactorNegative: feeNeg,
          negativeImpactFactor: impactNeg,
          impactExponentFactor: impactExp,
          estimatedGasFeeBaseAmount: gasBase,
          estimatedGasFeeMultiplierFactor: gasMult,
          increaseOrderGasLimit: incGas,
          decreaseOrderGasLimit: decGas,
          gasPriceWei,
          observedAtMs: now(),
        };
        // 명백한 비정상 = 채택 거부 (0 수수료·0 gas limit은 시장 파라미터로 비현실)
        if (feeNeg <= 0n || incGas <= 0n || decGas <= 0n || gasMult <= 0n || gasPriceWei <= 0n) return null;
        cache.set(keyLc, { at: now(), value });
        return value;
      } catch {
        return null; // sanitize — RPC 오류 상세(URL 포함 가능) 전파 금지
      }
    },
  };
}

/** 프로덕션 클라이언트 — GMX_RPC_URL 미설정 시 null (fail-closed, throw 아님: Intel은 관측 전용) */
export function createProductionCostReaderClient(): CostReaderClient | null {
  const url = process.env.GMX_RPC_URL?.trim();
  if (!url) return null;
  // 지연 import 회피 — viem은 이미 의존성. http 타임아웃 5s.
  const { createPublicClient, http } = require('viem') as typeof import('viem');
  const { arbitrum } = require('viem/chains') as typeof import('viem/chains');
  const client = createPublicClient({ chain: arbitrum, transport: http(url, { timeout: 5_000 }) });
  return {
    readContract: (args) => client.readContract(args as Parameters<typeof client.readContract>[0]),
    getGasPrice: () => client.getGasPrice(),
  };
}
