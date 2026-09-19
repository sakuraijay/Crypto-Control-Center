import { Router } from 'express';
import { db, workerStateTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
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

export const router = Router();

async function readWorkerStateValue(key: string): Promise<string | null> {
  const rows = await db.select().from(workerStateTable)
    .where(eq(workerStateTable.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

async function persistWorkerStateValue(key: string, value: string): Promise<void> {
  const updatedAt = new Date();
  await db.insert(workerStateTable)
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
