/**
 * 6E-2 §3·§9 + 6E-5 §4·§7 — Readiness Refresh fetch 래퍼 테스트.
 *  - 오직 POST /executor/relay/readiness/refresh 만 호출한다 (origin root /api/...).
 *  - PIN은 x-operator-pin 헤더로만 전달 (URL·body 금지).
 *  - 401/403 ≠ 503 (인증 실패 ≠ env 미설정).
 *  - 200+HTML(정적 SPA fallback) → API_ROUTE_MISMATCH (본문 미노출).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { postReadinessRefresh } from '../lib/relayStatus';
import { API_ROUTE_MISMATCH_MESSAGE } from '../lib/apiUrl';

afterEach(() => vi.unstubAllGlobals());

const jsonRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
  json: async () => body,
});
const htmlRes = (status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
  json: async () => { throw new Error('not json'); },
});

describe('postReadinessRefresh', () => {
  it('origin root 엔드포인트에 POST하고 PIN은 헤더로만 전달한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes(200, { ok: true, refresh: { attempted: true, atMs: 1, ok: true, basis: ['chainId 42161 확인'], failures: [] } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await postReadinessRefresh({ pin: '123456' });
    expect(r.kind).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/executor/relay/readiness/refresh');
    expect(url).not.toContain('/futures-web/');       // BASE_URL 오염 없음
    expect(init.method).toBe('POST');
    expect(init.headers['x-operator-pin']).toBe('123456');
    expect(url).not.toContain('123456');           // PIN이 URL에 없음
    expect(init.body).toBeUndefined();             // PIN이 body에 없음
  });

  it('401 → auth (env 미설정과 구분)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(401, { ok: false })));
    expect((await postReadinessRefresh({ pin: 'x'.repeat(6) })).kind).toBe('auth');
  });

  it('403 → auth', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(403, { ok: false })));
    expect((await postReadinessRefresh({ pin: 'x'.repeat(6) })).kind).toBe('auth');
  });

  it('503 → not_configured (OPERATOR_MASTER_PIN 미설정)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(503, { ok: false })));
    expect((await postReadinessRefresh({ pin: 'x'.repeat(6) })).kind).toBe('not_configured');
  });

  it('200+HTML(정적 SPA fallback) → API_ROUTE_MISMATCH, 본문 미노출', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlRes(200)));
    const r = await postReadinessRefresh({ pin: 'x'.repeat(6) });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toBe(API_ROUTE_MISMATCH_MESSAGE);
      expect(r.message).not.toContain('<html');
    }
  });

  it('backend 200 + refresh.ok=false → kind ok, basis/failures 그대로 전달 (렌더용)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonRes(200, { ok: true, refresh: { attempted: true, atMs: 5, ok: false, basis: ['b1'], failures: ['f1'] } }),
    ));
    const r = await postReadinessRefresh({ pin: 'x'.repeat(6) });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.refresh.ok).toBe(false);
      expect(r.refresh.basis).toEqual(['b1']);
      expect(r.refresh.failures).toEqual(['f1']);
    }
  });

  it('refresh 누락/실패 응답 → error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, { ok: false, error: 'boom' })));
    const r = await postReadinessRefresh({ pin: 'x'.repeat(6) });
    expect(r.kind).toBe('error');
  });

  it('네트워크 오류 → error (자동 retry 없음 — fetch 1회)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    expect((await postReadinessRefresh({ pin: 'x'.repeat(6) })).kind).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
