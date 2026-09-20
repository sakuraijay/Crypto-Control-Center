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

function runChild(mode: 'seed' | 'reload'): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [runnerFile, mode], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    env: childEnv(),
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout.trim());
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
    CREATE VIEW trades AS SELECT
      NULL::text AS id, NULL::text AS symbol, NULL::text AS side,
      NULL::text AS action, NULL::numeric AS size, NULL::numeric AS price,
      NULL::numeric AS pnl, NULL::text AS strategy, NULL::timestamp AS timestamp,
      NULL::bigint AS close_time, NULL::timestamp AS created_at,
      NULL::text AS gmx_market_address, NULL::text AS collateral_token,
      NULL::numeric AS size_in_usd, NULL::numeric AS leverage,
      NULL::numeric AS collateral_usd, NULL::boolean AS test_mode,
      NULL::numeric AS gross_pnl_usd, NULL::numeric AS position_fee_usd,
      NULL::numeric AS execution_fee_usd, NULL::numeric AS price_impact_usd,
      NULL::numeric AS funding_fee_usd, NULL::numeric AS borrowing_fee_usd,
      NULL::numeric AS net_pnl_usd, NULL::text AS settlement_status,
      NULL::timestamptz AS settled_at, NULL::text AS evidence_tx_hash,
      NULL::text AS cost_source, NULL::numeric AS est_entry_cost_usd,
      NULL::numeric AS est_exit_cost_usd, NULL::numeric AS est_holding_cost_usd,
      NULL::numeric AS funding_rate_per_hour, NULL::numeric AS borrowing_rate_per_hour,
      NULL::timestamptz AS cost_fetched_at, NULL::numeric AS net_pnl_estimated_usd,
      NULL::text AS managed_by, NULL::text AS open_decision_id,
      NULL::text AS closes_trade_id, NULL::text AS close_kind,
      NULL::text AS close_reason, NULL::numeric AS stop_price_usd,
      NULL::numeric AS take_profit_price_usd, NULL::jsonb AS risk_profile_snapshot,
      NULL::integer AS paper_position_slot, NULL::text AS settlement_account,
      NULL::text AS settlement_market_address,
      NULL::text AS settlement_collateral_token,
      NULL::text AS settlement_position_key, NULL::numeric AS pre_close_size_usd,
      NULL::text AS pre_close_size_usd_30, NULL::numeric AS requested_reduction_usd,
      NULL::text AS requested_reduction_usd_30, NULL::text AS settlement_intent_id,
      NULL::text AS settlement_relay_task_id, NULL::text AS settlement_order_key,
      NULL::text AS settlement_emitter_address, NULL::text AS settlement_block_number,
      NULL::text AS settlement_latest_block, NULL::integer AS settlement_confirmations,
      NULL::text AS settlement_evidence_basis,
      NULL::timestamptz AS settlement_evidence_at
    WHERE false;
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
});
