/**
 * Relay Routes — GMX delegated trading 3단계 (Gelato relay DRY-RUN 경로).
 *
 * GET  /executor/relay/status            — 모드·게이트·quote·task·revoke 상태
 * POST /executor/relay/dry-run           — OPEN/CLOSE dry-run (운영자 인증)
 * POST /executor/relay/revoke/prepare    — removeSubaccount owner 서명 준비 (운영자 인증)
 * POST /executor/relay/revoke/signature  — owner 서명 제출 (운영자 인증)
 * POST /executor/relay/revoke/cancel     — revoke 세션 취소 (운영자 인증)
 * POST /executor/relay/revoke/dry-run    — REVOKE dry-run (운영자 인증)
 *
 * **이번 단계에서 어떤 경로도 외부 relay 제출을 하지 않는다.**
 * 민감정보(서명 전문·개인키·암호문·API key·RPC URL)는 응답·로그에 절대 미포함.
 */

import { Router } from 'express';
import type { Address, Hex } from 'viem';
import { requireOperatorAuth } from '../lib/operatorAuthGuard';
import { resolveRelayMode, evaluateRelayGate, buildDryRunResult } from '../lib/relayAdapter';
import { getMockFeeQuote, validateFeeQuote, WETH_ARBITRUM } from '../lib/relayFeeQuote';
import {
  assembleOrderRelayCall, assembleRevokeRelayCall, type AssembledRelayCall,
} from '../lib/relayOrderAssembly';
import {
  createRelayTask, safeTransition, listRecentRelayTasks, RELAY_TASK_STATUS,
} from '../lib/relayLifecycle';
import {
  prepareRevokeSession, submitRevokeSignature, getActiveRevokeSession, cancelRevokeSession,
} from '../lib/revokeSession';
import { getConfiguredMainAccount } from '../lib/ownerApprovalSession';
import { getSignerAddress, isDelegatedSignerEnabled, isSignerInitialized } from '../lib/delegatedSigner';
import { resolveGmxLiveRelayConfig } from '../lib/gmxLiveConfig';
import { isLiveTestExecutionLocked } from '../lib/liveTestGate';
import { readSubaccountAuthorization, type DataStoreClient } from '../lib/gmxDataStore';
import { createCanonicalDataStoreClient } from '../lib/gmxCanonicalClient';
import { sanitizeRpcError } from '../lib/rpcErrorSanitize';
import { keccak256, toHex } from 'viem';

const router = Router();

// 테스트 주입 지점 (route 테스트에서 canonical mock 사용)
let canonicalClientFactory: () => DataStoreClient = createCanonicalDataStoreClient;
export function __setRelayCanonicalClientFactoryForTests(f: () => DataStoreClient): void {
  canonicalClientFactory = f;
}

/** mock quote 기본 파라미터 — 실제 Gelato quote 아님 (LIVE 근거 사용 금지) */
const MOCK_GAS_LIMIT = 3_000_000n;
const MOCK_GAS_PRICE = 20_000_000n; // 0.02 gwei (Arbitrum 대략적 개발용 값)

interface CanonicalCheck {
  confirmed: boolean;
  reason: string | null;
  approvalNonce: bigint | null;
  isSubaccountListed: boolean | null;
  expiresAt: string | null;
  remaining: string | null;
}

async function checkCanonical(): Promise<CanonicalCheck> {
  const cfg = resolveGmxLiveRelayConfig();
  const mainAccount = getConfiguredMainAccount();
  const signer = getSignerAddress();
  if (!cfg.ok) return { confirmed: false, reason: `relay 구성 미해결: ${cfg.reasons.join('; ')}`, approvalNonce: null, isSubaccountListed: null, expiresAt: null, remaining: null };
  if (!mainAccount) return { confirmed: false, reason: 'GMX_WALLET_ADDRESS 미설정', approvalNonce: null, isSubaccountListed: null, expiresAt: null, remaining: null };
  if (!signer) return { confirmed: false, reason: 'delegated signer 미초기화', approvalNonce: null, isSubaccountListed: null, expiresAt: null, remaining: null };
  try {
    const result = await readSubaccountAuthorization({
      client: canonicalClientFactory(),
      dataStore: cfg.config.dataStore as Address,
      relayRouter: cfg.config.subaccountGelatoRelayRouter as Address,
      account: mainAccount,
      subaccount: signer as Address,
    });
    if (!result.ok) return { confirmed: false, reason: result.reason, approvalNonce: null, isSubaccountListed: null, expiresAt: null, remaining: null };
    return {
      confirmed: true, reason: null,
      approvalNonce: result.data.approvalNonce,
      isSubaccountListed: result.data.isSubaccountListed,
      expiresAt: result.data.expiresAt.toString(),
      remaining: result.data.remaining.toString(),
    };
  } catch (e: unknown) {
    return { confirmed: false, reason: sanitizeRpcError(e), approvalNonce: null, isSubaccountListed: null, expiresAt: null, remaining: null };
  }
}

function baseGateInput(kind: 'OPEN' | 'CLOSE' | 'REVOKE', canonicalConfirmed: boolean, activeRevoke: boolean) {
  return {
    engineMode: process.env.WORKER_ENGINE_MODE ?? 'PAPER',
    liveTestLocked: isLiveTestExecutionLocked(),
    signerActive: isDelegatedSignerEnabled() && isSignerInitialized(),
    canonicalConfirmed,
    activeRevokeSession: activeRevoke,
    kind,
  };
}

// ── GET /executor/relay/status ───────────────────────────────────────────────
router.get('/executor/relay/status', requireOperatorAuth, async (_req, res) => {
  try {
    const { mode, requestedLive, reasons } = resolveRelayMode();
    const canonical = await checkCanonical();
    const revoke = await getActiveRevokeSession();
    const gate = evaluateRelayGate(mode, baseGateInput('OPEN', canonical.confirmed, !!revoke));

    const nowMs = Date.now();
    const quote = getMockFeeQuote({ gasLimit: MOCK_GAS_LIMIT, gasPrice: MOCK_GAS_PRICE, nowMs });
    const quoteCheck = validateFeeQuote({ quote, nowMs, orderNotionalUsd: null, ethPriceUsd: null });

    return res.json({
      ok: true,
      mode,
      requestedLive,                       // LIVE 요청됐어도 구조적으로 강등됨
      modeReasons: reasons,
      submissionEnabled: process.env.GMX_RELAY_SUBMISSION_ENABLED === 'true',
      liveStructurallyDisabled: true,      // 이번 단계 상수
      gate: { allowed: gate.allowed, blockReasons: gate.blockReasons },
      canonical: {
        confirmed: canonical.confirmed,
        reason: canonical.reason,
        approvalNonce: canonical.approvalNonce?.toString() ?? null,
        isSubaccountListed: canonical.isSubaccountListed,
        expiresAt: canonical.expiresAt,
        remaining: canonical.remaining,
      },
      feeQuote: {
        source: quote.source,
        feeToken: quote.feeToken,
        feeAmount: quote.feeAmount.toString(),
        gasLimit: quote.gasLimit.toString(),
        gasPrice: quote.gasPrice.toString(),
        quotedAtMs: quote.quotedAtMs,
        valid: quoteCheck.ok,
        invalidReason: quoteCheck.ok ? null : quoteCheck.reason,
      },
      revokeSession: revoke,               // 서명·암호문 미포함 요약
      recentTasks: await listRecentRelayTasks(20),
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

// ── POST /executor/relay/dry-run — OPEN/CLOSE ────────────────────────────────
router.post('/executor/relay/dry-run', requireOperatorAuth, async (req, res) => {
  try {
    const body = req.body ?? {};
    const kind = body.kind === 'CLOSE' ? 'CLOSE' as const : body.kind === 'OPEN' ? 'OPEN' as const : null;
    if (!kind) return res.status(400).json({ ok: false, error: "kind는 'OPEN' 또는 'CLOSE'" });

    const { mode, reasons } = resolveRelayMode();
    const canonical = await checkCanonical();
    const revoke = await getActiveRevokeSession();
    const gate = evaluateRelayGate(mode, baseGateInput(kind, canonical.confirmed, !!revoke));

    const cfg = resolveGmxLiveRelayConfig();
    const mainAccount = getConfiguredMainAccount();
    const signer = getSignerAddress();

    const nowMs = Date.now();
    const nowSec = BigInt(Math.floor(nowMs / 1000));
    const quote = getMockFeeQuote({ gasLimit: MOCK_GAS_LIMIT, gasPrice: MOCK_GAS_PRICE, nowMs });

    let assembled: AssembledRelayCall | null = null;
    let assembleError: string | undefined;
    let orderNotionalUsd: number | null = null;

    if (cfg.ok && mainAccount && signer) {
      try {
        const sizeDeltaUsd = BigInt(String(body.sizeDeltaUsd ?? '0'));       // 1e30
        const collateralDelta = BigInt(String(body.initialCollateralDeltaAmount ?? '0'));
        const acceptablePrice = BigInt(String(body.acceptablePrice ?? '0'));
        const executionFee = BigInt(String(body.executionFee ?? '0'));
        orderNotionalUsd = Number(sizeDeltaUsd / 10n ** 24n) / 1e6;          // 1e30 → USD
        assembled = assembleOrderRelayCall({
          kind,
          mainAccount,
          subaccount: signer as Address,
          relayRouter: cfg.config.subaccountGelatoRelayRouter as Address,
          order: {
            mainAccount,
            market: String(body.market ?? '') as Address,
            collateralToken: String(body.collateralToken ?? '') as Address,
            sizeDeltaUsd,
            initialCollateralDeltaAmount: collateralDelta,
            acceptablePrice,
            executionFee,
            isLong: Boolean(body.isLong),
          },
          quote,
          userNonce: nowSec,
          deadline: nowSec + 300n,
          subaccountApproval: null,       // dry-run: canonical AUTHORIZED 경로(approval 미첨부)
        });
      } catch (e: unknown) {
        assembleError = (e as Error).message;
      }
    } else {
      assembleError = !cfg.ok ? `relay 구성 미해결` : !mainAccount ? 'GMX_WALLET_ADDRESS 미설정' : 'signer 미초기화';
    }

    const ethPriceUsd = typeof body.ethPriceUsd === 'number' && body.ethPriceUsd > 0 ? body.ethPriceUsd : null;
    const result = buildDryRunResult({
      mode, kind, gate, modeReasons: reasons, assembled, assembleError,
      quote, nowMs, orderNotionalUsd, ethPriceUsd,
    });

    // durable 기록 — dry-run 결과도 relay_tasks에 남긴다 (제출은 없음)
    let taskRecord: { id: string; recorded: boolean } | null = null;
    if (assembled) {
      const idempotencyKey = `dryrun:${kind}:${assembled.packedPayloadHash}`;
      const created = await createRelayTask({
        idempotencyKey,
        kind,
        payloadHash: assembled.packedPayloadHash,
        calldataHash: assembled.calldataHash,
        feeToken: assembled.feeToken,
        feeAmount: assembled.feeAmount.toString(),
        userNonce: assembled.userNonce.toString(),
        approvalNonce: assembled.approvalNonce?.toString() ?? null,
      });
      if (created.ok) {
        if (result.ok) {
          await safeTransition({ taskId: created.taskId, to: RELAY_TASK_STATUS.DRY_RUN_VALIDATED });
        } else {
          await safeTransition({
            taskId: created.taskId, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
            patch: { errorClass: 'DRY_RUN_BLOCKED', resolutionBasis: result.blockReasons.slice(0, 3).join('; ') },
          });
        }
        taskRecord = { id: created.taskId, recorded: true };
      } else {
        taskRecord = { id: '', recorded: false };
        result.blockReasons.push(`durable 기록 실패(${created.reason}) — 어떤 제출도 불가`);
      }
    }

    return res.json({ ok: true, dryRun: result, task: taskRecord });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

// ── POST /executor/relay/revoke/prepare ──────────────────────────────────────
router.post('/executor/relay/revoke/prepare', requireOperatorAuth, async (_req, res) => {
  try {
    const cfg = resolveGmxLiveRelayConfig();
    const mainAccount = getConfiguredMainAccount();
    const signer = getSignerAddress();
    if (!cfg.ok) return res.status(503).json({ ok: false, error: `relay 구성 미해결: ${cfg.reasons.join('; ')}` });
    if (!mainAccount) return res.status(503).json({ ok: false, error: 'GMX_WALLET_ADDRESS 미설정' });
    if (!signer) return res.status(503).json({ ok: false, error: 'delegated signer 미초기화' });

    const nowMs = Date.now();
    const quote = getMockFeeQuote({ gasLimit: MOCK_GAS_LIMIT, gasPrice: MOCK_GAS_PRICE, nowMs });
    const quoteCheck = validateFeeQuote({ quote, nowMs, orderNotionalUsd: null, ethPriceUsd: null });
    if (!quoteCheck.ok) return res.status(503).json({ ok: false, error: `fee quote 검증 실패: ${quoteCheck.reason}` });

    const result = await prepareRevokeSession({
      mainAccount,
      subaccount: signer as Address,
      verifyingContract: cfg.config.subaccountGelatoRelayRouter as Address,
      feeToken: quote.feeToken,
      feeAmount: quote.feeAmount,
      nowSec: BigInt(Math.floor(nowMs / 1000)),
    });
    if (!result.ok) return res.status(500).json({ ok: false, error: result.reason });
    return res.json({ ok: true, sessionId: result.sessionId, typedData: result.typedData, digest: result.digest, summary: result.summary });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

// ── POST /executor/relay/revoke/signature ────────────────────────────────────
router.post('/executor/relay/revoke/signature', requireOperatorAuth, async (req, res) => {
  try {
    const { sessionId, signature } = req.body ?? {};
    if (typeof sessionId !== 'string' || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return res.status(400).json({ ok: false, error: 'sessionId와 65바이트 hex signature 필요' });
    }
    const mainAccount = getConfiguredMainAccount();
    if (!mainAccount) return res.status(503).json({ ok: false, error: 'GMX_WALLET_ADDRESS 미설정' });

    const result = await submitRevokeSignature({
      sessionId, signature: signature as Hex,
      expectedOwner: mainAccount,
      nowSec: BigInt(Math.floor(Date.now() / 1000)),
    });
    if (!result.ok) return res.status(400).json({ ok: false, error: result.reason });
    return res.json({ ok: true, sessionId: result.sessionId, status: 'OWNER_SIGNATURE_READY' });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

// ── POST /executor/relay/revoke/cancel ───────────────────────────────────────
router.post('/executor/relay/revoke/cancel', requireOperatorAuth, async (req, res) => {
  try {
    const { sessionId } = req.body ?? {};
    if (typeof sessionId !== 'string') return res.status(400).json({ ok: false, error: 'sessionId 필요' });
    const cancelled = await cancelRevokeSession(sessionId);
    if (!cancelled) return res.status(400).json({ ok: false, error: '취소 실패 — 활성 revoke 세션이 아님' });
    return res.json({ ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

// ── POST /executor/relay/revoke/dry-run ──────────────────────────────────────
router.post('/executor/relay/revoke/dry-run', requireOperatorAuth, async (_req, res) => {
  try {
    const { mode, reasons } = resolveRelayMode();
    const canonical = await checkCanonical();
    const revoke = await getActiveRevokeSession();
    const gate = evaluateRelayGate(mode, baseGateInput('REVOKE', canonical.confirmed, !!revoke));

    const cfg = resolveGmxLiveRelayConfig();
    const mainAccount = getConfiguredMainAccount();
    const signer = getSignerAddress();

    const nowMs = Date.now();
    const nowSec = BigInt(Math.floor(nowMs / 1000));
    const quote = getMockFeeQuote({ gasLimit: MOCK_GAS_LIMIT, gasPrice: MOCK_GAS_PRICE, nowMs });

    let assembled: AssembledRelayCall | null = null;
    let assembleError: string | undefined;
    if (cfg.ok && mainAccount && signer) {
      try {
        assembled = assembleRevokeRelayCall({
          mainAccount,
          subaccount: signer as Address,
          relayRouter: cfg.config.subaccountGelatoRelayRouter as Address,
          quote,
          userNonce: revoke?.userNonce ? BigInt(revoke.userNonce) : nowSec,
          deadline: revoke?.deadline ? BigInt(revoke.deadline) : nowSec + 300n,
        });
      } catch (e: unknown) {
        assembleError = (e as Error).message;
      }
    } else {
      assembleError = !cfg.ok ? 'relay 구성 미해결' : !mainAccount ? 'GMX_WALLET_ADDRESS 미설정' : 'signer 미초기화';
    }

    const result = buildDryRunResult({
      mode, kind: 'REVOKE', gate, modeReasons: reasons, assembled, assembleError,
      quote, nowMs, orderNotionalUsd: null, ethPriceUsd: null,
    });
    // owner 서명 READY 세션이 필수 게이트 — 서명 없는 dry-run은 유효하지 않음
    if (!revoke) {
      result.ok = false;
      result.blockReasons.push('활성 revoke 세션 없음 — prepare 먼저 수행');
    } else if (revoke.status !== 'OWNER_SIGNATURE_READY') {
      result.ok = false;
      result.blockReasons.push(`revoke 세션 상태 ${revoke.status} — owner 서명(OWNER_SIGNATURE_READY) 필요`);
    }

    // durable 기록 — OPEN/CLOSE와 동일하게 relay_tasks에 남긴다 (제출은 없음)
    let taskRecord: { id: string; recorded: boolean } | null = null;
    if (assembled) {
      const created = await createRelayTask({
        idempotencyKey: `dryrun:REVOKE:${assembled.packedPayloadHash}`,
        kind: 'REVOKE',
        payloadHash: assembled.packedPayloadHash,
        calldataHash: assembled.calldataHash,
        feeToken: assembled.feeToken,
        feeAmount: assembled.feeAmount.toString(),
        userNonce: assembled.userNonce.toString(),
        approvalNonce: null,
      });
      if (created.ok) {
        if (result.ok) {
          await safeTransition({ taskId: created.taskId, to: RELAY_TASK_STATUS.DRY_RUN_VALIDATED });
        } else {
          await safeTransition({
            taskId: created.taskId, to: RELAY_TASK_STATUS.FAILED_PRE_BROADCAST,
            patch: { errorClass: 'DRY_RUN_BLOCKED', resolutionBasis: result.blockReasons.slice(0, 3).join('; ') },
          });
        }
        taskRecord = { id: created.taskId, recorded: true };
      } else {
        taskRecord = { id: '', recorded: false };
        result.blockReasons.push(`durable 기록 실패(${created.reason}) — 어떤 제출도 불가`);
      }
    }

    return res.json({ ok: true, dryRun: result, revokeSession: revoke, task: taskRecord });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

export default router;
