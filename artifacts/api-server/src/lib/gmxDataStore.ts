/**
 * gmxDataStore — DataStore를 subaccount 인증 상태의 canonical source로 사용하는
 * 키 계산 + read-only reader.
 *
 * 근거 (gmx-io/gmx-synthetics main, contracts/data/Keys.sol,
 * subaccount/SubaccountUtils.sol — 2026-08-17 raw GitHub 확인):
 *  - 기본 키: keccak256(abi.encode("SUBACCOUNT_…")) (abi.encode of string)
 *  - subaccountListKey(account) = keccak256(abi.encode(SUBACCOUNT_LIST, account))
 *  - subaccountExpiresAtKey / subaccountActionCountKey /
 *    maxAllowedSubaccountActionCountKey = keccak256(abi.encode(BASE, account, subaccount, actionType))
 *  - subaccountIntegrationIdKey = keccak256(abi.encode(BASE, account, subaccount))
 *  - actionType(주문)은 Keys.SUBACCOUNT_ORDER_ACTION
 *  - SubaccountApproval nonce는 DataStore가 아니라 SubaccountGelatoRelayRouter의
 *    public mapping subaccountApprovalNonces(address)에서 읽는다.
 *
 * fail-closed: RPC/디코딩 오류·부분 실패 시 데이터를 추정하지 않고 { ok:false }를
 * 반환한다 (호출측은 UNVERIFIED로 취급하고 LIVE 차단 유지). 실제 RPC 호출은
 * 주입된 클라이언트를 통해서만 수행한다 (테스트는 mock fixture 전용).
 */

import { keccak256, encodeAbiParameters, type Hex, type Address } from 'viem';
import { sanitizeRpcError } from './rpcErrorSanitize';

// ── 키 계산 (순수) ────────────────────────────────────────────────────────────

/** keccak256(abi.encode(string)) — Keys.sol의 기본 키 스킴 */
export function hashKeyString(s: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'string' }], [s]));
}

export const KEY_SUBACCOUNT_LIST = hashKeyString('SUBACCOUNT_LIST');
export const KEY_SUBACCOUNT_EXPIRES_AT = hashKeyString('SUBACCOUNT_EXPIRES_AT');
export const KEY_SUBACCOUNT_ACTION_COUNT = hashKeyString('SUBACCOUNT_ACTION_COUNT');
export const KEY_MAX_ALLOWED_SUBACCOUNT_ACTION_COUNT = hashKeyString('MAX_ALLOWED_SUBACCOUNT_ACTION_COUNT');
export const KEY_SUBACCOUNT_INTEGRATION_ID = hashKeyString('SUBACCOUNT_INTEGRATION_ID');
/** 주문 actionType — SubaccountApproval.actionType 및 각 키 계산에 사용 */
export const SUBACCOUNT_ORDER_ACTION = hashKeyString('SUBACCOUNT_ORDER_ACTION');
export const KEY_SUBACCOUNT_FEATURE_DISABLED = hashKeyString('SUBACCOUNT_FEATURE_DISABLED');
export const KEY_SUBACCOUNT_INTEGRATION_DISABLED = hashKeyString('SUBACCOUNT_INTEGRATION_DISABLED');

export function subaccountListKey(account: Address): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }],
    [KEY_SUBACCOUNT_LIST, account],
  ));
}

function tripleKey(base: Hex, account: Address, subaccount: Address, actionType: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
    [base, account, subaccount, actionType],
  ));
}

export function subaccountExpiresAtKey(account: Address, subaccount: Address, actionType: Hex = SUBACCOUNT_ORDER_ACTION): Hex {
  return tripleKey(KEY_SUBACCOUNT_EXPIRES_AT, account, subaccount, actionType);
}
export function subaccountActionCountKey(account: Address, subaccount: Address, actionType: Hex = SUBACCOUNT_ORDER_ACTION): Hex {
  return tripleKey(KEY_SUBACCOUNT_ACTION_COUNT, account, subaccount, actionType);
}
export function maxAllowedSubaccountActionCountKey(account: Address, subaccount: Address, actionType: Hex = SUBACCOUNT_ORDER_ACTION): Hex {
  return tripleKey(KEY_MAX_ALLOWED_SUBACCOUNT_ACTION_COUNT, account, subaccount, actionType);
}
export function subaccountIntegrationIdKey(account: Address, subaccount: Address): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }],
    [KEY_SUBACCOUNT_INTEGRATION_ID, account, subaccount],
  ));
}

/** Keys.subaccountFeatureDisabledKey(module) — module = subaccount relay router 주소 */
export function subaccountFeatureDisabledKey(module: Address): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }],
    [KEY_SUBACCOUNT_FEATURE_DISABLED, module],
  ));
}

/** Keys.subaccountIntegrationDisabledKey(integrationId) */
export function subaccountIntegrationDisabledKey(integrationId: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }],
    [KEY_SUBACCOUNT_INTEGRATION_DISABLED, integrationId],
  ));
}

// ── read-only ABI ─────────────────────────────────────────────────────────────

export const DATA_STORE_READ_ABI = [
  { type: 'function', name: 'getUint', stateMutability: 'view', inputs: [{ name: 'key', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getBytes32', stateMutability: 'view', inputs: [{ name: 'key', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'containsAddress', stateMutability: 'view', inputs: [{ name: 'setKey', type: 'bytes32' }, { name: 'value', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getBool', stateMutability: 'view', inputs: [{ name: 'key', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const;

export const RELAY_ROUTER_NONCE_ABI = [
  { type: 'function', name: 'subaccountApprovalNonces', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

// ── Reader (클라이언트 주입 — 테스트는 mock 전용) ────────────────────────────

export interface DataStoreClient {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
  /** 최신 블록 timestamp(초). 만료 판정 기준. 미구현이면 호출측 nowSec 사용. */
  getBlockTimestamp?(): Promise<bigint>;
}

export interface SubaccountAuthOnchain {
  isSubaccountListed: boolean;
  expiresAt: bigint;        // unix seconds (0 = 미승인/해지)
  maxAllowedCount: bigint;
  usedCount: bigint;
  remaining: bigint;        // max(0, maxAllowedCount - usedCount)
  integrationId: Hex;
  approvalNonce: bigint;    // router.subaccountApprovalNonces(account)
  /** Keys.subaccountFeatureDisabledKey(relayRouter) — true면 기능 자체 비활성 */
  featureDisabled: boolean;
  /** Keys.subaccountIntegrationDisabledKey(integrationId) — true면 integration 비활성 */
  integrationDisabled: boolean;
  /** 온체인 블록 timestamp(초). 조회 불가 시 null (호출측 nowSec 사용). */
  blockTimestamp: bigint | null;
}

export type SubaccountAuthReadResult =
  | { ok: true; data: SubaccountAuthOnchain }
  | { ok: false; reason: string };

/**
 * DataStore + relay router에서 subaccount 인증 상태를 원자적으로(병렬 조회, 전체
 * 성공 시에만 ok) 읽는다. 어느 하나라도 실패하면 fail-closed.
 */
export async function readSubaccountAuthorization(params: {
  client: DataStoreClient;
  dataStore: Address;
  relayRouter: Address;
  account: Address;      // main account (owner)
  subaccount: Address;   // delegated signer
  actionType?: Hex;
}): Promise<SubaccountAuthReadResult> {
  const actionType = params.actionType ?? SUBACCOUNT_ORDER_ACTION;
  try {
    const [listed, expiresAt, maxAllowed, used, integrationId, approvalNonce] = await Promise.all([
      params.client.readContract({
        address: params.dataStore, abi: DATA_STORE_READ_ABI, functionName: 'containsAddress',
        args: [subaccountListKey(params.account), params.subaccount],
      }),
      params.client.readContract({
        address: params.dataStore, abi: DATA_STORE_READ_ABI, functionName: 'getUint',
        args: [subaccountExpiresAtKey(params.account, params.subaccount, actionType)],
      }),
      params.client.readContract({
        address: params.dataStore, abi: DATA_STORE_READ_ABI, functionName: 'getUint',
        args: [maxAllowedSubaccountActionCountKey(params.account, params.subaccount, actionType)],
      }),
      params.client.readContract({
        address: params.dataStore, abi: DATA_STORE_READ_ABI, functionName: 'getUint',
        args: [subaccountActionCountKey(params.account, params.subaccount, actionType)],
      }),
      params.client.readContract({
        address: params.dataStore, abi: DATA_STORE_READ_ABI, functionName: 'getBytes32',
        args: [subaccountIntegrationIdKey(params.account, params.subaccount)],
      }),
      params.client.readContract({
        address: params.relayRouter, abi: RELAY_ROUTER_NONCE_ABI, functionName: 'subaccountApprovalNonces',
        args: [params.account],
      }),
    ]);

    if (typeof listed !== 'boolean' || typeof expiresAt !== 'bigint' || typeof maxAllowed !== 'bigint'
      || typeof used !== 'bigint' || typeof integrationId !== 'string' || typeof approvalNonce !== 'bigint') {
      return { ok: false, reason: 'DataStore 응답 디코딩 실패 — fail-closed (UNVERIFIED)' };
    }

    // 2차 조회: feature/integration disabled 플래그 + 블록 timestamp
    // (integrationDisabled 키는 integrationId 조회 결과에 의존하므로 순차 실행)
    const [featureDisabled, integrationDisabled, blockTimestamp] = await Promise.all([
      params.client.readContract({
        address: params.dataStore, abi: DATA_STORE_READ_ABI, functionName: 'getBool',
        args: [subaccountFeatureDisabledKey(params.relayRouter)],
      }),
      params.client.readContract({
        address: params.dataStore, abi: DATA_STORE_READ_ABI, functionName: 'getBool',
        args: [subaccountIntegrationDisabledKey(integrationId as Hex)],
      }),
      params.client.getBlockTimestamp ? params.client.getBlockTimestamp() : Promise.resolve(null),
    ]);
    if (typeof featureDisabled !== 'boolean' || typeof integrationDisabled !== 'boolean') {
      return { ok: false, reason: 'DataStore disabled-flag 디코딩 실패 — fail-closed (UNVERIFIED)' };
    }
    if (blockTimestamp !== null && typeof blockTimestamp !== 'bigint') {
      return { ok: false, reason: '블록 timestamp 디코딩 실패 — fail-closed (UNVERIFIED)' };
    }

    const remaining = maxAllowed > used ? maxAllowed - used : 0n;
    return {
      ok: true,
      data: {
        isSubaccountListed: listed,
        expiresAt, maxAllowedCount: maxAllowed, usedCount: used, remaining,
        integrationId: integrationId as Hex, approvalNonce,
        featureDisabled, integrationDisabled, blockTimestamp,
      },
    };
  } catch (err: unknown) {
    return { ok: false, reason: `DataStore 조회 실패 — fail-closed (UNVERIFIED): ${sanitizeRpcError(err)}` };
  }
}
