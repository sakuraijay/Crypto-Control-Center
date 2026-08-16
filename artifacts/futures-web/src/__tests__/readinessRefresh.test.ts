/**
 * 6E-2 §3·§9 — Readiness Refresh fetch 래퍼 테스트.
 *  - 오직 POST /executor/relay/readiness/refresh 만 호출한다.
 *  - PIN은 x-operator-pin 헤더로만 전달 (URL·body 금지).
 *  - 401/403 ≠ 503 (인증 실패 ≠ env 미설정).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { postReadinessRefresh } from '../lib/relayStatus';

afterEach(() => vi.unstubAllGlobals());

describe('postReadinessRefresh', () => {
  it('올바른 엔드포인트에 POST하고 PIN은 헤더로만 전달한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ ok: true, refresh: { attempted: true, atMs: 1, ok: true, basis: ['chainId 42161 확인'], failures: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await postReadinessRefresh({ apiBase: '/api/', pin: '123456' });
    expect(r.kind).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/executor/relay/readiness/refresh');
    expect(init.method).toBe('POST');
    expect(init.headers['x-operator-pin']).toBe('123456');
    expect(url).not.toContain('123456');           // PIN이 URL에 없음
    expect(init.body).toBeUndefined();             // PIN이 body에 없음
  });

  it('401 → auth (env 미설정과 구분)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect((await postReadinessRefresh({ apiBase: '/api/', pin: 'x'.repeat(6) })).kind).toBe('auth');
  });

  it('403 → auth', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    expect((await postReadinessRefresh({ apiBase: '/api/', pin: 'x'.repeat(6) })).kind).toBe('auth');
  });

  it('503 → not_configured (OPERATOR_MASTER_PIN 미설정)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    expect((await postReadinessRefresh({ apiBase: '/api/', pin: 'x'.repeat(6) })).kind).toBe('not_configured');
  });

  it('refresh 누락/실패 응답 → error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: 'boom' }) }));
    const r = await postReadinessRefresh({ apiBase: '/api/', pin: 'x'.repeat(6) });
    expect(r.kind).toBe('error');
  });

  it('네트워크 오류 → error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await postReadinessRefresh({ apiBase: '/api/', pin: 'x'.repeat(6) })).kind).toBe('error');
  });
});
