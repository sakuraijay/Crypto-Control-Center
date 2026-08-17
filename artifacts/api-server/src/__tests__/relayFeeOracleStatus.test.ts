/**
 * 6E-8 — fee oracle HTTP status 구조적 보존 + readiness 문구 개선 테스트.
 *
 *  §2 transport: non-200 → { kind:'http', httpStatus:<정수>, message:'HTTP <n>' }
 *     — 응답 본문·upstream message·URL·key는 어떤 필드에도 미포함.
 *  §3 readiness: httpStatus 있으면 'HTTP <n>' 표시, 5xx는 '외부 fee oracle 일시 장애',
 *     status 없으면 kind만. fee 실패 시 refresh.ok=false 유지, fallback quote 없음.
 *  §4 signer 부재 → 'canonical readback 생략 … (예상된 fail-closed)' + eth_call 0회.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGelatoHttpTransport } from '../lib/relayTransport';
import { performReadinessRefresh } from '../lib/relayReadinessRefresh';
import { __resetReadinessRefreshForTests } from '../lib/relayActivationStatus';

const RO_ENV = { GMX_RELAY_READONLY_NETWORK_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv;
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.spyOn>;
});
afterEach(() => {
  fetchSpy.mockRestore();
  __resetReadinessRefreshForTests();
});

function quote(t = createGelatoHttpTransport(RO_ENV)) {
  return t.quoteRelayFee({ chainId: 42161, paymentToken: WETH, gasLimit: 3_000_000n });
}

describe('6E-8 §2 — quoteRelayFee HTTP status 구조적 보존', () => {
  it.each([400, 401, 404, 429, 500, 503])('HTTP %i → httpStatus 정수 보존 + 고정 메시지', async (status) => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'OracleService:: Internal server error', secret: 'upstream-body-x' }), { status }));
    const q = await quote();
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.kind).toBe('http');
    expect(q.httpStatus).toBe(status);
    expect(q.message).toBe(`HTTP ${status}`);
    // upstream 본문·URL·key 미노출
    const dump = JSON.stringify(q);
    expect(dump).not.toContain('OracleService');
    expect(dump).not.toContain('upstream-body-x');
    expect(dump).not.toContain('gelato.digital');
    expect(dump).not.toContain(WETH);
  });

  it('network 오류 → kind=network, httpStatus 없음, URL 반향 완전 제거', async () => {
    fetchSpy.mockRejectedValue(Object.assign(
      new Error('ECONNRESET https://api.gelato.digital/oracles/42161/estimate?paymentToken=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1&gasLimit=3000000'),
      { name: 'FetchError' },
    ));
    const q = await quote();
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.kind).toBe('network');
    expect('httpStatus' in q ? q.httpStatus : undefined).toBeUndefined();
    // 리뷰 반영 — error object에 반향된 URL(host/path/query/토큰)이 어떤 필드에도 없음
    const dump = JSON.stringify(q);
    expect(dump).not.toContain('https://');
    expect(dump).not.toContain('gelato.digital');
    expect(dump).not.toContain('paymentToken');
    expect(dump).not.toContain(WETH);
  });

  it('decode 오류(estimatedFee 없음) → kind=decode, httpStatus 없음', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ other: 1 }), { status: 200 }));
    const q = await quote();
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.kind).toBe('decode');
    expect('httpStatus' in q ? q.httpStatus : undefined).toBeUndefined();
  });
});

describe('6E-8 §3·§4·§6 — readiness failure 문구 + signer 예상 차단', () => {
  function deps(quoteResult: unknown, checkCanonical?: () => Promise<{ confirmed: boolean; reason: string | null }>) {
    return {
      env: RO_ENV,
      checkCanonical: checkCanonical ?? (async () => ({ confirmed: true, reason: null })),
      listOpenTaskIds: async () => [] as { id: string; relayTaskId: string | null }[],
      countAllocatedNonces: async () => 0,
      transport: {
        quoteRelayFee: vi.fn().mockResolvedValue(quoteResult),
        getRelayTaskStatus: vi.fn(),
      },
      readonlyClient: null,
      nowMs: () => 1000,
    };
  }

  it('HTTP 500 → 외부 fee oracle 일시 장애 분류 + HTTP 500 표시 + ok=false', async () => {
    const d = deps({ ok: false, kind: 'http', httpStatus: 500, message: 'HTTP 500' });
    const state = await performReadinessRefresh(d);
    expect(state.ok).toBe(false);
    expect(state.failures).toContain('fee oracle 조회 실패 (외부 fee oracle 일시 장애 — HTTP 500)');
    expect(d.transport.quoteRelayFee).toHaveBeenCalledTimes(1); // 자동 retry 없음
  });

  it('HTTP 404 (비 5xx) → (http: HTTP 404) 표시', async () => {
    const state = await performReadinessRefresh(deps({ ok: false, kind: 'http', httpStatus: 404, message: 'HTTP 404' }));
    expect(state.failures).toContain('fee oracle 조회 실패 (http: HTTP 404)');
  });

  it('5xx 경계: 499/600은 일시 장애 아님, 599는 일시 장애', async () => {
    const cases: [number, string][] = [
      [499, 'fee oracle 조회 실패 (http: HTTP 499)'],
      [599, 'fee oracle 조회 실패 (외부 fee oracle 일시 장애 — HTTP 599)'],
      [600, 'fee oracle 조회 실패 (http: HTTP 600)'],
    ];
    for (const [status, expected] of cases) {
      __resetReadinessRefreshForTests();
      const state = await performReadinessRefresh(deps({ ok: false, kind: 'http', httpStatus: status, message: `HTTP ${status}` }));
      expect(state.failures).toContain(expected);
    }
  });

  it('status 없는 실패(network/timeout/decode) → kind만 표시', async () => {
    for (const kind of ['network', 'timeout', 'decode'] as const) {
      __resetReadinessRefreshForTests();
      const state = await performReadinessRefresh(deps({ ok: false, kind, message: 'x' }));
      expect(state.failures).toContain(`fee oracle 조회 실패(${kind})`);
      expect(state.failures.join(' ')).not.toContain('HTTP');
    }
  });

  it('httpStatus 비정수 방어 → kind만 표시', async () => {
    const state = await performReadinessRefresh(deps({ ok: false, kind: 'http', httpStatus: '500 body', message: 'HTTP 500' }));
    expect(state.failures).toContain('fee oracle 조회 실패(http)');
  });

  it('upstream 응답 문자열이 failures에 전달되지 않는다', async () => {
    const state = await performReadinessRefresh(deps({
      ok: false, kind: 'http', httpStatus: 500, message: 'OracleService:: Internal server error',
    }));
    expect(state.failures.join(' ')).not.toContain('OracleService');
  });

  it('signer 미초기화 → 생략 문구(예상된 fail-closed) + ok=false + eth_call 0회', async () => {
    const ethCallSpy = vi.fn();
    const state = await performReadinessRefresh(deps(
      { ok: true, estimatedFeeWei: 100n, quotedAtMs: 1 },
      async () => {
        // checkCanonical이 signer 부재를 보고할 때 readback eth_call은 실행되지 않음을 모사
        return { confirmed: false, reason: 'delegated signer 미초기화 (예상된 fail-closed — readback 생략)' };
      },
    ));
    expect(state.ok).toBe(false);
    expect(state.failures).toContain('canonical readback 생략: delegated signer 미초기화 (예상된 fail-closed)');
    expect(state.failures.join(' ')).not.toContain('canonical readback 미확인');
    expect(ethCallSpy).not.toHaveBeenCalled();
  });

  it('signer 외 사유는 기존 미확인 문구 유지', async () => {
    const state = await performReadinessRefresh(deps(
      { ok: true, estimatedFeeWei: 100n, quotedAtMs: 1 },
      async () => ({ confirmed: false, reason: 'nonce 불일치' }),
    ));
    expect(state.failures).toContain('canonical readback 미확인: nonce 불일치');
  });
});
