import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ rows: new Map<string, string>(), trades: [] as unknown[],
  writes: [] as string[], acquired: true, failRead: false }));
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
  getServerPaperStatus: () => ({ unresolved: null }), openServerPaperPosition: vi.fn(),
  closeServerPaperPosition: vi.fn(), reduceServerPaper70: vi.fn(),
}));
import { maybeRunVirtualPaper400Cycle, VIRTUAL_PAPER_400_RUNTIME_KEY } from '../workers/virtualPaper400Runtime';
import { buildActiveVirtualPaper400SessionState, buildStoppedVirtualPaper400SessionState,
  VIRTUAL_PAPER_400_SESSION_STATE_KEY } from '../workers/virtualPaper400SessionState';
import { initialVirtualPaper400RiskState, virtualPaper400RiskKey } from '../workers/virtualPaper400Accounting';
import { openServerPaperPosition, closeServerPaperPosition } from '../workers/serverPaperExecutor';

const args = { cycleNumber: 1, quote: () => ({ priceUsd: 50_000, ageMs: 0 }), shouldContinue: () => true };
beforeEach(() => {
  fixture.rows.clear(); fixture.trades = []; fixture.writes = []; fixture.acquired = true; fixture.failRead = false;
  process.env.WORKER_ENGINE_MODE = 'PAPER'; vi.clearAllMocks();
});
function stoppedSession() {
  const active = buildActiveVirtualPaper400SessionState('runtime-replay', new Date(Date.now() - 1_000));
  const state = buildStoppedVirtualPaper400SessionState(active, 'test stop');
  fixture.rows.set(VIRTUAL_PAPER_400_SESSION_STATE_KEY, JSON.stringify(state)); return state.session;
}
describe('virtual runtime routing and durable account boundary', () => {
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
