/**
 * 6F-2 — GMX 공식 fee estimate 입력 + sponsor balance readiness 테스트.
 * (구 6E-8 fee oracle 테스트를 대체 — Gelato fee oracle은 실행 경로에서 제거됨)
 *
 *  §6 fee estimate: eth_gasPrice + DataStore multiplier 입력 확보 실패 시
 *     fail-closed 기록, fallback quote 없음.
 *  §9 transport HTTP status 구조적 보존: non-200 → { kind:'http', httpStatus, 'HTTP <n>' }.
 *  §10 sponsor balance: verified/insufficient/unverified 분류, 실패 시 fail-closed.
 *  §4 signer 부재 → 'canonical readback 생략 …' 문구 유지.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGelatoHttpTransport, GELATO_API_KEY_SECRET_NAME } from '../lib/relayTransport';
import { performReadinessRefresh } from '../lib/relayReadinessRefresh';
import {
  __resetReadinessRefreshForTests, __resetFeeAndSponsorStateForTests,
  getFeeEstimateState, getSponsorBalanceState,
} from '../lib/relayActivationStatus';

const RO_ENV = {
  GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
  [GELATO_API_KEY_SECRET_NAME]: 'test-key-not-real',
} as unknown as NodeJS.ProcessEnv;

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.spyOn>;
});
afterEach(() => {
  fetchSpy.mockRestore();
  __resetReadinessRefreshForTests();
  __resetFeeAndSponsorStateForTests();
});

function balanceCall(t = createGelatoHttpTransport(RO_ENV)) {
  return t.getSponsorBalance();
}

describe('6F-2 §9 — transport HTTP status 구조적 보존', () => {
  it.each([400, 401, 404, 429, 500, 503])('HTTP %i → httpStatus 정수 보존 + 고정 메시지', async (status) => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'GelatoService:: Internal server error', secret: 'upstream-body-x' }), { status }));
    const q = await balanceCall();
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.kind).toBe('http');
    expect(q.httpStatus).toBe(status);
    expect(q.message).toBe(`HTTP ${status}`);
    // upstream 본문·URL·key 미노출
    const dump = JSON.stringify(q);
    expect(dump).not.toContain('GelatoService');
    expect(dump).not.toContain('upstream-body-x');
    expect(dump).not.toContain('gelato.cloud');
    expect(dump).not.toContain('test-key-not-real');
  });

  it('network 오류 → kind=network, httpStatus 없음, URL 반향 완전 제거', async () => {
    fetchSpy.mockRejectedValue(Object.assign(
      new Error('ECONNRESET https://api.gelato.cloud/rpc?apiKey=SHOULD_NOT_LEAK_ANYWHERE_123456'),
      { name: 'FetchError' },
    ));
    const q = await balanceCall();
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.kind).toBe('network');
    expect('httpStatus' in q ? q.httpStatus : undefined).toBeUndefined();
    const dump = JSON.stringify(q);
    expect(dump).not.toContain('https://');
    expect(dump).not.toContain('gelato.cloud');
    expect(dump).not.toContain('SHOULD_NOT_LEAK');
  });

  it('decode 오류(JSON-RPC envelope 아님) → kind=decode, httpStatus 없음', async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ other: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const q = await balanceCall();
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.kind).toBe('decode');
    expect('httpStatus' in q ? q.httpStatus : undefined).toBeUndefined();
  });

  it('JSON-RPC error 응답 → kind=rpc, code 정수만 노출 (upstream message 미노출)', async () => {
    fetchSpy.mockImplementation(async (_url: unknown, init: unknown) => {
      const id = (JSON.parse(String((init as RequestInit).body)) as { id: number }).id;
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id, error: { code: -32000, message: 'secret upstream detail SHOULD_NOT_LEAK' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const q = await balanceCall();
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.kind).toBe('rpc');
    expect(q.message).toBe('JSON-RPC 오류 (code -32000)');
    expect(JSON.stringify(q)).not.toContain('SHOULD_NOT_LEAK');
  });
});

describe('6F-2 §6·§10·§4 — readiness fee estimate + sponsor balance + signer 문구', () => {
  type Deps = Parameters<typeof performReadinessRefresh>[0];
  function deps(overrides?: Partial<Deps>): Deps {
    return {
      env: RO_ENV,
      checkCanonical: async () => ({ confirmed: true, reason: null }),
      listOpenTaskIds: async () => [] as { id: string; relayTaskId: string | null; transportGen: string }[],
      countAllocatedNonces: async () => 0,
      markLegacyUnresolved: async () => true,
      transport: {
        getRelayTaskStatus: vi.fn().mockResolvedValue({ ok: true, statusCode: 100, transactionHash: null, blockNumber: null }),
        getSponsorBalance: vi.fn().mockResolvedValue({ ok: true, balance: 10n ** 18n, decimals: 18, unit: 'wei' }),
      },
      readonlyClient: null,
      nowMs: () => 1000,
      ...overrides,
    };
  }

  it('readonlyClient 미생성 → fee estimate fail-closed 기록 + refresh ok=false', async () => {
    const state = await performReadinessRefresh(deps());
    expect(state.ok).toBe(false);
    expect(state.failures.join(' ')).toContain('fee estimate');
    const fe = getFeeEstimateState();
    expect(fe.attempted).toBe(true);
    expect(fe.ok).toBe(false);
  });

  it('gasPrice 조회 실패 → fee estimate fail-closed (fallback 없음)', async () => {
    const state = await performReadinessRefresh(deps({
      env: { ...RO_ENV, GMX_DATA_STORE_ADDRESS: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8' } as NodeJS.ProcessEnv,
      readonlyClient: {
        getCode: async () => '0x6080' as `0x${string}`,
        getChainId: async () => 42161,
        getGasPrice: async () => { throw new Error('rpc down'); },
        readContract: async () => 10n ** 29n,
      },
    }));
    expect(state.ok).toBe(false);
    expect(getFeeEstimateState().ok).toBe(false);
    expect(getFeeEstimateState().failures.join(' ')).toContain('eth_gasPrice');
  });

  it('DataStore multiplier 조회 실패 → fee estimate fail-closed', async () => {
    await performReadinessRefresh(deps({
      env: { ...RO_ENV, GMX_DATA_STORE_ADDRESS: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8' } as NodeJS.ProcessEnv,
      readonlyClient: {
        getCode: async () => '0x6080' as `0x${string}`,
        getChainId: async () => 42161,
        getGasPrice: async () => 100_000_000n,
        readContract: async (args: { functionName: string }) => {
          if (args.functionName === 'getUint') throw new Error('datastore down');
          return args.functionName === 'digests' ? false : 0n;
        },
      },
    }));
    expect(getFeeEstimateState().ok).toBe(false);
    expect(getFeeEstimateState().failures.join(' ')).toContain('Multiplier');
  });

  it('sponsor balance > 0 → verified 기록', async () => {
    await performReadinessRefresh(deps());
    expect(getSponsorBalanceState().status).toBe('verified');
  });

  it('sponsor balance 0 → insufficient + refresh 실패 근거', async () => {
    const state = await performReadinessRefresh(deps({
      transport: {
        getRelayTaskStatus: vi.fn(),
        getSponsorBalance: vi.fn().mockResolvedValue({ ok: true, balance: 0n, decimals: 18, unit: 'wei' }),
      },
    }));
    expect(getSponsorBalanceState().status).toBe('insufficient');
    expect(state.failures.join(' ')).toContain('insufficient');
  });

  it('sponsor balance 조회 실패 → unverified (fail-closed, 자동 retry 없음)', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: false, kind: 'http', httpStatus: 500, message: 'HTTP 500' });
    const state = await performReadinessRefresh(deps({
      transport: { getRelayTaskStatus: vi.fn(), getSponsorBalance: spy },
    }));
    expect(getSponsorBalanceState().status).toBe('unverified');
    expect(state.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1); // 자동 retry 없음
  });

  it('transport 비활성 → sponsor unverified + fail-closed', async () => {
    const state = await performReadinessRefresh(deps({ transport: null }));
    expect(getSponsorBalanceState().status).toBe('unverified');
    expect(state.failures.join(' ')).toContain('sponsor balance');
  });

  it('legacy transport 세대 task → 신형 조회 0회 + UNRESOLVED_LEGACY_TRANSPORT 분류', async () => {
    const statusSpy = vi.fn();
    const state = await performReadinessRefresh(deps({
      transport: {
        getRelayTaskStatus: statusSpy,
        getSponsorBalance: vi.fn().mockResolvedValue({ ok: true, balance: 1n, decimals: 18, unit: 'wei' }),
      },
      listOpenTaskIds: async () => [
        { id: 't-legacy', relayTaskId: 'legacy-task-uuid', transportGen: 'legacy-digital' },
      ],
    }));
    expect(statusSpy).not.toHaveBeenCalled();
    expect(state.failures.join(' ')).toContain('UNRESOLVED_LEGACY_TRANSPORT');
  });

  it('legacy task는 DB 상태를 UNRESOLVED로 영속 전이(markLegacyUnresolved 호출) — 조회 0회', async () => {
    const markSpy = vi.fn().mockResolvedValue(true);
    const statusSpy = vi.fn();
    const state = await performReadinessRefresh(deps({
      transport: {
        getRelayTaskStatus: statusSpy,
        getSponsorBalance: vi.fn().mockResolvedValue({ ok: true, balance: 1n, decimals: 18, unit: 'wei' }),
      },
      listOpenTaskIds: async () => [
        { id: 't-legacy', relayTaskId: 'legacy-task-uuid', transportGen: 'legacy-digital' },
      ],
      markLegacyUnresolved: markSpy,
    }));
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(markSpy).toHaveBeenCalledWith('t-legacy');
    expect(statusSpy).not.toHaveBeenCalled();
    expect(state.failures.join(' ')).not.toContain('영속 전이 실패');
  });

  it('legacy UNRESOLVED 영속 전이 실패 → failures에 기록 (fail-closed)', async () => {
    const state = await performReadinessRefresh(deps({
      transport: {
        getRelayTaskStatus: vi.fn(),
        getSponsorBalance: vi.fn().mockResolvedValue({ ok: true, balance: 1n, decimals: 18, unit: 'wei' }),
      },
      listOpenTaskIds: async () => [
        { id: 't-legacy', relayTaskId: 'legacy-task-uuid', transportGen: 'legacy-digital' },
      ],
      markLegacyUnresolved: vi.fn().mockResolvedValue(false),
    }));
    expect(state.ok).toBe(false);
    expect(state.failures.join(' ')).toContain('legacy UNRESOLVED 영속 전이 실패');
  });

  it('signer 미초기화 → 생략 문구(예상된 fail-closed) 유지', async () => {
    const state = await performReadinessRefresh(deps({
      checkCanonical: async () => ({ confirmed: false, reason: 'delegated signer 미초기화 (예상된 fail-closed — readback 생략)' }),
    }));
    expect(state.ok).toBe(false);
    expect(state.failures).toContain('canonical readback 생략: delegated signer 미초기화 (예상된 fail-closed)');
  });

  it('signer 외 사유는 기존 미확인 문구 유지', async () => {
    const state = await performReadinessRefresh(deps({
      checkCanonical: async () => ({ confirmed: false, reason: 'nonce 불일치' }),
    }));
    expect(state.failures).toContain('canonical readback 미확인: nonce 불일치');
  });
});
