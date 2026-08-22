import { Router } from 'express';
import {
  db,
  strategyConfigTable,
  subaccountApprovalSessionsTable,
  workerStateTable,
} from '@workspace/db';
import { eq, inArray } from 'drizzle-orm';
import { isDelegatedSignerEnabled, isSignerInitialized } from '../lib/delegatedSigner';
import { isLiveTestExecutionLocked } from '../lib/liveTestGate';
import { requireOperatorAuth } from '../lib/operatorAuthGuard';

const router = Router();

const SIGNER_RECORD_KEYS = [
  'delegatedSignerEncryptedKey',
  'delegatedSignerMeta',
  'delegatedSignerPublicAddress',
] as const;

const APPROVAL_PURPOSE = 'APPROVAL';
const OWNER_SIGNATURE_READY = 'OWNER_SIGNATURE_READY';
const INVALIDATED = 'INVALIDATED';

type StrategyLimits = {
  liveTestMode?: unknown;
};

function isLiveTestMode(limits: unknown): boolean {
  return typeof limits === 'object'
    && limits !== null
    && (limits as StrategyLimits).liveTestMode === true;
}

function isExpiredOrMalformed(value: string, nowSeconds: bigint): boolean {
  try {
    return BigInt(value) <= nowSeconds;
  } catch {
    return true;
  }
}

/**
 * Authenticated signer readiness snapshot.
 *
 * This endpoint is intentionally limited to local process flags plus DB SELECTs.
 * It must not decrypt, initialize, restore, or provision a signer; perform RPC or
 * network I/O; invalidate approval sessions; or write to the database.
 */
router.get('/executor/signer/readiness', requireOperatorAuth, async (_req, res) => {
  try {
    const [signerRecords, approvalSessions, strategyConfigs] = await Promise.all([
      db
        .select({ key: workerStateTable.key })
        .from(workerStateTable)
        .where(inArray(workerStateTable.key, [...SIGNER_RECORD_KEYS])),
      db
        .select({
          status: subaccountApprovalSessionsTable.status,
          expiresAt: subaccountApprovalSessionsTable.expiresAt,
          deadline: subaccountApprovalSessionsTable.deadline,
        })
        .from(subaccountApprovalSessionsTable)
        .where(eq(subaccountApprovalSessionsTable.purpose, APPROVAL_PURPOSE)),
      db
        .select({ limits: strategyConfigTable.limits })
        .from(strategyConfigTable)
        .limit(1),
    ]);

    const signerKeys = new Set(signerRecords.map((record) => record.key));
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const staleOwnerSignatureReadySessionCount = approvalSessions.filter((session) =>
      session.status === OWNER_SIGNATURE_READY
      && (isExpiredOrMalformed(session.expiresAt, nowSeconds)
        || isExpiredOrMalformed(session.deadline, nowSeconds)),
    ).length;
    const invalidatedSessionCount = approvalSessions.filter(
      (session) => session.status === INVALIDATED,
    ).length;

    const effectiveWorkerMode = process.env.WORKER_ENGINE_MODE === 'LIVE' ? 'LIVE' : 'PAPER';
    const liveExecutionLocked = isLiveTestExecutionLocked();
    const delegatedSignerEnabled = isDelegatedSignerEnabled();
    const submitFlagEnabled = process.env.GMX_API_ORDER_SUBMISSION_ENABLED === 'true';
    const liveTestMode = isLiveTestMode(strategyConfigs[0]?.limits);
    const runtimeSignerInitialized = isSignerInitialized();

    const signerRecordsPresent = {
      encryptedSigner: signerKeys.has('delegatedSignerEncryptedKey'),
      metadata: signerKeys.has('delegatedSignerMeta'),
      publicSigner: signerKeys.has('delegatedSignerPublicAddress'),
    };

    const blockedReasons = [
      'READONLY_SNAPSHOT_CANNOT_VERIFY_CANONICAL_AUTHORIZATION',
      'READONLY_SNAPSHOT_CANNOT_VERIFY_RPC_OR_RECONCILIATION',
    ];
    if (effectiveWorkerMode !== 'LIVE') blockedReasons.push('WORKER_NOT_LIVE');
    if (liveExecutionLocked) blockedReasons.push('LIVE_EXECUTION_LOCKED');
    if (!delegatedSignerEnabled) blockedReasons.push('DELEGATED_SIGNER_DISABLED');
    if (!submitFlagEnabled) blockedReasons.push('ORDER_SUBMISSION_DISABLED');
    if (!liveTestMode) blockedReasons.push('LIVE_TEST_MODE_DISABLED');
    if (!signerRecordsPresent.encryptedSigner) blockedReasons.push('ENCRYPTED_SIGNER_RECORD_MISSING');
    if (!signerRecordsPresent.metadata) blockedReasons.push('SIGNER_METADATA_RECORD_MISSING');
    if (!signerRecordsPresent.publicSigner) blockedReasons.push('PUBLIC_SIGNER_RECORD_MISSING');
    if (!runtimeSignerInitialized) blockedReasons.push('RUNTIME_SIGNER_NOT_INITIALIZED');
    if (staleOwnerSignatureReadySessionCount > 0) {
      blockedReasons.push('STALE_OWNER_SIGNATURE_READY_SESSION_PRESENT');
    }

    return res.json({
      ok: true,
      readiness: {
        effectiveWorkerMode,
        liveExecutionLocked,
        delegatedSignerEnabled,
        submitFlagEnabled,
        liveTestMode,
        signerRecordsPresent,
        runtimeSignerInitialized,
        staleOwnerSignatureReadySessionCount,
        invalidatedSessionCount,
        actualSubmitPossible: false,
        failClosed: true,
        blockedReasons,
      },
    });
  } catch {
    return res.status(503).json({
      ok: false,
      readiness: {
        actualSubmitPossible: false,
        failClosed: true,
        blockedReasons: ['READINESS_SNAPSHOT_UNAVAILABLE'],
      },
    });
  }
});

export default router;