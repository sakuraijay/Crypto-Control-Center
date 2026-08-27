import { describe, expect, it, vi } from 'vitest';

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
  it('loads without DB, network, worker, signer, relay, or execution modules', async () => {
    const module = await import('../intel/offlineWalkForwardBacktestV2');
    expect(module.runOfflineWalkForwardBacktest).toBeTypeOf('function');
    expect(module.OFFLINE_WALK_FORWARD_SCHEMA_VERSION).toBe('offline-walk-forward/v1');
    expect(forbiddenLoads).toEqual([]);
  });
});
