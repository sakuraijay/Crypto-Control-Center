/**
 * 6E-5 §3·§7 — apiUrl 헬퍼 테스트.
 *  - 어떤 BASE_URL에서도 API URL은 origin root `/api/...` (BASE_URL 자체를 참조하지 않음).
 *  - absolute URL·protocol-relative·path traversal 거부.
 *  - `/futures-web/api/...` 생성 0건 정적 가드 (소스 스캔).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { apiUrl, apiUrlWithQuery, readApiJson, API_ROUTE_MISMATCH_MESSAGE, postApiJson } from '../apiUrl';

describe('apiUrl', () => {
  it('선행 슬래시 유무와 무관하게 /api/... 를 만든다', () => {
    expect(apiUrl('executor/status')).toBe('/api/executor/status');
    expect(apiUrl('/executor/status')).toBe('/api/executor/status');
    expect(apiUrl('executor/relay/readiness/refresh')).toBe('/api/executor/relay/readiness/refresh');
  });

  it('BASE_URL이 /futures-web/ 이어도 결과는 origin root — BASE_URL을 아예 참조하지 않는다', () => {
    // apiUrl 구현이 import.meta.env.BASE_URL을 읽지 않음을 소스로 검증
    const src = readFileSync(join(__dirname, '..', 'apiUrl.ts'), 'utf8');
    expect(src).not.toContain('BASE_URL');
    expect(apiUrl('executor/status').startsWith('/api/')).toBe(true);
    expect(apiUrl('executor/status')).not.toContain('/futures-web/');
  });

  it('absolute URL·protocol-relative·traversal·빈 세그먼트 거부', () => {
    expect(() => apiUrl('https://evil.example/x')).toThrow();
    expect(() => apiUrl('http://evil.example/x')).toThrow();
    expect(() => apiUrl('javascript:alert(1)')).toThrow();
    expect(() => apiUrl('//evil.example/x')).toThrow();
    expect(() => apiUrl('a/../b')).toThrow();
    expect(() => apiUrl('a//b')).toThrow();
    expect(() => apiUrl('')).toThrow();
    expect(() => apiUrl('/')).toThrow();
  });

  it('query는 URLSearchParams로 안전 인코딩', () => {
    expect(apiUrlWithQuery('gmx/positions', { account: '0xAbC def' }))
      .toBe('/api/gmx/positions?account=0xAbC+def');
    expect(apiUrlWithQuery('executor/status', {})).toBe('/api/executor/status');
  });
});

describe('readApiJson', () => {
  const mk = (ct: string | null, body: () => Promise<unknown>) => ({
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? ct : null) },
    json: body,
  }) as unknown as Response;

  it('application/json → json', async () => {
    const r = await readApiJson(mk('application/json; charset=utf-8', async () => ({ ok: true })));
    expect(r.kind).toBe('json');
  });

  it('text/html → route_mismatch (본문을 읽지 않음)', async () => {
    const r = await readApiJson(mk('text/html; charset=utf-8', async () => { throw new Error('no'); }));
    expect(r.kind).toBe('route_mismatch');
    expect(API_ROUTE_MISMATCH_MESSAGE).toContain('API_ROUTE_MISMATCH');
  });

  it('JSON content-type인데 decode 실패 → invalid_json', async () => {
    const r = await readApiJson(mk('application/json', async () => { throw new Error('bad'); }));
    expect(r.kind).toBe('invalid_json');
  });
});

describe('정적 가드 — `${BASE_URL}api/` 패턴 0건', () => {
  it('src 전체에서 BASE_URL 기반 API 경로 조합이 존재하지 않는다', () => {
    const root = join(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.spec\./.test(name)) {
          const text = readFileSync(p, 'utf8');
          if (text.includes('BASE_URL}api') || text.includes("BASE_URL + 'api") || text.includes('BASE_URL + "api')) {
            offenders.push(p);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('postApiJson — JSON 계약 강제 (6E-6)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: true })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('기본: POST /api/..., content-type/accept JSON, body {}', async () => {
    await postApiJson('executor/relay/readiness/refresh', { headers: { 'x-operator-pin': '123456' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/executor/relay/readiness/refresh');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['accept']).toBe('application/json');
    expect(init.headers['x-operator-pin']).toBe('123456');
    expect(init.body).toBe('{}');
  });

  it('caller가 Content-Type/Accept(대소문자 불문)를 덮어쓸 수 없다', async () => {
    await postApiJson('x/y', { headers: { 'Content-Type': 'text/plain', ACCEPT: 'text/html', 'content-type': 'multipart/form-data' } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['accept']).toBe('application/json');
    expect(Object.keys(init.headers).filter((k: string) => k.toLowerCase() === 'content-type')).toHaveLength(1);
    expect(Object.keys(init.headers).filter((k: string) => k.toLowerCase() === 'accept')).toHaveLength(1);
  });

  it('body는 정확히 JSON.stringify 결과 — payload 필드 보존, PIN 미포함', async () => {
    await postApiJson('executor/relay/revoke/signature', {
      headers: { 'x-operator-pin': '654321' },
      body: { sessionId: 's-1', signature: '0xabc' },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(JSON.stringify({ sessionId: 's-1', signature: '0xabc' }));
    expect(init.body).not.toContain('654321');
  });

  it('method PUT/PATCH 지원, 자동 retry 없음(fetch 1회)', async () => {
    await postApiJson('a/b', { method: 'PATCH', body: { v: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
  });
});
