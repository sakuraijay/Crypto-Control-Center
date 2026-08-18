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
import { getSignerAddress, getSignerEthBalance, isSignerInitialized, getSignerCreatedAt, isDelegatedSignerEnabled, provisionDelegatedSigner, getStoredPublicSignerAddress } from '../lib/delegatedSigner';
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
import { checkDelegationStatus, buildAddSubaccountTx, buildUsdcApproveTx, buildRemoveSubaccountTx, getUsdcAllowance, getUsdcAllowanceForSpender } from '../lib/gmxSubaccount';
import { buildCanaryAllowanceInfo, resolveSdkSyntheticsRouter, isExpectedCanarySigner, EXPECTED_CANARY_SIGNER } from '../lib/canaryAllowanceInfo';
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

// ── POST /executor/signer/provision ──────────────────────────────────────────
// Canary P0 — 활성화 데드락 해소: LIVE 잠금을 풀지 않고 signer만 명시적 1회
// 생성/조회한다 (운영자 PIN + application/json 필수 — requireOperatorAuth).
// 이 API는 서명·prepare/submit POST·Owner Approval·nonce/task/intent 생성·
// DB 거래행 생성·자금 이동을 절대 수행하지 않는다. 외부 네트워크 호출 0회.
// 응답에는 공개주소만 포함된다 (개인키·암호문·PIN·Secret 절대 금지).
router.post('/executor/signer/provision', requireOperatorAuth, async (_req, res) => {
  try {
    if (isEmergencyStopActive()) {
      return res.status(409).json({ ok: false, error: 'Emergency Stop 활성 — 프로비저닝 차단 (fail-closed)' });
    }
    const result = await provisionDelegatedSigner();
    return res.json({
      ok: true,
      created: result.created,
      signerAddress: result.address,
      createdAt: result.createdAt,
      liveExecutionLocked: isLiveTestExecutionLocked(),
      notice: 'LIVE 실행은 여전히 잠겨 있습니다 — 이 작업은 signer 키 생성/조회만 수행했으며 서명·주문·자금 이동은 일어나지 않았습니다.',
    });
  } catch (e: unknown) {
    // delegatedSigner의 고정 fail-closed 문구만 노출 (DB 원문 오류·Secret 미포함)
    const msg = e instanceof Error && e.message.startsWith('[DelegatedSigner]')
      ? e.message
      : '프로비저닝 실패 (fail-closed)';
    return res.status(409).json({ ok: false, error: msg });
  }
});

// ── GET /executor/signer ────────────────────────────────────────────────────────
// 서버 사이너 주소 + 잔고 정보. 개인키 절대 미포함.
router.get('/executor/signer', async (_req, res) => {
  try {
    // #125 — 런타임 주소 우선, 없으면 저장된 공개 주소(검증됨) 표시 (복호화 0회)
    const resolved  = await resolveApprovalSignerAddress();
    const address   = resolved.address;
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
      addressSource: resolved.source,                 // 'runtime' | 'stored_public' | null
      privateKeyDecrypted: initialized,               // stored_public 경로에서는 false
      orderSubmissionEnabled: process.env.GMX_API_ORDER_SUBMISSION_ENABLED === 'true',
      createdAt,
      ethFormatted:  ethBalance.ethFormatted,
      // #124-A — GMX API v2 경로에서 signer는 broadcast하지 않으므로 gas 불필요 (0 ETH)
      readyForGas:   true,
      signerGasModel: 'GMX_API_V2_ZERO_ETH',
      fundingNote:  address
        ? 'GMX API v2 signer gas: 0 ETH — delegated signer에 ETH를 전송할 필요가 없습니다 (EIP-712 서명만 수행, broadcast 없음).'
        : '사이너 주소를 확인할 수 없습니다 — 프로비저닝(서명키 준비) 1회가 필요합니다.',
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── #125 — Owner Approval용 signer 공개 주소 resolver ──────────────────────────
// 런타임 초기화 주소(강한 게이트 통과 시)가 있으면 그대로, 없으면 DB에 저장된
// 공개 주소를 EXPECTED_CANARY_SIGNER와 결속 검증해 사용한다 (복호화·서명 0회).
// PAPER + LIVE 잠금 상태에서도 Owner Approval prepare/canonical readback이
// 가능해지지만, 실제 delegated 서명 경로(개인키 접근)는 기존 강한 게이트 그대로다.
type ApprovalSignerResolution =
  | { address: string; source: 'runtime' | 'stored_public' }
  | { address: null; source: null; reason: string };

async function resolveApprovalSignerAddress(): Promise<ApprovalSignerResolution> {
  const runtime = getSignerAddress();
  if (isSignerInitialized() && runtime) return { address: runtime, source: 'runtime' };
  const stored = await getStoredPublicSignerAddress(EXPECTED_CANARY_SIGNER);
  if (stored.ok) return { address: stored.address, source: 'stored_public' };
  return { address: null, source: null, reason: stored.reason };
}

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
    // #125 — 런타임 주소 우선, 없으면 저장된 공개 주소(검증됨)로 canonical readback 허용
    const signerRes = await resolveApprovalSignerAddress();
    const signerAddress = signerRes.address;
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
      // #125 — 저장된 공개 주소로도 canonical 판정 가능 (readback은 eth_call만).
      // 실제 서명 능력(isSignerInitialized)은 LIVE 게이트에서 별도 검증된다.
      signerInitialized:      signerAddress !== null,
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
      // #125 — 주소 출처·보안 상태 명시 (UI 표시용)
      signerAddressSource: signerRes.source,             // 'runtime' | 'stored_public' | null
      privateKeyDecrypted: isSignerInitialized(),        // stored_public 경로에서는 항상 false
      orderSubmissionEnabled: process.env.GMX_API_ORDER_SUBMISSION_ENABLED === 'true',
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
      // #125 리뷰 지적 — authEligible(순수 canonical 판정)과 liveEligible(실제 서명 능력 포함)을 구분.
      // stored_public 경로는 서명 능력이 없으므로 canonical이 AUTHORIZED여도 LIVE 부적격.
      authEligible: isAuthStateLiveEligible(state),
      liveEligible: isAuthStateLiveEligible(state) && isSignerInitialized(),
      liveBlockedReason: !isAuthStateLiveEligible(state)
        ? `인증 상태 ${state} — LIVE 실행 차단`
        : !isSignerInitialized()
          ? '런타임 signer 미초기화(공개 주소 경로) — 서명 능력 없음, LIVE 실행 차단'
          : null,
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
    // #125 — 런타임 미초기화(PAPER·LIVE 잠금)여도 저장된 공개 주소로 prepare 가능.
    // 공개 주소 경로는 복호화·서명·nonce/task/intent 생성·외부 호출 0회 (fail-closed).
    const signerRes = await resolveApprovalSignerAddress();
    if (signerRes.address === null) {
      return res.status(503).json({ ok: false, error: `delegated signer 주소 확인 불가 — prepare 불가: ${signerRes.reason}` });
    }
    const signerAddress = signerRes.address;
    // #124-C — 서버 측 강제: 구성된 signer가 canary 예상 주소와 정확 일치할 때만 prepare 허용.
    // (UI 게이트는 방어층일 뿐 보안 통제가 아님 — 직접 API 호출 우회 차단)
    if (!isExpectedCanarySigner(signerAddress)) {
      return res.status(409).json({
        ok: false,
        error: `구성된 signer가 canary 예상 주소(${EXPECTED_CANARY_SIGNER})와 일치하지 않습니다 — prepare 차단 (fail-closed)`,
      });
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

    // canonical 강제 — 클라이언트 body의 expirySeconds/maxAllowedCount는 신뢰하지 않는다.
    // maxAllowedCount=8(감사 예산 6 + 비상 2), expiry=최대 1시간, deadline=10분 고정.
    const expiry = APPROVAL_LIMITS.DEFAULT_EXPIRY_SECONDS;
    const maxCount = Number(APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT);
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
      // #124-A — GMX API v2 경로에서 signer gas는 0 ETH (EIP-712 서명만, broadcast 없음)
      signerReadyForGas:     true,
      signerGasModel:        'GMX_API_V2_ZERO_ETH',
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
        // #124-A — GMX API v2 제출 경로에서는 signer가 broadcast하지 않으므로 gas 불필요 (0 ETH)
        signerHasGas:                true,
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
      // #124-A — signer ETH 충전 단계 제거: GMX API v2 경로에서 signer는 EIP-712 서명만
      // 수행하고 온체인 broadcast를 하지 않으므로 signer gas는 0 ETH.
    ];

    return res.json({
      ok:           true,
      signerAddress,
      hardCaps:     LIVE_TEST_CAPS,
      txs,
      signerGasModel: 'GMX_API_V2_ZERO_ETH', // GMX API v2 signer gas: 0 ETH
      postSetupSteps: [
        '위 단계 완료 후 Replit Secrets에 LIVE_TEST_EXECUTION_LOCKED=false 설정',
        'WORKER_ENGINE_MODE=LIVE 확인',
        '/executor/livetest/status에서 모든 체크리스트 통과 확인',
      ],
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── GET /executor/allowance/canary ───────────────────────────────────────────
// Controlled Canary USDC allowance 카드용 authoritative 파라미터 (#124-B).
// pinned SDK(SyntheticsRouter)·canonical USDC 교차검증 통과 시에만 verified=true.
// 서버는 approve 트랜잭션을 생성·서명·제출하지 않는다 (read-only).
router.get('/executor/allowance/canary', async (_req, res) => {
  try {
    const mainAddress = getConfiguredMainAccount();
    const sdkRouter = resolveSdkSyntheticsRouter();
    let allowanceUnits: bigint | null = null;
    if (mainAddress && sdkRouter) {
      allowanceUnits = await getUsdcAllowanceForSpender(mainAddress, sdkRouter);
    }
    const info = buildCanaryAllowanceInfo({
      sdkRouter,
      usdcAddress: USDC_ADDRESS,
      mainAddress: mainAddress || null,
      allowanceUnits,
    });
    return res.json({ ok: true, ...info });
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
