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
  listUnresolvedTasks, getRelayTaskById,
} from '../lib/relayLifecycle';
import { allocateUserNonce } from '../lib/relayNonce';
import { evaluateActivationGate } from '../lib/relayActivationGate';
import {
  computeReconciliationComplete, evaluateFreshLiveQuote,
  getStartupReconciliationState, isReconciliationRunning,
  isRelayNetworkStructurallyDisabled,
} from '../lib/relayActivationStatus';
import { countBlockingIntentsOrNull } from '../lib/executionIntents';
import { countOpenRelayTasksOrNull } from '../lib/relayLifecycle';
import { reconcileVerdict, applyReconcileVerdict } from '../lib/relayTaskReconciler';
import type { RelayTransport } from '../lib/relayTransport';
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

// 실제 transport는 프로덕션에서 주입되지 않는다(활성화 env 미설정) —
// recheck 경로는 transport가 없으면 증거 재수집 불가로 응답한다. 테스트 전용 주입.
let injectedTransport: RelayTransport | null = null;
export function __setRelayTransportForTests(t: RelayTransport | null): void {
  injectedTransport = t;
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
  // 최우선 구조적 게이트 (5단계 리뷰 반영): relay 네트워크 비활성이면
  // RPC client 생성·호출 자체를 금지한다 — 상태 조회 경로에서 어떤 실제
  // 네트워크 read도 발생하지 않는다 (fail-closed 결과만 반환).
  if (isRelayNetworkStructurallyDisabled(process.env)) {
    return {
      confirmed: false,
      reason: 'canonical readback 미수행 — relay 네트워크 비활성(GMX_RELAY_NETWORK_ENABLED 미설정, 구조적 차단)',
      approvalNonce: null, isSubaccountListed: null, expiresAt: null, remaining: null,
    };
  }
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

    // durable userNonce allocation — epoch초 사용 금지 (4단계 §2)
    const nonceAlloc = await allocateUserNonce({ mainAccount, purpose: 'REVOKE' });
    if (!nonceAlloc.ok) return res.status(503).json({ ok: false, error: nonceAlloc.reason });

    const result = await prepareRevokeSession({
      userNonce: nonceAlloc.nonce,
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

// ── UNRESOLVED 조사 (4단계 §9) ────────────────────────────────────────────────

function investigationView(row: NonNullable<Awaited<ReturnType<typeof getRelayTaskById>>>) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    relayTaskId: row.relayTaskId,
    txHash: row.txHash,
    orderKey: row.orderKey,
    userNonce: row.userNonce,
    approvalNonce: row.approvalNonce,
    errorClass: row.errorClass,                 // sanitize된 오류 분류만 저장됨
    resolutionBasis: row.resolutionBasis,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    links: {
      arbiscanTx: row.txHash ? `https://arbiscan.io/tx/${row.txHash}` : null,
      gelatoTask: row.relayTaskId ? `https://api.gelato.digital/tasks/status/${row.relayTaskId}` : null,
    },
    // UNRESOLVED가 있는 동안 신규 제출이 차단되는 사유 표시용
    blocking: row.status === RELAY_TASK_STATUS.UNRESOLVED,
  };
}

// GET /executor/relay/unresolved — 조사 목록
router.get('/executor/relay/unresolved', requireOperatorAuth, async (_req, res) => {
  try {
    const rows = await listUnresolvedTasks(50);
    return res.json({ ok: true, tasks: rows.map(investigationView) });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

// POST /executor/relay/unresolved/recheck — 증거 재수집만 허용.
// 강제 terminal 전환·payload 재제출·intent 삭제는 제공하지 않는다.
router.post('/executor/relay/unresolved/recheck', requireOperatorAuth, async (req, res) => {
  try {
    const { taskId } = req.body ?? {};
    if (typeof taskId !== 'string') return res.status(400).json({ ok: false, error: 'taskId 필요' });
    const row = await getRelayTaskById(taskId);
    if (!row) return res.status(404).json({ ok: false, error: 'task 없음' });
    // SUBMITTING(taskId 저장 실패 등으로 stale 잔존)도 조사 대상 — 자동 종결은 없다
    if (row.status !== RELAY_TASK_STATUS.UNRESOLVED && row.status !== RELAY_TASK_STATUS.SUBMITTING) {
      return res.status(400).json({ ok: false, error: `상태 ${row.status} — UNRESOLVED/SUBMITTING만 재조회 대상` });
    }

    // 증거 재수집: Gelato task status (transport 필요) — 이번 단계에서는
    // transport 미주입(활성화 env 미설정)이라 항상 "재수집 불가"로 응답.
    if (!injectedTransport) {
      return res.json({
        ok: true,
        rechecked: false,
        reason: 'relay transport 비활성(GMX_RELAY_NETWORK_ENABLED 미설정) — 증거 재수집 불가, 상태 유지',
        task: investigationView(row),
      });
    }
    if (!row.relayTaskId) {
      return res.json({
        ok: true, rechecked: false,
        reason: 'Gelato taskId 미확보 — task status 재조회 불가 (온체인 조사 필요)',
        task: investigationView(row),
      });
    }

    const status = await injectedTransport.getRelayTaskStatus({ taskId: row.relayTaskId });
    const verdict = reconcileVerdict({
      gelato: status.ok
        ? { taskState: status.taskState, transactionHash: status.transactionHash }
        : { taskState: null, transactionHash: null },
      onchain: { event: null, txHash: null, orderKey: null, blockNumber: null },
    });
    await applyReconcileVerdict(row.id, verdict);
    const updated = await getRelayTaskById(row.id);
    return res.json({
      ok: true, rechecked: true, verdictBasis: verdict.basis,
      task: updated ? investigationView(updated) : null,
    });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

// GET /executor/relay/activation — 활성화 이중 게이트 현황 (진단용, 5단계 §4·§9)
// 이 endpoint는 읽기 전용이다: 어떤 네트워크 호출·주문·설정 변경도 유발하지 않는다.
// reconciliationComplete/freshLiveFeeQuote는 하드코딩이 아닌 실제 파생값이다.
router.get('/executor/relay/activation', requireOperatorAuth, async (_req, res) => {
  try {
    const canonical = await checkCanonical();
    const revoke = await getActiveRevokeSession();
    const env = process.env;

    // DB 상태 파생 (조회 실패 = null → fail-closed)
    const blockingIntents = await countBlockingIntentsOrNull();
    const openRelayTasks = await countOpenRelayTasksOrNull();
    const dbOk = blockingIntents !== null && openRelayTasks !== null;

    // reconciliationComplete — startup reconciliation + 현재 DB 상태 파생
    const recon = await computeReconciliationComplete({
      countBlockingIntents: async () => blockingIntents,
      countOpenRelayTasks: async () => openRelayTasks,
      hasActiveRevoke: async () => !!revoke,
      getStartupState: getStartupReconciliationState,
      isRunning: isReconciliationRunning,
      nowMs: () => Date.now(),
    });

    // freshLiveFeeQuote — 저장된 live quote가 없으므로 항상 false로 파생된다
    // (mock quote는 구조적으로 불인정). 상태 조회가 quote 네트워크 호출을
    // 유발하지 않는다 — 저장값 검증만.
    const liveQuote = evaluateFreshLiveQuote({
      quote: null, chainId: 42161, nowMs: Date.now(),
      orderNotionalUsd: null, ethPriceUsd: null,
      quoteBoundPayloadHash: null, targetPayloadHash: null,
    });

    const unresolvedCount = (await listUnresolvedTasks(50)).length;
    const canonicalAuthorized = canonical.confirmed && canonical.isSubaccountListed === true;
    const signerActive = isDelegatedSignerEnabled() && isSignerInitialized();
    const liveLocked = isLiveTestExecutionLocked();

    const gate = evaluateActivationGate({
      env,
      liveTestMode: false,               // 서버 liveTestMode는 executor 상태에서 오되, 여기서는 보수적으로 false
      signerInitialized: isSignerInitialized(),
      canonicalAuthorized,
      emergencyStopActive: false,
      dbOk,
      rpcOk: canonical.confirmed,
      reconciliationComplete: recon.complete,
      blockingIntentCount: blockingIntents ?? 1,   // 조회 실패 → 차단으로 취급
      activeRevokeInProgress: !!revoke,
      freshLiveFeeQuote: liveQuote.fresh,
      currentChainId: 42161,
      gmxConfigOk: resolveGmxLiveRelayConfig().ok,
      kind: 'OPEN',
    });

    // §9 UI 상태 구분 — 표시 전용 플래그 (어떤 부작용도 없음)
    const statusFlags = {
      codeReady: true,
      networkDisabled: env.GMX_RELAY_NETWORK_ENABLED !== 'true' || env.GMX_RELAY_SUBMISSION_ENABLED !== 'true' || (env.GMX_RELAY_MODE ?? '').toUpperCase() !== 'LIVE',
      signerDisabled: !signerActive,
      canonicalUnverified: !canonicalAuthorized,
      canonicalReason: canonical.reason,
      reconciliationIncomplete: !recon.complete,
      reconciliationReasons: recon.reasons,
      liveQuoteMissing: !liveQuote.fresh,
      liveQuoteReasons: liveQuote.reasons,
      revokeActive: !!revoke,
      unresolvedPresent: unresolvedCount > 0,
      unresolvedCount,
      liveLocked,
      readyForControlledCanary: gate.networkEligible, // 전 조건 참일 때만
    };

    return res.json({ ok: true, networkEligible: gate.networkEligible, missing: gate.missing, statusFlags });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

export default router;
