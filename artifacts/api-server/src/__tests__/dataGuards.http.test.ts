/**
 * Task #111 — /api/data/trades 서버 권위 격리 가드 HTTP 테스트.
 *
 * 브라우저 POST/batch/DELETE가 서버 Worker 관리 상태(managed_by='SERVER')를
 * 덮어쓰거나 삭제할 수 없음을 검증한다. 판정 실패는 전부 fail-closed(503).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@workspace/db', () => {
  function chain(getResult: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from','where','limit','offset','orderBy','set','values',
                     'onConflictDoNothing','onConflictDoUpdate','returning']) {
      c[m] = () => c;
    }
    (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
      (resolve) => Promise.resolve(getResult()).then(resolve);
    return c;
  }
  return {
    db: {
      select: vi.fn(() => chain(() => [])),
      insert: vi.fn(() => chain(() => [])),
      update: vi.fn(() => chain(() => [])),
      delete: vi.fn(() => chain(() => 0)),
    },
    liveApprovalsTable:  { id:'id' },
    workerStateTable:    { key:'key', value:'value', updatedAt:'updatedAt' },
    aiDecisionsTable:    { id:'id' },
    strategyConfigTable: { id:'id' },
    tradesTable: {
      id:'id', symbol:'symbol', side:'side', action:'action', size:'size',
      price:'price', pnl:'pnl', strategy:'strategy', timestamp:'timestamp',
      closeTime:'close_time', sizeInUsd:'size_in_usd', managedBy:'managed_by',
    },
  };
});

vi.mock('drizzle-orm', () => ({
  eq:   vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  lt:   vi.fn(() => ({})),
  and:  vi.fn(() => ({})),
  sql:  Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
}));

vi.mock('../routes/notifications', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, sendPushToOperator: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../workers/internalExecutor', () => ({
  LIVE_EXECUTION_LOCKED: true,
  executeOrder:          vi.fn().mockResolvedValue({ simulated: true, txHash: null }),
  validateDryRunParams:  vi.fn().mockResolvedValue({ ok: true, error: null }),
  getExecutorStatus:     vi.fn().mockResolvedValue({}),
}));

vi.mock('../workers/aiWorker', () => ({
  workerManager: {
    start: vi.fn(), stop: vi.fn(),
    getStatus: vi.fn(() => ({
      workerRunning: false, lastCycleAt: null, cycleCount: 0, equityHwm: null,
      lastLimitsUsed: null, liveTestMode: false, liveTestVetoReason: null,
      liveTestAccumLossUsd: 0, liveTestDbOk: true,
    })),
  },
}));

import request from 'supertest';
import app     from '../app';
import { db }  from '@workspace/db';

function makeChain(getResult: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from','where','limit','offset','orderBy','set','values',
                   'onConflictDoNothing','onConflictDoUpdate','returning']) {
    c[m] = () => c;
  }
  (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
    (resolve) => Promise.resolve(getResult()).then(resolve);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c as any;
}

const CLIENT_TRADE = {
  id: 't-1', symbol: 'BTC', side: 'LONG', action: 'CLOSE',
  sizeInUsd: 100, price: 50_000, pnl: 5, strategy: 'Manual',
  timestamp: new Date().toISOString(), closeTime: Date.now(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockImplementation(() => makeChain(() => []) as never);
  vi.mocked(db.insert).mockImplementation(() => makeChain(() => []) as never);
  vi.mocked(db.delete).mockImplementation(() => makeChain(() => 0) as never);
});

describe('POST /api/data/trades — 서버 관리 격리', () => {
  it('동일 id가 서버 관리 행이면 409 SERVER_MANAGED_ROW', async () => {
    vi.mocked(db.select).mockImplementation(() =>
      makeChain(() => [{ id: 't-1', managedBy: 'SERVER' }]) as never);
    const res = await request(app).post('/api/data/trades').send(CLIENT_TRADE);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVER_MANAGED_ROW');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('서버 관리 미청산 포지션 심볼에 대한 CLOSE는 409 SERVER_MANAGED_POSITION', async () => {
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => makeChain(() => {
      call += 1;
      return call === 1 ? [] : [{ id: 'srv-1', managedBy: 'SERVER', action: 'OPEN', closeTime: 0 }];
    }) as never);
    const res = await request(app).post('/api/data/trades').send(CLIENT_TRADE);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVER_MANAGED_POSITION');
  });

  it('가드 판정 실패 → 503 SERVER_GUARD_UNKNOWN (fail-closed)', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => { throw new Error('db down'); }) as never);
    const res = await request(app).post('/api/data/trades').send(CLIENT_TRADE);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SERVER_GUARD_UNKNOWN');
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('POST /api/data/trades/batch — 서버 관리 격리 (단건과 동일 가드)', () => {
  it('batch에 서버 관리 행 id가 포함되면 409, 삽입 0건', async () => {
    vi.mocked(db.select).mockImplementation(() =>
      makeChain(() => [{ id: 't-1', managedBy: 'SERVER' }]) as never);
    const res = await request(app).post('/api/data/trades/batch').send([CLIENT_TRADE]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVER_MANAGED_ROW');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('batch에 서버 관리 미청산 심볼 CLOSE가 포함되면 409', async () => {
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => makeChain(() => {
      call += 1;
      return call === 1 ? [] : [{ id: 'srv-1', managedBy: 'SERVER' }];
    }) as never);
    const res = await request(app).post('/api/data/trades/batch').send([CLIENT_TRADE]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVER_MANAGED_POSITION');
  });

  it('가드 판정 실패 → 503 (fail-closed)', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => { throw new Error('db down'); }) as never);
    const res = await request(app).post('/api/data/trades/batch').send([CLIENT_TRADE]);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SERVER_GUARD_UNKNOWN');
  });
});

describe('DELETE /api/data/trades — 서버 권위 상태 보호', () => {
  it('서버 관리 행이 존재하면 409 — 전체 삭제 거부', async () => {
    vi.mocked(db.select).mockImplementation(() =>
      makeChain(() => [{ id: 'srv-1', managedBy: 'SERVER' }]) as never);
    const res = await request(app).delete('/api/data/trades');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVER_MANAGED_ROW');
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('판정 실패 → 503 (fail-closed, 삭제 안 함)', async () => {
    vi.mocked(db.select).mockImplementation(() => makeChain(() => { throw new Error('db down'); }) as never);
    const res = await request(app).delete('/api/data/trades');
    expect(res.status).toBe(503);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('서버 관리 행이 없으면 정상 삭제', async () => {
    const res = await request(app).delete('/api/data/trades');
    expect(res.status).toBe(200);
    expect(db.delete).toHaveBeenCalled();
  });
});
