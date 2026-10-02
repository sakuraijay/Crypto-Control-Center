import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let rootDir = '';
let dataDir = '';
let socketDir = '';
let runnerFile = '';
let databaseUrl = '';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('temporary PostgreSQL port unavailable');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
  return port;
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
    DELEGATED_SIGNER_ENABLED: 'true',
    GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
    LIVE_TEST_EXECUTION_LOCKED: 'false',
  };
}

function runChild(mode: 'exercise' | 'reload'): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [runnerFile, mode], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    env: childEnv(),
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout.trim());
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'paper-epoch-pg-'));
  dataDir = join(rootDir, 'data');
  socketDir = join(rootDir, 'socket');
  runnerFile = join(rootDir, 'paper-epoch-runner.cjs');
  mkdirSync(dataDir);
  mkdirSync(socketDir);
  symlinkSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules'),
    join(rootDir, 'node_modules'),
    'dir',
  );
  const port = await freePort();
  databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;

  execFileSync('initdb', [
    '-D', dataDir,
    '--auth=trust',
    '--username=postgres',
    '--no-locale',
  ], { stdio: 'pipe' });
  execFileSync('pg_ctl', [
    '-D', dataDir,
    '-l', join(rootDir, 'postgres.log'),
    '-o', `-F -p ${port} -k ${socketDir} -h 127.0.0.1`,
    '-w', 'start',
  ], { stdio: 'pipe' });

  execFileSync('psql', [
    databaseUrl,
    '-v', 'ON_ERROR_STOP=1',
    '-c', `
      CREATE TABLE trades (
        id text PRIMARY KEY, action text, close_time bigint, settlement_status text
      );
      CREATE TABLE live_approvals (id text PRIMARY KEY, status text);
      CREATE TABLE execution_intents (id text PRIMARY KEY, status text);
      CREATE TABLE relay_tasks (id text PRIMARY KEY, status text);
      CREATE TABLE protection_orders (id text PRIMARY KEY, status text);
      CREATE TABLE worker_state (
        key text PRIMARY KEY, value text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE strategy_config (
        id integer PRIMARY KEY, indicators jsonb NOT NULL DEFAULT '[]',
        limits jsonb NOT NULL, updated_at timestamp NOT NULL DEFAULT now()
      );
    `,
  ], { env: childEnv(), stdio: 'pipe' });

  buildSync({
    entryPoints: [
      resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/paperEpochActivationPostgresRunner.ts'),
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
      execFileSync('pg_ctl', [
        '-D', dataDir,
        '-m', 'immediate',
        '-w', 'stop',
      ], { stdio: 'pipe' });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  } else if (rootDir) {
    rmSync(rootDir, { recursive: true, force: true });
  }
}, 30_000);

describe('PAPER epoch activation on isolated temporary PostgreSQL', () => {
  it('proves locks, rollback, binding, replay, and fresh-process reload', () => {
    const exercise = runChild('exercise');
    expect(exercise).toMatchObject({
      advisory: { waitEventType: 'Lock', waitEvent: 'advisory' },
      table: { waitEventType: 'Lock', waitEvent: 'relation' },
      binding: {
        epochId: 'paper-1788462000000-postgres-binding',
        auditCount: 1,
      },
    });

    const reload = runChild('reload');
    expect(reload).toEqual({
      epochId: 'paper-1788462000000-postgres-binding',
      capitalUsd: 1000,
      equityHwmUsd: 1000,
      dailyBaselineUsd: 1000,
      weeklyBaselineUsd: 1000,
      riskState: 'NORMAL',
      tamperRejected: true,
    });
  });
});