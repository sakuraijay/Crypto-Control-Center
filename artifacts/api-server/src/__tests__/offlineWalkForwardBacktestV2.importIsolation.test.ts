import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const forbiddenLoads = vi.hoisted(() => [] as string[]);

function forbiddenModule(name: string): never {
  forbiddenLoads.push(name);
  throw new Error(`forbidden offline backtest import: ${name}`);
}

vi.mock('@workspace/db', () => forbiddenModule('@workspace/db'));
vi.mock('drizzle-orm', () => forbiddenModule('drizzle-orm'));
vi.mock('../intel/dataSource', () => forbiddenModule('intel/dataSource'));
vi.mock('../intel/intelCycle', () => forbiddenModule('intel/intelCycle'));
vi.mock('../routes/gmx', () => forbiddenModule('routes/gmx'));
vi.mock('../lib/executionIntents', () => forbiddenModule('executionIntents'));
vi.mock('../lib/gmxApiExecution', () => forbiddenModule('gmxApiExecution'));
vi.mock('../lib/gmxApiSubmitFlow', () => forbiddenModule('gmxApiSubmitFlow'));
vi.mock('../lib/delegatedSigner', () => forbiddenModule('delegatedSigner'));
vi.mock('../lib/relayLifecycle', () => forbiddenModule('relayLifecycle'));
vi.mock('../workers/aiWorker', () => forbiddenModule('aiWorker'));
vi.mock('../workers/serverPaperExecutor', () => forbiddenModule('serverPaperExecutor'));
vi.mock('../workers/liveTestExecutor', () => forbiddenModule('liveTestExecutor'));

describe('offline walk-forward backtest import isolation', () => {
  it('loads the simulator, replay adapter, report builder, and GET route without forbidden modules', async () => {
    const [core, replay, builder, route] = await Promise.all([
      import('../intel/offlineWalkForwardBacktestV2'),
      import('../intel/offlineDecisionReplayV2'),
      import('../intel/offlineBtcReportBuilderV2'),
      import('../routes/offline-backtest'),
    ]);
    expect(core.runOfflineWalkForwardBacktest).toBeTypeOf('function');
    expect(core.OFFLINE_WALK_FORWARD_SCHEMA_VERSION).toBe('offline-walk-forward/v1');
    expect(replay.replayOfflineDecision).toBeTypeOf('function');
    expect(builder.buildOfflineBtcReport).toBeTypeOf('function');
    expect(route.default).toBeDefined();
    expect(forbiddenLoads).toEqual([]);
  });

  it('keeps the read-only route free of runtime network and write verbs', () => {
    const source = readFileSync(join(__dirname, '..', 'routes', 'offline-backtest.ts'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\b(post|put|patch|delete)\s*\(/i);
    expect(source).not.toContain('@workspace/db');
    expect(source).not.toContain('../workers/');
  });
});
