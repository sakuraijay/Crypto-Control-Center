import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { db, workerStateTable } from '@workspace/db';
import { eq, sql } from 'drizzle-orm';
import { requireOperatorAuth } from '../lib/operatorAuthGuard';
import {
  ALPHA_START_INTENT_KEY,
  ALPHA_START_INTENT_SCOPE,
  buildActiveAlphaStartIntent,
  buildStoppedAlphaStartIntent,
  evaluateAlphaStartIntent,
  evaluateAlphaStartPolicy,
  serializeAlphaStartIntentV1,
  type PersistedAlphaStartIntentV1,
} from '../workers/alphaStartIntent';
import { WORKER_POLICY_CONTEXT_KEY } from '../workers/workerPolicyContext';
import {
  VIRTUAL_PAPER_400_SESSION_STATE_KEY,
  VIRTUAL_PAPER_400_LOCK_ID,
  buildActiveVirtualPaper400SessionState,
  buildStoppedVirtualPaper400SessionState,
  evaluateVirtualPaper400SessionState,
  serializeVirtualPaper400SessionState,
} from '../workers/virtualPaper400SessionState';

export const router = Router();

async function readWorkerStateValue(key: string, database: Pick<typeof db, 'select'> = db): Promise<string | null> {
  const rows = await database.select().from(workerStateTable)
    .where(eq(workerStateTable.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

async function persistWorkerStateValue(key: string, value: string, database: Pick<typeof db, 'insert'> = db): Promise<void> {
  const updatedAt = new Date();
  await database.insert(workerStateTable)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({
      target: workerStateTable.key,
      set: { value, updatedAt },
    });
}

/**
 * Read the durable operator intent.  This endpoint is observational only: it never
 * bootstraps missing state and never converts intent into execution authorization.
 */
router.get('/data/alpha-start-intent', async (_req, res) => {
  try {
    const raw = await readWorkerStateValue(ALPHA_START_INTENT_KEY);
    const intent = evaluateAlphaStartIntent(raw);
    const response = {
      ok: intent.status !== 'INVALID',
      scope: ALPHA_START_INTENT_SCOPE,
      executionAuthorized: false as const,
      intent,
    };
    if (intent.status === 'INVALID') return res.status(500).json(response);
    return res.json(response);
  } catch {
    return res.status(503).json({
      ok: false,
      code: 'ALPHA_START_INTENT_READ_FAILED',
      scope: ALPHA_START_INTENT_SCOPE,
      executionAuthorized: false,
      error: 'alpha start intent could not be read',
    });
  }
});

/**
 * Persist explicit operator START/STOP intent only.
 *
 * START requires a pre-existing, valid FIXED_BETA_400 accounting policy but never
 * changes that policy.  STOP is always allowed once operator-authenticated so a
 * stale/malformed policy can never prevent the operator from recording STOP.
 * Neither action submits orders, signs, moves funds, or grants execution rights.
 */
router.put('/data/alpha-start-intent', requireOperatorAuth, async (req, res) => {
  const action = req.body?.action;
  if (action !== 'START' && action !== 'STOP') {
    return res.status(400).json({
      ok: false,
      code: 'ALPHA_START_INTENT_ACTION_INVALID',
      scope: ALPHA_START_INTENT_SCOPE,
      executionAuthorized: false,
      error: 'action must be START or STOP',
    });
  }

  try {
    let value: string;
    let expectedStatus: 'ACTIVE' | 'STOPPED';

    if (action === 'START') {
      const policyRaw = await readWorkerStateValue(WORKER_POLICY_CONTEXT_KEY);
      const policyGate = evaluateAlphaStartPolicy(policyRaw);
      if (!policyGate.ok) {
        return res.status(409).json({
          ok: false,
          code: policyGate.reason,
          scope: ALPHA_START_INTENT_SCOPE,
          executionAuthorized: false,
          error: policyGate.reason === 'FIXED_BETA_REQUIRED'
            ? 'FIXED_BETA_400 accounting policy must already be selected before START'
            : 'worker policy context is invalid; START is fail-closed',
        });
      }

      if (typeof req.body?.expiresAt !== 'string') {
        return res.status(400).json({
          ok: false,
          code: 'EXPIRES_AT_REQUIRED',
          scope: ALPHA_START_INTENT_SCOPE,
          executionAuthorized: false,
          error: 'START requires an explicit future expiresAt timestamp',
        });
      }

      let state: PersistedAlphaStartIntentV1;
      try {
        state = buildActiveAlphaStartIntent(req.body.expiresAt);
      } catch (error) {
        return res.status(400).json({
          ok: false,
          code: (error as Error).message,
          scope: ALPHA_START_INTENT_SCOPE,
          executionAuthorized: false,
          error: 'expiresAt must be a valid future timestamp',
        });
      }
      value = serializeAlphaStartIntentV1(state);
      expectedStatus = 'ACTIVE';
    } else {
      if (req.body?.reason !== undefined && typeof req.body.reason !== 'string') {
        return res.status(400).json({
          ok: false,
          code: 'STOP_REASON_INVALID',
          scope: ALPHA_START_INTENT_SCOPE,
          executionAuthorized: false,
          error: 'reason must be a string when supplied',
        });
      }

      let state: PersistedAlphaStartIntentV1;
      try {
        state = buildStoppedAlphaStartIntent(req.body?.reason);
      } catch (error) {
        return res.status(400).json({
          ok: false,
          code: (error as Error).message,
          scope: ALPHA_START_INTENT_SCOPE,
          executionAuthorized: false,
          error: 'STOP reason is invalid',
        });
      }
      value = serializeAlphaStartIntentV1(state);
      expectedStatus = 'STOPPED';
    }

    await persistWorkerStateValue(ALPHA_START_INTENT_KEY, value);

    const readbackRaw = await readWorkerStateValue(ALPHA_START_INTENT_KEY);
    const intent = evaluateAlphaStartIntent(readbackRaw);
    if (intent.status !== expectedStatus) {
      return res.status(503).json({
        ok: false,
        code: 'ALPHA_START_INTENT_READBACK_FAILED',
        scope: ALPHA_START_INTENT_SCOPE,
        executionAuthorized: false,
        intent,
        error: 'persisted alpha start intent did not verify on readback',
      });
    }

    return res.json({
      ok: true,
      scope: ALPHA_START_INTENT_SCOPE,
      executionAuthorized: false,
      intent,
    });
  } catch {
    return res.status(503).json({
      ok: false,
      code: 'ALPHA_START_INTENT_PERSIST_FAILED',
      scope: ALPHA_START_INTENT_SCOPE,
      executionAuthorized: false,
      error: 'alpha start intent could not be persisted',
    });
  }
});

/**
 * VIRTUAL/PAPER 400 control-plane state is deliberately independent of the
 * real-money FIXED_BETA domain. GET is observational and never bootstraps state.
 */
router.get('/data/virtual-paper-400-session', async (_req, res) => {
  try {
    const raw = await readWorkerStateValue(VIRTUAL_PAPER_400_SESSION_STATE_KEY);
    const session = evaluateVirtualPaper400SessionState(raw);
    const runtimeRaw = await readWorkerStateValue('virtual_paper_400_runtime_v1');
    let runtime = null;
    if (runtimeRaw) {
      const candidate = JSON.parse(runtimeRaw);
      if (candidate?.mode === 'VIRTUAL_PAPER_400' && candidate.realFundsUsed === false
        && session.state && candidate.sessionId === session.state.session.sessionId) runtime = candidate;
    }
    const age = runtime ? Date.now() - Date.parse(runtime.at) : NaN;
    const response = {
      ok: session.status !== 'INVALID',
      mode: 'VIRTUAL_PAPER_400' as const,
      realFundsUsed: false as const,
      executionAuthorized: false as const,
      session,
      runtime,
      runtimeFresh: Number.isFinite(age) && age >= 0 && age <= 120_000,
    };
    if (session.status === 'INVALID') return res.status(500).json(response);
    return res.json(response);
  } catch {
    return res.status(503).json({
      ok: false,
      code: 'VIRTUAL_PAPER_400_SESSION_READ_FAILED',
      mode: 'VIRTUAL_PAPER_400',
      realFundsUsed: false,
      executionAuthorized: false,
      error: 'virtual PAPER 400 session state could not be read',
    });
  }
});

/**
 * Persist an explicit operator START/STOP for the virtual 400-USDC PAPER session.
 * START is idempotent while already ACTIVE and never touches wallet/FIXED_BETA
 * accounting. STOP preserves the exact session identity. A later START resumes
 * that same identity instead of minting a fresh 400-USDC ledger, so stop/restart
 * cannot erase prior losses or settlement history.
 */
router.put('/data/virtual-paper-400-session', requireOperatorAuth, async (req, res) => {
  const action = req.body?.action;
  if (action !== 'START' && action !== 'STOP') {
    return res.status(400).json({
      ok: false,
      code: 'VIRTUAL_PAPER_400_ACTION_INVALID',
      mode: 'VIRTUAL_PAPER_400',
      realFundsUsed: false,
      executionAuthorized: false,
      error: 'action must be START or STOP',
    });
  }

  if (req.body?.reason !== undefined && typeof req.body.reason !== 'string') {
    return res.status(400).json({
      ok: false,
      code: 'STOP_REASON_INVALID',
      mode: 'VIRTUAL_PAPER_400',
      realFundsUsed: false,
      executionAuthorized: false,
      error: 'reason must be a string when supplied',
    });
  }

  try {
    const reply = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${VIRTUAL_PAPER_400_LOCK_ID})`);
      let statusCode = 200;
      const response = {
        status(code: number) { statusCode = code; return this; },
        json(body: unknown) { return { statusCode, body }; },
      };
      const currentRaw = await readWorkerStateValue(VIRTUAL_PAPER_400_SESSION_STATE_KEY, tx);
      const current = evaluateVirtualPaper400SessionState(currentRaw);

      if (current.status === 'INVALID') {
        return response.status(409).json({
          ok: false,
          code: 'VIRTUAL_PAPER_400_SESSION_INVALID',
          mode: 'VIRTUAL_PAPER_400',
          realFundsUsed: false,
          executionAuthorized: false,
          session: current,
          error: 'invalid persisted virtual session state must be reviewed; it will not be overwritten automatically',
        });
      }

      if (action === 'START' && current.status === 'ACTIVE') {
        return response.json({
          ok: true,
          mode: 'VIRTUAL_PAPER_400',
          realFundsUsed: false,
          executionAuthorized: false,
          idempotent: true,
          session: current,
        });
      }

      if (action === 'STOP' && (current.status === 'MISSING' || current.status === 'STOPPED')) {
        return response.json({
          ok: true,
          mode: 'VIRTUAL_PAPER_400',
          realFundsUsed: false,
          executionAuthorized: false,
          idempotent: true,
          session: current,
        });
      }

      const now = new Date();
      const nextState = action === 'START'
        ? current.status === 'STOPPED'
          ? {
              schemaVersion: 1 as const,
              status: 'ACTIVE' as const,
              session: current.state!.session,
              updatedAt: now.toISOString(),
            }
          : buildActiveVirtualPaper400SessionState(`vp400-${randomUUID()}`, now)
        : buildStoppedVirtualPaper400SessionState(current.state!, req.body?.reason, now);

      await persistWorkerStateValue(
        VIRTUAL_PAPER_400_SESSION_STATE_KEY,
        serializeVirtualPaper400SessionState(nextState), tx,
      );

      const readbackRaw = await readWorkerStateValue(VIRTUAL_PAPER_400_SESSION_STATE_KEY, tx);
      const session = evaluateVirtualPaper400SessionState(readbackRaw);
      const expectedStatus = action === 'START' ? 'ACTIVE' : 'STOPPED';
      if (session.status !== expectedStatus || session.state?.session.sessionId !== nextState.session.sessionId) {
        return response.status(503).json({
          ok: false,
          code: 'VIRTUAL_PAPER_400_SESSION_READBACK_FAILED',
          mode: 'VIRTUAL_PAPER_400',
          realFundsUsed: false,
          executionAuthorized: false,
          session,
          error: 'persisted virtual PAPER 400 session did not verify on readback',
        });
      }

      return response.json({
        ok: true,
        mode: 'VIRTUAL_PAPER_400',
        realFundsUsed: false,
        executionAuthorized: false,
        idempotent: false,
        session,
      });
    });
    return res.status(reply.statusCode).json(reply.body);
  } catch (error) {
    const code = (error as Error)?.message;
    if (code === 'STOP_REASON_TOO_LONG' || code === 'STOP_REASON_INVALID') {
      return res.status(400).json({
        ok: false,
        code,
        mode: 'VIRTUAL_PAPER_400',
        realFundsUsed: false,
        executionAuthorized: false,
        error: 'virtual PAPER 400 STOP reason is invalid',
      });
    }
    return res.status(503).json({
      ok: false,
      code: 'VIRTUAL_PAPER_400_SESSION_PERSIST_FAILED',
      mode: 'VIRTUAL_PAPER_400',
      realFundsUsed: false,
      executionAuthorized: false,
      error: 'virtual PAPER 400 session could not be persisted',
    });
  }
});
