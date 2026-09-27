import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LOCK_ID = 4_000_920;
const STARTED_AT = new Date('2026-09-20T14:21:14.615Z');
const REPLAY_NOW = Date.parse('2026-09-20T04:00:10.000Z');
let rootDir = '';
let dataDir = '';
let socketDir = '';
let runnerFile = '';
let databaseUrl = '';
let port = 0;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('temporary PostgreSQL port unavailable');
  const selected = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
  return selected;
}

function childEnv(): NodeJS.ProcessEnv {
  const apiServerDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_PATH: [
      join(apiServerDir, 'node_modules'),
      resolve(apiServerDir, '../../lib/db/node_modules'),
      resolve(apiServerDir, '../../node_modules'),
    ].join(':'),
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    WORKER_ENGINE_MODE: 'PAPER',
    AUTO_WORKER_LIVE_ENABLED: 'false',
    GMX_RELAY_SUBMISSION_ENABLED: 'false',
    GMX_RELAY_NETWORK_ENABLED: 'false',
    GMX_RELAY_MODE: 'DISABLED',
    DELEGATED_SIGNER_ENABLED: 'false',
    GMX_API_ORDER_SUBMISSION_ENABLED: 'false',
    LIVE_TEST_EXECUTION_LOCKED: 'true',
  };
}

function pgCtl(action: 'start' | 'stop'): void {
  if (action === 'start') {
    execFileSync('pg_ctl', [
      '-D', dataDir,
      '-l', join(rootDir, 'postgres.log'),
      '-o', `-F -p ${port} -k ${socketDir} -h 127.0.0.1`,
      '-w', 'start',
    ], { stdio: 'pipe' });
    return;
  }
  execFileSync('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
}

function psql(sql: string): string {
  return execFileSync('psql', [databaseUrl, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: childEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runChild(mode: 'seed' | 'reload' | 'lifecycle-open' | 'lifecycle-close' | 'lifecycle-recheck'): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [runnerFile, mode], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    env: childEnv(),
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lastLine = stdout.trim().split('\n').at(-1);
  if (!lastLine) throw new Error(`PostgreSQL runner produced no output for ${mode}`);
  return JSON.parse(lastLine);
}

function fingerprint(): string {
  return psql(`SELECT md5(COALESCE(string_agg(key || '=' || value, '|' ORDER BY key), ''))
    FROM worker_state`);
}

async function waitForAdvisoryHolder(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (psql(`SELECT NOT pg_try_advisory_lock(${LOCK_ID})`) === 't') return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error('virtual advisory lock holder was not observed');
}

function stopHolder(holder: ChildProcess): Promise<void> {
  if (holder.exitCode !== null) return Promise.resolve();
  return new Promise(resolveExit => {
    holder.once('exit', () => resolveExit());
    holder.kill('SIGTERM');
  });
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'virtual400-pg-'));
  dataDir = join(rootDir, 'data');
  socketDir = join(rootDir, 'socket');
  runnerFile = join(rootDir, 'virtual400-postgres-runner.cjs');
  mkdirSync(dataDir);
  mkdirSync(socketDir);
  symlinkSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules'),
    join(rootDir, 'node_modules'),
    'dir',
  );
  port = await freePort();
  databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;

  execFileSync('initdb', [
    '-D', dataDir,
    '--auth=trust',
    '--username=postgres',
    '--no-locale',
  ], { stdio: 'pipe' });
  pgCtl('start');
  psql(`
    CREATE TABLE worker_state (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE trades (
      id text PRIMARY KEY, symbol text NOT NULL, side text NOT NULL,
      action text NOT NULL, size numeric(18,8) NOT NULL, price numeric(18,8) NOT NULL,
      pnl numeric(18,8) NOT NULL DEFAULT 0, strategy text NOT NULL DEFAULT 'Manual',
      timestamp timestamp NOT NULL, close_time bigint NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now(), gmx_market_address text,
      collateral_token text DEFAULT 'USDC', size_in_usd numeric(18,4),
      leverage numeric(8,2), collateral_usd numeric(18,4),
      test_mode boolean NOT NULL DEFAULT false, gross_pnl_usd numeric(18,8),
      position_fee_usd numeric(18,8), execution_fee_usd numeric(18,8),
      price_impact_usd numeric(18,8), funding_fee_usd numeric(18,8),
      borrowing_fee_usd numeric(18,8), net_pnl_usd numeric(18,8),
      settlement_status text NOT NULL DEFAULT 'UNSETTLED', settled_at timestamptz,
      evidence_tx_hash text, cost_source text, est_entry_cost_usd numeric(18,8),
      est_exit_cost_usd numeric(18,8), est_holding_cost_usd numeric(18,8),
      funding_rate_per_hour numeric(18,12), borrowing_rate_per_hour numeric(18,12),
      cost_fetched_at timestamptz, net_pnl_estimated_usd numeric(18,8),
      managed_by text, open_decision_id text, closes_trade_id text,
      close_kind text, close_reason text, stop_price_usd numeric(18,8),
      take_profit_price_usd numeric(18,8), risk_profile_snapshot jsonb,
      paper_position_slot integer CHECK (paper_position_slot IS NULL OR paper_position_slot IN (1,2)),
      settlement_account text, settlement_market_address text,
      settlement_collateral_token text, settlement_position_key text,
      pre_close_size_usd numeric(18,4), pre_close_size_usd_30 text,
      requested_reduction_usd numeric(18,4), requested_reduction_usd_30 text,
      settlement_intent_id text, settlement_relay_task_id text,
      settlement_order_key text, settlement_emitter_address text,
      settlement_block_number text, settlement_latest_block text,
      settlement_confirmations integer, settlement_evidence_basis text,
      settlement_evidence_at timestamptz
    );
    CREATE UNIQUE INDEX trades_open_decision_uq ON trades (open_decision_id)
      WHERE open_decision_id IS NOT NULL;
    CREATE UNIQUE INDEX trades_server_open_slot_uq ON trades (paper_position_slot)
      WHERE managed_by = 'SERVER' AND action = 'OPEN' AND close_time = 0
        AND paper_position_slot IS NOT NULL;
    CREATE UNIQUE INDEX trades_server_open_symbol_uq ON trades ((upper(symbol)))
      WHERE managed_by = 'SERVER' AND action = 'OPEN' AND close_time = 0;
    CREATE UNIQUE INDEX trades_full_close_uq ON trades (closes_trade_id)
      WHERE closes_trade_id IS NOT NULL AND close_kind = 'FULL';
    CREATE UNIQUE INDEX trades_reduce70_close_uq ON trades (closes_trade_id)
      WHERE closes_trade_id IS NOT NULL AND close_kind = 'REDUCE70';
  `);

  buildSync({
    entryPoints: [
      resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/virtualPaper400PostgresRunner.ts'),
    ],
    outfile: runnerFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: 'inline',
    packages: 'external',
    logLevel: 'silent',
    alias: {
      '@workspace/db': resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../lib/db/src/index.ts',
      ),
    },
  });
}, 30_000);

afterAll(() => {
  if (dataDir && existsSync(join(dataDir, 'PG_VERSION'))) {
    try {
      pgCtl('stop');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  } else if (rootDir) {
    rmSync(rootDir, { recursive: true, force: true });
  }
}, 30_000);

describe('Virtual400 runtime on isolated temporary PostgreSQL', () => {
  it('preserves the session/risk namespace across an actual database restart and rejects a concurrent cycle', async () => {
    const seeded = runChild('seed');
    expect(seeded).toEqual({
      sessionId: 'postgres-restart-session',
      strategyTag: 'SERVER_WORKER_AI_VIRTUAL_400_V1:postgres-restart-session',
      startedAt: STARTED_AT.toISOString(),
      status: 'STOPPED',
      equityHwmUsd: 425,
      hardStopReason: 'preserved historical virtual stop',
      runtimeStatus: 'STOPPED',
      realFundsUsed: false,
      standardState: 'STANDARD_SENTINEL',
      fixedBetaState: 'FIXED_BETA_SENTINEL',
      sessionRows: 1,
    });

    pgCtl('stop');
    pgCtl('start');
    expect(runChild('reload')).toEqual(seeded);

    const before = fingerprint();
    const holder = spawn('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c',
      `BEGIN; SELECT pg_advisory_xact_lock(${LOCK_ID}); SELECT pg_sleep(30); COMMIT;`], {
      env: childEnv(),
      stdio: 'ignore',
    });
    try {
      await waitForAdvisoryHolder();
      expect(runChild('reload')).toEqual(seeded);
      expect(fingerprint()).toBe(before);
    } finally {
      await stopHolder(holder);
    }
  }, 45_000);

  it('runs raw closed candles through Risk, the real PAPER executor, a database restart, protection and net settlement', () => {
    const opened = runChild('lifecycle-open');
    expect(opened).toMatchObject({
      status: 'OPENED',
      openRows: 1,
      closeRows: 0,
      realFundsUsed: false,
      sessionId: 'postgres-raw-candle-replay',
      strategyTag: 'SERVER_WORKER_AI_VIRTUAL_400_V1:postgres-raw-candle-replay',
      startedAt: new Date(REPLAY_NOW - 1_000).toISOString(),
      standardState: 'STANDARD_SENTINEL',
      fixedBetaState: 'FIXED_BETA_SENTINEL',
    });
    expect(Number(opened['notionalUsd'])).toBeGreaterThan(0);
    expect(Number(opened['notionalUsd'])).toBeLessThanOrEqual(200);
    expect(opened['leverage']).toBe('10.00');

    pgCtl('stop');
    pgCtl('start');

    const closed = runChild('lifecycle-close');
    expect(closed).toMatchObject({
      status: 'SETTLED',
      openRows: 0,
      closeRows: 1,
      settlementStatus: 'PAPER_ESTIMATED',
      closeReason: 'STOP_LOSS',
      settlementCount: 1,
      sessionId: opened['sessionId'],
      strategyTag: opened['strategyTag'],
      startedAt: opened['startedAt'],
      standardState: 'STANDARD_SENTINEL',
      fixedBetaState: 'FIXED_BETA_SENTINEL',
    });
    expect(Number(closed['modeledTradingCostUsd'])).toBeGreaterThan(0);
    expect(Number(closed['netPnlUsd'])).toBeLessThan(0);
    expect(Number(closed['realizedEquityUsd'])).toBeLessThan(400);

    expect(runChild('lifecycle-recheck')).toEqual(closed);
  }, 45_000);
});
