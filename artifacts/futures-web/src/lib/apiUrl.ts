/**
 * apiUrl — 6E-5 §3: 내부 API URL 단일 헬퍼.
 *
 * 배경: 프로덕션에서 futures-web은 플랫폼 정적 핸들러(`/futures-web/`)가 서빙하고
 * api-server는 origin root `/api/...`에서만 응답한다. base-path 상대 API 경로 패턴은
 * 프로덕션에서 `/futures-web/api/...`를 만들어 정적 SPA fallback(200+HTML)에
 * 흡수되는 치명적 경로 버그를 낳는다 (6E-4 진단).
 *
 * 규칙:
 *  - 자산/라우터 경로       → asset base path 사용 가능 (이 모듈 소관 아님)
 *  - 내부 backend API 경로  → 반드시 이 헬퍼로 origin root `/api/...` 생성
 *  - 어떤 asset base path에서도 `/futures-web/api/...`를 만들지 않는다 (base path 미참조)
 */

const API_ROOT = '/api/';

/**
 * `apiUrl('executor/status')` → `/api/executor/status`
 * `apiUrl('/executor/status')` → `/api/executor/status`
 *
 * 거부(fail-closed, throw):
 *  - absolute URL (`http://...`, `https://...`, 스킴 포함 전부)
 *  - protocol-relative (`//host/...`)
 *  - path traversal (`..`) 및 빈 세그먼트(`a//b`)
 */
export function apiUrl(path: string): string {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new Error('apiUrl: 빈 경로는 허용되지 않습니다');
  }
  const raw = path.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    throw new Error('apiUrl: absolute URL 주입은 허용되지 않습니다');
  }
  if (raw.startsWith('//')) {
    throw new Error('apiUrl: protocol-relative URL은 허용되지 않습니다');
  }
  // query/hash는 경로 검증에서 분리 (query는 호출측에서 URLSearchParams로 구성 권장)
  const qIdx = raw.search(/[?#]/);
  const pathPart = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const suffix = qIdx === -1 ? '' : raw.slice(qIdx);

  const trimmed = pathPart.replace(/^\/+/, '');
  if (trimmed.length === 0) throw new Error('apiUrl: 경로가 비어 있습니다');
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error('apiUrl: path traversal 또는 빈 세그먼트는 허용되지 않습니다');
    }
  }
  return `${API_ROOT}${segments.join('/')}${suffix}`;
}

/** query를 안전하게 붙인 API URL. 값은 전부 URLSearchParams로 인코딩된다. */
export function apiUrlWithQuery(path: string, query: Record<string, string | number | boolean>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) params.set(k, String(v));
  const qs = params.toString();
  return qs.length > 0 ? `${apiUrl(path)}?${qs}` : apiUrl(path);
}

// ── 6E-5 §4 — 응답 Content-Type 검증 ────────────────────────────────────────

export const API_ROUTE_MISMATCH_MESSAGE = 'API_ROUTE_MISMATCH: 정적 SPA fallback 응답 수신';

export type ApiJsonBody =
  | { kind: 'json'; json: unknown }
  /** 2xx인데 JSON이 아님(HTML 등) — 정적 SPA fallback이 API 경로를 삼킨 경우. 본문은 노출하지 않는다. */
  | { kind: 'route_mismatch' }
  /** Content-Type은 JSON인데 decode 실패 */
  | { kind: 'invalid_json' };

// ── 6E-6 §3 — 공용 JSON POST helper ─────────────────────────────────────────

/**
 * 내부 API로 JSON body를 보내는 mutation 요청(POST/PUT/PATCH)의 단일 계약.
 *  - URL은 apiUrl()로 origin root `/api/...` 강제
 *  - `Content-Type: application/json` + `Accept: application/json` 자동 부여
 *  - body는 항상 JSON.stringify(body ?? {})
 *  - PIN 등 민감 header는 호출자가 headers로 명시적으로 주입 (여기서 저장·로그하지 않음)
 *  - 자동 retry 없음, header/body/error 로그 미출력
 * FormData/파일 업로드에는 사용하지 말 것 (JSON Content-Type을 강제하므로).
 */
export async function postApiJson(
  path: string,
  options?: {
    method?: 'POST' | 'PUT' | 'PATCH';
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  return fetch(apiUrl(path), {
    method: options?.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(options?.headers ?? {}),
    },
    body: JSON.stringify(options?.body ?? {}),
  });
}

/**
 * JSON API 응답 본문을 fail-closed로 읽는다.
 *  - Content-Type에 application/json이 없으면 route_mismatch (본문 미노출)
 *  - decode 실패는 invalid_json
 * HTTP status 구분(401/403/503 등)은 호출측 계약에서 처리한다.
 */
export async function readApiJson(res: Response): Promise<ApiJsonBody> {
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) return { kind: 'route_mismatch' };
  try {
    return { kind: 'json', json: await res.json() };
  } catch {
    return { kind: 'invalid_json' };
  }
}
