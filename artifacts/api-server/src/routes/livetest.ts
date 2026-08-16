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
import { getSignerAddress, getSignerEthBalance, isSignerInitialized, getSignerCreatedAt } from '../lib/delegatedSigner';
import { checkDelegationStatus, buildAddSubaccountTx, buildUsdcApproveTx, buildRemoveSubaccountTx, getUsdcAllowance } from '../lib/gmxSubaccount';
import { checkLiveTestGate, isLiveTestExecutionLocked, LIVE_TEST_CAPS, delegationTimeRemainingSeconds } from '../lib/liveTestGate';
import { USDC_ADDRESS } from '../lib/gmxContracts';
import {
  getAuditLog,
  setEmergencyStop,
  isEmergencyStopActive,
  isReconciled,
} from '../workers/liveTestExecutor';

const router = Router();

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
