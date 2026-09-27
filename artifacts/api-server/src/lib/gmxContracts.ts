/**
 * GMX V2 — Arbitrum One 계약 주소 및 ABI
 *
 * ⚠️  라이브 전 필수 검증 항목:
 *   1. GMX_SUBACCOUNT_ROUTER_ADDRESS 환경변수 → GMX 공식 배포 주소로 설정
 *      https://github.com/gmx-io/gmx-synthetics/blob/main/deployments/arbitrum/
 *   2. GMX_ORDER_VAULT_ADDRESS 환경변수 → 동일 소스에서 OrderVault 주소 확인
 *   3. ABI 함수 시그니처 → Arbiscan에서 소스코드 검증
 *
 * SubaccountRouter 필수 환경변수:
 *   GMX_SUBACCOUNT_ROUTER_ADDRESS  — SubaccountRouter 컨트랙트 주소
 *   GMX_ORDER_VAULT_ADDRESS         — OrderVault 컨트랙트 주소
 */

// ── Arbitrum One 고정 주소 ─────────────────────────────────────────────────────
/** USDC (Native) on Arbitrum One — 6 decimals */
export const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const;
/** ARB token on Arbitrum One — 18 decimals */
export const ARB_ADDRESS  = '0x912CE59144191C1204E64559FE8253a0e49E6548' as const;
/** GMX V2 ExchangeRouter on Arbitrum One */
export const EXCHANGE_ROUTER_ADDRESS = '0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8' as const;
/** Zero address */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
/** Zero bytes32 */
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

/** GMX V2 executionFee per market order (0.0015 ETH default, configurable) */
export function getExecutionFeeWei(): bigint {
  const envFee = process.env.GMX_EXECUTION_FEE_WEI;
  if (envFee && /^\d+$/.test(envFee)) return BigInt(envFee);
  return 1_500_000_000_000_000n; // 0.0015 ETH default
}

/** SubaccountRouter 주소 — GMX_SUBACCOUNT_ROUTER_ADDRESS 환경변수 필수 */
export function getSubaccountRouterAddress(): `0x${string}` {
  const addr = process.env.GMX_SUBACCOUNT_ROUTER_ADDRESS?.trim();
  if (!addr || !addr.startsWith('0x') || addr.length !== 42) {
    throw new Error(
      '[GMX] GMX_SUBACCOUNT_ROUTER_ADDRESS 환경변수가 설정되지 않았거나 잘못됨. ' +
      'GMX 공식 배포에서 SubaccountRouter 주소를 확인 후 Replit Secrets에 설정하세요.'
    );
  }
  return addr as `0x${string}`;
}

/** OrderVault 주소 — GMX_ORDER_VAULT_ADDRESS 환경변수 필수 */
export function getOrderVaultAddress(): `0x${string}` {
  const addr = process.env.GMX_ORDER_VAULT_ADDRESS?.trim();
  if (!addr || !addr.startsWith('0x') || addr.length !== 42) {
    throw new Error(
      '[GMX] GMX_ORDER_VAULT_ADDRESS 환경변수가 설정되지 않았거나 잘못됨. ' +
      'GMX 공식 배포에서 OrderVault 주소를 확인 후 Replit Secrets에 설정하세요.'
    );
  }
  return addr as `0x${string}`;
}

// ── GMX V2 Order Type Enum ────────────────────────────────────────────────────
export const GMX_ORDER_TYPE = {
  MarketSwap:         0,
  LimitSwap:          1,
  MarketIncrease:     2, // 포지션 열기 (시장가)
  LimitIncrease:      3,
  MarketDecrease:     4, // 포지션 닫기 (시장가)
  LimitDecrease:      5, // TP
  StopLossDecrease:   6, // SL
  Liquidation:        7,
} as const;

export const GMX_DECREASE_SWAP_TYPE = {
  NoSwap:              0,
  SwapPnlTokenToCollateralToken: 1,
  SwapCollateralTokenToPnlToken: 2,
} as const;

// ── SubaccountRouter ABI ───────────────────────────────────────────────────────
// ⚠️ 라이브 전 Arbiscan에서 실제 ABI 검증 필수
// https://arbiscan.io/address/<GMX_SUBACCOUNT_ROUTER_ADDRESS>#readContract
export const SUBACCOUNT_ROUTER_ABI = [
  // ── View ──────────────────────────────────────────────────────────────────
  {
    name: 'subaccounts',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'account',    type: 'address' },
      { name: 'subaccount', type: 'address' },
    ],
    outputs: [
      { name: 'remainingActions', type: 'uint256' },
      { name: 'expiresAt',        type: 'uint256' },
    ],
  },

  // ── Main Account Actions (MetaMask으로 서명) ───────────────────────────────
  {
    name: 'addSubaccount',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'subaccount',        type: 'address' },
      { name: 'expiresAt',         type: 'uint256' },
      { name: 'maxAllowedActions', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'removeSubaccount',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'subaccount', type: 'address' }],
    outputs: [],
  },

  // ── Subaccount Actions (서버 사이너가 서명) ────────────────────────────────
  {
    name: 'multicall',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
  {
    // 메인 계정의 USDC를 OrderVault로 전송 (메인 계정이 Router에 approve 필요)
    name: 'sendTokens',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account',  type: 'address' }, // 메인 지갑 (USDC 소스)
      { name: 'token',    type: 'address' },
      { name: 'receiver', type: 'address' }, // OrderVault
      { name: 'amount',   type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'createOrder',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'account', type: 'address' },
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'addresses',
            type: 'tuple',
            components: [
              { name: 'receiver',               type: 'address'   },
              { name: 'cancellationReceiver',   type: 'address'   },
              { name: 'callbackContract',        type: 'address'   },
              { name: 'uiFeeReceiver',           type: 'address'   },
              { name: 'market',                  type: 'address'   },
              { name: 'initialCollateralToken',  type: 'address'   },
              { name: 'swapPath',                type: 'address[]' },
            ],
          },
          {
            name: 'numbers',
            type: 'tuple',
            components: [
              { name: 'sizeDeltaUsd',                type: 'uint256' },
              { name: 'initialCollateralDeltaAmount', type: 'uint256' },
              { name: 'triggerPrice',                type: 'uint256' },
              { name: 'acceptablePrice',             type: 'uint256' },
              { name: 'executionFee',                type: 'uint256' },
              { name: 'callbackGasLimit',            type: 'uint256' },
              { name: 'minOutputAmount',             type: 'uint256' },
              { name: 'validFromTime',               type: 'uint256' },
            ],
          },
          { name: 'orderType',                 type: 'uint256' },
          { name: 'decreasePositionSwapType',  type: 'uint256' },
          { name: 'isLong',                    type: 'bool'    },
          { name: 'shouldUnwrapNativeToken',   type: 'bool'    },
          { name: 'autoCancel',               type: 'bool'    },
          { name: 'referralCode',              type: 'bytes32' },
        ],
      },
    ],
    outputs: [{ name: 'orderKey', type: 'bytes32' }],
  },
  {
    name: 'updateOrder',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account',          type: 'address' },
      { name: 'key',              type: 'bytes32' },
      { name: 'sizeDeltaUsd',     type: 'uint256' },
      { name: 'acceptablePrice',  type: 'uint256' },
      { name: 'triggerPrice',     type: 'uint256' },
      { name: 'minOutputAmount',  type: 'uint256' },
      { name: 'autoCancel',      type: 'bool'    },
    ],
    outputs: [],
  },
  {
    name: 'cancelOrder',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'key',     type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

// ── ERC-20 (USDC approve) ABI ─────────────────────────────────────────────────
export const ERC20_APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ── 가격 변환 유틸리티 ─────────────────────────────────────────────────────────
// GMX V2 내부 가격 단위 = USD * 1e30
const PRICE_PRECISION = 10n ** 30n;

/** USD 숫자(예: 2500.5) → GMX V2 price bigint (1e30 기준) */
export function usdToGmxPrice(usdNumber: number): bigint {
  // 소수점 6자리까지 보존 후 1e24 곱셈으로 1e30 도달
  const scaled = BigInt(Math.round(usdNumber * 1_000_000)); // 1e6 precision
  return scaled * (PRICE_PRECISION / 1_000_000n);           // → 1e30
}

/** USD 포지션 크기 → GMX V2 sizeDeltaUsd bigint (1e30) */
export function usdSizeToGmx(usdSize: number): bigint {
  return usdToGmxPrice(usdSize);
}

/** USDC 수량(달러) → USDC wei (6 decimals) */
export function usdToUsdcWei(usdAmount: number): bigint {
  return BigInt(Math.round(usdAmount * 1_000_000));
}

/** 롱 포지션 acceptablePrice: 현재가 + slippage% */
export function acceptablePriceLong(currentPriceUsd: number, slippagePct = 1.0): bigint {
  return usdToGmxPrice(currentPriceUsd * (1 + slippagePct / 100));
}

/** 숏 포지션 acceptablePrice: 현재가 - slippage% */
export function acceptablePriceShort(currentPriceUsd: number, slippagePct = 1.0): bigint {
  return usdToGmxPrice(currentPriceUsd * (1 - slippagePct / 100));
}

/** 롱 청산 acceptablePrice: 현재가 - slippage% (더 낮은 가격 허용) */
export function acceptablePriceCloseLong(currentPriceUsd: number, slippagePct = 1.0): bigint {
  return usdToGmxPrice(currentPriceUsd * (1 - slippagePct / 100));
}

/** 숏 청산 acceptablePrice: 현재가 + slippage% (더 높은 가격 허용) */
export function acceptablePriceCloseShort(currentPriceUsd: number, slippagePct = 1.0): bigint {
  return usdToGmxPrice(currentPriceUsd * (1 + slippagePct / 100));
}
