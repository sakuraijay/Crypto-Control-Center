/**
 * #125 — 공개 signer 주소 안전 경로 adversarial 테스트.
 *
 * 보장 검증:
 *  - 행 없음 / 중복 / 형식 손상 / 예상 주소 불일치 / DB 오류 / 고아 주소 → fail-closed
 *  - 조회 성공 시에도 복호화(createDecipheriv) 0회 · 외부 네트워크 0회 ·
 *    모듈 런타임 상태 불변(isSignerInitialized=false 유지)
 *  - 프로비저닝이 공개 주소를 write-once backfill하며, 저장값 불일치 시 overwrite 금지
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── 제어 가능한 worker_state in-memory mock (signerProvisioning.test.ts와 동일 패턴) ──
const store = new Map<string, string>();
let dbFail = false;
let duplicateRowsFor: string | null = null; // 특정 키 조회 시 중복 행 반환

vi.mock('@workspace/db', () => {
  const keyOf = (cond: unknown): string => {
    const chunks = (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
    const strs = chunks.filter((c): c is string => typeof c === 'string' && c !== 'key');
    return strs[strs.length - 1] ?? '';
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: (cond: unknown) => {
            if (dbFail) return Promise.reject(new Error('conn refused: postgres://user:pw@host/db'));
            const k = keyOf(cond);
            const v = store.get(k);
            if (v === undefined) return Promise.resolve([]);
            const row = { key: k, value: v };
            return Promise.resolve(duplicateRowsFor === k ? [row, { ...row }] : [row]);
          },
        }),
      }),
      insert: () => ({
        values: (row: { key: string; value: string }) => ({
          onConflictDoNothing: () => {
            if (dbFail) return Promise.reject(new Error('insert failed'));
            if (!store.has(row.key)) store.set(row.key, row.value);
            return Promise.resolve([]);
          },
          onConflictDoUpdate: () => {
            if (dbFail) return Promise.reject(new Error('insert failed'));
            store.set(row.key, row.value);
            return Promise.resolve([]);
          },
        }),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
      delete: () => ({ where: () => Promise.resolve([]) }),
    },
    workerStateTable: { key: 'key' },
    tradesTable: {}, strategyConfigTable: {}, aiDecisionsTable: {}, liveApprovalsTable: {},
    runMigrations: vi.fn(async () => {}),
  };
});

// node:crypto 복호화 스파이 — 공개 주소 조회 경로에서 0회여야 한다
vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>();
  return { ...orig, createDecipheriv: vi.fn(orig.createDecipheriv) };
});
import { createDecipheriv } from 'node:crypto';

import {
  getStoredPublicSignerAddress,
  provisionDelegatedSigner,
  isSignerInitialized,
  getSignerAddress,
  __resetDelegatedSignerForTests,
} from '../lib/delegatedSigner';

const SECRET = 's'.repeat(48);
const PUB_KEY = 'delegatedSignerPublicAddress';
const ENC_KEY = 'delegatedSignerEncryptedKey';
const META_KEY = 'delegatedSignerMeta';
const CANARY = '0xc56436F09039E15Aa2244659d0fC5b7f706DdbF6';

function stubPaperLockedEnv(): void {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('GMX_API_READONLY_ENABLED', 'true');
  vi.stubEnv('DELEGATED_SIGNER_ENABLED', 'true');
  vi.stubEnv('LIVE_TEST_EXECUTION_LOCKED', 'true');
  for (const k of ['WORKER_ENGINE_MODE', 'GMX_API_ORDER_SUBMISSION_ENABLED',
                   'GMX_RELAY_NETWORK_ENABLED', 'GMX_RELAY_SUBMISSION_ENABLED', 'GMX_RELAY_MODE']) {
    vi.stubEnv(k, '');
  }
}

const fetchSpy = vi.fn();

beforeEach(() => {
  store.clear();
  dbFail = false;
  duplicateRowsFor = null;
  __resetDelegatedSignerForTests();
  stubPaperLockedEnv();
  fetchSpy.mockClear();
  (createDecipheriv as ReturnType<typeof vi.fn>).mockClear();
  vi.stubGlobal('fetch', fetchSpy); // 외부 네트워크 호출 0회 검증
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** 프로비저닝된 상태를 흉내: 암호키 행 + 공개 주소 행 */
function seedProvisioned(address = CANARY): void {
  store.set(ENC_KEY, 'aa'.repeat(96)); // 형식만 갖춘 더미 암호문 — 절대 복호화되지 않아야 함
  store.set(META_KEY, JSON.stringify({ createdAt: new Date().toISOString() }));
  store.set(PUB_KEY, address);
}

describe('#125 getStoredPublicSignerAddress — fail-closed 전수', () => {
  it('행 없음 → 실패 (프로비저닝 안내)', async () => {
    store.set(ENC_KEY, 'aa'.repeat(96));
    const r = await getStoredPublicSignerAddress(CANARY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('저장된 공개 signer 주소 없음');
  });

  it('중복 행 → 실패', async () => {
    seedProvisioned();
    duplicateRowsFor = PUB_KEY;
    const r = await getStoredPublicSignerAddress(CANARY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('중복');
  });

  it('형식 손상(주소 아님) → 실패', async () => {
    seedProvisioned('not-an-address');
    const r = await getStoredPublicSignerAddress(CANARY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('손상');
  });

  it('예상 canary 주소 불일치 → 실패', async () => {
    seedProvisioned('0x' + 'ab'.repeat(20));
    const r = await getStoredPublicSignerAddress(CANARY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('불일치');
  });

  it('DB 오류 → 실패 (원문 오류·연결 문자열 미노출)', async () => {
    seedProvisioned();
    dbFail = true;
    const r = await getStoredPublicSignerAddress(CANARY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('DB 조회 실패');
      expect(r.reason).not.toContain('postgres://');
    }
  });

  it('암호키 행 부재(고아 공개 주소) → 실패', async () => {
    store.set(PUB_KEY, CANARY); // 키 행 없이 주소만 존재
    const r = await getStoredPublicSignerAddress(CANARY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('고아');
  });

  it('DELEGATED_SIGNER_ENABLED 미설정 → 실패', async () => {
    seedProvisioned();
    vi.stubEnv('DELEGATED_SIGNER_ENABLED', '');
    const r = await getStoredPublicSignerAddress(CANARY);
    expect(r.ok).toBe(false);
  });

  it('성공 경로: 주소 반환 + 복호화 0회 + 외부 호출 0회 + 런타임 상태 불변', async () => {
    seedProvisioned();
    const r = await getStoredPublicSignerAddress(CANARY);
    expect(r).toEqual({ ok: true, address: CANARY });
    expect(createDecipheriv).not.toHaveBeenCalled();  // 암호문 접근·복호화 0회
    expect(fetchSpy).not.toHaveBeenCalled();          // 외부 네트워크 0회
    expect(isSignerInitialized()).toBe(false);        // 모듈 상태 불변
    expect(getSignerAddress()).toBeNull();
    // 잠금·PAPER env 불변
    expect(process.env.LIVE_TEST_EXECUTION_LOCKED).toBe('true');
    expect(process.env.GMX_API_ORDER_SUBMISSION_ENABLED).not.toBe('true');
  });
});

describe('#125 프로비저닝 공개 주소 backfill (write-once)', () => {
  it('신규 프로비저닝이 공개 주소 행을 함께 저장한다', async () => {
    const result = await provisionDelegatedSigner(process.env);
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(store.get(PUB_KEY)).toBe(result.address);
    // 저장 직후 안전 경로 조회 가능 (예상 주소 = 방금 파생된 주소)
    const r = await getStoredPublicSignerAddress(result.address);
    expect(r).toEqual({ ok: true, address: result.address });
  });

  it('기존 signer 재프로비저닝(idempotent)이 공개 주소를 backfill한다', async () => {
    const first = await provisionDelegatedSigner(process.env);
    store.delete(PUB_KEY); // 과거 버전에서 프로비저닝돼 주소 행이 없는 상황 재현
    const second = await provisionDelegatedSigner(process.env);
    expect(second.created).toBe(false);
    expect(second.address).toBe(first.address);
    expect(store.get(PUB_KEY)).toBe(first.address);
  });

  it('저장된 공개 주소가 파생 주소와 불일치하면 overwrite하지 않고 실패', async () => {
    await provisionDelegatedSigner(process.env);
    store.set(PUB_KEY, '0x' + 'ff'.repeat(20)); // 변조
    await expect(provisionDelegatedSigner(process.env)).rejects.toThrow(/공개 주소 영속 검증 실패/);
    expect(store.get(PUB_KEY)).toBe('0x' + 'ff'.repeat(20)); // overwrite 없음 (fail-closed)
  });
});
