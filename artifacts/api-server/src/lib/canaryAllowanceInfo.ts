/**
 * canaryAllowanceInfo — Controlled Canary USDC allowance 카드용 authoritative 파라미터 (#124-B).
 *
 * 서버가 반환하는 chainId/USDC/spender는 pinned SDK(@gmx-io/sdk 1.7.0) 및 canonical
 * 상수와 교차검증(verified)된 경우에만 UI에서 approve 버튼이 활성화된다.
 *
 * spender 결정 근거: GMX API v2 실행 경로의 allowance 게이트(checkUsdcCollateralGate)는
 * SDK fetchAllowances({spender:'router'})를 사용하고, SDK는 'router'를
 * getContract(42161,'SyntheticsRouter')로 해석한다. 따라서 canary approve의 spender는
 * SyntheticsRouter이며, 런타임 SDK 해석값과 pinned 상수가 일치해야만 verified=true.
 *
 * 서버는 approve 트랜잭션을 생성·서명·제출하지 않는다 (read-only 파라미터 제공만).
 */

import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url ?? __filename);
const { getContract } = _require('@gmx-io/sdk/configs/contracts') as typeof import('@gmx-io/sdk/configs/contracts');

/** 정확히 15 USDC (6 decimals) — canary 하드캡. 다른 금액/unlimited 금지. */
export const CANARY_ALLOWANCE_AMOUNT_UNITS = 15_000_000n;

/** pinned SDK 1.7.0 기준 Arbitrum One SyntheticsRouter (allowance 게이트 spender) */
export const PINNED_SYNTHETICS_ROUTER = '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6';

/** Arbitrum One canonical native USDC */
export const PINNED_CANONICAL_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

export const ARBITRUM_CHAIN_ID = 42161;

/**
 * #124-C — 운영자가 프로비저닝을 승인한 canary delegated signer 공개주소.
 * prepare(Owner Approval)는 서버 signer가 이 주소와 정확히 일치할 때만 허용 (서버 측 강제).
 */
export const EXPECTED_CANARY_SIGNER = '0xc56436F09039E15Aa2244659d0fC5b7f706DdbF6';

export function isExpectedCanarySigner(signer: string | null | undefined): boolean {
  return typeof signer === 'string' && signer.toLowerCase() === EXPECTED_CANARY_SIGNER.toLowerCase();
}

export interface CanaryAllowanceInfo {
  verified: boolean;
  reasons: string[];
  chainId: number;
  usdcAddress: string;
  spenderAddress: string | null;
  /** 승인 금액 (USDC 6-decimals units, 문자열) — 정확히 '15000000'만 유효 */
  amountUnits: string;
  mainAddress: string | null;
  /** 현재 on-chain allowance (units 문자열) — 조회 실패 시 null (표시용) */
  allowanceUnits: string | null;
}

/** 런타임 SDK에서 SyntheticsRouter 주소 해석 (실패 시 null — fail-closed) */
export function resolveSdkSyntheticsRouter(): string | null {
  try {
    const addr = getContract(ARBITRUM_CHAIN_ID, 'SyntheticsRouter');
    return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr : null;
  } catch {
    return null;
  }
}

/**
 * 순수 빌더 — 교차검증 결과 조합. 하나라도 불일치/누락이면 verified=false (fail-closed).
 * spenderAddress는 검증 통과 시에만 노출 (미검증 spender를 UI에 주지 않는다).
 */
export function buildCanaryAllowanceInfo(input: {
  sdkRouter: string | null;
  usdcAddress: string;
  mainAddress: string | null;
  allowanceUnits: bigint | null;
}): CanaryAllowanceInfo {
  const reasons: string[] = [];

  const routerOk =
    input.sdkRouter !== null &&
    input.sdkRouter.toLowerCase() === PINNED_SYNTHETICS_ROUTER.toLowerCase();
  if (!routerOk) {
    reasons.push(
      input.sdkRouter === null
        ? 'SDK SyntheticsRouter 해석 실패 — spender 교차검증 불가 (fail-closed)'
        : 'SDK SyntheticsRouter 주소가 pinned 상수와 불일치 — 차단 (fail-closed)',
    );
  }

  const usdcOk = input.usdcAddress.toLowerCase() === PINNED_CANONICAL_USDC.toLowerCase();
  if (!usdcOk) reasons.push('USDC 주소가 canonical(0xaf88…5831)과 불일치 — 차단 (fail-closed)');

  const mainOk = Boolean(input.mainAddress && /^0x[0-9a-fA-F]{40}$/.test(input.mainAddress));
  if (!mainOk) reasons.push('main wallet(GMX_WALLET_ADDRESS) 미설정 — approve 대상 확인 불가');

  const verified = routerOk && usdcOk && mainOk;

  return {
    verified,
    reasons,
    chainId: ARBITRUM_CHAIN_ID,
    usdcAddress: PINNED_CANONICAL_USDC,
    spenderAddress: verified ? PINNED_SYNTHETICS_ROUTER : null,
    amountUnits: CANARY_ALLOWANCE_AMOUNT_UNITS.toString(),
    mainAddress: mainOk ? input.mainAddress : null,
    allowanceUnits: input.allowanceUnits === null ? null : input.allowanceUnits.toString(),
  };
}
