/**
 * Canary P0 — 운영자 signer 프로비저닝 adversarial 테스트.
 *
 * 계약:
 *  §1 게이트 — 전제조건(readonly on, signer flag on, PAPER, 잠금 유지, 제출/relay
 *     전부 비활성) 하나라도 어긋나면 차단, DB 접근 0회
 *  §2 인증 — 무PIN/오PIN 401, 비JSON 415, PIN 미설정 503
 *  §3 idempotent — 기존 signer 존재 시 새 키 생성 없이 동일 공개주소만 반환
 *  §4 동시성 — 동시 2요청에도 DB 승자 1개, 두 응답 모두 같은 주소
 *  §5 fail-closed — DB 오류/손상/복호화 실패/SESSION_SECRET 미달 시 생성 금지
 *  §6 비노출 — 응답/오류에 개인키·암호문·PIN·Secret 미포함, 외부 fetch·서명 0회
 *  §7 최소권한 분리 — 프로비저닝 성공 후에도 런타임 서명 경로·초기화 상태 불변
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// ── 제어 가능한 worker_state in-memory mock ─────────────────────────────────
const store = new Map<string, string>();
let dbFail = false;
let selectCount = 0;

vi.mock('@workspace/db', () => {
  const keyOf = (cond: unknown): string => {
    // drizzle eq(col, X)는 SQL 객체 — queryChunks의 Param에서 문자열 값을 추출
    // mock 테이블에서 컬럼은 문자열 'key'이므로 queryChunks는
    // [StringChunk, 'key', StringChunk(' = '), '<조회값>', StringChunk] 형태
    const chunks = (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
    const strs = chunks.filter((c): c is string => typeof c === 'string' && c !== 'key');
    return strs[strs.length - 1] ?? '';
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: (cond: unknown) => {
            selectCount++;
            if (dbFail) return Promise.reject(new Error('conn refused: postgres://user:pw@host/db'));
            const k = keyOf(cond);
            const v = store.get(k);
            return Promise.resolve(v === undefined ? [] : [{ key: k, value: v }]);
          },
        }),
      }),
      insert: () => ({
        values: (row: { key: string; value: string }) => {
          const chain = {
            onConflictDoNothing: () => {
              if (dbFail) return Promise.reject(new Error('insert failed'));
              if (!store.has(row.key)) store.set(row.key, row.value); // PK 단일성
              return Promise.resolve([]);
            },
            onConflictDoUpdate: () => {
              if (dbFail) return Promise.reject(new Error('insert failed'));
              store.set(row.key, row.value);
              return Promise.resolve([]);
            },
          };
          return chain;
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
      delete: () => ({ where: () => Promise.resolve([]) }),
    },
    workerStateTable: { key: 'key' },
    tradesTable: {}, strategyConfigTable: {}, aiDecisionsTable: {}, liveApprovalsTable: {},
    runMigrations: vi.fn(async () => {}),
  };
});

import app from '../app';
import {
  provisionDelegatedSigner,
  isSignerProvisioningAllowed,
  isSignerInitialized,
  getSignerAddress,
  signDigestWithDelegatedSigner,
  __resetDelegatedSignerForTests,
} from '../lib/delegatedSigner';

const PIN = 'test-pin-123456';
const SECRET = 's'.repeat(48);

/** P0 프로비저닝 허용 env (Canary 2단계 production 조합) */
function stubStage2Env(): void {
  vi.stubEnv('OPERATOR_MASTER_PIN', PIN);
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('GMX_API_READONLY_ENABLED', 'true');
  vi.stubEnv('DELEGATED_SIGNER_ENABLED', 'true');
  vi.stubEnv('LIVE_TEST_EXECUTION_LOCKED', 'true');
  for (const k of ['WORKER_ENGINE_MODE','GMX_API_ORDER_SUBMISSION_ENABLED',
                   'GMX_RELAY_NETWORK_ENABLED','GMX_RELAY_SUBMISSION_ENABLED','GMX_RELAY_MODE']) {
    vi.stubEnv(k, '');
  }
}

const globalFetchSpy = vi.fn();

beforeEach(() => {
  store.clear();
  dbFail = false;
  selectCount = 0;
  __resetDelegatedSignerForTests();
  stubStage2Env();
  globalFetchSpy.mockClear();
  vi.stubGlobal('fetch', globalFetchSpy); // 외부 네트워크 호출 0회 검증
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const post = (headers: Record<string, string> = {}, body: unknown = {}) =>
  request(app).post('/api/executor/signer/provision').set(headers).send(body as object);

describe('§2 인증 계약', () => {
  it('무PIN → 401, DB 접근 0회', async () => {
    const res = await post({ 'Content-Type': 'application/json' });
    expect(res.status).toBe(401);
    expect(selectCount).toBe(0);
  });
  it('오PIN → 401', async () => {
    const res = await post({ 'Content-Type': 'application/json', 'x-operator-pin': 'wrong-pin-999' });
    expect(res.status).toBe(401);
    expect(selectCount).toBe(0);
  });
  it('비JSON content-type → 415', async () => {
    const res = await request(app).post('/api/executor/signer/provision')
      .set({ 'Content-Type': 'text/plain', 'x-operator-pin': PIN }).send('x');
    expect(res.status).toBe(415);
  });
  it('OPERATOR_MASTER_PIN 미설정 → 503 (fail-closed)', async () => {
    vi.stubEnv('OPERATOR_MASTER_PIN', '');
    const res = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    expect(res.status).toBe(503);
  });
});

describe('§1 게이트 — 잘못된 상태에서 차단 (DB 접근 0회)', () => {
  const cases: Array<[string, string, string]> = [
    ['GMX_API_READONLY_ENABLED', 'false', 'readonly 꺼짐'],
    ['DELEGATED_SIGNER_ENABLED', 'false', 'signer flag 꺼짐'],
    ['WORKER_ENGINE_MODE', 'LIVE', 'LIVE 모드'],
    ['LIVE_TEST_EXECUTION_LOCKED', 'false', '잠금 해제 상태'],
    ['GMX_API_ORDER_SUBMISSION_ENABLED', 'true', 'API 제출 활성'],
    ['GMX_RELAY_NETWORK_ENABLED', 'true', 'relay 네트워크 활성'],
    ['GMX_RELAY_SUBMISSION_ENABLED', 'true', 'relay 제출 활성'],
    ['GMX_RELAY_MODE', 'LIVE', 'relay LIVE mode'],
  ];
  for (const [key, value, label] of cases) {
    it(`${label} (${key}=${value}) → 409 차단·키 생성 0회`, async () => {
      vi.stubEnv(key, value);
      const res = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
      expect(selectCount).toBe(0);      // 저장소 접근 자체가 0회
      expect(store.size).toBe(0);       // 키 생성 0회
    });
  }
  it('isSignerProvisioningAllowed — 2단계 조합은 allowed=true', () => {
    expect(isSignerProvisioningAllowed(process.env).allowed).toBe(true);
  });
});

describe('§3/§4 정상 경로 — 신규 생성·idempotent·동시성', () => {
  it('absent → 신규 생성, 공개주소만 반환 (created=true)', async () => {
    const res = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.created).toBe(true);
    expect(res.body.signerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(res.body.liveExecutionLocked).toBe(true);
    expect(store.has('delegatedSignerEncryptedKey')).toBe(true);
  });

  it('기존 signer 존재 → 새 키 생성 없이 동일 주소 반환 (created=false)', async () => {
    const first = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    const storedCipher = store.get('delegatedSignerEncryptedKey');
    const second = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.signerAddress).toBe(first.body.signerAddress);
    expect(store.get('delegatedSignerEncryptedKey')).toBe(storedCipher); // overwrite 없음
  });

  it('동시 2요청 → 키 1개, 두 응답 모두 같은 주소, created는 최대 1회', async () => {
    const [a, b] = await Promise.all([
      provisionDelegatedSigner(process.env),
      provisionDelegatedSigner(process.env),
    ]);
    expect(a.address).toBe(b.address);
    expect(store.has('delegatedSignerEncryptedKey')).toBe(true);
    expect([a.created, b.created].filter(Boolean).length).toBeLessThanOrEqual(1);
  });
});

describe('§5 fail-closed — 오류 시 생성/overwrite 금지', () => {
  it('DB 조회 실패 → 409, 신규 생성 금지, DB 원문 오류 미노출', async () => {
    dbFail = true;
    const res = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    expect(res.status).toBe(409);
    expect(store.size).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
  });

  it('메타만 남은 손상 상태 → corrupt 차단, overwrite 금지', async () => {
    store.set('delegatedSignerMeta', JSON.stringify({ createdAt: '2026-01-01T00:00:00Z' }));
    const res = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    expect(res.status).toBe(409);
    expect(store.has('delegatedSignerEncryptedKey')).toBe(false);
  });

  it('SESSION_SECRET 변경으로 복호화 실패 → 신규 생성·overwrite 금지', async () => {
    await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN }); // 생성
    const cipherBefore = store.get('delegatedSignerEncryptedKey');
    vi.stubEnv('SESSION_SECRET', 'x'.repeat(48)); // 다른 secret
    const res = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('복호화 실패');
    expect(store.get('delegatedSignerEncryptedKey')).toBe(cipherBefore);
  });

  it('SESSION_SECRET 길이 미달 → 409, 키 생성 0회', async () => {
    vi.stubEnv('SESSION_SECRET', 'short');
    const res = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    expect(res.status).toBe(409);
    expect(store.size).toBe(0);
  });
});

describe('§6/§7 비노출·최소권한 분리', () => {
  it('응답에 개인키·암호문·PIN·Secret 미포함, 외부 fetch 0회', async () => {
    const res = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    const raw = JSON.stringify(res.body);
    const cipher = store.get('delegatedSignerEncryptedKey')!;
    expect(raw).not.toContain(cipher);
    expect(raw).not.toContain(cipher.slice(0, 32));
    expect(raw).not.toContain(PIN);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toMatch(/[0-9a-fA-F]{64,}/); // 64+ hex(개인키·암호문 형태) 부재
    expect(globalFetchSpy).toHaveBeenCalledTimes(0);
  });

  it('프로비저닝 성공 후에도 런타임 서명 경로는 미초기화·차단 유지', async () => {
    await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    expect(isSignerInitialized()).toBe(false);   // 모듈 런타임 상태 불변
    expect(getSignerAddress()).toBeNull();
    await expect(
      signDigestWithDelegatedSigner(`0x${'ab'.repeat(32)}` as `0x${string}`),
    ).rejects.toThrow(/차단|disabled|미초기화/); // 강한 전체 게이트 그대로
  });

  it('Emergency Stop 활성 → 409 차단', async () => {
    const { setEmergencyStop } = await import('../workers/liveTestExecutor');
    setEmergencyStop('provisioning adversarial test');
    const res = await post({ 'Content-Type': 'application/json', 'x-operator-pin': PIN });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Emergency Stop');
    const { clearEmergencyStopForTests } = await import('../workers/liveTestExecutor') as unknown as { clearEmergencyStopForTests?: () => void };
    clearEmergencyStopForTests?.();
  });
});
