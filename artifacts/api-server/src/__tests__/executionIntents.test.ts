/**
 * executionIntents.ts 단위 테스트 — durable execution intent 영속화 계층.
 *
 * 검증:
 *  - createPreparedIntent: created / duplicate(PK 충돌) / error(fail-closed)
 *  - markIntentSubmitted / markIntentUnresolved / markIntentFailedPreBroadcast
 *  - hasBlockingIntents: 존재/부재/조회 실패(fail-closed → true)
 *  - reconcileIntentsOnRestart: PREPARED/SUBMITTED → UNRESOLVED, 실패 시 ok=false
 *  - buildIntentId 결정적 idempotency key
 *
 * 실제 DB I/O 없음 (mock 전용).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── @workspace/db 모킹 ────────────────────────────────────────────────────────
const dbState = vi.hoisted(() => ({
  insertReturning: [{ id: 'x' }] as { id: string }[],
  insertThrows:    false,
  updateReturning: [{ id: 'x' }] as { id: string }[],
  updateThrows:    false,
  selectRows:      [] as { id: string; status?: string }[],
  selectThrows:    false,
  lastUpdateSet:   null as Record<string, unknown> | null,
}));

vi.mock('@workspace/db', () => {
  const selectResult = () => {
    if (dbState.selectThrows) return Promise.reject(new Error('select failed'));
    return Promise.resolve(dbState.selectRows);
  };
  const whereObj = () => {
    const p = selectResult() as Promise<unknown> & { limit?: unknown };
    // where(...)는 await 가능해야 하고 .limit()도 지원해야 함
    (p as { limit: (n: number) => Promise<unknown> }).limit = (_n: number) => selectResult();
    return p;
  };
  return {
    db: {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockImplementation(() => {
              if (dbState.insertThrows) return Promise.reject(new Error('insert failed'));
              return Promise.resolve(dbState.insertReturning);
            }),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((setArg: Record<string, unknown>) => {
          dbState.lastUpdateSet = setArg;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockImplementation(() => {
                if (dbState.updateThrows) return Promise.reject(new Error('update failed'));
                return Promise.resolve(dbState.updateReturning);
              }),
            }),
          };
        }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(whereObj) }),
      }),
    },
    executionIntentsTable: { id: 'id', status: 'status' },
  };
});

vi.mock('drizzle-orm', () => ({
  eq:      vi.fn((_col, val) => `eq(${String(val)})`),
  inArray: vi.fn((_col, vals) => `inArray(${String(vals)})`),
}));

beforeEach(() => {
  dbState.insertReturning = [{ id: 'x' }];
  dbState.insertThrows    = false;
  dbState.updateReturning = [{ id: 'x' }];
  dbState.updateThrows    = false;
  dbState.selectRows      = [];
  dbState.selectThrows    = false;
  dbState.lastUpdateSet   = null;
});

function newIntent() {
  return {
    id: 'intent:open:d1', decisionId: 'd1', cycleNumber: 1, symbol: 'ETH',
    orderType: 'open' as const, isLong: true, sizeUsd: 10, collateralUsd: 5,
  };
}

describe('buildIntentId — 결정적 idempotency key', () => {
  it('같은 decisionId + orderType이면 항상 같은 key', async () => {
    const { buildIntentId } = await import('../lib/executionIntents');
    expect(buildIntentId('d1', 'open')).toBe(buildIntentId('d1', 'open'));
    expect(buildIntentId('d1', 'open')).not.toBe(buildIntentId('d1', 'close'));
    expect(buildIntentId('d1', 'open')).not.toBe(buildIntentId('d2', 'open'));
  });
});

describe('createPreparedIntent', () => {
  it('INSERT 성공 → created', async () => {
    const { createPreparedIntent } = await import('../lib/executionIntents');
    expect(await createPreparedIntent(newIntent())).toBe('created');
  });

  it('PK 충돌(0행 반환) → duplicate (중복 제출 차단)', async () => {
    dbState.insertReturning = [];
    const { createPreparedIntent } = await import('../lib/executionIntents');
    expect(await createPreparedIntent(newIntent())).toBe('duplicate');
  });

  it('INSERT 예외 → error (fail-closed, 제출 금지)', async () => {
    dbState.insertThrows = true;
    const { createPreparedIntent } = await import('../lib/executionIntents');
    expect(await createPreparedIntent(newIntent())).toBe('error');
  });
});

describe('mark* 전환', () => {
  it('markIntentSubmitted 성공 → true, txHash+SUBMITTED 저장', async () => {
    const { markIntentSubmitted } = await import('../lib/executionIntents');
    expect(await markIntentSubmitted('intent:open:d1', '0xTx')).toBe(true);
    expect(dbState.lastUpdateSet).toMatchObject({ status: 'SUBMITTED', txHash: '0xTx' });
  });

  it('markIntentSubmitted 예외 → false (PREPARED 잔존)', async () => {
    dbState.updateThrows = true;
    const { markIntentSubmitted } = await import('../lib/executionIntents');
    expect(await markIntentSubmitted('intent:open:d1', '0xTx')).toBe(false);
  });

  it('markIntentUnresolved → UNRESOLVED 저장 (FAILED 아님)', async () => {
    const { markIntentUnresolved } = await import('../lib/executionIntents');
    expect(await markIntentUnresolved('intent:open:d1', 'timeout')).toBe(true);
    expect(dbState.lastUpdateSet).toMatchObject({ status: 'UNRESOLVED', error: 'timeout' });
  });

  it('markIntentFailedPreBroadcast → FAILED 저장', async () => {
    const { markIntentFailedPreBroadcast } = await import('../lib/executionIntents');
    expect(await markIntentFailedPreBroadcast('intent:open:d1', 'client init')).toBe(true);
    expect(dbState.lastUpdateSet).toMatchObject({ status: 'FAILED' });
  });
});

describe('hasBlockingIntents', () => {
  it('차단 상태 행 존재 → true', async () => {
    dbState.selectRows = [{ id: 'a' }];
    const { hasBlockingIntents } = await import('../lib/executionIntents');
    expect(await hasBlockingIntents()).toBe(true);
  });

  it('차단 상태 행 없음 → false', async () => {
    const { hasBlockingIntents } = await import('../lib/executionIntents');
    expect(await hasBlockingIntents()).toBe(false);
  });

  it('조회 실패 → true (fail-closed)', async () => {
    dbState.selectThrows = true;
    const { hasBlockingIntents } = await import('../lib/executionIntents');
    expect(await hasBlockingIntents()).toBe(true);
  });
});

describe('reconcileIntentsOnRestart', () => {
  it('PREPARED/SUBMITTED → UNRESOLVED 전환 + blockingCount 반환', async () => {
    dbState.selectRows = [
      { id: 'a', status: 'PREPARED' },
      { id: 'b', status: 'SUBMITTED' },
      { id: 'c', status: 'UNRESOLVED' },
    ];
    const { reconcileIntentsOnRestart } = await import('../lib/executionIntents');
    const r = await reconcileIntentsOnRestart();
    expect(r.ok).toBe(true);
    expect(r.blockingCount).toBe(3);
    expect(dbState.lastUpdateSet).toMatchObject({ status: 'UNRESOLVED' });
  });

  it('차단 intent 없으면 갱신 없이 ok=true, blockingCount=0', async () => {
    const { reconcileIntentsOnRestart } = await import('../lib/executionIntents');
    const r = await reconcileIntentsOnRestart();
    expect(r).toEqual({ ok: true, blockingCount: 0 });
    expect(dbState.lastUpdateSet).toBeNull();
  });

  it('조회 실패 → ok=false (fail-closed)', async () => {
    dbState.selectThrows = true;
    const { reconcileIntentsOnRestart } = await import('../lib/executionIntents');
    const r = await reconcileIntentsOnRestart();
    expect(r.ok).toBe(false);
  });
});
