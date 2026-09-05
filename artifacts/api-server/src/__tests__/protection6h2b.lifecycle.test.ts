/**
 * 6H-2B §13 — 보호 주문 durable 수명주기·오케스트레이션 테스트.
 *
 * in-memory DB mock으로 검증:
 *  - §5 순서: durable PLANNED 커밋 → PREPARED → SUBMITTING → 단일 submit 1회 → SUBMITTED
 *  - 자동 재제출 금지 (동일 protectionId 재호출 = 제출 0회)
 *  - 제출 결과 불명 = UNRESOLVED + emergency close 요구
 *  - emergency close 최대 1회 보장
 *  - reconciliation: 온체인 증거만 ACTIVE/terminal, 증거 수집 실패 = 차단
 *  - startup coverage: 무방비 포지션 → 차단 + emergency 대상
 * 실제 네트워크·DB·서명 I/O 없음.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── in-memory protection_orders store (vi.mock에서 접근 — hoisted 필수) ──────
type Row = Record<string, unknown>;
const hoisted = vi.hoisted(() => {
  const col = (name: string) => ({ __col: name });
  return {
    store: new Map<string, Record<string, unknown>>(),
    failFlags: { insert: false, update: false, select: false },
    protectionOrdersTable: {
      id: col('id'), parentOpenIntentId: col('parentOpenIntentId'), positionKey: col('positionKey'),
      purpose: col('purpose'), symbol: col('symbol'), marketAddress: col('marketAddress'),
      isLong: col('isLong'), sizeDeltaUsd: col('sizeDeltaUsd'), triggerPriceUsd: col('triggerPriceUsd'),
      acceptablePriceUsd: col('acceptablePriceUsd'), dayKey: col('dayKey'), status: col('status'),
      requestId: col('requestId'), orderKey: col('orderKey'), typedDataDigest: col('typedDataDigest'),
      evidence: col('evidence'), error: col('error'), submitAttempts: col('submitAttempts'),
      updatedAt: col('updatedAt'),
    },
  };
});
const store = hoisted.store;
const failFlags = hoisted.failFlags;
const protectionOrdersTable = hoisted.protectionOrdersTable;

type Cond =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'in'; col: string; vals: unknown[] }
  | { kind: 'and'; conds: Cond[] };

function matches(row: Row, c: Cond | undefined): boolean {
  if (!c) return true;
  if (c.kind === 'eq') return row[c.col] === c.val;
  if (c.kind === 'in') return c.vals.includes(row[c.col]);
  return c.conds.every((x) => matches(row, x));
}

vi.mock('drizzle-orm', () => ({
  eq: (c: { __col: string }, val: unknown): Cond => ({ kind: 'eq', col: c.__col, val }),
  inArray: (c: { __col: string }, vals: unknown[]): Cond => ({ kind: 'in', col: c.__col, vals }),
  and: (...conds: Cond[]): Cond => ({ kind: 'and', conds }),
  sql: () => ({ __sqlIncrement: true }),
}));

vi.mock('@workspace/db', () => {
  type C = { kind: string; col?: string; val?: unknown; vals?: unknown[]; conds?: C[] };
  const match = (row: Record<string, unknown>, c: C | undefined): boolean => {
    if (!c) return true;
    if (c.kind === 'eq') return row[c.col!] === c.val;
    if (c.kind === 'in') return (c.vals ?? []).includes(row[c.col!]);
    return (c.conds ?? []).every((x) => match(row, x));
  };
  const st = hoisted.store;
  const ff = hoisted.failFlags;
  return {
    protectionOrdersTable: hoisted.protectionOrdersTable,
    db: {
      select: () => ({
        from: () => ({
          where: async (c: C) => {
            if (ff.select) throw new Error('select fail');
            return [...st.values()].filter((r) => match(r, c));
          },
        }),
      }),
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          if (ff.insert) throw new Error('insert fail');
          const id = v.id as string;
          if (st.has(id)) throw Object.assign(new Error('duplicate'), { name: 'UniqueViolation' });
          // 부분 unique index (positionKey,purpose) 활성셋 흉내
          for (const r of st.values()) {
            if (r.positionKey === v.positionKey && r.purpose === v.purpose &&
                !['EXECUTED', 'CANCELLED'].includes(r.status as string)) {
              throw Object.assign(new Error('unique active'), { name: 'UniqueViolation' });
            }
          }
          st.set(id, { requestId: null, orderKey: null, typedDataDigest: null, evidence: null, error: null, submitAttempts: 0, updatedAt: new Date(), ...v });
        },
      }),
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: (c: C) => ({
            returning: async () => {
              if (ff.update) throw new Error('update fail');
              const hit = [...st.values()].filter((r) => match(r, c));
              for (const r of hit) {
                for (const [k, v] of Object.entries(set)) {
                  if (v && typeof v === 'object' && '__sqlIncrement' in (v as object)) {
                    r[k] = ((r[k] as number) ?? 0) + 1;
                  } else r[k] = v;
                }
              }
              return hit.map((r) => ({ id: r.id }));
            },
          }),
        }),
      }),
    },
  };
});

vi.mock('../lib/profitProtection', () => ({ manilaDayKey: () => '2026-08-18' }));

import {
  createInitialStopAfterOpenConfirmed, runEmergencyClose, setProtectionSubmitFn,
  reconcileProtections, checkStartupProtectionCoverage,
  type ProtectionSubmitOutcome,
} from '../workers/protectionExecutor';
import {
  planProtection, transitionProtection, getProtection, getProtectionLineageForPosition,
} from '../lib/protectionOrders';

const OPEN = {
  parentOpenIntentId: 'intent-1', evidence: 'OrderExecuted tx=0xabc',
  positionKey: 'pos-1', symbol: 'ETH', marketAddress: '0x' + '3'.repeat(40),
  isLong: true, confirmedSizeUsd: 100,
};
const STOP_INPUT = { open: OPEN, triggerPriceUsd: 1900, acceptablePriceUsd: 1890 };

beforeEach(() => {
  store.clear();
  failFlags.insert = false; failFlags.update = false; failFlags.select = false;
  setProtectionSubmitFn(null);
});

describe('§3 planProtection / transition (durable 계층)', () => {
  it('idempotent insert — 재호출 created:false', async () => {
    const a = await planProtection({ parentOpenIntentId: 'i1', positionKey: 'p1', purpose: 'INITIAL_STOP', symbol: 'ETH', marketAddress: '0x0', isLong: true, sizeDeltaUsd: 10, triggerPriceUsd: 1, acceptablePriceUsd: 1, dayKey: 'd' });
    expect(a).toEqual({ ok: true, protectionId: 'prot:i1:INITIAL_STOP', created: true });
    const b = await planProtection({ parentOpenIntentId: 'i1', positionKey: 'p1', purpose: 'INITIAL_STOP', symbol: 'ETH', marketAddress: '0x0', isLong: true, sizeDeltaUsd: 10, triggerPriceUsd: 1, acceptablePriceUsd: 1, dayKey: 'd' });
    expect(b).toEqual({ ok: true, protectionId: 'prot:i1:INITIAL_STOP', created: false });
  });
  it('같은 position/purpose에 다른 활성 행 → 거부 (unique 충돌)', async () => {
    await planProtection({ parentOpenIntentId: 'i1', positionKey: 'p1', purpose: 'INITIAL_STOP', symbol: 'ETH', marketAddress: '0x0', isLong: true, sizeDeltaUsd: 10, triggerPriceUsd: 1, acceptablePriceUsd: 1, dayKey: 'd' });
    const b = await planProtection({ parentOpenIntentId: 'i2', positionKey: 'p1', purpose: 'INITIAL_STOP', symbol: 'ETH', marketAddress: '0x0', isLong: true, sizeDeltaUsd: 10, triggerPriceUsd: 1, acceptablePriceUsd: 1, dayKey: 'd' });
    expect(b.ok).toBe(false);
  });
  it('조건부 UPDATE — from 불일치 = 전이 실패, 허용 외 전이 거부', async () => {
    await planProtection({ parentOpenIntentId: 'i1', positionKey: 'p1', purpose: 'INITIAL_STOP', symbol: 'ETH', marketAddress: '0x0', isLong: true, sizeDeltaUsd: 10, triggerPriceUsd: 1, acceptablePriceUsd: 1, dayKey: 'd' });
    const id = 'prot:i1:INITIAL_STOP';
    expect((await transitionProtection(id, 'SUBMITTED', 'ACTIVE')).ok).toBe(false); // from 불일치
    expect((await transitionProtection(id, 'PLANNED', 'ACTIVE')).ok).toBe(false);   // 건너뛰기 금지
    expect((await transitionProtection(id, 'PLANNED', 'PREPARED')).ok).toBe(true);
    expect((await getProtection(id))?.status).toBe('PREPARED');
  });
  it('재시작 coverage는 terminal Stop에서도 원래 OPEN lineage를 복구한다', async () => {
    await planProtection({
      parentOpenIntentId: 'intent:open:general-sol',
      positionKey: 'position-sol',
      purpose: 'INITIAL_STOP',
      symbol: 'SOL',
      marketAddress: '0x0',
      isLong: true,
      sizeDeltaUsd: 10,
      triggerPriceUsd: 100,
      acceptablePriceUsd: 99,
      dayKey: 'd',
    });
    await transitionProtection('prot:intent:open:general-sol:INITIAL_STOP', 'PLANNED', 'CANCELLED');
    expect(await getProtectionLineageForPosition('position-sol')).toEqual({
      ok: true,
      parentOpenIntentId: 'intent:open:general-sol',
    });
  });
  it('동일 position의 복수 lineage는 emergency-close 자동 선택을 거부한다', async () => {
    store.set('legacy-a', {
      id: 'legacy-a', parentOpenIntentId: 'intent:open:a', positionKey: 'position-shared',
    });
    store.set('legacy-b', {
      id: 'legacy-b', parentOpenIntentId: 'intent:open:b', positionKey: 'position-shared',
    });
    expect((await getProtectionLineageForPosition('position-shared')).ok).toBe(false);
  });
});

describe('§5 INITIAL_STOP 수명주기', () => {
  it('정상: durable 커밋 → 단일 submit 1회 → SUBMITTED (attempts=1)', async () => {
    const submit = vi.fn(async (): Promise<ProtectionSubmitOutcome> => ({ status: 'ACCEPTED', requestId: 'req-1', typedDataDigest: '0xdigest' }));
    setProtectionSubmitFn(submit);
    const r = await createInitialStopAfterOpenConfirmed(STOP_INPUT);
    expect(r.ok).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    const row = await getProtection('prot:intent-1:INITIAL_STOP');
    expect(row?.status).toBe('SUBMITTED');
    expect(row?.submitAttempts).toBe(1);
    expect(row?.requestId).toBe('req-1');
  });
  it('재호출 = 자동 재제출 금지 (submit 추가 0회)', async () => {
    const submit = vi.fn(async (): Promise<ProtectionSubmitOutcome> => ({ status: 'ACCEPTED', requestId: 'req-1', typedDataDigest: null }));
    setProtectionSubmitFn(submit);
    await createInitialStopAfterOpenConfirmed(STOP_INPUT);
    const r2 = await createInitialStopAfterOpenConfirmed(STOP_INPUT);
    expect(r2.ok).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    if (!r2.ok) expect(r2.reason).toContain('자동 재제출 금지');
  });
  it('재시작 후 persisted SUBMITTED 일반 intent는 재제출하지 않는다', async () => {
    const generic = {
      open: {
        ...OPEN,
        parentOpenIntentId: 'intent:open:ai/9dc4036f-9083-4670-b28a-e69dfce5fdc3',
        symbol: 'SOL',
      },
      triggerPriceUsd: 145,
      acceptablePriceUsd: 144.275,
    };
    const submit = vi.fn(async (): Promise<ProtectionSubmitOutcome> => ({
      status: 'ACCEPTED', requestId: 'req-sol', typedDataDigest: null,
    }));
    setProtectionSubmitFn(submit);
    expect((await createInitialStopAfterOpenConfirmed(generic)).ok).toBe(true);
    expect((await createInitialStopAfterOpenConfirmed(generic)).ok).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('deterministic ID의 기존 row 결속이 변조되면 재사용·submit을 거부한다', async () => {
    await planProtection({
      parentOpenIntentId: OPEN.parentOpenIntentId,
      positionKey: 'different-position',
      purpose: 'INITIAL_STOP',
      symbol: OPEN.symbol,
      marketAddress: OPEN.marketAddress,
      isLong: OPEN.isLong,
      sizeDeltaUsd: OPEN.confirmedSizeUsd,
      triggerPriceUsd: STOP_INPUT.triggerPriceUsd,
      acceptablePriceUsd: STOP_INPUT.acceptablePriceUsd,
      dayKey: '2026-08-19',
    });
    const submit = vi.fn();
    setProtectionSubmitFn(submit as never);
    const result = await createInitialStopAfterOpenConfirmed(STOP_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('결속 불일치');
      expect(result.emergencyCloseRequired).toBe(true);
    }
    expect(submit).not.toHaveBeenCalled();
  });
  it.each(['PREPARED', 'SUBMITTING'] as const)(
    '동시 pass가 %s claim을 보면 emergency close 요구 없이 대기',
    async (status) => {
      const submit = vi.fn();
      setProtectionSubmitFn(submit as never);
      await planProtection({
        parentOpenIntentId: OPEN.parentOpenIntentId,
        positionKey: OPEN.positionKey,
        purpose: 'INITIAL_STOP',
        symbol: OPEN.symbol,
        marketAddress: OPEN.marketAddress,
        isLong: OPEN.isLong,
        sizeDeltaUsd: OPEN.confirmedSizeUsd,
        triggerPriceUsd: STOP_INPUT.triggerPriceUsd,
        acceptablePriceUsd: STOP_INPUT.acceptablePriceUsd,
        dayKey: '2026-08-19',
      });
      await transitionProtection('prot:intent-1:INITIAL_STOP', 'PLANNED', 'PREPARED');
      if (status === 'SUBMITTING') {
        await transitionProtection(
          'prot:intent-1:INITIAL_STOP',
          'PREPARED',
          'SUBMITTING',
          { incrementSubmitAttempts: true },
        );
      }
      const result = await createInitialStopAfterOpenConfirmed(STOP_INPUT);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.emergencyCloseRequired).toBe(false);
        expect(result.currentStatus).toBe(status);
      }
      expect(submit).not.toHaveBeenCalled();
    },
  );
  it('제출 결과 불명(예외) → UNRESOLVED + emergency close 요구, 재호출도 제출 0회', async () => {
    const submit = vi.fn(async () => { throw new Error('timeout'); });
    setProtectionSubmitFn(submit as never);
    const r = await createInitialStopAfterOpenConfirmed(STOP_INPUT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.emergencyCloseRequired).toBe(true);
    expect((await getProtection('prot:intent-1:INITIAL_STOP'))?.status).toBe('UNRESOLVED');
    const r2 = await createInitialStopAfterOpenConfirmed(STOP_INPUT);
    expect(r2.ok).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('durable 저장 실패 → 제출 0회 + emergency close 요구', async () => {
    failFlags.insert = true;
    const submit = vi.fn();
    setProtectionSubmitFn(submit as never);
    const r = await createInitialStopAfterOpenConfirmed(STOP_INPUT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.emergencyCloseRequired).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
  it('trigger/size 비정상 → durable 기록도 제출도 없음', async () => {
    const submit = vi.fn();
    setProtectionSubmitFn(submit as never);
    expect((await createInitialStopAfterOpenConfirmed({ ...STOP_INPUT, triggerPriceUsd: 0 })).ok).toBe(false);
    expect((await createInitialStopAfterOpenConfirmed({ open: { ...OPEN, confirmedSizeUsd: 0 }, triggerPriceUsd: 1900, acceptablePriceUsd: 1890 })).ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
  it('submitFn 미구성(잠금 환경) → 네트워크 0회, fail-closed', async () => {
    const r = await createInitialStopAfterOpenConfirmed(STOP_INPUT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('제출 0회');
  });
});

describe('§6 emergency close', () => {
  const EC = { parentOpenIntentId: 'intent-1', positionKey: 'pos-1', symbol: 'ETH', marketAddress: '0x0', isLong: true, fullSizeUsd: 100, reason: 'stop 미확보' };
  it('최대 1회 — 두 번째 호출은 재제출 금지', async () => {
    const submit = vi.fn(async (): Promise<ProtectionSubmitOutcome> => ({ status: 'ACCEPTED', requestId: 'r', typedDataDigest: null }));
    setProtectionSubmitFn(submit);
    const a = await runEmergencyClose(EC);
    expect(a.ok).toBe(true);
    const b = await runEmergencyClose(EC);
    expect(b.ok).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    if (!b.ok) expect(b.reason).toContain('재제출 금지');
  });
  it('결과 불명 → UNRESOLVED (자동 FAILED 금지)', async () => {
    setProtectionSubmitFn(async () => ({ status: 'UNRESOLVED', reason: '전송 후 응답 없음' }));
    const a = await runEmergencyClose(EC);
    expect(a.ok).toBe(false);
    expect((await getProtection('prot:intent-1:EMERGENCY_CLOSE'))?.status).toBe('UNRESOLVED');
  });
  it('size 비정상 → 시도 없음', async () => {
    const submit = vi.fn();
    setProtectionSubmitFn(submit as never);
    expect((await runEmergencyClose({ ...EC, fullSizeUsd: NaN })).ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('§9 reconciliation 적용', () => {
  async function seedSubmitted(): Promise<string> {
    await planProtection({ parentOpenIntentId: 'i1', positionKey: 'p1', purpose: 'INITIAL_STOP', symbol: 'ETH', marketAddress: '0x0', isLong: true, sizeDeltaUsd: 10, triggerPriceUsd: 1, acceptablePriceUsd: 1, dayKey: 'd' });
    const id = 'prot:i1:INITIAL_STOP';
    await transitionProtection(id, 'PLANNED', 'PREPARED');
    await transitionProtection(id, 'PREPARED', 'SUBMITTING', { incrementSubmitAttempts: true });
    await transitionProtection(id, 'SUBMITTING', 'SUBMITTED', { requestId: 'req-1' });
    return id;
  }
  it('온체인 orderKey → ACTIVE (orderKey 영속)', async () => {
    const id = await seedSubmitted();
    const key = '0x' + 'b'.repeat(64);
    const s = await reconcileProtections(async () => ({ apiStatus: 'pending', onchainOrderKey: key, onchainExecuted: false, onchainCancelled: false, onchainFrozen: false, positionExists: true }));
    expect(s.transitioned).toBe(1);
    const row = await getProtection(id);
    expect(row?.status).toBe('ACTIVE');
    expect(row?.orderKey).toBe(key);
  });
  it('API terminal 문자열만 → 전이 없음 + 차단', async () => {
    const id = await seedSubmitted();
    const s = await reconcileProtections(async () => ({ apiStatus: 'executed', onchainOrderKey: null, onchainExecuted: false, onchainCancelled: false, onchainFrozen: false, positionExists: true }));
    expect(s.transitioned).toBe(0);
    expect(s.blockNewOpens).toBe(true);
    expect((await getProtection(id))?.status).toBe('SUBMITTED');
  });
  it('frozen → FROZEN + emergency 대상', async () => {
    await seedSubmitted();
    const s = await reconcileProtections(async () => ({ apiStatus: null, onchainOrderKey: null, onchainExecuted: false, onchainCancelled: false, onchainFrozen: true, positionExists: true }));
    expect(s.emergencyCloseRequired).toEqual(['p1']);
    expect(s.blockNewOpens).toBe(true);
  });
  it('증거 수집 실패 → 전이 없음 + 차단 (자동 조치 금지)', async () => {
    const id = await seedSubmitted();
    const s = await reconcileProtections(async () => null);
    expect(s.transitioned).toBe(0);
    expect(s.blockNewOpens).toBe(true);
    expect((await getProtection(id))?.status).toBe('SUBMITTED');
  });
});

describe('§6 startup coverage', () => {
  it('포지션 조회 실패 → 차단 (fail-closed)', () => {
    const r = checkStartupProtectionCoverage({ positions: null, activeStopPositionKeys: new Set() });
    expect(r.ok).toBe(false);
    expect(r.blockNewOpens).toBe(true);
  });
  it('ACTIVE stop 없는 포지션 → uncovered + 차단', () => {
    const r = checkStartupProtectionCoverage({
      positions: [{ positionKey: 'p1', marketAddress: '0x0', isLong: true, sizeUsd: 50 }],
      activeStopPositionKeys: new Set(),
    });
    expect(r.ok).toBe(false);
    expect(r.uncovered).toEqual([{ positionKey: 'p1', sizeUsd: 50 }]);
  });
  it('전부 커버 → ok', () => {
    const r = checkStartupProtectionCoverage({
      positions: [{ positionKey: 'p1', marketAddress: '0x0', isLong: true, sizeUsd: 50 }],
      activeStopPositionKeys: new Set(['p1']),
    });
    expect(r.ok).toBe(true);
    expect(r.blockNewOpens).toBe(false);
  });
});
