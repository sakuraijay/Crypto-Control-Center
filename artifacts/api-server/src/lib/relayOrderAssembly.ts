/**
 * relayOrderAssembly — OPEN/CLOSE/REVOKE relay 호출 payload 조립 (3단계).
 *
 * **오프라인 전용**: 이 모듈은 어떤 네트워크 호출도 하지 않는다.
 * 서명은 호출측이 fixture(테스트) 또는 delegated signer 경로에서 공급하며,
 * 실제 개인키·복호화·owner 서명 생성은 이 저장소에서 절대 수행하지 않는다.
 *
 * 공식 근거 (gmx-io/gmx-synthetics main a85ea3491c19):
 *  - SubaccountGelatoRelayRouter.createOrder(relayParams, subaccountApproval,
 *    account, subaccount, params) — struct hash는 RelayUtils.getCreateOrderStructHash.
 *  - removeSubaccount(relayParams, account, subaccount) — **main account 서명**
 *    (withRelay isSubaccount=false), typehash:
 *    "RemoveSubaccount(address subaccount,bytes32 relayParams)".
 *  - subaccount 주문에서 externalCalls 비어있지 않으면 revert
 *    (NonEmptyExternalCallsForSubaccountOrder) → 조립 단계에서 강제.
 *  - Gelato 제출 데이터 = encodePacked(calldata, to, feeToken, feeAmount)
 *    (gmx-interface master sendExpressTransaction.ts) — 여기서는 계산만.
 */

import {
  keccak256, encodeAbiParameters, encodeFunctionData, encodePacked, toHex,
  type Address, type Hex,
} from 'viem';
import {
  buildMinimalRelayParams, computeRelayParamsHash, computeRelayDigest,
  computeGmxRelayDomainSeparator, RELAY_PARAMS_ABI_COMPONENTS, type RelayParamsInput,
} from './gmxEip712';
import {
  buildOpenOrderParams, buildCloseOrderParams, computeCreateOrderDigest,
  encodeSubaccountCreateOrderCalldata, getCreateOrderStructHash,
  type BuildOrderInput, type CreateOrderParams, type SubaccountApprovalStruct,
} from './gmxCreateOrder';
import { ARBITRUM_ONE_CHAIN_ID } from './gmxLiveConfig';
import type { RelayFeeQuote } from './relayFeeQuote';

const ZERO_SIG: Hex = '0x';

// ── RemoveSubaccount (revoke) ────────────────────────────────────────────────

/** 공식 RelayUtils.REMOVE_SUBACCOUNT_TYPEHASH와 동일 문자열 */
export const REMOVE_SUBACCOUNT_TYPE_STRING = 'RemoveSubaccount(address subaccount,bytes32 relayParams)';
export const REMOVE_SUBACCOUNT_TYPEHASH: Hex = keccak256(toHex(REMOVE_SUBACCOUNT_TYPE_STRING));

/** RelayUtils.getRemoveSubaccountStructHash와 동일 */
export function getRemoveSubaccountStructHash(relayParams: RelayParamsInput, subaccount: Address): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }],
    [REMOVE_SUBACCOUNT_TYPEHASH, subaccount, computeRelayParamsHash(relayParams)],
  ));
}

/** owner(main account)가 서명할 RemoveSubaccount digest */
export function computeRemoveSubaccountDigest(params: {
  chainId: number; verifyingContract: Address;
  relayParams: RelayParamsInput; subaccount: Address;
}): Hex {
  const ds = computeGmxRelayDomainSeparator(params.chainId, params.verifyingContract);
  return computeRelayDigest(ds, getRemoveSubaccountStructHash(params.relayParams, params.subaccount));
}

/** MetaMask eth_signTypedData_v4용 typed data (RemoveSubaccount) */
export function buildRemoveSubaccountTypedData(params: {
  chainId: number; verifyingContract: Address;
  relayParams: RelayParamsInput; subaccount: Address;
}) {
  return {
    domain: {
      name: 'GmxBaseGelatoRelayRouter', version: '1',
      chainId: params.chainId, verifyingContract: params.verifyingContract,
    },
    types: {
      RemoveSubaccount: [
        { name: 'subaccount', type: 'address' },
        { name: 'relayParams', type: 'bytes32' },
      ],
    },
    primaryType: 'RemoveSubaccount' as const,
    message: {
      subaccount: params.subaccount,
      relayParams: computeRelayParamsHash(params.relayParams),
    },
  };
}

export const REMOVE_SUBACCOUNT_ABI = [
  {
    type: 'function', name: 'removeSubaccount', stateMutability: 'nonpayable',
    inputs: [
      { name: 'relayParams', type: 'tuple', components: [
        { name: 'oracleParams', ...RELAY_PARAMS_ABI_COMPONENTS[0] },
        { name: 'externalCalls', ...RELAY_PARAMS_ABI_COMPONENTS[1] },
        { name: 'tokenPermits', ...RELAY_PARAMS_ABI_COMPONENTS[2] },
        { name: 'fee', ...RELAY_PARAMS_ABI_COMPONENTS[3] },
        { name: 'userNonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'desChainId', type: 'uint256' },
        { name: 'signature', type: 'bytes' },
      ]},
      { name: 'account', type: 'address' },
      { name: 'subaccount', type: 'address' },
    ],
    outputs: [],
  },
] as const;

export function encodeRemoveSubaccountCalldata(params: {
  relayParams: RelayParamsInput; relaySignature: Hex;
  account: Address; subaccount: Address;
}): Hex {
  return encodeFunctionData({
    abi: REMOVE_SUBACCOUNT_ABI,
    functionName: 'removeSubaccount',
    args: [
      { ...params.relayParams, signature: params.relaySignature },
      params.account,
      params.subaccount,
    ],
  });
}

// ── 조립 결과 ────────────────────────────────────────────────────────────────

export interface AssembledRelayCall {
  kind: 'OPEN' | 'CLOSE' | 'REVOKE';
  calldata: Hex;
  calldataHash: Hex;              // keccak256(calldata)
  /** Gelato 제출 payload(encodePacked(calldata,to,feeToken,feeAmount))의 hash — 제출 없음 */
  packedPayloadHash: Hex;
  relayParamsHash: Hex;
  structHash: Hex;
  /** 서명 대상 digest — OPEN/CLOSE: delegated signer, REVOKE: owner(main) */
  signingDigest: Hex;
  signerRole: 'delegated' | 'owner';
  actionCount: number;
  feeToken: Address;
  feeAmount: bigint;
  userNonce: bigint;
  deadline: bigint;
  desChainId: bigint;
  receiverVerified: boolean;      // OPEN/CLOSE: receiver==main account 확인 결과
  approvalAttached: boolean;      // subaccountApproval.signature 포함 여부(shouldAdd 경로)
  approvalNonce: bigint | null;
}

export interface AssembleOrderInput {
  kind: 'OPEN' | 'CLOSE';
  mainAccount: Address;
  subaccount: Address;
  relayRouter: Address;
  order: BuildOrderInput;
  quote: RelayFeeQuote;
  userNonce: bigint;              // 공식 interface: epoch 초 사용
  deadline: bigint;
  /**
   * canonical 미반영(첫 action) 시에만 approval 첨부. 첨부 signature는
   * DB에 저장된 owner 서명(호출측이 복호화 없이 fixture/dry-run에서는 0x)을 사용.
   * SubaccountRouterUtils: signature.length==0이면 approval 처리 자체를 건너뜀.
   */
  subaccountApproval: SubaccountApprovalStruct | null;
  /** delegated signer 서명 — dry-run은 0x(placeholder), 검증 결과에 명시 */
  relaySignature?: Hex;
}

/** OPEN/CLOSE relay 호출 조립 — 제출 없음, 계산만 */
export function assembleOrderRelayCall(input: AssembleOrderInput): AssembledRelayCall {
  if (input.quote.feeSwapPath.length !== 0) {
    throw new Error('feeSwapPath 금지 — WNT 직접 지불만 허용 (fail-closed)');
  }
  const relayParams = buildMinimalRelayParams({
    feeToken: input.quote.feeToken,
    feeAmount: input.quote.feeAmount,
    userNonce: input.userNonce,
    deadline: input.deadline,
  });

  const order: CreateOrderParams = input.kind === 'OPEN'
    ? buildOpenOrderParams(input.order)
    : buildCloseOrderParams(input.order);

  const emptyApproval: SubaccountApprovalStruct = {
    subaccount: input.subaccount,
    shouldAdd: false,
    expiresAt: 0n,
    maxAllowedCount: 0n,
    actionType: ('0x' + '00'.repeat(32)) as Hex,
    nonce: 0n,
    desChainId: 0n,
    deadline: 0n,
    integrationId: ('0x' + '00'.repeat(32)) as Hex,
    signature: ZERO_SIG,
  };
  const approval = input.subaccountApproval ?? emptyApproval;
  const approvalAttached = approval.signature !== ZERO_SIG && approval.signature.length > 2;

  const structHash = getCreateOrderStructHash({
    relayParams, subaccountApproval: approval, account: input.mainAccount, order,
  });
  const signingDigest = computeCreateOrderDigest({
    chainId: ARBITRUM_ONE_CHAIN_ID, verifyingContract: input.relayRouter,
    relayParams, subaccountApproval: approval, account: input.mainAccount, order,
  });

  const calldata = encodeSubaccountCreateOrderCalldata({
    relayParams,
    relaySignature: input.relaySignature ?? ZERO_SIG,
    subaccountApproval: approval,
    account: input.mainAccount,
    subaccount: input.subaccount,
    order,
  });

  return finalize({
    kind: input.kind, calldata, relayParams, structHash, signingDigest,
    signerRole: 'delegated', actionCount: 1,
    relayRouter: input.relayRouter,
    receiverVerified: order.addresses.receiver.toLowerCase() === input.mainAccount.toLowerCase(),
    approvalAttached,
    approvalNonce: approvalAttached ? approval.nonce : null,
  });
}

export interface AssembleRevokeInput {
  mainAccount: Address;
  subaccount: Address;
  relayRouter: Address;
  quote: RelayFeeQuote;
  userNonce: bigint;
  deadline: bigint;
  /** owner 서명 — dry-run은 0x placeholder */
  relaySignature?: Hex;
}

/** REVOKE(removeSubaccount) relay 호출 조립 — owner 서명 대상, 제출 없음 */
export function assembleRevokeRelayCall(input: AssembleRevokeInput): AssembledRelayCall {
  if (input.quote.feeSwapPath.length !== 0) {
    throw new Error('feeSwapPath 금지 (fail-closed)');
  }
  const relayParams = buildMinimalRelayParams({
    feeToken: input.quote.feeToken,
    feeAmount: input.quote.feeAmount,
    userNonce: input.userNonce,
    deadline: input.deadline,
  });
  const structHash = getRemoveSubaccountStructHash(relayParams, input.subaccount);
  const signingDigest = computeRemoveSubaccountDigest({
    chainId: ARBITRUM_ONE_CHAIN_ID, verifyingContract: input.relayRouter,
    relayParams, subaccount: input.subaccount,
  });
  const calldata = encodeRemoveSubaccountCalldata({
    relayParams, relaySignature: input.relaySignature ?? ZERO_SIG,
    account: input.mainAccount, subaccount: input.subaccount,
  });
  return finalize({
    kind: 'REVOKE', calldata, relayParams, structHash, signingDigest,
    signerRole: 'owner', actionCount: 1,
    relayRouter: input.relayRouter,
    receiverVerified: true, approvalAttached: false, approvalNonce: null,
  });
}

function finalize(p: {
  kind: 'OPEN' | 'CLOSE' | 'REVOKE'; calldata: Hex; relayParams: RelayParamsInput;
  structHash: Hex; signingDigest: Hex; signerRole: 'delegated' | 'owner';
  actionCount: number; relayRouter: Address; receiverVerified: boolean;
  approvalAttached: boolean; approvalNonce: bigint | null;
}): AssembledRelayCall {
  const packed = encodePacked(
    ['bytes', 'address', 'address', 'uint256'],
    [p.calldata, p.relayRouter, p.relayParams.fee.feeToken, p.relayParams.fee.feeAmount],
  );
  return {
    kind: p.kind,
    calldata: p.calldata,
    calldataHash: keccak256(p.calldata),
    packedPayloadHash: keccak256(packed),
    relayParamsHash: computeRelayParamsHash(p.relayParams),
    structHash: p.structHash,
    signingDigest: p.signingDigest,
    signerRole: p.signerRole,
    actionCount: p.actionCount,
    feeToken: p.relayParams.fee.feeToken,
    feeAmount: p.relayParams.fee.feeAmount,
    userNonce: p.relayParams.userNonce,
    deadline: p.relayParams.deadline,
    desChainId: p.relayParams.desChainId,
    receiverVerified: p.receiverVerified,
    approvalAttached: p.approvalAttached,
    approvalNonce: p.approvalNonce,
  };
}
