/**
 * GMX V2 delegated authorization 조회 및 legacy MetaMask 트랜잭션 빌더
 *
 * 이 모듈은 읽기 전용(view call) 및 미서명 트랜잭션 데이터 빌드만 수행합니다.
 * 실제 온체인 전송은 liveTestExecutor.ts 또는 MetaMask(브라우저)가 담당합니다.
 *
 * Safety boundary:
 * - Subaccount authorization/read/unsigned-tx paths must use the separately audited
 *   canonical Arbitrum One SubaccountRouter only.
 * - A syntactically valid but different address must never be accepted here.
 */

import { createPublicClient, http, encodeFunctionData } from 'viem';
import { arbitrum } from 'viem/chains';
import {
  SUBACCOUNT_ROUTER_ABI,
  ERC20_APPROVE_ABI,
  USDC_ADDRESS,
} from './gmxContracts';
import {
  GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT,
  validateCanonicalSubaccountRouterEnv,
} from './gmxCanonicalSubaccountRouterAudit';
import { createCanonicalDataStoreClient } from './gmxCanonicalClient';
import { readSubaccountAuthorization, type DataStoreClient } from './gmxDataStore';
import { resolveGmxLiveRelayConfig } from './gmxLiveConfig';
import { validateEnvAgainstManifest } from './gmxDeploymentManifest';

/**
 * Execution-boundary router resolver.
 *
 * Keep this stricter than the generic gmxContracts getter: readiness and unrelated
 * startup reads may need to report an invalid configuration without throwing, but
 * any delegation read or unsigned authorization/revoke transaction built by this
 * module must be pinned to the audited canonical router.
 */
function getCanonicalSubaccountRouterAddress(): `0x${string}` {
  const validation = validateCanonicalSubaccountRouterEnv(process.env);
  if (!validation.ok) {
    throw new Error(
      '[GMXSubaccount] canonical SubaccountRouter unavailable or mismatched — fail-closed',
    );
  }
  return GMX_CANONICAL_SUBACCOUNT_ROUTER_AUDIT.address as `0x${string}`;
}

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

// ── API v2 canonical 위임 상태 조회 ────────────────────────────────────────────

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

let apiV2DelegationClientFactory: () => DataStoreClient = createCanonicalDataStoreClient;

export function __setApiV2DelegationClientFactoryForTests(
  factory: (() => DataStoreClient) | null,
): void {
  apiV2DelegationClientFactory = factory ?? createCanonicalDataStoreClient;
}

/**
 * GMX API v2의 canonical DataStore + SubaccountGelatoRelayRouter 계약으로
 * delegated authorization을 조회한다.
 *
 * 중요: SubaccountRouter.subaccounts()는 legacy direct-router 세대의 상태다.
 * API v2 submit path가 그 값을 요구하면 올바른 Owner Approval도 거부하므로,
 * 이 readback은 반드시 API v2 manifest와 DataStore 키 계약만 사용한다.
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
    const relay = resolveGmxLiveRelayConfig();
    if (!relay.ok || !relay.config) {
      return {
        ...base,
        queryError: '[GMXSubaccount] GMX API v2 relay config unavailable — fail-closed',
      };
    }

    const manifest = validateEnvAgainstManifest(process.env);
    if (!manifest.ok) {
      return {
        ...base,
        queryError: '[GMXSubaccount] GMX API v2 relay manifest mismatch — fail-closed',
      };
    }

    const result = await readSubaccountAuthorization({
      client: apiV2DelegationClientFactory(),
      dataStore: relay.config.dataStore as `0x${string}`,
      relayRouter: relay.config.subaccountGelatoRelayRouter as `0x${string}`,
      account: mainAddress as `0x${string}`,
      subaccount: signerAddress as `0x${string}`,
    });
    if (!result.ok) return { ...base, queryError: result.reason };

    const onchain = result.data;
    const remaining = Number(onchain.remaining);
    const expiresAt = Number(onchain.expiresAt);
    const nowUnix = Number(onchain.blockTimestamp ?? BigInt(Math.floor(Date.now() / 1000)));
    const isExpired = expiresAt <= nowUnix;
    const isAuth =
      onchain.isSubaccountListed
      && !onchain.featureDisabled
      && !onchain.integrationDisabled
      && remaining > 0
      && !isExpired;

    return {
      ...base,
      isAuthorized:     isAuth,
      remainingActions: remaining,
      expiresAtUnix:    expiresAt,
      isExpired,
      queryOk:          true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error && err.message.startsWith('[GMXSubaccount]')
      ? err.message
      : '[GMXSubaccount] GMX API v2 canonical readback unavailable — fail-closed';
    console.error('[GMXSubaccount] checkDelegationStatus 실패:', msg);
    return { ...base, queryError: msg };
  }
}

// ── Legacy direct-router MetaMask 트랜잭션 빌더 ─────────────────────────────────
// API v2 Owner Approval과 혼용 금지. 기존 명시적 operator 경로 호환을 위해
// 남겨 두되, audited legacy env가 없으면 계속 fail-closed한다.

export interface UnsignedTx {
  to:    string;
  data:  string;
  value: string; // hex wei
}

/**
 * MetaMask에서 실행할 USDC approve 트랜잭션 빌드.
 * 메인 지갑이 canonical SubaccountRouter에게 USDC 사용 권한 부여.
 * amount: USDC wei (6 decimals). 기본값: 15 USDC (하드캡).
 */
export function buildUsdcApproveTx(amount: bigint = 15_000_000n): UnsignedTx {
  const routerAddress = getCanonicalSubaccountRouterAddress();
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
  const routerAddress = getCanonicalSubaccountRouterAddress();
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
  const routerAddress = getCanonicalSubaccountRouterAddress();
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
    const routerAddress = getCanonicalSubaccountRouterAddress();
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
 * 이 generic helper는 caller가 전달한 spender를 조회하며 authorization builder가 아니다.
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
 * canonical 주소로 view 호출을 시도하고 결과 형태를 확인.
 * 서버 시작 시 한 번 호출.
 */
export async function verifySubaccountRouter(): Promise<{ ok: boolean; error?: string }> {
  try {
    const routerAddress = getCanonicalSubaccountRouterAddress();
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
