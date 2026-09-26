import assert from 'node:assert/strict';
import { db, pool, tradesTable, workerStateTable, type DbTrade } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
  evaluateVirtualPaper400Account,
  initialVirtualPaper400RiskState,
  virtualPaper400RiskKey,
} from '../../workers/virtualPaper400Accounting';
import { maybeRunVirtualPaper400Cycle } from '../../workers/virtualPaper400Runtime';
import { runVirtualPaper400Cycle } from '../../workers/virtualPaper400Cycle';
import {
  buildActiveVirtualPaper400SessionState,
  buildStoppedVirtualPaper400SessionState,
  VIRTUAL_PAPER_400_SESSION_STATE_KEY,
} from '../../workers/virtualPaper400SessionState';
import {
  __resetServerPaperStateForTests,
  loadServerOpenRows,
  manageServerPaperTick,
  openServerPaperPosition,
} from '../../workers/serverPaperExecutor';
import { storePaperCostSnapshot } from '../../lib/paperCostCache';
import { rawCandleVirtualReplaySignal } from '../helpers/virtualPaper400RawCandleReplay';
import { virtualReplayCost } from '../helpers/virtualPaper400Replay';

const SESSION_ID = 'postgres-restart-session';
const STARTED_AT = new Date('2026-09-20T14:21:14.615Z');
const REPLAY_NOW = Date.parse('2026-09-20T04:00:10.000Z');

async function upsertState(key: string, value: unknown): Promise<void> {
  await db.insert(workerStateTable).values({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: workerStateTable.key,
    set: {
      value: typeof value === 'string' ? value : JSON.stringify(value),
      updatedAt: new Date(),
    },
  });
}

async function stateValue(key: string): Promise<string | undefined> {
  return (await db.select().from(workerStateTable).where(eq(workerStateTable.key, key)))[0]?.value;
}

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

async function lifecycleOpen(): Promise<Record<string, unknown>> {
  const now = new Date(REPLAY_NOW);
  const active = buildActiveVirtualPaper400SessionState(
    'postgres-raw-candle-replay',
    new Date(REPLAY_NOW - 1_000),
  );
  let saved = initialVirtualPaper400RiskState(active.session);
  await pool.query('TRUNCATE trades, worker_state');
  await upsertState(VIRTUAL_PAPER_400_SESSION_STATE_KEY, active);
  await upsertState(virtualPaper400RiskKey(active.session), saved);
  await upsertState('riskEngineStateV1', 'STANDARD_SENTINEL');
  await upsertState('fixed_beta_accounting_state_v1', 'FIXED_BETA_SENTINEL');

  const signal = rawCandleVirtualReplaySignal(REPLAY_NOW);
  const costFor = (size: number) => virtualReplayCost(REPLAY_NOW, size);
  const quote = () => ({ priceUsd: signal.entryPrice!, ageMs: 0 });
  const result = await runVirtualPaper400Cycle({
    now,
    engineMode: 'PAPER',
    policyAppliedAt: now.toISOString(),
    sessionRaw: JSON.stringify(active),
    previous: saved,
    rows: [],
    quote,
    shouldContinue: () => true,
    persistRisk: async state => {
      saved = state;
      await upsertState(virtualPaper400RiskKey(active.session), state);
    },
    readSignals: async () => [signal],
    readCost: async (_symbol, _long, size) => costFor(size),
    claim: async (id, audit) => {
      const inserted = await db.insert(workerStateTable).values({
        key: id, value: JSON.stringify(audit), updatedAt: now,
      }).onConflictDoNothing().returning({ key: workerStateTable.key });
      return inserted.length === 1;
    },
    open: async (args, cost) => {
      storePaperCostSnapshot(args.symbol, cost, args.nowMs);
      return openServerPaperPosition(args);
    },
    close: async () => { throw new Error('unexpected risk close'); },
    reduce: async () => { throw new Error('unexpected risk reduction'); },
  });
  const rows = await db.select().from(tradesTable);
  const open = rows.find(row => row.action === 'OPEN');
  return {
    status: result.status,
    openRows: rows.filter(row => row.action === 'OPEN' && row.closeTime === 0).length,
    closeRows: rows.filter(row => row.action === 'CLOSE').length,
    realFundsUsed: result.realFundsUsed,
    sessionId: active.session.sessionId,
    strategyTag: open?.strategy,
    startedAt: active.session.startedAt,
    notionalUsd: open?.sizeInUsd,
    leverage: open?.leverage,
    stopPriceUsd: open?.stopPriceUsd,
    standardState: await stateValue('riskEngineStateV1'),
    fixedBetaState: await stateValue('fixed_beta_accounting_state_v1'),
  };
}

async function lifecycleSettlement(): Promise<Record<string, unknown>> {
  __resetServerPaperStateForTests();
  const sessionRaw = await stateValue(VIRTUAL_PAPER_400_SESSION_STATE_KEY);
  assert.ok(sessionRaw);
  const session = JSON.parse(sessionRaw);
  const riskRaw = await stateValue(virtualPaper400RiskKey(session.session));
  assert.ok(riskRaw);
  const previous = JSON.parse(riskRaw);
  const before = await db.select().from(tradesTable);
  const open = before.find(row => row.action === 'OPEN');
  assert.ok(open?.stopPriceUsd);
  const stopPrice = Number(open.stopPriceUsd);
  const quote = () => ({ priceUsd: stopPrice - 0.01, ageMs: 0 });
  await manageServerPaperTick(quote, REPLAY_NOW + 3_600_000);
  const rows = await db.select().from(tradesTable);
  const close = rows.find(row => row.action === 'CLOSE');
  assert.ok(close);
  const account = evaluateVirtualPaper400Account({
    session: session.session,
    previous,
    rows: rows as DbTrade[],
    now: new Date(REPLAY_NOW + 3_600_001),
    quote,
  });
  return {
    status: 'SETTLED',
    sessionId: session.session.sessionId,
    strategyTag: close.strategy,
    startedAt: session.session.startedAt,
    openRows: (await loadServerOpenRows()).length,
    closeRows: rows.filter(row => row.action === 'CLOSE').length,
    settlementStatus: close.settlementStatus,
    closeReason: close.closeReason,
    netPnlUsd: close.netPnlEstimatedUsd,
    settlementCount: account.ledger.settlementCount,
    modeledTradingCostUsd: account.ledger.modeledTradingCostUsd,
    realizedEquityUsd: account.ledger.realizedEquityUsd,
    standardState: await stateValue('riskEngineStateV1'),
    fixedBetaState: await stateValue('fixed_beta_accounting_state_v1'),
  };
}

async function run(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'lifecycle-open') {
    process.stdout.write(`${JSON.stringify(await lifecycleOpen())}\n`);
    return;
  }
  if (mode === 'lifecycle-close' || mode === 'lifecycle-recheck') {
    process.stdout.write(`${JSON.stringify(await lifecycleSettlement())}\n`);
    return;
  }
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
