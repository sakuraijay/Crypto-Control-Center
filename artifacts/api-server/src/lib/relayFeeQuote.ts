/**
 * relayFeeQuote — Gelato relay fee quote 어댑터 (3단계: mock 전용).
 *
 * 공식 근거 (gmx-io/gmx-synthetics main, gmx-io/gmx-interface master):
 *  - callWithSyncFee 방식: fee는 같은 트랜잭션에서 GMX 계약이 Gelato fee
 *    collector에 지급. feeToken은 swap path가 없으면 WNT(WETH)만 허용
 *    (BaseGelatoRelayRouter._handleRelayFee → UnsupportedRelayFeeToken).
 *  - interface는 gasLimit×gasPrice에 1.3x 버퍼를 적용해 feeAmount 산출
 *    (estimateExpressParams: mulDiv(13n,10n)).
 *  - subaccount 주문에서 feeSwapPath 사용 시 MAX_RELAY_FEE_SWAP_USD_FOR_SUBACCOUNT
 *    한도 검사 — 이번 단계에서는 swap path 자체를 금지한다.
 *
 * 이 모듈은 절대 네트워크 호출을 하지 않는다. 실제 quote는 후속 단계에서
 * Gelato API 어댑터로 대체하되 같은 검증을 통과해야 한다.
 */

import type { Address } from 'viem';

/** Arbitrum One WETH (WNT) — GMX 공식 배포 문서 기준 */
export const WETH_ARBITRUM: Address = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';

/** 이번 단계 feeToken allowlist — WNT만 (swap path 금지와 일관) */
export const FEE_TOKEN_ALLOWLIST: readonly Address[] = [WETH_ARBITRUM];

/** quote 신선도 한도 (ms) — 초과 시 stale 거부 */
export const QUOTE_MAX_AGE_MS = 30_000;

/** 절대 상한: 0.005 ETH (wei) — 이보다 큰 relay fee는 무조건 거부 */
export const MAX_FEE_ABSOLUTE_WEI = 5_000_000_000_000_000n;

/** 주문 규모 대비 상한: fee USD가 주문 notional의 1%를 넘으면 거부 (bps) */
export const MAX_FEE_TO_ORDER_BPS = 100n;

export interface RelayFeeQuote {
  feeToken: Address;
  feeAmount: bigint;        // wei
  gasLimit: bigint;
  gasPrice: bigint;         // wei
  feeSwapPath: Address[];   // 이번 단계: 반드시 []
  quotedAtMs: number;
  /**
   * 'gmx_official_estimate' = GMX 공식 산정(gmxFeeEstimate — 6F-2 §6).
   * legacy 'gelato'(fee oracle) source는 제거됐다 — oracle fallback 금지.
   */
  source: 'mock' | 'gmx_official_estimate';
  /** §6 결속 — gmx_official_estimate quote는 반드시 결속 필드를 가진다 */
  boundChainId?: number;
  boundRelayRouter?: Address;
  boundPayloadHash?: string;
}

/**
 * mock quote 생성 — 결정적 계산(gasLimit×gasPrice×1.3), 네트워크 0회.
 * 실제 Gelato quote가 아니며 LIVE 제출 근거로 사용 금지.
 */
export function getMockFeeQuote(params: { gasLimit: bigint; gasPrice: bigint; nowMs: number }): RelayFeeQuote {
  const raw = params.gasLimit * params.gasPrice;
  return {
    feeToken: WETH_ARBITRUM,
    feeAmount: (raw * 13n) / 10n, // 공식 interface와 동일한 1.3x 버퍼
    gasLimit: params.gasLimit,
    gasPrice: params.gasPrice,
    feeSwapPath: [],
    quotedAtMs: params.nowMs,
    source: 'mock',
  };
}

export type FeeQuoteValidation = { ok: true } | { ok: false; reason: string };

/**
 * fee quote 방어 검증 — 실패 시 fallback 숫자 생성 금지, 무조건 거부.
 * @param ethPriceUsd 주문 규모 대비 비율 검사용 ETH/USD (없으면 비율 검사 실패 처리)
 */
export function validateFeeQuote(params: {
  quote: RelayFeeQuote | null | undefined;
  nowMs: number;
  orderNotionalUsd: number | null; // REVOKE 등 주문 없음 → null이면 비율 검사 생략
  ethPriceUsd: number | null;
  /** §6 결속 검증 — 지정 시 gmx_official_estimate quote의 결속 필드와 정확 일치 필수 */
  expectedBinding?: { chainId: number; relayRouter: string; payloadHash: string };
}): FeeQuoteValidation {
  const { quote, nowMs } = params;
  if (!quote) return { ok: false, reason: 'fee quote 없음 — fallback 금지, 제출 불가 (fail-closed)' };

  if (params.expectedBinding) {
    if (quote.source !== 'gmx_official_estimate') {
      return { ok: false, reason: `quote source '${quote.source}' — 제출에는 gmx_official_estimate만 허용` };
    }
    if (quote.boundChainId !== params.expectedBinding.chainId) {
      return { ok: false, reason: 'quote-chainId 결속 불일치 — 거부' };
    }
    if ((quote.boundRelayRouter ?? '').toLowerCase() !== params.expectedBinding.relayRouter.toLowerCase()) {
      return { ok: false, reason: 'quote-relayRouter 결속 불일치 — 거부' };
    }
    if ((quote.boundPayloadHash ?? '').toLowerCase() !== params.expectedBinding.payloadHash.toLowerCase()) {
      return { ok: false, reason: 'quote-payload 결속 불일치 — 거부' };
    }
  }

  if (!FEE_TOKEN_ALLOWLIST.some((t) => t.toLowerCase() === quote.feeToken.toLowerCase())) {
    return { ok: false, reason: `feeToken 비허용: ${quote.feeToken} — WNT(WETH)만 허용` };
  }
  if (quote.feeSwapPath.length !== 0) {
    return { ok: false, reason: 'feeSwapPath 금지 — 이번 단계는 WNT 직접 지불만 허용' };
  }
  if (quote.feeAmount <= 0n) {
    return { ok: false, reason: 'feeAmount 0 또는 음수 — 비정상 quote 거부' };
  }
  if (quote.feeAmount > MAX_FEE_ABSOLUTE_WEI) {
    return { ok: false, reason: `feeAmount 절대 상한 초과 (${quote.feeAmount} > ${MAX_FEE_ABSOLUTE_WEI} wei)` };
  }
  if (nowMs - quote.quotedAtMs > QUOTE_MAX_AGE_MS) {
    return { ok: false, reason: `stale quote (${nowMs - quote.quotedAtMs}ms 경과 > ${QUOTE_MAX_AGE_MS}ms)` };
  }
  if (nowMs < quote.quotedAtMs) {
    return { ok: false, reason: 'quote 시각이 미래 — 거부' };
  }

  // 주문 규모 대비 비율 검사 (주문형 kind만)
  if (params.orderNotionalUsd !== null) {
    if (params.ethPriceUsd === null || params.ethPriceUsd <= 0) {
      return { ok: false, reason: 'ETH 가격 미확인 — fee 비율 검사 불가, 제출 불가 (fail-closed)' };
    }
    if (params.orderNotionalUsd <= 0) {
      return { ok: false, reason: '주문 규모 0 이하 — fee 비율 검사 불가' };
    }
    const feeUsd = (Number(quote.feeAmount) / 1e18) * params.ethPriceUsd;
    const maxUsd = (params.orderNotionalUsd * Number(MAX_FEE_TO_ORDER_BPS)) / 10_000;
    if (feeUsd > maxUsd) {
      return { ok: false, reason: `fee가 주문 규모의 ${Number(MAX_FEE_TO_ORDER_BPS) / 100}% 초과 ($${feeUsd.toFixed(4)} > $${maxUsd.toFixed(4)})` };
    }
  }

  return { ok: true };
}
