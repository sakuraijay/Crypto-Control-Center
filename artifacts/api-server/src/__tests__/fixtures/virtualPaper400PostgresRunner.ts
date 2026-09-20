import assert from 'node:assert/strict';
import { db, pool, workerStateTable } from '@workspace/db';
import {
  initialVirtualPaper400RiskState,
  virtualPaper400RiskKey,
} from '../../workers/virtualPaper400Accounting';
import { maybeRunVirtualPaper400Cycle } from '../../workers/virtualPaper400Runtime';
import {
  buildActiveVirtualPaper400SessionState,
  buildStoppedVirtualPaper400SessionState,
  VIRTUAL_PAPER_400_SESSION_STATE_KEY,
} from '../../workers/virtualPaper400SessionState';

const SESSION_ID = 'postgres-restart-session';
const STARTED_AT = new Date('2026-09-20T14:21:14.615Z');

async function seed(): Promise<void> {
  const active = buildActiveVirtualPaper400SessionState(SESSION_ID, STARTED_AT);
  const stopped = buildStoppedVirtualPaper400SessionState(
    active,
    'isolated PostgreSQL restart fixture',
  );
  const risk = initialVirtualPaper400RiskState(stopped.session);
  risk.risk.locks.hardStopReason = 'preserved historical virtual stop';
  risk.equityHwmUsd = 425;

  await pool.query('TRUNCATE worker_state');
  await pool.query(
    `INSERT INTO worker_state (key, value) VALUES
      ($1, $2), ($3, $4), ('riskEngineStateV1', 'STANDARD_SENTINEL'),
      ('fixed_beta_accounting_state_v1', 'FIXED_BETA_SENTINEL')`,
    [
      VIRTUAL_PAPER_400_SESSION_STATE_KEY,
      JSON.stringify(stopped),
      virtualPaper400RiskKey(stopped.session),
      JSON.stringify(risk),
    ],
  );
}

async function snapshot(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(workerStateTable);
  const values = new Map(rows.map(row => [row.key, row.value]));
  const sessionRaw = values.get(VIRTUAL_PAPER_400_SESSION_STATE_KEY);
  assert.ok(sessionRaw);
  const session = JSON.parse(sessionRaw);
  const riskKey = virtualPaper400RiskKey(session.session);
  const riskRaw = values.get(riskKey);
  const runtimeRaw = values.get('virtual_paper_400_runtime_v1');
  assert.ok(riskRaw);
  assert.ok(runtimeRaw);
  const risk = JSON.parse(riskRaw);
  const runtime = JSON.parse(runtimeRaw);
  return {
    sessionId: session.session.sessionId,
    strategyTag: session.session.strategyTag,
    startedAt: session.session.startedAt,
    status: session.status,
    equityHwmUsd: risk.equityHwmUsd,
    hardStopReason: risk.risk.locks.hardStopReason,
    runtimeStatus: runtime.status,
    realFundsUsed: runtime.realFundsUsed,
    standardState: values.get('riskEngineStateV1'),
    fixedBetaState: values.get('fixed_beta_accounting_state_v1'),
    sessionRows: rows.filter(
      row => row.key === VIRTUAL_PAPER_400_SESSION_STATE_KEY,
    ).length,
  };
}

async function run(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'seed') await seed();
  assert.equal(
    await maybeRunVirtualPaper400Cycle({
      cycleNumber: mode === 'seed' ? 1 : 2,
      quote: () => ({ priceUsd: 50_000, ageMs: 0 }),
      shouldContinue: () => true,
    }),
    true,
  );
  process.stdout.write(JSON.stringify(await snapshot()));
}

run()
  .finally(() => pool.end())
  .catch(error => {
    process.stderr.write(String(error?.stack ?? error));
    process.exitCode = 1;
  });
