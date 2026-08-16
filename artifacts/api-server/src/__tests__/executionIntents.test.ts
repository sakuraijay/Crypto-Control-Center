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
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(whereObj),
          orderBy: vi.fn().mockReturnValue({ limit: (_n: number) => selectResult() }),
        }),
      }),
    },
    executionIntentsTable: { id: 'id', status: 'status', createdAt: 'created_at' },
  };
});

vi.mock('drizzle-orm', () => ({
  eq:      vi.fn((_col, val) => `eq(${String(val)})`),
  inArray: vi.fn((_col, vals) => `inArray(${String(vals)})`),
  and:     vi.fn((...args: unknown[]) => `and(${args.join(',')})`),
  desc:    vi.fn((col: unknown) => `desc(${String(col)})`),
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

  it('markIntentSubmitted 0행(이미 terminal — 지연 호출) → false, 역행 없음', async () => {
    dbState.updateReturning = [];
    const { markIntentSubmitted } = await import('../lib/executionIntents');
    expect(await markIntentSubmitted('intent:open:d1', '0xTx')).toBe(false);
  });

  it('markIntentUnresolved 0행(이미 terminal) → false, 역행 없음', async () => {
    dbState.updateReturning = [];
    const { markIntentUnresolved } = await import('../lib/executionIntents');
    expect(await markIntentUnresolved('intent:open:d1', 'late')).toBe(false);
  });

  it('markIntentFailedPreBroadcast 0행(PREPARED 아님) → false', async () => {
    dbState.updateReturning = [];
    const { markIntentFailedPreBroadcast } = await import('../lib/executionIntents');
    expect(await markIntentFailedPreBroadcast('intent:open:d1', 'late')).toBe(false);
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

describe('resolveIntentTerminal — 조건부 terminal 전환', () => {
  it('전환 성공 → true, 상태+증거 저장', async () => {
    const { resolveIntentTerminal } = await import('../lib/executionIntents');
    const ok = await resolveIntentTerminal('intent:open:d1', 'CONFIRMED', {
      receiptStatus: 'success', orderKey: '0xkey', resolutionTxHash: '0xTx',
      resolutionBlock: '123', resolutionReason: 'OrderExecuted 이벤트 확인',
    });
    expect(ok).toBe(true);
    expect(dbState.lastUpdateSet).toMatchObject({
      status: 'CONFIRMED', orderKey: '0xkey', resolutionBlock: '123',
    });
  });

  it('0행 반환(이미 terminal / 동시 reconcile 선점) → false, 역행 없음', async () => {
    dbState.updateReturning = [];
    const { resolveIntentTerminal } = await import('../lib/executionIntents');
    const ok = await resolveIntentTerminal('intent:open:d1', 'FAILED', {
      resolutionReason: 'receipt reverted',
    });
    expect(ok).toBe(false);
  });

  it('UPDATE 예외 → false (차단 유지)', async () => {
    dbState.updateThrows = true;
    const { resolveIntentTerminal } = await import('../lib/executionIntents');
    expect(await resolveIntentTerminal('x', 'CANCELLED', { resolutionReason: 'r' })).toBe(false);
  });
});

describe('updateIntentEvidence — 차단 유지한 채 근거만 저장', () => {
  it('orderKey·블록 저장, status는 건드리지 않음', async () => {
    const { updateIntentEvidence } = await import('../lib/executionIntents');
    const ok = await updateIntentEvidence('intent:open:d1', {
      receiptStatus: 'success', orderKey: '0xkey', orderCreatedBlock: '100',
    });
    expect(ok).toBe(true);
    expect(dbState.lastUpdateSet).toMatchObject({ orderKey: '0xkey', orderCreatedBlock: '100' });
    expect(dbState.lastUpdateSet).not.toHaveProperty('status');
  });
});

describe('listBlockingIntents / listRecentIntents', () => {
  it('조회 실패 → null (fail-closed)', async () => {
    dbState.selectThrows = true;
    const { listBlockingIntents, listRecentIntents } = await import('../lib/executionIntents');
    expect(await listBlockingIntents()).toBeNull();
    expect(await listRecentIntents()).toBeNull();
  });

  it('정상 조회 → 행 반환', async () => {
    dbState.selectRows = [{ id: 'a', status: 'UNRESOLVED' }];
    const { listBlockingIntents } = await import('../lib/executionIntents');
    expect(await listBlockingIntents()).toEqual([{ id: 'a', status: 'UNRESOLVED' }]);
  });
});
