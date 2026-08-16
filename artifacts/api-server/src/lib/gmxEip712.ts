/**
 * gmxEip712 — 최신 GMX delegated trading(Gelato relay)용 EIP-712 순수 빌더/검증기.
 *
 * 근거 (gmx-io/gmx-synthetics main, contracts/router/relay/RelayUtils.sol,
 * SubaccountRouterUtils.sol, IRelayUtils.sol — 2026-08-17 raw GitHub 확인):
 *  - Domain: EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
 *    name = "GmxBaseGelatoRelayRouter", version = "1",
 *    chainId = srcChainId(동일 체인 흐름에서는 block.chainid = 42161),
 *    verifyingContract = SubaccountGelatoRelayRouter 주소.
 *  - SubaccountApproval typehash 필드 순서(정확히 이 순서):
 *    SubaccountApproval(address subaccount,bool shouldAdd,uint256 expiresAt,
 *    uint256 maxAllowedCount,bytes32 actionType,uint256 nonce,uint256 desChainId,
 *    uint256 deadline,bytes32 integrationId)
 *    → main account(owner)가 서명. nonce는 라우터 계약의
 *      subaccountApprovalNonces(mainAccount)와 일치해야 하며 사용 시 +1 (replay 방지).
 *  - RelayParams 해시는 typehash 기반 struct hash가 아니라
 *    keccak256(abi.encode(oracleParams, externalCalls, tokenPermits, fee,
 *    userNonce, deadline, desChainId)) — signature 필드 제외.
 *    각 액션(CreateOrder 등) typehash에 bytes32 relayParams로 포함되고
 *    delegated signer(subaccount)가 digest에 서명한다.
 *
 * 이 모듈은 순수 함수만 제공한다: 개인키를 보관·반환하지 않고, RPC 호출도 없다.
 */

import {
  hashTypedData,
  hashDomain,
  keccak256,
  concat,
  encodeAbiParameters,
  recoverTypedDataAddress,
  recoverAddress,
  type Hex,
  type Address,
} from 'viem';
import { ARBITRUM_ONE_CHAIN_ID } from './gmxOrderEvents';

// ── Domain ────────────────────────────────────────────────────────────────────

export const GMX_RELAY_DOMAIN_NAME = 'GmxBaseGelatoRelayRouter';
export const GMX_RELAY_DOMAIN_VERSION = '1';

export function buildGmxRelayDomain(chainId: number, verifyingContract: Address) {
  return {
    name: GMX_RELAY_DOMAIN_NAME,
    version: GMX_RELAY_DOMAIN_VERSION,
    chainId: BigInt(chainId),
    verifyingContract,
  } as const;
}

/** EIP-712 domain separator (공식 DOMAIN_SEPARATOR_TYPEHASH 스킴과 동일) */
export function computeGmxRelayDomainSeparator(chainId: number, verifyingContract: Address): Hex {
  return hashDomain({
    domain: buildGmxRelayDomain(chainId, verifyingContract),
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  });
}

// ── SubaccountApproval (owner/main account 서명) ─────────────────────────────

/** 공식 typehash 원문 (필드 순서 변경 금지) */
export const SUBACCOUNT_APPROVAL_TYPE_STRING =
  'SubaccountApproval(address subaccount,bool shouldAdd,uint256 expiresAt,uint256 maxAllowedCount,bytes32 actionType,uint256 nonce,uint256 desChainId,uint256 deadline,bytes32 integrationId)';

export const SUBACCOUNT_APPROVAL_EIP712_TYPES = {
  SubaccountApproval: [
    { name: 'subaccount', type: 'address' },
    { name: 'shouldAdd', type: 'bool' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'maxAllowedCount', type: 'uint256' },
    { name: 'actionType', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'desChainId', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'integrationId', type: 'bytes32' },
  ],
} as const;

export interface SubaccountApprovalMessage {
  subaccount: Address;
  shouldAdd: boolean;
  expiresAt: bigint;
  maxAllowedCount: bigint;
  actionType: Hex;      // Keys.SUBACCOUNT_ORDER_ACTION
  nonce: bigint;        // router.subaccountApprovalNonces(mainAccount)
  desChainId: bigint;   // 반드시 42161
  deadline: bigint;     // unix seconds
  integrationId: Hex;   // 미사용 시 0x00…00
}

/** 서명 요청용 typed data 객체 (지갑/서명기로 전달; 이 모듈은 서명하지 않음) */
export function buildSubaccountApprovalTypedData(params: {
  chainId: number;
  verifyingContract: Address;
  approval: SubaccountApprovalMessage;
}) {
  return {
    domain: buildGmxRelayDomain(params.chainId, params.verifyingContract),
    types: SUBACCOUNT_APPROVAL_EIP712_TYPES,
    primaryType: 'SubaccountApproval' as const,
    message: params.approval,
  };
}

export function hashSubaccountApproval(params: {
  chainId: number;
  verifyingContract: Address;
  approval: SubaccountApprovalMessage;
}): Hex {
  return hashTypedData(buildSubaccountApprovalTypedData(params));
}

export type Eip712VerifyResult = { ok: true; recovered: Address } | { ok: false; reason: string };

/**
 * Owner(main account) SubaccountApproval 서명 검증 (ECDSA/EOA).
 * fail-closed: chainId·router·nonce·deadline·서명자 어느 하나라도 불일치 시 거부.
 * ERC-1271/EIP-6492(컨트랙트 지갑)는 이 순수 검증기 범위 밖 — 온체인 검증 필요.
 */
export async function verifySubaccountApprovalSignature(params: {
  chainId: number;
  verifyingContract: Address;
  approval: SubaccountApprovalMessage;
  signature: Hex;
  expectedOwner: Address;
  expectedNonce: bigint;     // 온체인 subaccountApprovalNonces(owner)
  nowSec: bigint;
}): Promise<Eip712VerifyResult> {
  const { approval } = params;
  if (params.chainId !== ARBITRUM_ONE_CHAIN_ID) {
    return { ok: false, reason: `chainId가 ${ARBITRUM_ONE_CHAIN_ID}(Arbitrum One)이 아님 — 거부` };
  }
  if (approval.desChainId !== BigInt(ARBITRUM_ONE_CHAIN_ID)) {
    return { ok: false, reason: 'desChainId가 42161이 아님 — 타 체인 approval 거부' };
  }
  if (approval.deadline <= params.nowSec) {
    return { ok: false, reason: 'deadline 경과 — 만료된 approval 거부' };
  }
  if (approval.nonce !== params.expectedNonce) {
    return { ok: false, reason: 'nonce 불일치 — replay/순서 오류 거부' };
  }
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      ...buildSubaccountApprovalTypedData(params),
      signature: params.signature,
    });
  } catch {
    return { ok: false, reason: '서명 복구 실패 — 형식 오류 거부' };
  }
  if (recovered.toLowerCase() !== params.expectedOwner.toLowerCase()) {
    return { ok: false, reason: '서명자가 main account(owner)와 불일치 — 거부' };
  }
  return { ok: true, recovered };
}

// ── RelayParams (delegated signer 서명 대상의 구성 요소) ─────────────────────

/** IRelayUtils.sol 구조체와 1:1 대응하는 ABI 타입 (signature 필드 제외 순서) */
export const RELAY_PARAMS_ABI_COMPONENTS = [
  {
    // OracleUtils.SetPricesParams — 수수료 스왑 미사용 시 전부 빈 배열
    type: 'tuple',
    components: [
      { name: 'tokens', type: 'address[]' },
      { name: 'providers', type: 'address[]' },
      { name: 'data', type: 'bytes[]' },
    ],
  },
  {
    // ExternalCalls
    type: 'tuple',
    components: [
      { name: 'sendTokens', type: 'address[]' },
      { name: 'sendAmounts', type: 'uint256[]' },
      { name: 'externalCallTargets', type: 'address[]' },
      { name: 'externalCallDataList', type: 'bytes[]' },
      { name: 'refundTokens', type: 'address[]' },
      { name: 'refundReceivers', type: 'address[]' },
    ],
  },
  {
    // TokenPermit[]
    type: 'tuple[]',
    components: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
      { name: 'token', type: 'address' },
    ],
  },
  {
    // FeeParams — main account가 relay 수수료 지불
    type: 'tuple',
    components: [
      { name: 'feeToken', type: 'address' },
      { name: 'feeAmount', type: 'uint256' },
      { name: 'feeSwapPath', type: 'address[]' },
    ],
  },
  { type: 'uint256' }, // userNonce
  { type: 'uint256' }, // deadline
  { type: 'uint256' }, // desChainId
] as const;

export interface RelayFeeParams {
  feeToken: Address;
  feeAmount: bigint;
  feeSwapPath: Address[];
}
export interface RelayTokenPermit {
  owner: Address; spender: Address; value: bigint; deadline: bigint;
  v: number; r: Hex; s: Hex; token: Address;
}
export interface RelayExternalCalls {
  sendTokens: Address[]; sendAmounts: bigint[];
  externalCallTargets: Address[]; externalCallDataList: Hex[];
  refundTokens: Address[]; refundReceivers: Address[];
}
export interface RelayOracleParams { tokens: Address[]; providers: Address[]; data: Hex[] }
export interface RelayParamsInput {
  oracleParams: RelayOracleParams;
  externalCalls: RelayExternalCalls;
  tokenPermits: RelayTokenPermit[];
  fee: RelayFeeParams;
  userNonce: bigint;
  deadline: bigint;
  desChainId: bigint; // 반드시 42161
}

/** 스왑·외부호출·permit이 없는 최소 RelayParams (WNT로 수수료 직접 지불) */
export function buildMinimalRelayParams(params: {
  feeToken: Address; feeAmount: bigint; userNonce: bigint; deadline: bigint;
}): RelayParamsInput {
  return {
    oracleParams: { tokens: [], providers: [], data: [] },
    externalCalls: {
      sendTokens: [], sendAmounts: [], externalCallTargets: [],
      externalCallDataList: [], refundTokens: [], refundReceivers: [],
    },
    tokenPermits: [],
    fee: { feeToken: params.feeToken, feeAmount: params.feeAmount, feeSwapPath: [] },
    userNonce: params.userNonce,
    deadline: params.deadline,
    desChainId: BigInt(ARBITRUM_ONE_CHAIN_ID),
  };
}

/**
 * 공식 _getRelayParamsHash와 동일:
 * keccak256(abi.encode(oracleParams, externalCalls, tokenPermits, fee, userNonce, deadline, desChainId))
 */
export function computeRelayParamsHash(p: RelayParamsInput): Hex {
  return keccak256(
    encodeAbiParameters(RELAY_PARAMS_ABI_COMPONENTS, [
      p.oracleParams,
      p.externalCalls,
      p.tokenPermits,
      p.fee,
      p.userNonce,
      p.deadline,
      p.desChainId,
    ]),
  );
}

/** EIP-712 최종 digest: keccak256(0x1901 ‖ domainSeparator ‖ structHash) */
export function computeRelayDigest(domainSeparator: Hex, structHash: Hex): Hex {
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}

/**
 * Delegated signer(subaccount) relay 서명 검증 (ECDSA).
 *
 * 호출자가 준 digest를 신뢰하지 않는다: relayParams + domain(chainId·relay router)
 * + (2단계) actionStructHash로 기대 digest를 **재계산**하여, 서명이 정확히 이
 * relayParams에 결속됐는지 확인한다. relayParams를 변조하면 기대 digest가 달라져
 * 서명자 복구가 불일치 → 거부 (fail-closed).
 *
 * 1단계에서는 struct hash = relayParams 해시. 2단계에서 액션(CreateOrder 등)별
 * struct hash가 추가되면 `actionStructHash`에 keccak256(relayParamsHash ‖ actionHash)
 * 결합 방식으로 확장한다 (결합 규칙은 공식 GelatoRelayUtils 검증 후 구현).
 */
export async function verifyRelaySignature(params: {
  relayParams: RelayParamsInput;
  chainId: number;              // 42161만 허용
  verifyingContract: Address;   // SubaccountGelatoRelayRouter
  signature: Hex;
  expectedSigner: Address;      // delegated signer (subaccount) 공개 주소
  nowSec: bigint;
}): Promise<Eip712VerifyResult> {
  if (params.chainId !== ARBITRUM_ONE_CHAIN_ID) {
    return { ok: false, reason: 'chainId가 42161이 아님 — 타 체인 도메인 거부' };
  }
  if (params.relayParams.desChainId !== BigInt(ARBITRUM_ONE_CHAIN_ID)) {
    return { ok: false, reason: 'desChainId가 42161이 아님 — 타 체인 relay 거부' };
  }
  if (params.relayParams.deadline <= params.nowSec) {
    return { ok: false, reason: 'relay deadline 경과 — 거부' };
  }
  // 기대 digest를 relayParams에서 직접 재계산 — 서명↔파라미터 결속 보장
  const domainSeparator = computeGmxRelayDomainSeparator(params.chainId, params.verifyingContract);
  const expectedDigest = computeRelayDigest(domainSeparator, computeRelayParamsHash(params.relayParams));
  let recovered: Address;
  try {
    recovered = await recoverAddress({ hash: expectedDigest, signature: params.signature });
  } catch {
    return { ok: false, reason: '서명 복구 실패 — 형식 오류 거부' };
  }
  if (recovered.toLowerCase() !== params.expectedSigner.toLowerCase()) {
    return { ok: false, reason: '서명자가 delegated signer와 불일치 (relayParams 변조 포함) — 거부' };
  }
  return { ok: true, recovered };
}
