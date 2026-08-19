/**
 * GMX delegated trading 6단계 — 읽기 전용 네트워크와 LIVE 제출 네트워크 분리.
 *
 * 검증 (지시서 §8):
 *  - 플래그 매트릭스: read-only만 → GET 허용·POST 0회; submit 계열 단독 → 전부 0회
 *  - transport 내부 최종 게이트 (호출측 우회 가정)
 *  - signer 저장소 접근 게이트 (read-only만으로는 DB·복호화·키 생성 0회)
 *  - relay read-only RPC client 분리 (플래그 없으면 client 미생성)
 *  - readiness refresh: GET/eth_call만 수행, POST·signer·task 생성 0회
 *  - activation 게이트에 read-only 플래그 요구 추가
 *
 * DB-free: @workspace/db mock. 외부 fetch는 전부 spy/mock — 실호출 0회.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── @workspace/db 모킹 (CI DB-free 규칙) ─────────────────────────────────────
vi.mock('@workspace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue([]) }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  },
  workerStateTable: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
  relayTasksTable: {}, relayNoncesTable: {}, executionIntentsTable: {},
  subaccountApprovalSessionsTable: {},
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => 'eq'), inArray: vi.fn(() => 'inArray'), desc: vi.fn(() => 'desc'),
}));

import {
  createGelatoHttpTransport, GELATO_API_KEY_SECRET_NAME, type RelayTransport,
} from '../lib/relayTransport';
import {
  isRelayReadonlyNetworkEnabled, recordReadinessRefresh, getReadinessRefreshState,
  __resetReadinessRefreshForTests,
} from '../lib/relayActivationStatus';
import { performReadinessRefresh } from '../lib/relayReadinessRefresh';
import { createRelayReadonlyClient, __setRelayReadonlyPublicClientFactoryForTests } from '../lib/relayReadonlyClient';
import { evaluateActivationGate, type ActivationGateInput } from '../lib/relayActivationGate';
import { isSignerStorageAccessAllowed } from '../lib/delegatedSigner';

const VALID_TARGET = '0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f'; // 6C: submit target은 manifest router만 허용
const VALID_DATA = '0x1234567890abcdef';

function envOf(flags: Record<string, string>): NodeJS.ProcessEnv {
  return flags as unknown as NodeJS.ProcessEnv;
}

const ALL_SUBMIT_FLAGS = {
  GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
  GMX_RELAY_NETWORK_ENABLED: 'true',
  GMX_RELAY_SUBMISSION_ENABLED: 'true',
  GMX_RELAY_MODE: 'LIVE',
  [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
};

const VALID_TASK_ID = `0x${'ab'.repeat(32)}`;

async function callAll(t: RelayTransport) {
  const q = await t.getSponsorBalance();
  const s = await t.submitRelayTask({ chainId: 42161, target: VALID_TARGET, packedData: VALID_DATA });
  const st = await t.getRelayTaskStatus({ taskId: VALID_TASK_ID });
  return { q, s, st };
}

// JSON-RPC 2.0 mock — 요청 body의 method/id에 맞는 응답을 돌려준다 (6F-2)
function rpcResponseFor(body: string): Response {
  const req = JSON.parse(body) as { id: number; method: string };
  let result: unknown;
  if (req.method === 'relayer_getStatus') result = { status: 200, hash: `0x${'cd'.repeat(32)}`, receipt: { transactionHash: `0x${'cd'.repeat(32)}`, blockNumber: 1 } };
  else if (req.method === 'gelato_getBalance') result = { balance: '1000000', decimals: 18, unit: 'wei' };
  else result = `0x${'ef'.repeat(32)}`; // relayer_sendTransaction → taskId
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // 매 호출마다 새 Response — body 스트림은 1회만 읽을 수 있으므로 재사용 금지
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    rpcResponseFor(String((init as RequestInit | undefined)?.body ?? '{}')),
  ) as unknown as ReturnType<typeof vi.spyOn>;
});
afterEach(() => {
  fetchSpy.mockRestore();
  __resetReadinessRefreshForTests();
});

// ═════════════════════════════════════════════════════════════════════════════
describe('6단계 §2 — read-only 플래그 해석', () => {
  it("정확히 'true'일 때만 활성 — 기존 플래그가 암묵적으로 켜지 않는다", () => {
    expect(isRelayReadonlyNetworkEnabled(envOf({}))).toBe(false);
    expect(isRelayReadonlyNetworkEnabled(envOf({ GMX_RELAY_READONLY_NETWORK_ENABLED: 'TRUE' }))).toBe(false);
    expect(isRelayReadonlyNetworkEnabled(envOf({ GMX_RELAY_READONLY_NETWORK_ENABLED: '1' }))).toBe(false);
    // submit 계열 전부 켜도 read-only는 꺼져 있음
    expect(isRelayReadonlyNetworkEnabled(envOf({
      GMX_RELAY_NETWORK_ENABLED: 'true', GMX_RELAY_SUBMISSION_ENABLED: 'true', GMX_RELAY_MODE: 'LIVE',
    }))).toBe(false);
    expect(isRelayReadonlyNetworkEnabled(envOf({ GMX_RELAY_READONLY_NETWORK_ENABLED: 'true' }))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('6단계 §3 — transport 플래그 매트릭스 (fetch 발신 여부)', () => {
  it('모든 플래그 미설정 → 모든 relay fetch 0회', async () => {
    const t = createGelatoHttpTransport(envOf({ [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real' }));
    const { q, s, st } = await callAll(t);
    expect(q.ok).toBe(false); expect(s.ok).toBe(false); expect(st.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('read-only만 true → balance/status 조회만 허용, submit 발신 0회', async () => {
    const t = createGelatoHttpTransport(envOf({
      GMX_RELAY_READONLY_NETWORK_ENABLED: 'true', [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
    }));
    const { q, s, st } = await callAll(t);
    expect(q.ok).toBe(true);
    expect(st.ok).toBe(true);
    expect(s.ok).toBe(false);
    if (!s.ok) { expect(s.kind).toBe('config'); expect(s.ambiguous).toBe(false); }
    // fetch 2회 — 전부 read-only method, relayer_sendTransaction 없음
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const methods = fetchSpy.mock.calls.map((call: unknown[]) =>
      (JSON.parse(String((call[1] as RequestInit).body)) as { method: string }).method);
    expect(methods.sort()).toEqual(['gelato_getBalance', 'relayer_getStatus']);
    expect(methods).not.toContain('relayer_sendTransaction');
  });

  it('submit network만 true → 모든 relay fetch 0회', async () => {
    const t = createGelatoHttpTransport(envOf({
      GMX_RELAY_NETWORK_ENABLED: 'true', [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
    }));
    const { q, s, st } = await callAll(t);
    expect(q.ok).toBe(false); expect(s.ok).toBe(false); expect(st.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('submission enabled만 true → 모든 relay fetch 0회', async () => {
    const t = createGelatoHttpTransport(envOf({
      GMX_RELAY_SUBMISSION_ENABLED: 'true', [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
    }));
    const { q, s, st } = await callAll(t);
    expect(q.ok).toBe(false); expect(s.ok).toBe(false); expect(st.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mode LIVE만 설정 → 모든 relay fetch 0회', async () => {
    const t = createGelatoHttpTransport(envOf({
      GMX_RELAY_MODE: 'LIVE', [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
    }));
    const { q, s, st } = await callAll(t);
    expect(q.ok).toBe(false); expect(s.ok).toBe(false); expect(st.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('read-only+submit network지만 submission disabled → POST 0회', async () => {
    const t = createGelatoHttpTransport(envOf({
      GMX_RELAY_READONLY_NETWORK_ENABLED: 'true', GMX_RELAY_NETWORK_ENABLED: 'true',
      GMX_RELAY_MODE: 'LIVE', [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
    }));
    const s = await t.submitRelayTask({ chainId: 42161, target: VALID_TARGET, packedData: VALID_DATA });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.message).toContain('LEGACY_DISABLED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('read-only+submission enabled지만 submit network disabled → POST 0회', async () => {
    const t = createGelatoHttpTransport(envOf({
      GMX_RELAY_READONLY_NETWORK_ENABLED: 'true', GMX_RELAY_SUBMISSION_ENABLED: 'true',
      GMX_RELAY_MODE: 'LIVE', [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
    }));
    const s = await t.submitRelayTask({ chainId: 42161, target: VALID_TARGET, packedData: VALID_DATA });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.message).toContain('LEGACY_DISABLED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('6G-1: 네 플래그 전부 true + key여도 legacy submit은 LEGACY_DISABLED — fetch 0회', async () => {
    const t = createGelatoHttpTransport(envOf(ALL_SUBMIT_FLAGS));
    const s = await t.submitRelayTask({ chainId: 42161, target: VALID_TARGET, packedData: VALID_DATA });
    expect(s.ok).toBe(false);
    if (!s.ok) { expect(s.kind).toBe('config'); expect(s.ambiguous).toBe(false); expect(s.message).toContain('LEGACY_DISABLED'); }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('전부 활성이라도 chainId ≠ 42161 → fetch 0회', async () => {
    const t = createGelatoHttpTransport(envOf(ALL_SUBMIT_FLAGS));
    const s = await t.submitRelayTask({ chainId: 1, target: VALID_TARGET, packedData: VALID_DATA });
    expect(s.ok).toBe(false);
    if (!s.ok) { expect(s.kind).toBe('config'); expect(s.ambiguous).toBe(false); }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('전부 활성이라도 target/packedData 형식 오류 → fetch 0회', async () => {
    const t = createGelatoHttpTransport(envOf(ALL_SUBMIT_FLAGS));
    const bad1 = await t.submitRelayTask({ chainId: 42161, target: 'not-an-address', packedData: VALID_DATA });
    const bad2 = await t.submitRelayTask({ chainId: 42161, target: VALID_TARGET, packedData: '0x' });
    expect(bad1.ok).toBe(false); expect(bad2.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("GMX_RELAY_MODE='DRY_RUN'이면 세 플래그가 켜져도 POST 0회", async () => {
    const t = createGelatoHttpTransport(envOf({ ...ALL_SUBMIT_FLAGS, GMX_RELAY_MODE: 'DRY_RUN' }));
    const s = await t.submitRelayTask({ chainId: 42161, target: VALID_TARGET, packedData: VALID_DATA });
    expect(s.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('6단계 §4 — signer 저장소 접근 게이트', () => {
  const FULL = {
    GMX_RELAY_READONLY_NETWORK_ENABLED: 'true', GMX_RELAY_NETWORK_ENABLED: 'true',
    GMX_RELAY_SUBMISSION_ENABLED: 'true', GMX_RELAY_MODE: 'LIVE',
    DELEGATED_SIGNER_ENABLED: 'true', WORKER_ENGINE_MODE: 'LIVE', LIVE_TEST_EXECUTION_LOCKED: 'false',
  };

  it('전부 충족 시에만 allowed=true', () => {
    expect(isSignerStorageAccessAllowed(envOf(FULL)).allowed).toBe(true);
  });

  const cases: Array<[string, string]> = [
    ['GMX_RELAY_READONLY_NETWORK_ENABLED', 'false'],
    ['GMX_RELAY_NETWORK_ENABLED', 'false'],
    ['GMX_RELAY_SUBMISSION_ENABLED', 'false'],
    ['GMX_RELAY_MODE', 'DRY_RUN'],
    ['DELEGATED_SIGNER_ENABLED', 'false'],
    ['WORKER_ENGINE_MODE', 'PAPER'],
    ['LIVE_TEST_EXECUTION_LOCKED', 'true'],
  ];
  for (const [key, bad] of cases) {
    it(`${key} 미충족 → 저장소 접근 차단`, () => {
      const r = isSignerStorageAccessAllowed(envOf({ ...FULL, [key]: bad }));
      expect(r.allowed).toBe(false);
      expect(r.missing.length).toBeGreaterThan(0);
    });
  }

  it('read-only만 활성(canonical 조회 상태) → signer DB 조회·복호화·키 생성 0회', async () => {
    vi.resetModules();
    vi.stubEnv('DELEGATED_SIGNER_ENABLED', 'true');
    vi.stubEnv('SESSION_SECRET', 'test-session-secret-for-stage6-readonly-gate-check-x');
    vi.stubEnv('GMX_RELAY_READONLY_NETWORK_ENABLED', 'true');
    vi.stubEnv('GMX_RELAY_NETWORK_ENABLED', 'false');
    vi.stubEnv('GMX_RELAY_SUBMISSION_ENABLED', 'false');
    vi.stubEnv('GMX_RELAY_MODE', '');
    vi.stubEnv('WORKER_ENGINE_MODE', 'PAPER');
    vi.stubEnv('LIVE_TEST_EXECUTION_LOCKED', 'true');
    const mod = await import('../lib/delegatedSigner');
    mod.__resetDelegatedSignerForTests();
    const { db } = await import('@workspace/db');
    (db.select as ReturnType<typeof vi.fn>).mockClear();
    await mod.initializeDelegatedSigner();          // throw 없이 no-op
    expect(mod.isSignerInitialized()).toBe(false);
    expect(mod.getSignerAddress()).toBeNull();
    expect(db.select).not.toHaveBeenCalled();       // signer DB 조회 0회
    // 서명도 차단
    await expect(mod.signDigestWithDelegatedSigner(`0x${'a'.repeat(64)}` as `0x${string}`))
      .rejects.toThrow(/차단|fail-closed/);
    vi.unstubAllEnvs();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('6단계 §5 — relay read-only RPC client 분리', () => {
  afterEach(() => __setRelayReadonlyPublicClientFactoryForTests(null));

  it('read-only 플래그 미설정 → client 미생성 (연결 시작 없음)', () => {
    const factorySpy = vi.fn();
    __setRelayReadonlyPublicClientFactoryForTests(factorySpy as never);
    const r = createRelayReadonlyClient(envOf({ GMX_RPC_URL: 'https://rpc.example' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('GMX_RELAY_READONLY_NETWORK_ENABLED');
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('플래그 켜도 GMX_RPC_URL 없으면 미생성 (fail-closed)', () => {
    const r = createRelayReadonlyClient(envOf({ GMX_RELAY_READONLY_NETWORK_ENABLED: 'true' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('GMX_RPC_URL');
  });

  it('허용 메서드만 노출 — 쓰기·서명·sendRawTransaction·wallet_* 능력 없음', () => {
    const fake = {
      readContract: vi.fn(), getBlock: vi.fn().mockResolvedValue({ timestamp: 1n }),
      getTransactionReceipt: vi.fn(), getLogs: vi.fn(),
      sendRawTransaction: vi.fn(), writeContract: vi.fn(),
    };
    __setRelayReadonlyPublicClientFactoryForTests((() => fake) as never);
    const r = createRelayReadonlyClient(envOf({
      GMX_RELAY_READONLY_NETWORK_ENABLED: 'true', GMX_RPC_URL: 'https://rpc.example',
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.client).sort()).toEqual(
        ['getBlockTimestamp', 'getChainId', 'getCode', 'getGasPrice', 'getLogs', 'getTransactionReceipt', 'readContract'].sort(),
      );
      expect('sendRawTransaction' in r.client).toBe(false);
      expect('writeContract' in r.client).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('6단계 §6 — activation 게이트에 read-only 플래그 요구', () => {
  function fullInput(env: Record<string, string>): ActivationGateInput {
    return {
      env: envOf(env),
      liveTestMode: true, signerInitialized: true, canonicalAuthorized: true,
      emergencyStopActive: false, dbOk: true, rpcOk: true, reconciliationComplete: true,
      blockingIntentCount: 0, activeRevokeInProgress: false, freshLiveFeeQuote: true,
      currentChainId: 42161, gmxConfigOk: true, deploymentVerified: true, kind: 'OPEN',
    };
  }
  const FULL_ENV = {
    WORKER_ENGINE_MODE: 'LIVE', LIVE_TEST_EXECUTION_LOCKED: 'false',
    DELEGATED_SIGNER_ENABLED: 'true', GMX_RELAY_SUBMISSION_ENABLED: 'true',
    GMX_RELAY_NETWORK_ENABLED: 'true', GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
    GMX_RELAY_MODE: 'LIVE',
    GMX_API_READONLY_ENABLED: 'true', GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
    GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: '0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f',
    GMX_DATA_STORE_ADDRESS: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
    GMX_EVENT_EMITTER_ADDRESS: '0xC8ee91A54287DB53897056e12D9819156D3822Fb',
  };

  it('read-only 플래그 포함 전부 충족 시에만 networkEligible=true', () => {
    expect(evaluateActivationGate(fullInput(FULL_ENV)).networkEligible).toBe(true);
  });

  it('read-only 플래그 미설정 → readyForControlledCanary 불가', () => {
    const { GMX_RELAY_READONLY_NETWORK_ENABLED: _omit, ...rest } = FULL_ENV;
    const r = evaluateActivationGate(fullInput(rest));
    expect(r.networkEligible).toBe(false);
    expect(r.missing.some((m) => m.includes('GMX_RELAY_READONLY_NETWORK_ENABLED'))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('6단계 §7 — 읽기 전용 readiness refresh', () => {
  function makeGmxApiDeps() {
    const submitSpy = vi.fn();
    const statusSpy = vi.fn().mockResolvedValue({ ok: true, status: 'executed' });
    const peersSpy = vi.fn().mockResolvedValue([
      { peerHost: 'arbitrum.gmxapi.io', ok: true },
      { peerHost: 'arbitrum.gmxapi.ai', ok: true },
    ]);
    return { statusSpy, peersSpy, submitSpy };
  }

  it('read-only 비활성 → 외부 읽기 0회, fail-closed 기록', async () => {
    const { statusSpy, peersSpy, submitSpy } = makeGmxApiDeps();
    const canonicalSpy = vi.fn();
    const state = await performReadinessRefresh({
      env: envOf({}),
      checkCanonical: canonicalSpy,
      listOpenTaskIds: async () => [],
      countAllocatedNonces: async () => 0,
      markLegacyUnresolved: async () => true,
      fetchGmxOrderStatus: statusSpy,
      checkGmxPeers: peersSpy,
      readonlyClient: null,
      nowMs: () => 1000,
    });
    expect(state.ok).toBe(false);
    expect(state.failures[0]).toContain('GMX_RELAY_READONLY_NETWORK_ENABLED');
    expect(canonicalSpy).not.toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
    expect(peersSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
    expect(getReadinessRefreshState().attempted).toBe(true);
  });

  it('read-only 활성 → canonical·nonce·task status·balance 조회만 수행, submit 0회', async () => {
    const { statusSpy, peersSpy, submitSpy } = makeGmxApiDeps();
    const state = await performReadinessRefresh({
      env: envOf({ GMX_RELAY_READONLY_NETWORK_ENABLED: 'true' }),
      checkCanonical: async () => ({ confirmed: true, reason: null }),
      listOpenTaskIds: async () => [
        { id: 't1', relayTaskId: 'req-1', transportGen: 'GMX_API_V2' },
        { id: 't2', relayTaskId: null, transportGen: 'GMX_API_V2' },
      ],
      countAllocatedNonces: async () => 3,
      markLegacyUnresolved: async () => true,
      fetchGmxOrderStatus: statusSpy,
      checkGmxPeers: peersSpy,
      readonlyClient: null,
      nowMs: () => 2000,
    });
    // readonlyClient 미주입 → fee estimate 입력은 fail-closed (ok=false 예상)
    expect(state.ok).toBe(false);
    expect(state.atMs).toBe(2000);
    expect(statusSpy).toHaveBeenCalledTimes(1);   // GMX_API_V2 세대 + requestId 있는 것만
    expect(peersSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).not.toHaveBeenCalled();                        // submit 0회
    expect(state.basis.join(' ')).toContain('신규 할당 없음');
  });

  it('조회 실패는 fail-closed로 기록 (ok=false, 상태 저장)', async () => {
    const { statusSpy, peersSpy } = makeGmxApiDeps();
    const state = await performReadinessRefresh({
      env: envOf({ GMX_RELAY_READONLY_NETWORK_ENABLED: 'true' }),
      checkCanonical: async () => ({ confirmed: false, reason: 'nonce 불일치' }),
      listOpenTaskIds: async () => null,                             // DB 조회 실패
      countAllocatedNonces: async () => null,
      markLegacyUnresolved: async () => true,
      fetchGmxOrderStatus: statusSpy,
      checkGmxPeers: peersSpy,
      readonlyClient: null,
      nowMs: () => 3000,
    });
    expect(state.ok).toBe(false);
    expect(state.failures.length).toBeGreaterThanOrEqual(3);
    const stored = getReadinessRefreshState();
    expect(stored.ok).toBe(false);
    expect(stored.atMs).toBe(3000);
  });

  it('의존성 예외 throw도 fail-closed로 기록된다 (500으로 새지 않음)', async () => {
    const state = await performReadinessRefresh({
      env: envOf({ GMX_RELAY_READONLY_NETWORK_ENABLED: 'true' }),
      checkCanonical: async () => { throw new Error('boom-canonical'); },
      listOpenTaskIds: async () => { throw new Error('boom-tasks'); },
      countAllocatedNonces: async () => { throw new Error('boom-nonce'); },
      markLegacyUnresolved: async () => true,
      fetchGmxOrderStatus: vi.fn().mockRejectedValue(new Error('boom-status')),
      checkGmxPeers: vi.fn().mockRejectedValue(new Error('boom-peers')),
      readonlyClient: null,
      nowMs: () => 4000,
    });
    expect(state.ok).toBe(false);
    expect(state.failures.length).toBeGreaterThanOrEqual(3);
    const stored = getReadinessRefreshState();
    expect(stored.attempted).toBe(true);
    expect(stored.ok).toBe(false);
    expect(stored.atMs).toBe(4000);
    // 오류 메시지에 원문 예외 노출 없음
    expect(stored.failures.join(' ')).not.toContain('boom-');
  });

  it('canonical 스냅샷 record/get 왕복 — activation GET 무호출 상태 조회용', async () => {
    const { recordCanonicalSnapshot, getCanonicalSnapshot } = await import('../lib/relayActivationStatus');
    expect(getCanonicalSnapshot()).toBeNull(); // 미조회 = null (fail-closed 취급)
    recordCanonicalSnapshot({
      atMs: 7, confirmed: true, reason: null, approvalNonce: '3',
      isSubaccountListed: true, expiresAt: '100', remaining: '5',
    });
    expect(getCanonicalSnapshot()).toMatchObject({ confirmed: true, approvalNonce: '3' });
  });

  it('recordReadinessRefresh/getReadinessRefreshState 왕복', () => {
    recordReadinessRefresh({ atMs: 42, ok: true, basis: ['x'], failures: [] });
    const s = getReadinessRefreshState();
    expect(s).toMatchObject({ attempted: true, atMs: 42, ok: true, basis: ['x'] });
  });
});
