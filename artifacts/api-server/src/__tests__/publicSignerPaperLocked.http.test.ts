/**
 * #125 — PAPER·LIVE 잠금 상태에서 저장된 공개 signer 주소로
 * Owner Approval prepare / canonical readback이 가능해지는지 HTTP 레벨 검증.
 *
 * 핵심 adversarial 보장:
 *  - 런타임 signer 미초기화(강한 게이트 미충족) 상태에서도 prepare가 signer 503을
 *    통과해 GMX readonly transport까지 도달한다 (subaccount=canary 결속)
 *  - 저장 주소가 canary 예상 주소와 불일치하면 prepare 503 (fail-closed)
 *  - canonical readback은 주입된 DataStoreClient.readContract(eth_call 상당)만 사용
 *  - 복호화 0회 · 서명 0회 · 외부 fetch 0회 · 주문 prepare/submit 0회 · 잠금 env 불변
 */
import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

// ── worker_state in-memory DB mock (db-free CI) ──────────────────────────────
const store = new Map<string, string>();

vi.mock('@workspace/db', () => {
  const keyOf = (cond: unknown): string => {
    const chunks = (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
    const strs = chunks.filter((c): c is string => typeof c === 'string' && c !== 'key');
    return strs[strs.length - 1] ?? '';
  };
  function chain(getResult: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'limit', 'offset', 'orderBy', 'set', 'values',
                     'onConflictDoNothing', 'onConflictDoUpdate', 'returning']) {
      c[m] = () => c;
    }
    // where는 worker_state 조회를 실제로 처리 (그 외 테이블은 빈 배열)
    c.where = (cond: unknown) => {
      const k = keyOf(cond);
      const v = k ? store.get(k) : undefined;
      const rows = v === undefined ? [] : [{ key: k, value: v }];
      const p: Record<string, unknown> = { ...c };
      p.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      p.limit = async () => rows;
      p.orderBy = () => ({ limit: async () => rows });
      return p;
    };
    (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
      (resolve) => Promise.resolve(getResult()).then(resolve);
    return c;
  }
  return {
    db: {
      select: () => chain(() => []),
      insert: () => chain(() => []),
      update: () => chain(() => []),
      delete: () => chain(() => []),
    },
    tradesTable: {}, strategyConfigTable: {}, aiDecisionsTable: {},
    liveApprovalsTable: {}, workerStateTable: { key: 'key' }, relayTasksTable: {},
    subaccountApprovalSessionsTable: {}, executionIntentsTable: {},
    runMigrations: vi.fn(async () => {}),
  };
});

// node:crypto 복호화 스파이 — 전 구간 0회
vi.mock('node:crypto', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:crypto')>();
  return { ...orig, createDecipheriv: vi.fn(orig.createDecipheriv) };
});
import { createDecipheriv } from 'node:crypto';

import app from '../app';
import {
  __setGmxApiTransportForTests,
  __setCanonicalClientFactoryForTests,
} from '../routes/livetest';
import { EXPECTED_CANARY_SIGNER } from '../lib/canaryAllowanceInfo';
import { isSignerInitialized } from '../lib/delegatedSigner';
import type { GmxApiTransport } from '../lib/gmxApiTransport';

const PIN = 'test-pin-123456';
const MAIN = '0x46c27887c5EC5E36b2a21E1Ec1BC69e7a593950e';
const ADDR = (b: string) => '0x' + b.repeat(20);
const PUB_KEY = 'delegatedSignerPublicAddress';
const ENC_KEY = 'delegatedSignerEncryptedKey';

const saved: Record<string, string | undefined> = {};
// Production #125 시나리오: PAPER + LIVE 잠금 + 주문 제출 비활성 + readonly만 활성
const ENV: Record<string, string> = {
  OPERATOR_MASTER_PIN: PIN,
  SESSION_SECRET: 's'.repeat(48),
  GMX_WALLET_ADDRESS: MAIN,
  GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: ADDR('11'),
  GMX_DATA_STORE_ADDRESS: ADDR('22'),
  GMX_EVENT_EMITTER_ADDRESS: '0xC8ee91A54287DB53897056e12D9819156D3822Fb',
  DELEGATED_SIGNER_ENABLED: 'true',
  GMX_API_READONLY_ENABLED: 'true',
  LIVE_TEST_EXECUTION_LOCKED: 'true',
  WORKER_ENGINE_MODE: 'PAPER',
  GMX_API_ORDER_SUBMISSION_ENABLED: 'false',
  GMX_RELAY_NETWORK_ENABLED: '',
  GMX_RELAY_SUBMISSION_ENABLED: '',
  GMX_RELAY_MODE: '',
};

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
});
afterAll(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

// 주입식 GMX API transport — postJson 호출 기록 (실 네트워크 0회)
function makeTransportMock(): { transport: GmxApiTransport; calls: { path: string; body: unknown; purpose: string }[] } {
  const calls: { path: string; body: unknown; purpose: string }[] = [];
  const transport = {
    readonlyEnabled: true,
    submissionEnabled: false,
    postJson: async (path: string, body: unknown, purpose: string) => {
      calls.push({ path, body, purpose });
      // prepare 검증 단계 이전에서 흐름을 종료시키는 제어된 실패 —
      // signer 게이트 통과 여부만 검증하는 테스트이므로 세션 생성 0회 유지
      return { ok: false as const, kind: 'http', httpStatus: 502, ambiguous: false, message: 'stub', peerHost: null };
    },
  } as unknown as GmxApiTransport;
  return { transport, calls };
}

// 주입식 canonical DataStoreClient — readContract만 존재 (쓰기·서명 능력 자체가 없음)
function makeCanonicalMock() {
  const calls: { functionName: string }[] = [];
  return {
    calls,
    client: {
      readContract: async (args: { functionName: string }) => {
        calls.push({ functionName: args.functionName });
        switch (args.functionName) {
          case 'containsAddress': return false;             // 미등록 → OWNER_SIGNATURE_REQUIRED
          case 'getUint': return 0n;
          case 'getBytes32': return ('0x' + '00'.repeat(32));
          case 'getBool': return false;
          case 'subaccountApprovalNonces': return 0n;
          default: throw new Error(`unexpected fn: ${args.functionName}`);
        }
      },
      getBlockTimestamp: async () => 1_700_000_000n,
    },
  };
}

const fetchSpy = vi.fn(async () => { throw new Error('외부 fetch 금지 — 테스트 위반'); });

beforeEach(() => {
  store.clear();
  fetchSpy.mockClear();
  (createDecipheriv as ReturnType<typeof vi.fn>).mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setGmxApiTransportForTests(null);
  __setCanonicalClientFactoryForTests(null);
});

function seedStoredPublicAddress(address = EXPECTED_CANARY_SIGNER): void {
  store.set(ENC_KEY, 'aa'.repeat(96)); // 더미 암호문 — 복호화 0회 스파이로 고정
  store.set(PUB_KEY, address);
}

describe('#125 PAPER·잠금 상태 Owner Approval prepare (stored_public 경로)', () => {
  it('저장 공개 주소로 signer 게이트 통과 → GMX readonly transport 도달 (subaccount=canary 결속)', async () => {
    seedStoredPublicAddress();
    const { transport, calls } = makeTransportMock();
    __setGmxApiTransportForTests(transport);
    const canonical = makeCanonicalMock();
    __setCanonicalClientFactoryForTests(() => canonical.client); // nonce도 readContract만

    const res = await request(app)
      .post('/api/executor/subaccount-approval/prepare')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json')
      .send({ walletAddress: MAIN });

    // 제어된 transport 실패 → 502 (signer 503/409를 이미 통과했음을 증명)
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/subaccounts/approval/prepare');
    expect(calls[0].purpose).toBe('readonly');
    const body = calls[0].body as { account: string; subaccount: string };
    expect(body.account).toBe(MAIN);
    expect(body.subaccount).toBe(EXPECTED_CANARY_SIGNER); // canary 결속
    // 주문 prepare/submit 0회 (approval prepare 경로 1회뿐)
    expect(calls.every((c) => c.path === '/subaccounts/approval/prepare')).toBe(true);
    // 보안 불변식
    expect(createDecipheriv).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isSignerInitialized()).toBe(false);
    expect(process.env.LIVE_TEST_EXECUTION_LOCKED).toBe('true');
    expect(process.env.GMX_API_ORDER_SUBMISSION_ENABLED).toBe('false');
  });

  it('저장 주소가 canary 예상 주소와 불일치 → 503 (fail-closed)', async () => {
    seedStoredPublicAddress('0x' + 'ab'.repeat(20));
    const { transport, calls } = makeTransportMock();
    __setGmxApiTransportForTests(transport);

    const res = await request(app)
      .post('/api/executor/subaccount-approval/prepare')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json')
      .send({ walletAddress: MAIN });

    expect(res.status).toBe(503);
    expect(String(res.body.error)).toContain('불일치');
    expect(calls).toHaveLength(0); // transport 미도달
  });

  it('저장 주소 행 없음 → 503 + 프로비저닝 안내', async () => {
    store.set(ENC_KEY, 'aa'.repeat(96)); // 키만 있고 주소 행 없음
    const res = await request(app)
      .post('/api/executor/subaccount-approval/prepare')
      .set('x-operator-pin', PIN)
      .set('content-type', 'application/json')
      .send({ walletAddress: MAIN });
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toContain('프로비저닝');
  });

  it('PIN 없음 → 401 (공개 주소 경로가 운영자 인증을 우회하지 않음)', async () => {
    seedStoredPublicAddress();
    const res = await request(app)
      .post('/api/executor/subaccount-approval/prepare')
      .set('content-type', 'application/json')
      .send({ walletAddress: MAIN });
    expect(res.status).toBe(401);
  });
});

describe('#125 PAPER·잠금 상태 canonical readback (stored_public 경로)', () => {
  it('readback이 주입 클라이언트의 readContract만 사용 + 상태/출처 필드 노출', async () => {
    seedStoredPublicAddress();
    const canonical = makeCanonicalMock();
    __setCanonicalClientFactoryForTests(() => canonical.client);

    const res = await request(app).get('/api/executor/subaccount-auth');
    expect(res.status).toBe(200);
    expect(res.body.signerAddress).toBe(EXPECTED_CANARY_SIGNER);
    expect(res.body.signerAddressSource).toBe('stored_public');
    expect(res.body.privateKeyDecrypted).toBe(false);
    expect(res.body.orderSubmissionEnabled).toBe(false);
    // canonical 판정 도달 (SIGNER_DISABLED로 좌초하지 않음)
    expect(res.body.state).toBe('OWNER_SIGNATURE_REQUIRED');
    expect(res.body.liveEligible).toBe(false); // LIVE는 여전히 차단
    // eth_call 상당(readContract)만 호출됨 — 클라이언트에 쓰기 능력 자체가 없음
    expect(canonical.calls.length).toBeGreaterThan(0);
    // 보안 불변식
    expect(createDecipheriv).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isSignerInitialized()).toBe(false);
  });

  it('온체인 AUTHORIZED여도 stored_public 경로는 liveEligible=false (서명 능력 없음)', async () => {
    seedStoredPublicAddress();
    const calls: { functionName: string }[] = [];
    // 유효한 온체인 위임: listed + 미래 만료 + 잔여 액션 + disabled 아님
    __setCanonicalClientFactoryForTests(() => ({
      readContract: async (args: { functionName: string; args: readonly unknown[] }) => {
        calls.push({ functionName: args.functionName });
        switch (args.functionName) {
          case 'containsAddress': return true;
          case 'getUint':
            // 호출 순서 고정(Promise.all 배열 순): expiresAt → maxAllowed → used
            return [9_999_999_999n, 10n, 0n][calls.filter((c) => c.functionName === 'getUint').length - 1] ?? 0n;
          case 'getBytes32': return ('0x' + '11'.repeat(32));
          case 'getBool': return false;
          case 'subaccountApprovalNonces': return 0n;
          default: throw new Error(`unexpected fn: ${args.functionName}`);
        }
      },
      getBlockTimestamp: async () => 1_700_000_000n,
    }));

    const res = await request(app).get('/api/executor/subaccount-auth');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('AUTHORIZED');       // 순수 canonical 판정
    expect(res.body.authEligible).toBe(true);
    expect(res.body.liveEligible).toBe(false);       // 서명 능력 없음 → LIVE 부적격
    expect(String(res.body.liveBlockedReason)).toContain('서명 능력 없음');
    expect(res.body.privateKeyDecrypted).toBe(false);
    expect(isSignerInitialized()).toBe(false);       // 실행 게이트 입력값도 여전히 false
    expect(createDecipheriv).not.toHaveBeenCalled();
  });

  it('저장 주소 없음 → canonical 조회 스킵 (외부 호출 0회) + 주소 null', async () => {
    const canonical = makeCanonicalMock();
    __setCanonicalClientFactoryForTests(() => canonical.client);
    const res = await request(app).get('/api/executor/subaccount-auth');
    expect(res.status).toBe(200);
    expect(res.body.signerAddress).toBeNull();
    expect(res.body.signerAddressSource).toBeNull();
    expect(canonical.calls).toHaveLength(0);
  });

  it('GET /executor/signer — stored_public 주소·보안 필드 노출', async () => {
    seedStoredPublicAddress();
    const res = await request(app).get('/api/executor/signer');
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(EXPECTED_CANARY_SIGNER);
    expect(res.body.addressSource).toBe('stored_public');
    expect(res.body.initialized).toBe(false);
    expect(res.body.privateKeyDecrypted).toBe(false);
    expect(res.body.orderSubmissionEnabled).toBe(false);
    expect(createDecipheriv).not.toHaveBeenCalled();
  });
});
