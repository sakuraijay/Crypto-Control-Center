/**
 * Deliberately narrow PAPER epoch activation.  This module never talks to an
 * executor; it only performs the durable reset after proving the account is
 * completely quiescent.
 */
import {
  db, executionIntentsTable, liveApprovalsTable, protectionOrdersTable,
  relayTasksTable, strategyConfigTable, tradesTable, workerStateTable,
} from '@workspace/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  BASELINE_DAILY_KEY,
  BASELINE_WEEKLY_KEY,
  dailyPeriodStartUtc,
  parseBaseline,
  weeklyPeriodStartUtc,
} from './equityBaselines';
import {
  initialRiskEngineState,
  RISK_ENGINE_STATE_KEY,
  type PersistedRiskEngineState,
} from './riskEngineState';
import { getServerPaperStatus } from '../workers/serverPaperExecutor';
import { applyPaperEpochInMemory, isWorkerCycleInProgress } from '../workers/aiWorker';
import {
  buildActivePaperEpoch,
  buildPaperEpochBinding,
  isValidPaperEpochIdempotencyKey,
  PAPER_EPOCH_ACTIVE_KEY,
  parseActivePaperEpoch,
  verifyActivePaperEpochSnapshot,
} from './paperEpochState';
import {
  isPaperEpochActivationHeld, releasePaperEpochActivationLock, tryAcquirePaperEpochActivationLock,
} from './paperEpochActivationLock';

export { PAPER_EPOCH_ACTIVE_KEY } from './paperEpochState';

function exactBoundaries(env: NodeJS.ProcessEnv): string[] {
  const required: Array<[string, boolean]> = [
    ['WORKER_ENGINE_MODE', env.WORKER_ENGINE_MODE === 'PAPER'],
    ['AUTO_WORKER_LIVE_ENABLED', env.AUTO_WORKER_LIVE_ENABLED === 'false'],
    ['GMX_RELAY_SUBMISSION_ENABLED', env.GMX_RELAY_SUBMISSION_ENABLED === 'false'],
    ['GMX_RELAY_NETWORK_ENABLED', env.GMX_RELAY_NETWORK_ENABLED === 'false'],
    ['GMX_RELAY_MODE', (env.GMX_RELAY_MODE ?? '').trim() === 'DISABLED'],
    ['DELEGATED_SIGNER_ENABLED', env.DELEGATED_SIGNER_ENABLED === 'true'],
    ['GMX_API_ORDER_SUBMISSION_ENABLED', env.GMX_API_ORDER_SUBMISSION_ENABLED === 'true'],
    ['LIVE_TEST_EXECUTION_LOCKED', env.LIVE_TEST_EXECUTION_LOCKED === 'false'],
  ];
  return required.filter(([, ok]) => !ok).map(([key]) => `${key}_DRIFT`);
}

export function validatePaperEpochActivationBody(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'INVALID_BODY';
  const keys = Object.keys(body as object).sort();
  if (keys.join(',') !== 'activeCapitalUsd,approved,idempotencyKey') return 'INVALID_BODY';
  const b = body as Record<string, unknown>;
  if (b.approved !== true || b.activeCapitalUsd !== 1000
    || !isValidPaperEpochIdempotencyKey(b.idempotencyKey)) return 'INVALID_BODY';
  return null;
}

export type PaperEpochActivationResult =
  | { status: 'APPLIED'; epochId: string }
  | { status: 'ALREADY_APPLIED'; epochId: string }
  | { status: 'BUSY'; retryable: true }
  | { status: 'BLOCKED'; blockers: string[] };

type ActivationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RunActivationTransaction = <T>(
  work: (tx: ActivationTransaction) => Promise<T>,
) => Promise<T>;

type ActivationRuntime = {
  getServerPaperStatus: typeof getServerPaperStatus;
  applyPaperEpochInMemory: typeof applyPaperEpochInMemory;
  isWorkerCycleInProgress: typeof isWorkerCycleInProgress;
  isPaperEpochActivationHeld: typeof isPaperEpochActivationHeld;
  tryAcquirePaperEpochActivationLock: typeof tryAcquirePaperEpochActivationLock;
  releasePaperEpochActivationLock: typeof releasePaperEpochActivationLock;
  now: () => Date;
  runTransaction: RunActivationTransaction;
};

const productionRuntime: ActivationRuntime = {
  getServerPaperStatus, applyPaperEpochInMemory, isWorkerCycleInProgress,
  isPaperEpochActivationHeld, tryAcquirePaperEpochActivationLock, releasePaperEpochActivationLock,
  now: () => new Date(),
  runTransaction: (work) => db.transaction(work),
};
let runtime: ActivationRuntime = productionRuntime;

/** Narrow seam for deterministic unit tests; production always uses the imports above. */
export function __setPaperEpochActivationRuntimeForTests(overrides: Partial<ActivationRuntime> | null): void {
  runtime = overrides ? { ...productionRuntime, ...overrides } : productionRuntime;
}

export async function activatePaperEpoch(idempotencyKey: string, env = process.env): Promise<PaperEpochActivationResult> {
  if (runtime.isPaperEpochActivationHeld() || runtime.isWorkerCycleInProgress()) return { status: 'BUSY', retryable: true };
  const boundaryBlockers = exactBoundaries(env);
  if (boundaryBlockers.length) return { status: 'BLOCKED', blockers: boundaryBlockers };
  if (!runtime.tryAcquirePaperEpochActivationLock()) return { status: 'BUSY', retryable: true };
  try {
    const paper = runtime.getServerPaperStatus();
    if (paper.pendingClose !== null || paper.unresolved !== null) {
      return { status: 'BLOCKED', blockers: ['SERVER_PAPER_NOT_QUIESCENT'] };
    }
    const now = runtime.now();
    const active = buildActivePaperEpoch(idempotencyKey, now);
    const { epochId } = active;
    const outcome = await runtime.runTransaction(async (tx) => {
      // One stable advisory key serializes all processes, while the in-process
      // guard prevents a worker tick from starting during this critical section.
      await tx.execute(sql`select pg_advisory_xact_lock(814320019)`);
      const lockedBoundaryBlockers = exactBoundaries(env);
      if (lockedBoundaryBlockers.length) return { status: 'BLOCKED' as const, blockers: lockedBoundaryBlockers };
      for (const table of ['trades', 'live_approvals', 'execution_intents', 'relay_tasks', 'protection_orders', 'worker_state', 'strategy_config']) {
        await tx.execute(sql.raw(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`));
      }
      const existing = await tx.select().from(workerStateTable)
        .where(eq(workerStateTable.key, active.auditKey)).limit(1);
      if (existing.length) {
        try {
          const stateRows = await tx.select().from(workerStateTable);
          const activeRaw = stateRows.find(r => r.key === PAPER_EPOCH_ACTIVE_KEY)?.value;
          const parsedActive = parseActivePaperEpoch(activeRaw, now.getTime());
          if (!parsedActive.ok) throw new Error(parsedActive.reason);
          const storedActive = parsedActive.value;
          const config = await tx.select().from(strategyConfigTable).limit(1);
          const riskRaw = stateRows.find(r => r.key === RISK_ENGINE_STATE_KEY)?.value;
          const dailyRaw = stateRows.find(r => r.key === BASELINE_DAILY_KEY)?.value;
          const weeklyRaw = stateRows.find(r => r.key === BASELINE_WEEKLY_KEY)?.value;
          const risk = riskRaw ? JSON.parse(riskRaw) as PersistedRiskEngineState : null;
          const daily = parseBaseline(dailyRaw);
          const weekly = parseBaseline(weeklyRaw);
          const state = new Map(stateRows.map(row => [row.key, row.value]));
          const verified = config[0] && activeRaw
            ? verifyActivePaperEpochSnapshot({
              activeRaw,
              auditRaw: existing[0].value,
              equityHwmRaw: state.get('equityHwm') ?? null,
              limits: config[0].limits,
              dailyRaw: dailyRaw ?? null,
              weeklyRaw: weeklyRaw ?? null,
              riskRaw: riskRaw ?? null,
              nowMs: now.getTime(),
            })
            : { ok: false as const, reason: 'ACTIVE_EPOCH_STATE_UNAVAILABLE' };
          const equityHwm = Number(state.get('equityHwm'));
          if (!verified.ok || verified.value.audit.idempotencyKey !== idempotencyKey
            || verified.value.audit.epochId !== storedActive.epochId
            || !risk || !daily || !weekly || !Number.isFinite(equityHwm)) {
            throw new Error('active epoch pointer mismatch');
          }
          return {
            status: 'ALREADY_APPLIED' as const,
            epochId: verified.value.audit.epochId,
            now: new Date(storedActive.startedAtMs),
            startedAtMs: storedActive.startedAtMs,
            daily,
            weekly,
            limits: config[0].limits as Record<string, unknown>,
            risk,
            equityHwm,
            resetPeriodValues: false,
          };
        } catch { throw new Error('corrupt epoch idempotency audit'); }
      }
      const [open, approvals, intents, protections, unsettled, relay] = await Promise.all([
        tx.select({ id: tradesTable.id }).from(tradesTable).where(and(eq(tradesTable.action, 'OPEN'), eq(tradesTable.closeTime, 0))),
        tx.select({ id: liveApprovalsTable.id }).from(liveApprovalsTable).where(eq(liveApprovalsTable.status, 'PENDING')),
        tx.select({ id: executionIntentsTable.id }).from(executionIntentsTable).where(inArray(executionIntentsTable.status, ['PREPARED', 'SUBMITTED', 'UNRESOLVED'])),
        tx.select({ id: protectionOrdersTable.id }).from(protectionOrdersTable).where(inArray(protectionOrdersTable.status, ['PLANNED', 'PREPARED', 'SUBMITTING', 'SUBMITTED', 'UNRESOLVED', 'FROZEN'])),
        tx.select({ id: tradesTable.id }).from(tradesTable).where(eq(tradesTable.settlementStatus, 'UNSETTLED')),
        tx.select({ id: relayTasksTable.id, status: relayTasksTable.status }).from(relayTasksTable),
      ]);
      const nonTerminal = relay.filter(r => !['CONFIRMED', 'CANCELLED', 'FAILED_PRE_BROADCAST', 'FAILED'].includes(r.status));
      const counts = { open: open.length, approvals: approvals.length, intents: intents.length, protections: protections.length, unsettled: unsettled.length, relay: nonTerminal.length };
      if (Object.values(counts).some(n => n !== 0)) return { status: 'BLOCKED' as const, blockers: Object.entries(counts).filter(([, n]) => n).map(([k]) => `${k.toUpperCase()}_NON_ZERO`) };
      const stateRows = await tx.select().from(workerStateTable);
      const state = new Map(stateRows.map(r => [r.key, r.value]));
      const configRows = await tx.select().from(strategyConfigTable).limit(1);
      if (configRows.length !== 1 || !configRows[0].limits || typeof configRows[0].limits !== 'object' || Array.isArray(configRows[0].limits)) throw new Error('strategy config unavailable');
      const limits = { ...(configRows[0].limits as Record<string, unknown>), tradingCapital: 1000 };
      const daily = { periodStart: dailyPeriodStartUtc(now), equity: 1000, recordedAt: now.toISOString() };
      const weekly = { periodStart: weeklyPeriodStartUtc(now), equity: 1000, recordedAt: now.toISOString() };
      const activePrevious = state.get(PAPER_EPOCH_ACTIVE_KEY) ?? null;
      const risk = initialRiskEngineState(now, 1000);
      const binding = buildPaperEpochBinding(active, limits, daily, weekly, risk);
      const audit = {
        schemaVersion: 1,
        idempotencyKey,
        epochId,
        appliedAt: now.toISOString(),
        appliedAtMs: now.getTime(),
        before: {
        activeEpoch: activePrevious, equityHwm: state.get('equityHwm') ?? null, daily: state.get(BASELINE_DAILY_KEY) ?? null,
        weekly: state.get(BASELINE_WEEKLY_KEY) ?? null, risk: state.get(RISK_ENGINE_STATE_KEY) ?? null, limits: configRows[0].limits,
        },
        after: { activeEpoch: active, limits, equityHwm: 1000, daily, weekly, risk },
        zeroStateCounts: counts,
        binding,
      };
      const updated = await tx.update(strategyConfigTable).set({ limits, updatedAt: now }).where(eq(strategyConfigTable.id, configRows[0].id)).returning({ id: strategyConfigTable.id });
      if (updated.length !== 1) throw new Error('strategy config update failed');
      const insertedAudit = await tx.insert(workerStateTable).values({ key: active.auditKey, value: JSON.stringify(audit) }).onConflictDoNothing().returning({ key: workerStateTable.key });
      if (insertedAudit.length !== 1) throw new Error('idempotency audit conflict');
      for (const [key, value] of [[PAPER_EPOCH_ACTIVE_KEY, JSON.stringify(active)], ['equityHwm', '1000'], [BASELINE_DAILY_KEY, JSON.stringify(daily)], [BASELINE_WEEKLY_KEY, JSON.stringify(weekly)], [RISK_ENGINE_STATE_KEY, JSON.stringify(risk)]] as const) {
        await tx.insert(workerStateTable).values({ key, value }).onConflictDoUpdate({ target: workerStateTable.key, set: { value, updatedAt: now } });
      }
      return {
        status: 'APPLIED' as const,
        epochId,
        now,
        startedAtMs: now.getTime(),
        daily,
        weekly,
        limits,
        risk,
        equityHwm: 1000,
        resetPeriodValues: true,
      };
    });
    if (outcome.status === 'APPLIED' || outcome.status === 'ALREADY_APPLIED') {
      runtime.applyPaperEpochInMemory(
        outcome.epochId,
        outcome.now,
        outcome.startedAtMs,
        outcome.daily,
        outcome.weekly,
        outcome.limits,
        outcome.risk,
        outcome.equityHwm,
        outcome.resetPeriodValues,
      );
      return { status: outcome.status, epochId: outcome.epochId };
    }
    return outcome;
  } catch {
    return { status: 'BLOCKED', blockers: ['ACTIVATION_FAILED_CLOSED'] };
  } finally { runtime.releasePaperEpochActivationLock(); }
}