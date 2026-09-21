import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ rows: new Map<string, string>(), trades: [] as unknown[],
  pending: false, writes: [] as string[], acquired: true, failRead: false }));
vi.mock('drizzle-orm', () => ({ eq: (_field: unknown, value: string) => ({ value }),
  sql: () => ({}), and: () => ({}), inArray: () => ({}) }));
vi.mock('@workspace/db', () => {
  const workerStateTable = { kind: 'state', key: 'key' };
  const tradesTable = { kind: 'trades', strategy: 'strategy' };
  function select() {
    let table: { kind: string }; let key: string;
    const c = { from(t: { kind: string }) { table = t; return c; },
      where(condition: { value: string }) { key = condition.value; return c; }, limit() { return c; },
      then(resolve: (rows: unknown) => unknown, reject: (e: unknown) => unknown) {
        return Promise.resolve().then(() => {
          if (fixture.failRead) throw new Error('DB read failed');
          return table.kind === 'trades' ? fixture.trades
            : fixture.rows.has(key) ? [{ key, value: fixture.rows.get(key) }] : [];
        }).then(resolve, reject);
      } };
    return c;
  }
  function insert() {
    let row: { key: string; value: string }; let claim = false;
    const c = { values(value: typeof row) { row = value; return c; },
      onConflictDoUpdate() { return c; }, onConflictDoNothing() { claim = true; return c; },
      returning() { return c; }, then(resolve: (value: unknown) => unknown) {
        if (claim && fixture.rows.has(row.key)) return Promise.resolve([]).then(resolve);
        fixture.rows.set(row.key, row.value); fixture.writes.push(row.key);
        return Promise.resolve([{ key: row.key }]).then(resolve);
      } };
    return c;
  }
  const db = { select, insert, execute: async () => ({ rows: [{ acquired: fixture.acquired }] }),
    transaction: async (callback: (tx: unknown) => unknown): Promise<unknown> => callback(db) };
  return { db, workerStateTable, tradesTable };
});
vi.mock('../workers/serverPaperExecutor', () => ({
  getServerPaperStatus: () => ({ unresolved: null, pendingClose: fixture.pending ? { reason: 'pending' } : null }), openServerPaperPosition: vi.fn(),
  closeServerPaperPosition: vi.fn(), reduceServerPaper70: vi.fn(),
}));
vi.mock('../lib/manualCanaryReadonlyEvidence', () => ({ fetchManualCanaryReadonlyCost: vi.fn(async () => ({
  ok: false, reason: 'COST_DATA_UNAVAILABLE: test fixture',
})) }));
vi.mock('../intel/intelService', () => ({ runStrategyShadowWorkerReadOnly: vi.fn(async () => ({ status: 'EVALUATED', records: [] })) }));
import { runStrategyShadowWorkerReadOnly } from '../intel/intelService';
import { fetchManualCanaryReadonlyCost } from '../lib/manualCanaryReadonlyEvidence';
import { maybeRunVirtualPaper400Cycle, VIRTUAL_PAPER_400_RUNTIME_KEY } from '../workers/virtualPaper400Runtime';
import { buildActiveVirtualPaper400SessionState, buildStoppedVirtualPaper400SessionState,
  VIRTUAL_PAPER_400_SESSION_STATE_KEY } from '../workers/virtualPaper400SessionState';
import { initialVirtualPaper400RiskState, virtualPaper400RiskKey } from '../workers/virtualPaper400Accounting';
import { openServerPaperPosition, closeServerPaperPosition } from '../workers/serverPaperExecutor';
import { virtualPaper400Activity } from '../workers/virtualPaper400Activity';
import { buildStrategyShadowWorkerEnvelope } from '../intel/strategyShadowWorkerEnvelopeV2';
import { virtualPaper400StrategyContinuityKey } from '../workers/virtualPaper400StrategyContinuity';

const args = { cycleNumber: 1, quote: () => ({ priceUsd: 50_000, ageMs: 0 }), shouldContinue: () => true };
beforeEach(() => {
  fixture.pending = false; fixture.rows.clear(); fixture.trades = []; fixture.writes = []; fixture.acquired = true; fixture.failRead = false;
  process.env.WORKER_ENGINE_MODE = 'PAPER'; vi.clearAllMocks();
  vi.mocked(runStrategyShadowWorkerReadOnly).mockImplementation(async input =>
    buildStrategyShadowWorkerEnvelope({ cycleNumber: input.cycleNumber,
      generatedAt: input.evaluatedAt, expectedSymbols: input.expectedSymbols, records: [],
      existingAi: input.existingAi, lifecycleSnapshot: input.lifecycleSnapshot,
      notEvaluatedReason: 'test has no completed candle' }));
});
function stoppedSession() {
  const active = buildActiveVirtualPaper400SessionState('runtime-replay', new Date(Date.now() - 1_000));
  const state = buildStoppedVirtualPaper400SessionState(active, 'test stop');
  fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, JSON.stringify(state)); return state.session;
}
describe('virtual runtime routing and durable account boundary', () => {
  it('retains the 2x policy and protection of existing inventory until it is settled', async () => {
    const active = buildActiveVirtualPaper400SessionState('held-upgrade', new Date(Date.now() - 60_000));
    fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, JSON.stringify(active));
    fixture.rows.set(virtualPaper400RiskKey(active.session), JSON.stringify(initialVirtualPaper400RiskState(active.session)));
    const key = `virtual_paper_400_policy_v1:${active.session.sessionId}`;
    const old = JSON.stringify({ version: 'virtual400-active/v1', appliedAt: active.session.startedAt, sessionId: active.session.sessionId });
    fixture.rows.set(key, old);
    fixture.trades = [{ id: 'old-open', strategy: active.session.strategyTag, symbol: 'BTC', side: 'LONG', action: 'OPEN',
      timestamp: new Date(Date.now() - 30_000), closeTime: 0, managedBy: 'SERVER', testMode: false,
      settlementStatus: 'PAPER_ESTIMATED', costSource: 'PAPER_GMX_ESTIMATE', price: '50000', sizeInUsd: '80', leverage: '2',
      stopPriceUsd: '49000', takeProfitPriceUsd: '52000', estEntryCostUsd: '.015', estExitCostUsd: '.015',
      fundingRatePerHour: '.00001', borrowingRatePerHour: '.00001' }];
    const before = JSON.stringify(fixture.trades);
    await maybeRunVirtualPaper400Cycle(args);
    expect(fixture.rows.get(key)).toBe(old); expect(JSON.stringify(fixture.trades)).toBe(before);
    expect(JSON.parse(fixture.rows.get(VIRTUAL_PAPER_400_RUNTIME_KEY)!).reason).toBe('POLICY_SAFE_BOUNDARY_PENDING');
    expect(openServerPaperPosition).not.toHaveBeenCalled(); expect(closeServerPaperPosition).not.toHaveBeenCalled();
  });
  it('migrates v1 only after recovery clears, preserving the active session and risk checkpoint', async () => {
    const active = buildActiveVirtualPaper400SessionState('upgrade-test', new Date(Date.now() - 60_000));
    const raw = JSON.stringify(active); fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, raw);
    const key = `virtual_paper_400_policy_v1:${active.session.sessionId}`;
    const old = JSON.stringify({ version: 'virtual400-active/v1', appliedAt: active.session.startedAt, sessionId: active.session.sessionId });
    fixture.rows.set(key, old); fixture.pending = true;
    await maybeRunVirtualPaper400Cycle(args);
    expect(fixture.rows.get(key)).toBe(old);
    expect(JSON.parse(fixture.rows.get(VIRTUAL_PAPER_400_RUNTIME_KEY)!).policy.maxLeverage).toBe(2);
    expect(openServerPaperPosition).not.toHaveBeenCalled();
    fixture.pending = false; await maybeRunVirtualPaper400Cycle(args);
    const upgraded = fixture.rows.get(key)!;
    expect(JSON.parse(upgraded).version).toBe('virtual400-active/v2');
    expect(JSON.parse(fixture.rows.get(VIRTUAL_PAPER_400_RUNTIME_KEY)!).policy).toMatchObject({ minLeverage: 5, maxLeverage: 10 });
    await maybeRunVirtualPaper400Cycle(args);
    expect(fixture.rows.get(key)).toBe(upgraded); expect(fixture.rows.get(VIRTUAL_PAPER_400_SESSION_STATE_KEY)).toBe(raw);
    expect(JSON.parse(fixture.rows.get(virtualPaper400RiskKey(active.session))!).equityHwmUsd).toBe(400);
  });
  it('exposes the actual in-flight market batch, then stops presenting it as running', async () => {
    const active = buildActiveVirtualPaper400SessionState('activity-test', new Date(Date.now() - 1_000));
    fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, JSON.stringify(active));
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(runStrategyShadowWorkerReadOnly).mockImplementationOnce(async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      return { status: 'EVALUATED', records: [] } as any;
    });
    const cycle = maybeRunVirtualPaper400Cycle({ ...args, cycleNumber: 9 });
    await started;
    const current = virtualPaper400Activity.read(active.session.sessionId);
    expect(current.activityFresh).toBe(true);
    expect(current.activity!.phase).toBe('ANALYZING_MARKETS');
    expect(current.activity!.symbols).toEqual(['BTC','ETH','SOL']);
    expect(fixture.rows.has(VIRTUAL_PAPER_400_RUNTIME_KEY)).toBe(false);
    release(); await cycle;
    const final = virtualPaper400Activity.read(active.session.sessionId).activity!;
    expect(final.phase).toBe('WAITING'); expect(final.outcome).toBe('NO_TRADE');
    expect(final.symbols).toEqual([]);
    expect(openServerPaperPosition).not.toHaveBeenCalled();
  });
  it('persists sanitized directional cost failure evidence without weakening fail-closed entry', async () => {
    const active = buildActiveVirtualPaper400SessionState('cost-diagnostics', new Date(Date.now() - 1_000));
    fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, JSON.stringify(active));
    vi.mocked(fetchManualCanaryReadonlyCost).mockResolvedValueOnce({
      ok: false,
      reason: 'COST_DATA_UNAVAILABLE: provider https://private.example/path?token=raw-secret',
    });
    await maybeRunVirtualPaper400Cycle(args);
    const runtime = JSON.parse(fixture.rows.get(VIRTUAL_PAPER_400_RUNTIME_KEY)!);
    const btc = runtime.analysis.find((row: { symbol: string }) => row.symbol === 'BTC');
    expect(btc.reason).toContain('COST_UNAVAILABLE: long=COST_DATA_UNAVAILABLE: provider [URL]');
    expect(btc.reason).not.toContain('private.example');
    expect(btc.reason).not.toContain('raw-secret');
    expect(openServerPaperPosition).not.toHaveBeenCalled();
  });
  it('ends a failed analysis with a generic error without exposing raw infrastructure errors', async () => {
    const active = buildActiveVirtualPaper400SessionState('activity-error', new Date(Date.now() - 1_000));
    fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, JSON.stringify(active));
    vi.mocked(runStrategyShadowWorkerReadOnly).mockRejectedValueOnce(new Error('private infrastructure error'));
    await expect(maybeRunVirtualPaper400Cycle(args)).rejects.toThrow('private infrastructure error');
    const snapshot = virtualPaper400Activity.read(active.session.sessionId).activity!;
    expect(snapshot.phase).toBe('ERROR'); expect(snapshot.reason).toBe('CYCLE_FAILED');
    expect(JSON.stringify(snapshot)).not.toContain('private infrastructure');
    expect(openServerPaperPosition).not.toHaveBeenCalled();
  });
  it('promotes the dedicated policy once and scans all three supported symbols without resetting the session', async () => {
    const active = buildActiveVirtualPaper400SessionState('active-test', new Date(Date.now() - 1_000));
    const raw = JSON.stringify(active);
    fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, raw);
    fixture.pending = true;
    await maybeRunVirtualPaper400Cycle(args);
    expect(fixture.rows.has(`virtual_paper_400_policy_v1:${active.session.sessionId}`)).toBe(false);
    expect(runStrategyShadowWorkerReadOnly).not.toHaveBeenCalled();
    fixture.pending = false;
    await maybeRunVirtualPaper400Cycle(args);
    expect(runStrategyShadowWorkerReadOnly).toHaveBeenCalledWith(expect.objectContaining({
      expectedSymbols: ['BTC', 'ETH', 'SOL'], allowedRegimeSymbols: ['BTC', 'ETH', 'SOL'],
      lifecycleSnapshot: expect.objectContaining({ schemaVersion: 'signal-lifecycle-snapshot/v1' }),
      previousRegimes: {},
    }));
    const continuityKey = virtualPaper400StrategyContinuityKey(active.session.sessionId);
    expect(JSON.parse(fixture.rows.get(continuityKey)!)).toMatchObject({
      schemaVersion: 'virtual-paper-400-strategy-continuity/v2',
      sessionId: active.session.sessionId,
      lastEnvelopeStatus: 'NOT_EVALUATED',
      lastMeaningfulAnalysis: null,
    });
    const key = `virtual_paper_400_policy_v1:${active.session.sessionId}`;
    const first = fixture.rows.get(key);
    expect(JSON.parse(first!).version).toBe('virtual400-active/v2');
    await maybeRunVirtualPaper400Cycle({ ...args, cycleNumber: 2 });
    expect(fixture.rows.get(key)).toBe(first);
    expect(fixture.rows.get(VIRTUAL_PAPER_400_SESSION_STATE_KEY)).toBe(raw);
    expect(JSON.parse(fixture.rows.get(VIRTUAL_PAPER_400_RUNTIME_KEY)!).policy.maxLeverage).toBe(10);
    expect(JSON.parse(fixture.rows.get(VIRTUAL_PAPER_400_RUNTIME_KEY)!).strategyContinuity)
      .toMatchObject({ status: 'RESTORED', lifecycleRecords: 0, regimes: [],
        lastMeaningfulAnalysis: null });
  });
  it('fails only new entry closed when session-scoped strategy continuity is corrupt', async () => {
    const active = buildActiveVirtualPaper400SessionState('continuity-corrupt', new Date(Date.now() - 1_000));
    fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, JSON.stringify(active));
    const key = virtualPaper400StrategyContinuityKey(active.session.sessionId);
    fixture.rows.set(key, JSON.stringify({ schemaVersion: 'wrong', sessionId: active.session.sessionId }));
    const before = fixture.rows.get(key);
    await maybeRunVirtualPaper400Cycle(args);
    const runtime = JSON.parse(fixture.rows.get(VIRTUAL_PAPER_400_RUNTIME_KEY)!);
    expect(runtime).toMatchObject({ status: 'BLOCKED', reason: 'STRATEGY_CONTINUITY_STATE_INVALID',
      strategyContinuity: { status: 'BLOCKED', reason: 'STRATEGY_CONTINUITY_STATE_INVALID' } });
    expect(fixture.rows.get(key)).toBe(before);
    expect(runStrategyShadowWorkerReadOnly).not.toHaveBeenCalled();
    expect(openServerPaperPosition).not.toHaveBeenCalled();
  });
  it('continues existing-position protection even when strategy continuity is corrupt', async () => {
    const active = buildActiveVirtualPaper400SessionState('continuity-protection', new Date(Date.now() - 60_000));
    fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, JSON.stringify(active));
    const risk = initialVirtualPaper400RiskState(active.session);
    risk.risk.locks.hardStopReason = 'historical hard stop';
    fixture.rows.set(virtualPaper400RiskKey(active.session), JSON.stringify(risk));
    fixture.rows.set(virtualPaper400StrategyContinuityKey(active.session.sessionId), '{broken');
    fixture.trades = [{ id: 'protected-open', strategy: active.session.strategyTag, symbol: 'BTC', side: 'LONG', action: 'OPEN',
      timestamp: new Date(Date.now() - 30_000), closeTime: 0, managedBy: 'SERVER', testMode: false,
      settlementStatus: 'PAPER_ESTIMATED', costSource: 'PAPER_GMX_ESTIMATE', price: '50000', sizeInUsd: '80', leverage: '2',
      stopPriceUsd: '49000', takeProfitPriceUsd: '52000', estEntryCostUsd: '.015', estExitCostUsd: '.015',
      fundingRatePerHour: '.00001', borrowingRatePerHour: '.00001' }];
    vi.mocked(closeServerPaperPosition).mockResolvedValueOnce({ ok: true } as never);
    await maybeRunVirtualPaper400Cycle(args);
    expect(closeServerPaperPosition).toHaveBeenCalledWith(expect.objectContaining({
      openTradeId: 'protected-open', expectedStrategy: active.session.strategyTag,
    }), expect.any(Function));
    expect(runStrategyShadowWorkerReadOnly).not.toHaveBeenCalled();
    expect(openServerPaperPosition).not.toHaveBeenCalled();
  });
  it('falls through to Standard only when the virtual session is absent', async () => {
    expect(await maybeRunVirtualPaper400Cycle(args)).toBe(false);
    expect(fixture.writes).toEqual([]);
  });
  it('keeps stopped sessions in their namespace and reads them back after process-local reset', async () => {
    const session = stoppedSession();
    const risk = initialVirtualPaper400RiskState(session); risk.risk.locks.hardStopReason = 'historical stop';
    fixture.rows.set(virtualPaper400RiskKey(session), JSON.stringify(risk));
    fixture.rows.set('riskEngineStateV1', 'Standard');
    fixture.rows.set('fixed_beta_accounting_state_v1', 'Real-money');
    expect(await maybeRunVirtualPaper400Cycle(args)).toBe(true);
    const first = fixture.rows.get(virtualPaper400RiskKey(session))!;
    expect(await maybeRunVirtualPaper400Cycle({ ...args, cycleNumber: 2 })).toBe(true);
    expect(JSON.parse(first).risk.locks.hardStopReason).toBe('historical stop');
    expect(JSON.parse(fixture.rows.get(VIRTUAL_PAPER_400_RUNTIME_KEY)!).status).toBe('STOPPED');
    expect(fixture.rows.get('riskEngineStateV1')).toBe('Standard');
    expect(fixture.rows.get('fixed_beta_accounting_state_v1')).toBe('Real-money');
    expect(openServerPaperPosition).not.toHaveBeenCalled(); expect(closeServerPaperPosition).not.toHaveBeenCalled();
  });
  it('does not initialize over a missing risk checkpoint when trading history exists', async () => {
    stoppedSession(); fixture.trades = [{ id: 'history' }];
    await expect(maybeRunVirtualPaper400Cycle(args)).rejects.toThrow('MISSING_WITH_HISTORY');
    expect(fixture.writes).toEqual([]);
  });
  it('does not run a second instance when its advisory lock is held', async () => {
    stoppedSession(); fixture.acquired = false;
    expect(await maybeRunVirtualPaper400Cycle(args)).toBe(true);
    expect(fixture.writes).toEqual([]);
  });
  it('fails closed on unreadable, malformed and LIVE state', async () => {
    fixture.failRead = true;
    await expect(maybeRunVirtualPaper400Cycle(args)).rejects.toThrow('DB read failed');
    fixture.failRead = false; fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, 'broken');
    await expect(maybeRunVirtualPaper400Cycle(args)).rejects.toThrow('VIRTUAL_SESSION_INVALID');
    stoppedSession(); process.env.WORKER_ENGINE_MODE = 'LIVE';
    await expect(maybeRunVirtualPaper400Cycle(args)).rejects.toThrow('PAPER_MODE_REQUIRED');
    expect(fixture.writes).toEqual([]); expect(openServerPaperPosition).not.toHaveBeenCalled();
  });
});
