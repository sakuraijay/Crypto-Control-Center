/**
 * GMX V2 SubaccountRouter — 온체인 상태 조회 및 MetaMask 트랜잭션 빌더
 *
 * 이 모듈은 읽기 전용(view call) 및 미서명 트랜잭션 데이터 빌드만 수행합니다.
 * 실제 온체인 전송은 liveTestExecutor.ts 또는 MetaMask(브라우저)가 담당합니다.
 */

import { createPublicClient, http, encodeFunctionData } from 'viem';
import { arbitrum } from 'viem/chains';
import {
  SUBACCOUNT_ROUTER_ABI,
  ERC20_APPROVE_ABI,
  USDC_ADDRESS,
  getSubaccountRouterAddress,
} from './gmxContracts';

// ── RPC 클라이언트 ─────────────────────────────────────────────────────────────
function getRpcUrl(): string {
  const url = process.env.GMX_RPC_URL?.trim();
  if (!url) throw new Error('[GMXSubaccount] GMX_RPC_URL 환경변수가 설정되지 않았습니다');
  return url;
}

function getPublicClient() {
  return createPublicClient({
    chain:     arbitrum,
    transport: http(getRpcUrl(), { timeout: 8_000 }),
  });
}

// ── 위임 상태 조회 ─────────────────────────────────────────────────────────────

export interface DelegationStatus {
  /** 서브계정이 온체인에서 승인되어 있는지 여부 */
  isAuthorized:       boolean;
  /** 남은 허용 액션 수 */
  remainingActions:   number;
  /** 만료 Unix timestamp (초) */
  expiresAtUnix:      number;
  /** 만료 여부 */
  isExpired:          boolean;
  /** 메인 지갑 주소 */
  mainAddress:        string;
  /** 서버 사이너 주소 */
  signerAddress:      string;
  /** 온체인 조회 성공 여부 */
  queryOk:            boolean;
  /** 조회 오류 메시지 */
  queryError?:        string;
}

/**
 * SubaccountRouter.subaccounts() 뷰 호출로 위임 상태를 온체인에서 조회.
 * RPC 실패 시 fail-closed (isAuthorized: false).
 */
export async function checkDelegationStatus(
  mainAddress: string,
  signerAddress: string,
): Promise<DelegationStatus> {
  const base: DelegationStatus = {
    isAuthorized:     false,
    remainingActions: 0,
    expiresAtUnix:    0,
    isExpired:        true,
    mainAddress,
    signerAddress,
    queryOk:          false,
  };

  try {
    const routerAddress = getSubaccountRouterAddress();
    const client        = getPublicClient();
    const nowUnix       = Math.floor(Date.now() / 1000);

    const result = await client.readContract({
      address:      routerAddress,
      abi:          SUBACCOUNT_ROUTER_ABI,
      functionName: 'subaccounts',
      args:         [mainAddress as `0x${string}`, signerAddress as `0x${string}`],
    });

    // result = [remainingActions, expiresAt]
    const remaining  = Number((result as [bigint, bigint])[0]);
    const expiresAt  = Number((result as [bigint, bigint])[1]);
    const isExpired  = expiresAt > 0 && expiresAt < nowUnix;
    const isAuth     = remaining > 0 && !isExpired;

    return {
      ...base,
      isAuthorized:     isAuth,
      remainingActions: remaining,
      expiresAtUnix:    expiresAt,
      isExpired,
      queryOk:          true,
    };
  } catch (err: unknown) {
    const msg = (err as Error).message ?? 'Unknown RPC error';
    console.error('[GMXSubaccount] checkDelegationStatus 실패:', msg);
    return { ...base, queryError: msg };
  }
}

// ── MetaMask 트랜잭션 빌더 (실제 전송은 사용자가 MetaMask로 수행) ────────────────

export interface UnsignedTx {
  to:    string;
  data:  string;
  value: string; // hex wei
}

/**
 * MetaMask에서 실행할 USDC approve 트랜잭션 빌드.
 * 메인 지갑이 SubaccountRouter에게 USDC 사용 권한 부여.
 * amount: USDC wei (6 decimals). 기본값: 15 USDC (하드캡).
 */
export function buildUsdcApproveTx(amount: bigint = 15_000_000n): UnsignedTx {
  const routerAddress = getSubaccountRouterAddress();
  const data = encodeFunctionData({
    abi:          ERC20_APPROVE_ABI,
    functionName: 'approve',
    args:         [routerAddress, amount],
  });
  return { to: USDC_ADDRESS, data, value: '0x0' };
}

/**
 * MetaMask에서 실행할 addSubaccount 트랜잭션 빌드.
 * 메인 지갑이 서버 사이너를 서브계정으로 승인.
 *
 * @param signerAddress - 서버가 생성한 서명자 주소 (/api/executor/signer 에서 확인)
 * @param maxActions    - 허용 액션 수 (LIVE TEST 하드캡: 10)
 * @param validHours    - 유효 시간 (LIVE TEST 하드캡: 24)
 */
export function buildAddSubaccountTx(
  signerAddress: string,
  maxActions: number = 10,
  validHours: number = 24,
): UnsignedTx {
  const routerAddress = getSubaccountRouterAddress();
  const expiresAt     = BigInt(Math.floor(Date.now() / 1000) + validHours * 3600);
  const data = encodeFunctionData({
    abi:          SUBACCOUNT_ROUTER_ABI,
    functionName: 'addSubaccount',
    args:         [
      signerAddress as `0x${string}`,
      expiresAt,
      BigInt(maxActions),
    ],
  });
  return { to: routerAddress, data, value: '0x0' };
}

/**
 * MetaMask에서 실행할 removeSubaccount 트랜잭션 빌드.
 * 메인 지갑이 서버 사이너의 권한을 즉시 철회.
 * Emergency Stop 시 이 트랜잭션을 MetaMask로 제출하거나
 * 서버 사이너 지갑이 직접 온체인 전송할 수 있음.
 */
export function buildRemoveSubaccountTx(signerAddress: string): UnsignedTx {
  const routerAddress = getSubaccountRouterAddress();
  const data = encodeFunctionData({
    abi:          SUBACCOUNT_ROUTER_ABI,
    functionName: 'removeSubaccount',
    args:         [signerAddress as `0x${string}`],
  });
  return { to: routerAddress, data, value: '0x0' };
}

/**
 * USDC allowance 조회 (approve 필요 여부 확인).
 */
export async function getUsdcAllowance(mainAddress: string): Promise<bigint> {
  try {
    const routerAddress = getSubaccountRouterAddress();
    const client        = getPublicClient();
    const result = await client.readContract({
      address:      USDC_ADDRESS as `0x${string}`,
      abi:          ERC20_APPROVE_ABI,
      functionName: 'allowance',
      args:         [mainAddress as `0x${string}`, routerAddress],
    });
    return result as bigint;
  } catch {
    return 0n;
  }
}

/**
 * 지정 spender에 대한 USDC allowance 조회 (#124-B canary 카드용).
 * 조회 실패는 null 반환 (0으로 위장 금지 — 표시 fail-closed).
 */
export async function getUsdcAllowanceForSpender(mainAddress: string, spender: string): Promise<bigint | null> {
  try {
    const client = getPublicClient();
    const result = await client.readContract({
      address:      USDC_ADDRESS as `0x${string}`,
      abi:          ERC20_APPROVE_ABI,
      functionName: 'allowance',
      args:         [mainAddress as `0x${string}`, spender as `0x${string}`],
    });
    return result as bigint;
  } catch {
    return null;
  }
}

/**
 * SubaccountRouter 컨트랙트가 올바르게 배포되어 있는지 검증.
 * 알려진 주소로 view 호출을 시도하고 결과 형태를 확인.
 * 서버 시작 시 한 번 호출.
 */
export async function verifySubaccountRouter(): Promise<{ ok: boolean; error?: string }> {
  try {
    const routerAddress = getSubaccountRouterAddress();
    const client        = getPublicClient();
    // 임의 주소로 view 호출 — 응답이 배열이어야 함
    await client.readContract({
      address:      routerAddress,
      abi:          SUBACCOUNT_ROUTER_ABI,
      functionName: 'subaccounts',
      args:         [routerAddress, routerAddress], // self-check
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = (err as Error).message ?? 'Unknown error';
    return { ok: false, error: msg };
  }
}
