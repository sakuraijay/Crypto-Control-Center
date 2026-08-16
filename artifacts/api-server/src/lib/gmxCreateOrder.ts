/**
 * gmxCreateOrder — GMX delegated trading 2단계: CreateOrder EIP-712 struct hash
 * + SubaccountGelatoRelayRouter.createOrder calldata 빌더 (오프라인 전용).
 *
 * 근거 (gmx-io/gmx-synthetics main, contracts/router/relay/RelayUtils.sol,
 * SubaccountGelatoRelayRouter.sol, order/IBaseOrderUtils.sol, order/Order.sol —
 * 2026-08-17 raw GitHub 확인, typehash 추측 없음):
 *  - CREATE_ORDER_TYPEHASH = keccak256(abi.encodePacked(
 *      "CreateOrder(address account,CreateOrderAddresses addresses,CreateOrderNumbers numbers,
 *       uint256 orderType,uint256 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,
 *       bool autoCancel,bytes32 referralCode,bytes32[] dataList,bytes32 relayParams,bytes32 subaccountApproval)",
 *      CREATE_ORDER_ADDRESSES, CREATE_ORDER_NUMBERS))
 *  - getCreateOrderStructHash(relayParams, subaccountApproval, account, params):
 *      subaccountApprovalHash = keccak256(abi.encode(subaccountApproval))
 *      — EIP-712 struct hash가 아니라 **struct 전체(signature 포함)의 plain abi.encode**
 *  - dataList 해시 = keccak256(abi.encodePacked(bytes32[]))
 *  - OrderType: MarketIncrease=2(OPEN), MarketDecrease=4(CLOSE)
 *  - createOrder(relayParams, subaccountApproval, account, subaccount, params)
 *
 * 이 모듈은 해시·digest·calldata **생성까지만** 수행한다. Gelato 제출·서명·
 * 온체인 전송은 절대 하지 않는다 (fail-closed 검증만).
 */

import { keccak256, encodeAbiParameters, encodePacked, encodeFunctionData, toHex, type Address, type Hex } from 'viem';
import {
  computeRelayParamsHash,
  computeGmxRelayDomainSeparator,
  computeRelayDigest,
  type RelayParamsInput,
  type SubaccountApprovalMessage,
  RELAY_PARAMS_ABI_COMPONENTS,
} from './gmxEip712';

// ── 공식 typehash 문자열 (원문 그대로 — 수정 금지) ───────────────────────────

export const CREATE_ORDER_ADDRESSES_TYPE_STRING =
  'CreateOrderAddresses(address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath)';
export const CREATE_ORDER_NUMBERS_TYPE_STRING =
  'CreateOrderNumbers(uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 validFromTime)';
export const CREATE_ORDER_ROOT_TYPE_STRING =
  'CreateOrder(address account,CreateOrderAddresses addresses,CreateOrderNumbers numbers,uint256 orderType,uint256 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList,bytes32 relayParams,bytes32 subaccountApproval)';

export const CREATE_ORDER_ADDRESSES_TYPEHASH: Hex =
  keccak256(toHex(CREATE_ORDER_ADDRESSES_TYPE_STRING));
export const CREATE_ORDER_NUMBERS_TYPEHASH: Hex =
  keccak256(toHex(CREATE_ORDER_NUMBERS_TYPE_STRING));
export const CREATE_ORDER_TYPEHASH: Hex = keccak256(
  toHex(CREATE_ORDER_ROOT_TYPE_STRING + CREATE_ORDER_ADDRESSES_TYPE_STRING + CREATE_ORDER_NUMBERS_TYPE_STRING),
);

// ── Order enum (contracts/order/Order.sol) ───────────────────────────────────
export const ORDER_TYPE = {
  MarketSwap: 0n,
  LimitSwap: 1n,
  MarketIncrease: 2n,
  LimitIncrease: 3n,
  MarketDecrease: 4n,
  LimitDecrease: 5n,
} as const;

export const DECREASE_POSITION_SWAP_TYPE = {
  NoSwap: 0n,
  SwapPnlTokenToCollateralToken: 1n,
  SwapCollateralTokenToPnlToken: 2n,
} as const;

// ── CreateOrderParams 구조 ────────────────────────────────────────────────────

export interface CreateOrderAddresses {
  receiver: Address;
  cancellationReceiver: Address;
  callbackContract: Address;
  uiFeeReceiver: Address;
  market: Address;
  initialCollateralToken: Address;
  swapPath: Address[];
}

export interface CreateOrderNumbers {
  sizeDeltaUsd: bigint;
  initialCollateralDeltaAmount: bigint;
  triggerPrice: bigint;
  acceptablePrice: bigint;
  executionFee: bigint;
  callbackGasLimit: bigint;
  minOutputAmount: bigint;
  validFromTime: bigint;
}

export interface CreateOrderParams {
  addresses: CreateOrderAddresses;
  numbers: CreateOrderNumbers;
  orderType: bigint;
  decreasePositionSwapType: bigint;
  isLong: boolean;
  shouldUnwrapNativeToken: boolean;
  autoCancel: boolean;
  referralCode: Hex;
  dataList: Hex[];
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex;

// ── struct hash 계산 (공식 RelayUtils와 1:1) ─────────────────────────────────

export function getCreateOrderAddressesStructHash(a: CreateOrderAddresses): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
      { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' },
    ],
    [
      CREATE_ORDER_ADDRESSES_TYPEHASH,
      a.receiver, a.cancellationReceiver, a.callbackContract, a.uiFeeReceiver,
      a.market, a.initialCollateralToken,
      keccak256(encodePacked(['address[]'], [a.swapPath])),
    ],
  ));
}

export function getCreateOrderNumbersStructHash(n: CreateOrderNumbers): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    ],
    [
      CREATE_ORDER_NUMBERS_TYPEHASH,
      n.sizeDeltaUsd, n.initialCollateralDeltaAmount, n.triggerPrice, n.acceptablePrice,
      n.executionFee, n.callbackGasLimit, n.minOutputAmount, n.validFromTime,
    ],
  ));
}

/** SubaccountApproval struct(서명 포함)의 plain abi.encode 해시 — 공식과 동일 */
export const SUBACCOUNT_APPROVAL_STRUCT_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'subaccount', type: 'address' },
      { name: 'shouldAdd', type: 'bool' },
      { name: 'expiresAt', type: 'uint256' },
      { name: 'maxAllowedCount', type: 'uint256' },
      { name: 'actionType', type: 'bytes32' },
      { name: 'nonce', type: 'uint256' },
      { name: 'desChainId', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'integrationId', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
  },
] as const;

export interface SubaccountApprovalStruct extends SubaccountApprovalMessage {
  signature: Hex;
}

export function hashSubaccountApprovalStruct(approval: SubaccountApprovalStruct): Hex {
  return keccak256(encodeAbiParameters(SUBACCOUNT_APPROVAL_STRUCT_ABI, [approval]));
}

/**
 * 공식 RelayUtils.getCreateOrderStructHash(relayParams, subaccountApproval, account, params)
 */
export function getCreateOrderStructHash(params: {
  relayParams: RelayParamsInput;
  subaccountApproval: SubaccountApprovalStruct;
  account: Address;
  order: CreateOrderParams;
}): Hex {
  const relayParamsHash = computeRelayParamsHash(params.relayParams);
  const subaccountApprovalHash = hashSubaccountApprovalStruct(params.subaccountApproval);
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bool' },
      { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' },
    ],
    [
      CREATE_ORDER_TYPEHASH,
      params.account,
      getCreateOrderAddressesStructHash(params.order.addresses),
      getCreateOrderNumbersStructHash(params.order.numbers),
      params.order.orderType,
      params.order.decreasePositionSwapType,
      params.order.isLong,
      params.order.shouldUnwrapNativeToken,
      params.order.autoCancel,
      params.order.referralCode,
      keccak256(encodePacked(['bytes32[]'], [params.order.dataList])),
      relayParamsHash,
      subaccountApprovalHash,
    ],
  ));
}

/** delegated signer가 서명할 EIP-712 digest (0x1901 ‖ ds ‖ structHash) */
export function computeCreateOrderDigest(params: {
  chainId: number;
  verifyingContract: Address;   // SubaccountGelatoRelayRouter
  relayParams: RelayParamsInput;
  subaccountApproval: SubaccountApprovalStruct;
  account: Address;
  order: CreateOrderParams;
}): Hex {
  const ds = computeGmxRelayDomainSeparator(params.chainId, params.verifyingContract);
  return computeRelayDigest(ds, getCreateOrderStructHash(params));
}

// ── OPEN/CLOSE 파라미터 빌더 (검증 포함, fail-closed) ────────────────────────

export interface BuildOrderInput {
  mainAccount: Address;          // receiver·cancellationReceiver 강제 대상
  market: Address;
  collateralToken: Address;      // USDC 등
  sizeDeltaUsd: bigint;          // 1e30
  initialCollateralDeltaAmount: bigint;
  acceptablePrice: bigint;       // 1e30/토큰 정밀도 반영값
  executionFee: bigint;
  isLong: boolean;
}

function assertCommon(input: BuildOrderInput): void {
  if (input.sizeDeltaUsd <= 0n) throw new Error('sizeDeltaUsd는 양수여야 합니다');
  if (input.executionFee < 0n) throw new Error('executionFee는 음수 불가');
  if (input.mainAccount === ZERO_ADDRESS) throw new Error('mainAccount 필수');
}

/** OPEN — MarketIncrease. receiver/cancellationReceiver = main account 강제. */
export function buildOpenOrderParams(input: BuildOrderInput): CreateOrderParams {
  assertCommon(input);
  if (input.initialCollateralDeltaAmount <= 0n) throw new Error('OPEN은 담보 입금이 필요합니다');
  return {
    addresses: {
      receiver: input.mainAccount,
      cancellationReceiver: input.mainAccount,
      callbackContract: ZERO_ADDRESS,
      uiFeeReceiver: ZERO_ADDRESS,
      market: input.market,
      initialCollateralToken: input.collateralToken,
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: input.sizeDeltaUsd,
      initialCollateralDeltaAmount: input.initialCollateralDeltaAmount,
      triggerPrice: 0n,
      acceptablePrice: input.acceptablePrice,
      executionFee: input.executionFee,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: ORDER_TYPE.MarketIncrease,
    decreasePositionSwapType: DECREASE_POSITION_SWAP_TYPE.NoSwap,
    isLong: input.isLong,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ZERO_BYTES32,
    dataList: [],
  };
}

/** CLOSE — MarketDecrease. receiver/cancellationReceiver = main account 강제. */
export function buildCloseOrderParams(input: BuildOrderInput): CreateOrderParams {
  assertCommon(input);
  return {
    addresses: {
      receiver: input.mainAccount,
      cancellationReceiver: input.mainAccount,
      callbackContract: ZERO_ADDRESS,
      uiFeeReceiver: ZERO_ADDRESS,
      market: input.market,
      initialCollateralToken: input.collateralToken,
      swapPath: [],
    },
    numbers: {
      sizeDeltaUsd: input.sizeDeltaUsd,
      initialCollateralDeltaAmount: input.initialCollateralDeltaAmount,
      triggerPrice: 0n,
      acceptablePrice: input.acceptablePrice,
      executionFee: input.executionFee,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: ORDER_TYPE.MarketDecrease,
    decreasePositionSwapType: DECREASE_POSITION_SWAP_TYPE.NoSwap,
    isLong: input.isLong,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ZERO_BYTES32,
    dataList: [],
  };
}

// ── calldata 인코딩 (제출 없음) ──────────────────────────────────────────────

const CREATE_ORDER_PARAMS_ABI_COMPONENT = {
  type: 'tuple',
  components: [
    {
      name: 'addresses', type: 'tuple',
      components: [
        { name: 'receiver', type: 'address' },
        { name: 'cancellationReceiver', type: 'address' },
        { name: 'callbackContract', type: 'address' },
        { name: 'uiFeeReceiver', type: 'address' },
        { name: 'market', type: 'address' },
        { name: 'initialCollateralToken', type: 'address' },
        { name: 'swapPath', type: 'address[]' },
      ],
    },
    {
      name: 'numbers', type: 'tuple',
      components: [
        { name: 'sizeDeltaUsd', type: 'uint256' },
        { name: 'initialCollateralDeltaAmount', type: 'uint256' },
        { name: 'triggerPrice', type: 'uint256' },
        { name: 'acceptablePrice', type: 'uint256' },
        { name: 'executionFee', type: 'uint256' },
        { name: 'callbackGasLimit', type: 'uint256' },
        { name: 'minOutputAmount', type: 'uint256' },
        { name: 'validFromTime', type: 'uint256' },
      ],
    },
    { name: 'orderType', type: 'uint8' },
    { name: 'decreasePositionSwapType', type: 'uint8' },
    { name: 'isLong', type: 'bool' },
    { name: 'shouldUnwrapNativeToken', type: 'bool' },
    { name: 'autoCancel', type: 'bool' },
    { name: 'referralCode', type: 'bytes32' },
    { name: 'dataList', type: 'bytes32[]' },
  ],
} as const;

export const SUBACCOUNT_CREATE_ORDER_ABI = [
  {
    type: 'function',
    name: 'createOrder',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'relayParams', type: 'tuple', components: [
        { name: 'oracleParams', ...RELAY_PARAMS_ABI_COMPONENTS[0] },
        { name: 'externalCalls', ...RELAY_PARAMS_ABI_COMPONENTS[1] },
        { name: 'tokenPermits', ...RELAY_PARAMS_ABI_COMPONENTS[2] },
        { name: 'fee', ...RELAY_PARAMS_ABI_COMPONENTS[3] },
        { name: 'userNonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        // 6C 감사 결과: 배포 artifact ABI의 calldata struct 순서는
        // signature가 desChainId보다 **앞**이다 (EIP-712 hash 순서와 다름 — 그쪽은 signature 미포함)
        { name: 'signature', type: 'bytes' },
        { name: 'desChainId', type: 'uint256' },
      ]},
      { name: 'subaccountApproval', ...SUBACCOUNT_APPROVAL_STRUCT_ABI[0] },
      { name: 'account', type: 'address' },
      { name: 'subaccount', type: 'address' },
      { name: 'params', ...CREATE_ORDER_PARAMS_ABI_COMPONENT },
    ],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

function hasExternalCalls(rp: RelayParamsInput): boolean {
  const e = rp.externalCalls;
  return e.sendTokens.length > 0 || e.sendAmounts.length > 0 || e.externalCallTargets.length > 0
    || e.externalCallDataList.length > 0 || e.refundTokens.length > 0 || e.refundReceivers.length > 0;
}

/**
 * createOrder calldata 인코딩 — **오프라인 전용** (제출 절대 없음).
 * fail-closed 검증: receiver/cancellationReceiver=main account, externalCalls 빈 값,
 * relaySignature는 delegated signer의 CreateOrder digest 서명(호출측 검증 책임).
 */
export function encodeSubaccountCreateOrderCalldata(params: {
  relayParams: RelayParamsInput;
  relaySignature: Hex;
  subaccountApproval: SubaccountApprovalStruct;
  account: Address;
  subaccount: Address;
  order: CreateOrderParams;
}): Hex {
  if (params.order.addresses.receiver.toLowerCase() !== params.account.toLowerCase()) {
    throw new Error('receiver는 main account여야 합니다 — 자금 유출 방지 (fail-closed)');
  }
  if (params.order.addresses.cancellationReceiver.toLowerCase() !== params.account.toLowerCase()) {
    throw new Error('cancellationReceiver는 main account여야 합니다 (fail-closed)');
  }
  if (hasExternalCalls(params.relayParams)) {
    throw new Error('externalCalls는 비어 있어야 합니다 — 외부 호출 금지 (fail-closed)');
  }
  if (params.order.orderType > 255n || params.order.decreasePositionSwapType > 255n) {
    throw new Error('orderType/decreasePositionSwapType는 uint8 범위여야 합니다');
  }
  return encodeFunctionData({
    abi: SUBACCOUNT_CREATE_ORDER_ABI,
    functionName: 'createOrder',
    args: [
      { ...params.relayParams, signature: params.relaySignature },
      params.subaccountApproval,
      params.account,
      params.subaccount,
      {
        ...params.order,
        orderType: Number(params.order.orderType),
        decreasePositionSwapType: Number(params.order.decreasePositionSwapType),
      },
    ],
  });
}
