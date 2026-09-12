import { describe, expect, it, vi } from 'vitest';

const forbiddenLoads = vi.hoisted(() => [] as string[]);

function forbiddenModule(name: string): never {
  forbiddenLoads.push(name);
  throw new Error(`forbidden Candle Signal import: ${name}`);
}

vi.mock('@workspace/db', () => forbiddenModule('@workspace/db'));
vi.mock('drizzle-orm', () => forbiddenModule('drizzle-orm'));
vi.mock('../intel/dataSource', () => forbiddenModule('intel/dataSource'));
vi.mock('../intel/intelCycle', () => forbiddenModule('intel/intelCycle'));
vi.mock('../routes/gmx', () => forbiddenModule('routes/gmx'));
vi.mock('../lib/executionIntents', () => forbiddenModule('executionIntents'));
vi.mock('../lib/riskStateMachine', () => forbiddenModule('riskStateMachine'));
vi.mock('../lib/riskSizing', () => forbiddenModule('riskSizing'));
vi.mock('../lib/gmxApiExecution', () => forbiddenModule('gmxApiExecution'));
vi.mock('../workers/aiWorker', () => forbiddenModule('aiWorker'));
vi.mock('../workers/serverPaperExecutor', () => forbiddenModule('serverPaperExecutor'));
vi.mock('../workers/liveTestExecutor', () => forbiddenModule('liveTestExecutor'));

describe('Candle Signal Core import isolation', () => {
  it('loads pure contract/features/core without DB, RPC, execution, risk, or worker modules', async () => {
    const [contract, features, core] = await Promise.all([
      import('../intel/candleSignalContract'),
      import('../intel/candleSignalFeatures'),
      import('../intel/candleSignalCore'),
    ]);
    expect(contract.CANDLE_SIGNAL_SCHEMA_VERSION).toBe('candle-signal/v1');
    expect(features.computeCandleRsi).toBeTypeOf('function');
    expect(core.evaluateCandleSignal).toBeTypeOf('function');
    expect(forbiddenLoads).toEqual([]);
  });
});