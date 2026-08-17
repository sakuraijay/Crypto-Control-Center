/**
 * LIVE TEST Routes — 사이너 관리, 게이트 상태, 비상정지
 *
 * GET  /executor/signer              — 서버 사이너 주소 + ETH 잔고
 * GET  /executor/livetest/status     — 전체 게이트 상태 조회
 * GET  /executor/livetest/setup-txs  — MetaMask 설정 트랜잭션 (서명 전 확인용)
 * GET  /executor/livetest/revoke-tx  — MetaMask 권한 철회 트랜잭션
 * POST /executor/emergency-stop      — 비상정지 + 로그
 * GET  /executor/livetest/audit-log  — 주문 감사로그 조회
 */

import { Router } from 'express';
import { getSignerAddress, getSignerEthBalance, isSignerInitialized, getSignerCreatedAt, isDelegatedSignerEnabled } from '../lib/delegatedSigner';
import { resolveGmxLiveRelayConfig, ARBITRUM_ONE_CHAIN_ID } from '../lib/gmxLiveConfig';
import { deriveSubaccountAuthState, isAuthStateLiveEligible, type SubaccountAuthState } from '../lib/subaccountAuthState';
import { readSubaccountAuthorization, RELAY_ROUTER_NONCE_ABI, type SubaccountAuthOnchain, type DataStoreClient } from '../lib/gmxDataStore';
import { createCanonicalDataStoreClient } from '../lib/gmxCanonicalClient';
import { requireOperatorAuth } from '../lib/operatorAuthGuard';
import { sanitizeRpcError } from '../lib/rpcErrorSanitize';
import {
  prepareApprovalSession,
  submitApprovalSignature,
  getActiveReadySession,
  getConfiguredMainAccount,
  APPROVAL_LIMITS,
} from '../lib/ownerApprovalSession';
import type { Address, Hex } from 'viem';
import { checkDelegationStatus, buildAddSubaccountTx, buildUsdcApproveTx, buildRemoveSubaccountTx, getUsdcAllowance } from '../lib/gmxSubaccount';
import { checkLiveTestGate, isLiveTestExecutionLocked, LIVE_TEST_CAPS, delegationTimeRemainingSeconds } from '../lib/liveTestGate';
import { USDC_ADDRESS } from '../lib/gmxContracts';
import {
  getAuditLog,
  setEmergencyStop,
  isEmergencyStopActive,
  isReconciled,
} from '../workers/liveTestExecutor';
import { createGmxApiTransport, type GmxApiTransport } from '../lib/gmxApiTransport';
import { validateGmxPreparedApproval } from '../lib/gmxApiApproval';

const router = Router();

// 6G-1 §5 — 공식 GMX API transport (approval prepare 전용, readonly). 테스트 주입 지원.
let injectedGmxApiTransport: GmxApiTransport | null = null;
export function __setGmxApiTransportForTests(t: GmxApiTransport | null): void {
  injectedGmxApiTransport = t;
}
function getGmxApiTransportForApproval(): GmxApiTransport {
  return injectedGmxApiTransport ?? createGmxApiTransport(process.env);
}

// ── GET /executor/signer ────────────────────────────────────────────────────────
// 서버 사이너 주소 + 잔고 정보. 개인키 절대 미포함.
router.get('/executor/signer', async (_req, res) => {
  try {
    const address   = getSignerAddress();
    const createdAt = getSignerCreatedAt();
    const initialized = isSignerInitialized();
    const rpcUrl    = process.env.GMX_RPC_URL ?? '';

    let ethBalance = { ethWei: 0n, ethFormatted: '0', readyForGas: false };
    if (initialized && rpcUrl) {
      try { ethBalance = await getSignerEthBalance(rpcUrl); } catch { /* non-fatal */ }
    }

    return res.json({
      ok:           true,
      initialized,
      address,
      createdAt,
      ethFormatted:  ethBalance.ethFormatted,
      readyForGas:   ethBalance.readyForGas,
      // 사이너에게 자금 보내는 방법 안내 (주소만 제공, 개인키 절대 미포함)
      fundingNote:  initialized && address
        ? `0.02 ETH 이상을 ${address} 주소로 전송하면 주문 실행 가능합니다.`
        : '사이너가 초기화되지 않았습니다.',
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── subaccount-auth 공통 헬퍼 ───────────────────────────────────────────────────

// 테스트 주입 지점 — 실제 RPC 클라이언트 대신 mock 주입 가능
let _canonicalClientFactory: () => DataStoreClient = createCanonicalDataStoreClient;
export function __setCanonicalClientFactoryForTests(f: (() => DataStoreClient) | null): void {
  _canonicalClientFactory = f ?? createCanonicalDataStoreClient;
}

interface CanonicalReadOutcome {
  onchain: SubaccountAuthOnchain | null;
  onchainError: string | null;
}

async function readCanonicalAuth(params: {
  relayRouter: Address; dataStore: Address; account: Address; subaccount: Address;
}): Promise<CanonicalReadOutcome> {
  let client: DataStoreClient;
  try {
    client = _canonicalClientFactory();
  } catch (e: unknown) {
    return { onchain: null, onchainError: (e as Error).message };
  }
  const result = await readSubaccountAuthorization({
    client,
    dataStore: params.dataStore,
    relayRouter: params.relayRouter,
    account: params.account,
    subaccount: params.subaccount,
  });
  if (!result.ok) return { onchain: null, onchainError: result.reason };
  return { onchain: result.data, onchainError: null };
}

async function readCanonicalNonce(relayRouter: Address, account: Address): Promise<bigint> {
  const client = _canonicalClientFactory();
  const nonce = await client.readContract({
    address: relayRouter, abi: RELAY_ROUTER_NONCE_ABI,
    functionName: 'subaccountApprovalNonces', args: [account],
  });
  if (typeof nonce !== 'bigint') throw new Error('router nonce 디코딩 실패 — fail-closed');
  return nonce;
}

// ── GET /executor/subaccount-auth ───────────────────────────────────────────────
// 최신 delegated trading 인증 상태 (read-only, canonical 온체인 조회 연결 — 2단계).
// 노출 범위: 상태 enum, signer 공개 주소, chainId, 구성 결함 사유, LIVE 차단 사유,
// 온체인 요약(expiresAt/max/used/remaining/nonce/integrationId/disabled 플래그),
// READY 세션 요약. 절대 미노출: 개인키·키 암호문·서명 전문·RPC URL·env 원문.
// 이 단계에서도 중앙 LIVE 게이트는 이 상태로 통과시키지 않는다.
router.get('/executor/subaccount-auth', async (_req, res) => {
  try {
    const relay = resolveGmxLiveRelayConfig();
    const mainAccount = getConfiguredMainAccount();
    const signerAddress = getSignerAddress();
    const nowSec = BigInt(Math.floor(Date.now() / 1000));

    // canonical 조회는 구성·주소가 전부 준비된 경우에만 시도 (그 외 UNVERIFIED)
    let canonical: CanonicalReadOutcome = { onchain: null, onchainError: null };
    if (relay.ok && relay.config && mainAccount && signerAddress) {
      canonical = await readCanonicalAuth({
        relayRouter: relay.config.subaccountGelatoRelayRouter as Address,
        dataStore: relay.config.dataStore as Address,
        account: mainAccount,
        subaccount: signerAddress as Address,
      });
    }

    const state: SubaccountAuthState = deriveSubaccountAuthState({
      relayConfigured:        relay.ok,
      signerInitialized:      isSignerInitialized(),
      delegatedSignerEnabled: isDelegatedSignerEnabled(),
      onchain:                canonical.onchain,
      onchainError:           canonical.onchainError,
      nowSec,
    });

    // READY 세션 조회 — canonical nonce와 불일치 시 내부에서 즉시 무효화됨.
    // canonical 미확인이면 nonce 판단 보류(null).
    const readySession = await getActiveReadySession({
      expectedOwner: mainAccount,
      expectedSubaccount: (signerAddress as Address | null),
      canonicalNonce: canonical.onchain ? canonical.onchain.approvalNonce : null,
    });

    // 상태 표시 규칙: 서명만 저장된 경우(canonical 미등록) OWNER_SIGNATURE_READY 노출.
    // AUTHORIZED는 canonical 확인으로만 도달 — 세션 존재가 상태를 승격시키지 않는다.
    const displayState =
      state === 'OWNER_SIGNATURE_REQUIRED' && readySession ? 'OWNER_SIGNATURE_READY' : state;

    const oc = canonical.onchain;
    return res.json({
      ok: true,
      state,                 // 순수 canonical 판정 상태 (LIVE 게이트 판단 기준)
      displayState,          // UI 표시용 (READY 세션 반영)
      chainId: ARBITRUM_ONE_CHAIN_ID,
      mainAccount,
      signerAddress,
      relayRouter: relay.ok && relay.config ? relay.config.subaccountGelatoRelayRouter : null,
      relayConfigured: relay.ok,
      configReasons: relay.ok ? [] : relay.reasons,
      onchain: oc ? {
        isSubaccountListed: oc.isSubaccountListed,
        expiresAt: oc.expiresAt.toString(),
        maxAllowedCount: oc.maxAllowedCount.toString(),
        usedCount: oc.usedCount.toString(),
        remaining: oc.remaining.toString(),
        integrationId: oc.integrationId,
        approvalNonce: oc.approvalNonce.toString(),
        featureDisabled: oc.featureDisabled,
        integrationDisabled: oc.integrationDisabled,
        blockTimestamp: oc.blockTimestamp !== null ? oc.blockTimestamp.toString() : null,
      } : null,
      onchainError: canonical.onchainError,
      expiresAt: oc ? oc.expiresAt.toString() : null,
      remainingActions: oc ? oc.remaining.toString() : null,
      readySession,          // 서명·암호문 절대 미포함 (요약만)
      liveEligible: isAuthStateLiveEligible(state),
      liveBlockedReason: isAuthStateLiveEligible(state) ? null : `인증 상태 ${state} — LIVE 실행 차단`,
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── POST /executor/subaccount-approval/prepare ─────────────────────────────────
// MetaMask owner approval typed data 준비 (운영자 인증 필수).
// 서버가 canonical router nonce를 직접 읽어 typed data를 생성한다.
// actionType·chainId·router·integrationId는 서버 고정 — 사용자 수정 불가.
// 실패 시 LIVE 관련 상태는 어떤 것도 변경되지 않는다 (fail-closed).
router.post('/executor/subaccount-approval/prepare', requireOperatorAuth, async (req, res) => {
  try {
    const relay = resolveGmxLiveRelayConfig();
    if (!relay.ok || !relay.config) {
      return res.status(503).json({ ok: false, error: 'relay 구성 미완비 — prepare 불가', reasons: relay.ok ? [] : relay.reasons });
    }
    const mainAccount = getConfiguredMainAccount();
    if (!mainAccount) {
      return res.status(503).json({ ok: false, error: 'GMX_WALLET_ADDRESS 미설정 — main account 확인 불가' });
    }
    const signerAddress = getSignerAddress();
    if (!isSignerInitialized() || !signerAddress) {
      return res.status(503).json({ ok: false, error: 'delegated signer 미초기화 — prepare 불가' });
    }

    // 요청 지갑 주소는 GMX_WALLET_ADDRESS와 정확히 일치해야 함
    const requestedWallet = typeof req.body?.walletAddress === 'string' ? req.body.walletAddress : '';
    if (requestedWallet.toLowerCase() !== mainAccount.toLowerCase()) {
      return res.status(403).json({ ok: false, error: '연결된 지갑이 구성된 main wallet(GMX_WALLET_ADDRESS)과 일치하지 않습니다' });
    }

    let canonicalNonce: bigint;
    try {
      canonicalNonce = await readCanonicalNonce(relay.config.subaccountGelatoRelayRouter as Address, mainAccount);
    } catch (e: unknown) {
      // RPC 예외에는 endpoint URL(토큰 포함 가능)이 담길 수 있음 — sanitize 필수
      return res.status(502).json({ ok: false, error: `canonical nonce 조회 실패 — prepare 중단: ${sanitizeRpcError(e)}` });
    }

    const expiry = typeof req.body?.expirySeconds === 'number' ? req.body.expirySeconds : undefined;
    const maxCount = typeof req.body?.maxAllowedCount === 'number' ? req.body.maxAllowedCount : undefined;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));

    // 6G-1 §5 — 공식 GMX API prepareSubaccountApproval이 권위 원천.
    // readonly transport 비활성/호출 실패/검증 실패 = prepare 0회 (fail-closed).
    const gmxApi = getGmxApiTransportForApproval();
    if (!gmxApi.readonlyEnabled) {
      return res.status(503).json({ ok: false, error: "GMX_API_READONLY_ENABLED !== 'true' — GMX API prepare 불가 (fail-closed)" });
    }
    const apiRes = await gmxApi.postJson('/subaccounts/approval/prepare', {
      chainId: ARBITRUM_ONE_CHAIN_ID,
      account: mainAccount,
      subaccount: signerAddress,
      ...(expiry !== undefined ? { expirySeconds: expiry } : {}),
      ...(maxCount !== undefined ? { maxAllowedCount: maxCount } : {}),
    }, 'readonly');
    if (!apiRes.ok) {
      return res.status(502).json({ ok: false, error: `GMX API approval prepare 실패(${apiRes.kind}) — 세션 생성 0회` });
    }
    const validated = validateGmxPreparedApproval({
      raw: apiRes.data,
      expected: {
        mainAccount,
        subaccount: signerAddress as Address,
        verifyingContract: relay.config.subaccountGelatoRelayRouter as Address,
        canonicalNonce,
        nowSec,
      },
    });
    if (!validated.ok) {
      return res.status(422).json({ ok: false, error: 'GMX API approval 검증 실패 — 세션 생성 0회', reasons: validated.reasons });
    }

    const result = await prepareApprovalSession({
      mainAccount,
      subaccount: signerAddress as Address,
      verifyingContract: relay.config.subaccountGelatoRelayRouter as Address,
      canonicalNonce,
      nowSec,
      externalMessage: validated.message,
    });
    if (!result.ok) return res.status(500).json({ ok: false, error: result.reason });

    return res.json({
      ok: true,
      sessionId: result.prepared.sessionId,
      typedData: JSON.parse(JSON.stringify(result.prepared.typedData, (_k, v) => typeof v === 'bigint' ? v.toString() : v)),
      summary: result.prepared.summary,
      limits: {
        expirySecondsMin: APPROVAL_LIMITS.MIN_EXPIRY_SECONDS,
        expirySecondsMax: APPROVAL_LIMITS.MAX_EXPIRY_SECONDS,
        maxAllowedCountMin: APPROVAL_LIMITS.MIN_MAX_ALLOWED_COUNT.toString(),
        maxAllowedCountMax: APPROVAL_LIMITS.MAX_MAX_ALLOWED_COUNT.toString(),
      },
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── POST /executor/subaccount-approval/signature ───────────────────────────────
// MetaMask 서명 제출 (운영자 인증 필수). 서버가 typed data를 재구성해 검증하며
// 클라이언트 digest는 신뢰하지 않는다. 성공 시 OWNER_SIGNATURE_READY까지만 —
// LIVE 잠금 해제·Gelato 제출은 절대 하지 않는다. 응답에 서명·암호문 미포함.
router.post('/executor/subaccount-approval/signature', requireOperatorAuth, async (req, res) => {
  try {
    const relay = resolveGmxLiveRelayConfig();
    if (!relay.ok || !relay.config) {
      return res.status(503).json({ ok: false, error: 'relay 구성 미완비 — 서명 제출 불가' });
    }
    const mainAccount = getConfiguredMainAccount();
    if (!mainAccount) {
      return res.status(503).json({ ok: false, error: 'GMX_WALLET_ADDRESS 미설정 — 서명 검증 불가' });
    }
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    const signature = typeof req.body?.signature === 'string' ? req.body.signature : '';
    if (!sessionId || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return res.status(400).json({ ok: false, error: 'sessionId와 65-byte hex signature가 필요합니다' });
    }

    let canonicalNonce: bigint;
    try {
      canonicalNonce = await readCanonicalNonce(relay.config.subaccountGelatoRelayRouter as Address, mainAccount);
    } catch (e: unknown) {
      return res.status(502).json({ ok: false, error: `canonical nonce 조회 실패 — 서명 저장 중단: ${sanitizeRpcError(e)}` });
    }

    const result = await submitApprovalSignature({
      sessionId,
      signature: signature as Hex,
      canonicalNonce,
      expectedOwner: mainAccount,
      nowSec: BigInt(Math.floor(Date.now() / 1000)),
    });
    if (!result.ok) return res.status(422).json({ ok: false, error: result.reason });

    return res.json({
      ok: true,
      sessionId: result.sessionId,
      status: result.status,   // OWNER_SIGNATURE_READY — AUTHORIZED 아님
      note: '서명이 안전하게 저장되었습니다. AUTHORIZED 상태는 온체인 등록 확인 후에만 표시됩니다. LIVE 실행 잠금은 변경되지 않았습니다.',
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── GET /executor/livetest/status ────────────────────────────────────────────────
// 모든 게이트 상태 전체 조회
router.get('/executor/livetest/status', async (req, res) => {
  try {
    const mainAddress   = process.env.GMX_WALLET_ADDRESS ?? '';
    const signerAddress = getSignerAddress();
    const rpcUrl        = process.env.GMX_RPC_URL ?? '';

    const executionLocked = isLiveTestExecutionLocked();
    const emergencyStop   = isEmergencyStopActive();
    const reconciled      = isReconciled();

    let delegation = null;
    let ethBalance = { ethWei: 0n, ethFormatted: '0', readyForGas: false };
    let usdcAllowance = '0';
    let timeRemaining = 0;

    if (signerAddress && mainAddress && rpcUrl) {
      try {
        [delegation, ethBalance] = await Promise.all([
          checkDelegationStatus(mainAddress, signerAddress),
          getSignerEthBalance(rpcUrl),
        ]);
        usdcAllowance = (await getUsdcAllowance(mainAddress)).toString();
        if (delegation) timeRemaining = delegationTimeRemainingSeconds(delegation);
      } catch { /* non-fatal */ }
    }

    const subaccountRouterConfigured = Boolean(process.env.GMX_SUBACCOUNT_ROUTER_ADDRESS?.trim());
    const orderVaultConfigured       = Boolean(process.env.GMX_ORDER_VAULT_ADDRESS?.trim());

    return res.json({
      ok:                    true,
      executionLocked,
      emergencyStop,
      reconciled,
      signerInitialized:     isSignerInitialized(),
      signerAddress,
      mainAddress:           mainAddress || null,
      signerEth:             ethBalance.ethFormatted,
      signerReadyForGas:     ethBalance.readyForGas,
      usdcAllowanceWei:      usdcAllowance,
      usdcApproved:          BigInt(usdcAllowance) >= 15_000_000n, // ≥ 15 USDC
      delegation,
      delegationTimeRemainingSeconds: timeRemaining,
      subaccountRouterConfigured,
      orderVaultConfigured,
      hardCaps:              LIVE_TEST_CAPS,
      // 준비 체크리스트
      readyChecklist: {
        signerInitialized:           isSignerInitialized(),
        mainAddressConfigured:       Boolean(mainAddress),
        rpcConfigured:               Boolean(rpcUrl),
        subaccountRouterConfigured,
        orderVaultConfigured,
        executionUnlocked:           !executionLocked,
        signerHasGas:                ethBalance.readyForGas,
        usdcApproved:                BigInt(usdcAllowance) >= 15_000_000n,
        delegationActive:            delegation?.isAuthorized ?? false,
        noEmergencyStop:             !emergencyStop,
        reconciled,
      },
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── GET /executor/livetest/setup-txs ─────────────────────────────────────────
// MetaMask에서 순서대로 실행할 설정 트랜잭션 반환 (미서명 데이터만 — 절대 서버가 서명 안 함)
router.get('/executor/livetest/setup-txs', (req, res) => {
  try {
    const signerAddress = getSignerAddress();
    if (!signerAddress) {
      return res.status(503).json({ ok: false, error: '사이너 미초기화. 서버 재시작 후 재시도하세요.' });
    }

    const maxActions = LIVE_TEST_CAPS.maxActions;
    const validHours = LIVE_TEST_CAPS.validHours;

    // 메인 지갑이 순서대로 MetaMask로 실행해야 할 트랜잭션
    const txs = [
      {
        step:        1,
        description: `USDC approve — SubaccountRouter에게 15 USDC 사용 권한 부여`,
        tx:          buildUsdcApproveTx(15_000_000n), // 15 USDC (6 decimals)
        note:        `USDC contract(${USDC_ADDRESS})를 호출합니다. MetaMask에서 "Approve" 확인.`,
      },
      {
        step:        2,
        description: `addSubaccount — 서버 사이너(${signerAddress})를 서브계정으로 승인`,
        tx:          buildAddSubaccountTx(signerAddress, maxActions, validHours),
        note:        `SubaccountRouter를 호출합니다. 유효기간: ${validHours}시간, 허용액션: ${maxActions}회. MetaMask에서 확인.`,
      },
      {
        step:        3,
        description: `ETH 전송 — 사이너 지갑에 가스비 충전`,
        tx: {
          to:    signerAddress,
          data:  '0x',
          value: '0x' + (20_000_000_000_000_000n).toString(16), // 0.02 ETH
        },
        note:        `${signerAddress}로 0.02 ETH 이상을 전송하세요 (가스 + 실행 수수료).`,
      },
    ];

    return res.json({
      ok:           true,
      signerAddress,
      hardCaps:     LIVE_TEST_CAPS,
      txs,
      postSetupSteps: [
        '위 3단계 완료 후 Replit Secrets에 LIVE_TEST_EXECUTION_LOCKED=false 설정',
        'WORKER_ENGINE_MODE=LIVE 확인',
        '/executor/livetest/status에서 모든 체크리스트 통과 확인',
      ],
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── GET /executor/livetest/revoke-tx ─────────────────────────────────────────
// 권한 철회 트랜잭션 (MetaMask로 실행 — 메인 지갑 서명 필요)
router.get('/executor/livetest/revoke-tx', (req, res) => {
  try {
    const signerAddress = getSignerAddress();
    if (!signerAddress) return res.status(503).json({ ok: false, error: '사이너 미초기화' });
    const tx = buildRemoveSubaccountTx(signerAddress);
    return res.json({
      ok:          true,
      signerAddress,
      tx,
      note:        '이 트랜잭션을 MetaMask에서 실행하면 서버 사이너 권한이 즉시 철회됩니다.',
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── POST /executor/emergency-stop ─────────────────────────────────────────────
// 비상정지: 모든 신규 주문 차단 + 로그
router.post('/executor/emergency-stop', async (req, res) => {
  const body   = req.body as Record<string, unknown>;
  const reason = typeof body.reason === 'string' ? body.reason : '운영자 수동 비상정지';
  try {
    await setEmergencyStop(reason);
    console.error(`[LiveTest] ⚠️  Emergency Stop — reason: ${reason}`);
    return res.json({
      ok:      true,
      message: '비상정지 활성화. 모든 신규 LIVE TEST 주문 차단됨.',
      note:    `권한 철회: GET /executor/livetest/revoke-tx 트랜잭션을 MetaMask에서 실행하세요.`,
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── GET /executor/livetest/audit-log ─────────────────────────────────────────
router.get('/executor/livetest/audit-log', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const log   = await getAuditLog(limit);
    return res.json({ ok: true, count: log.length, entries: log });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

export default router;
