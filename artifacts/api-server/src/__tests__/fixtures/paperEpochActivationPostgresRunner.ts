import assert from 'node:assert/strict';
import {
  db, pool,
} from '@workspace/db';
import {
  __setPaperEpochActivationRuntimeForTests,
  activatePaperEpoch,
} from '../../lib/paperEpochActivation';
import {
  PAPER_EPOCH_ACTIVE_KEY,
  verifyActivePaperEpochSnapshot,
} from '../../lib/paperEpochState';
import {
  BASELINE_DAILY_KEY,
  BASELINE_WEEKLY_KEY,
} from '../../lib/equityBaselines';
import { RISK_ENGINE_STATE_KEY } from '../../lib/riskEngineState';

const safeEnv: NodeJS.ProcessEnv = {
  WORKER_ENGINE_MODE: 'PAPER',
  AUTO_WORKER_LIVE_ENABLED: 'false',
  GMX_RELAY_SUBMISSION_ENABLED: 'false',
  GMX_RELAY_NETWORK_ENABLED: 'false',
  GMX_RELAY_MODE: 'DISABLED',
  DELEGATED_SIGNER_ENABLED: 'true',
  GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
  LIVE_TEST_EXECUTION_LOCKED: 'false',
};
const fixedNow = new Date('2026-09-03T19:00:00.000Z');
const previousDaily = JSON.stringify({
  periodStart: '2026-09-03T00:00:00.000Z',
  equity: 24.5,
  recordedAt: '2026-09-03T18:00:00.000Z',
});
const previousWeekly = JSON.stringify({
  periodStart: '2026-08-31T00:00:00.000Z',
  equity: 24.5,
  recordedAt: '2026-09-03T18:00:00.000Z',
});
const previousRisk = JSON.stringify({
  riskOperatingState: 'HARD_STOPPED',
  locks: { hardStopReason: 'historical trigger' },
});
let memoryApplyCount = 0;

function installRuntime(): void {
  memoryApplyCount = 0;
  __setPaperEpochActivationRuntimeForTests({
    getServerPaperStatus: () => ({
      openPosition: null,
      openPositions: [],
      pendingClose: null,
      unresolved: null,
      lastTickAt: null,
      lastTickStale: false,
      lastOpenAttempt: null,
      lastCloseAction: null,
    }) as never,
    applyPaperEpochInMemory: () => {
      memoryApplyCount += 1;
    },
    isPaperEpochActivationHeld: () => false,
    isWorkerCycleInProgress: () => false,
    tryAcquirePaperEpochActivationLock: () => true,
    releasePaperEpochActivationLock: () => undefined,
    now: () => fixedNow,
  });
}

async function resetFixture(): Promise<void> {
  await pool.query(`
    TRUNCATE trades, live_approvals, execution_intents, relay_tasks,
      protection_orders, worker_state, strategy_config;
    INSERT INTO strategy_config (id, limits)
    VALUES (1, '{"tradingCapital":24.5,"reserveCashPct":20,"maxDrawdownPercent":8}');
  `);
  await pool.query(
    `INSERT INTO worker_state (key, value) VALUES
      ('equityHwm', '1000'),
      ('equityBaselineDaily', $1),
      ('equityBaselineWeekly', $2),
      ('riskEngineStateV1', $3)`,
    [previousDaily, previousWeekly, previousRisk],
  );
}

async function waitForBlockedQuery(fragment: string): Promise<{
  waitEventType: string;
  waitEvent: string;
}> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{
      wait_event_type: string;
      wait_event: string;
    }>(`
      SELECT wait_event_type, wait_event
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE $1
      LIMIT 1
    `, [`%${fragment}%`]);
    if (result.rows[0]) {
      return {
        waitEventType: result.rows[0].wait_event_type,
        waitEvent: result.rows[0].wait_event,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`lock waiter not observed for ${fragment}`);
}

async function assertNoWritesBeforeUnlock(): Promise<void> {
  const result = await pool.query(`
    SELECT
      (SELECT limits->>'tradingCapital' FROM strategy_config WHERE id = 1) AS capital,
      (SELECT count(*)::int FROM worker_state
        WHERE key LIKE 'paperEpochActivation:%' OR key = 'paperEpochActiveV1') AS epoch_writes
  `);
  assert.equal(result.rows[0].capital, '24.5');
  assert.equal(result.rows[0].epoch_writes, 0);
}

async function lockAndActivate(
  idempotencyKey: string,
  holderSql: string,
  expectedWaitQuery: string,
): Promise<{ waitEventType: string; waitEvent: string }> {
  await resetFixture();
  installRuntime();
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(holderSql);
    const activation = activatePaperEpoch(idempotencyKey, safeEnv);
    const lockEvidence = await waitForBlockedQuery(expectedWaitQuery);
    await assertNoWritesBeforeUnlock();
    await holder.query('COMMIT');
    const outcome = await activation;
    assert.equal(outcome.status, 'APPLIED');
    return lockEvidence;
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
}

async function verifyRollback(): Promise<void> {
  await resetFixture();
  installRuntime();
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_epoch_hwm_write() RETURNS trigger AS $$
    BEGIN
      IF NEW.key = 'equityHwm' THEN
        RAISE EXCEPTION 'injected epoch write failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_epoch_hwm_write
      BEFORE INSERT OR UPDATE ON worker_state
      FOR EACH ROW EXECUTE FUNCTION fail_epoch_hwm_write();
  `);
  try {
    const outcome = await activatePaperEpoch('postgres-rollback', safeEnv);
    assert.deepEqual(outcome, {
      status: 'BLOCKED',
      blockers: ['ACTIVATION_FAILED_CLOSED'],
    });
  } finally {
    await pool.query('DROP TRIGGER fail_epoch_hwm_write ON worker_state');
    await pool.query('DROP FUNCTION fail_epoch_hwm_write()');
  }
  const config = await pool.query('SELECT limits FROM strategy_config WHERE id = 1');
  const states = await pool.query('SELECT key, value FROM worker_state ORDER BY key');
  assert.equal(config.rows[0].limits.tradingCapital, 24.5);
  assert.deepEqual(states.rows, [
    { key: BASELINE_DAILY_KEY, value: previousDaily },
    { key: BASELINE_WEEKLY_KEY, value: previousWeekly },
    { key: 'equityHwm', value: '1000' },
    { key: RISK_ENGINE_STATE_KEY, value: previousRisk },
  ]);
  assert.equal(memoryApplyCount, 0);
}

async function activateAndReplay(): Promise<{
  epochId: string;
  stateCount: number;
  auditCount: number;
}> {
  await resetFixture();
  installRuntime();
  const first = await activatePaperEpoch('postgres-binding', safeEnv);
  assert.equal(first.status, 'APPLIED');
  if (first.status !== 'APPLIED') throw new Error('activation did not apply');

  const beforeReplay = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM worker_state) AS state_count,
      (SELECT count(*)::int FROM worker_state
        WHERE key LIKE 'paperEpochActivation:%') AS audit_count,
      (SELECT row_to_json(config_row) FROM (
        SELECT indicators, limits, updated_at FROM strategy_config WHERE id = 1
      ) config_row) AS config_row,
      (SELECT jsonb_agg(jsonb_build_object(
        'key', key, 'value', value, 'updatedAt', updated_at
      ) ORDER BY key) FROM worker_state) AS state_rows
  `);
  const replay = await activatePaperEpoch('postgres-binding', safeEnv);
  assert.deepEqual(replay, { status: 'ALREADY_APPLIED', epochId: first.epochId });
  const afterReplay = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM worker_state) AS state_count,
      (SELECT count(*)::int FROM worker_state
        WHERE key LIKE 'paperEpochActivation:%') AS audit_count,
      (SELECT row_to_json(config_row) FROM (
        SELECT indicators, limits, updated_at FROM strategy_config WHERE id = 1
      ) config_row) AS config_row,
      (SELECT jsonb_agg(jsonb_build_object(
        'key', key, 'value', value, 'updatedAt', updated_at
      ) ORDER BY key) FROM worker_state) AS state_rows
  `);
  assert.deepEqual(afterReplay.rows[0], beforeReplay.rows[0]);
  assert.equal(memoryApplyCount, 2);
  return {
    epochId: first.epochId,
    stateCount: afterReplay.rows[0].state_count,
    auditCount: afterReplay.rows[0].audit_count,
  };
}

async function reloadAndVerify(): Promise<{
  epochId: string;
  capitalUsd: number;
  equityHwmUsd: number;
  dailyBaselineUsd: number;
  weeklyBaselineUsd: number;
  riskState: string;
  tamperRejected: boolean;
}> {
  const result = await pool.query(`
    SELECT
      (SELECT limits FROM strategy_config WHERE id = 1) AS limits,
      (SELECT jsonb_object_agg(key, value ORDER BY key) FROM worker_state) AS states
  `);
  const { limits, states } = result.rows[0];
  const auditKey = 'paperEpochActivation:postgres-binding';
  const input = {
    activeRaw: states[PAPER_EPOCH_ACTIVE_KEY],
    auditRaw: states[auditKey],
    equityHwmRaw: states.equityHwm,
    limits,
    dailyRaw: states[BASELINE_DAILY_KEY],
    weeklyRaw: states[BASELINE_WEEKLY_KEY],
    riskRaw: states[RISK_ENGINE_STATE_KEY],
    nowMs: fixedNow.getTime(),
  };
  const verified = verifyActivePaperEpochSnapshot(input);
  if (!verified.ok) throw new Error(verified.reason);
  assert.equal(verified.ok, true);
  assert.equal(verified.value.activeEpoch.activeCapitalUsd, 1000);
  assert.equal(verified.value.activeEpoch.executionAuthorized, false);
  assert.equal(Number(states.equityHwm), 1000);
  assert.equal(JSON.parse(states[BASELINE_DAILY_KEY]).equity, 1000);
  assert.equal(JSON.parse(states[BASELINE_WEEKLY_KEY]).equity, 1000);
  const risk = JSON.parse(states[RISK_ENGINE_STATE_KEY]);
  assert.equal(risk.riskOperatingState, 'NORMAL');
  assert.equal(risk.startOfDayEquityUsd, 1000);
  assert.equal(risk.startOfWeekEquityUsd, 1000);

  const tampered = JSON.parse(input.activeRaw);
  tampered.activeCapitalUsd = 2500;
  const tamperResult = verifyActivePaperEpochSnapshot({
    ...input,
    activeRaw: JSON.stringify(tampered),
  });
  assert.equal(tamperResult.ok, false);
  return {
    epochId: verified.value.activeEpoch.epochId,
    capitalUsd: verified.value.activeEpoch.activeCapitalUsd,
    equityHwmUsd: Number(states.equityHwm),
    dailyBaselineUsd: JSON.parse(states[BASELINE_DAILY_KEY]).equity,
    weeklyBaselineUsd: JSON.parse(states[BASELINE_WEEKLY_KEY]).equity,
    riskState: risk.riskOperatingState,
    tamperRejected: !tamperResult.ok,
  };
}

async function main(): Promise<void> {
  try {
    const mode = process.argv[2];
    if (mode === 'exercise') {
      const advisory = await lockAndActivate(
        'postgres-advisory',
        'SELECT pg_advisory_xact_lock(814320019)',
        'pg_advisory_xact_lock(814320019)',
      );
      const table = await lockAndActivate(
        'postgres-table-lock',
        'LOCK TABLE strategy_config IN ROW EXCLUSIVE MODE',
        'LOCK TABLE strategy_config IN SHARE ROW EXCLUSIVE MODE',
      );
      await verifyRollback();
      const binding = await activateAndReplay();
      console.log(JSON.stringify({ advisory, table, binding }));
    } else if (mode === 'reload') {
      console.log(JSON.stringify(await reloadAndVerify()));
    } else {
      throw new Error(`unknown runner mode: ${String(mode)}`);
    }
  } finally {
    __setPaperEpochActivationRuntimeForTests(null);
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});