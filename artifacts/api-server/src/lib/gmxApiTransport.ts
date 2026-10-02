/**
 * gmxApiTransport — 공식 GMX API v2 hardened HTTP 어댑터 (6G-1 §3).
 *
 * 원칙:
 *  - 허용 peer는 정확히 2개: arbitrum.gmxapi.io/v1, arbitrum.gmxapi.ai/v1.
 *    임의 URL·redirect·다른 host·다른 chain은 전부 fail-closed(config).
 *  - GMX API는 공개 API(OpenAPI security: []) — 어떤 인증 헤더도 보내지 않는다.
 *    GELATO_API_KEY는 이 모듈에서 절대 읽지도, 전송하지도 않는다.
 *  - 응답 크기 상한은 readonly 1MiB / submit 256KiB로 분리한다. 공식
 *    markets/info 전체 응답은 256KiB를 넘으므로 조회만 제한적으로 확대하고,
 *    제출 응답의 기존 상한은 유지한다. timeout, Content-Type=application/json,
 *    JSON decode 검증. 오류는 sanitize된 고정 문구 + kind + httpStatus 정수만 노출한다.
 *    (URL query·서명·typed data 전문·개인키는 로그/오류에 절대 포함 금지)
 *  - peer 정책: readonly(시장 데이터·prepare·status)는 network/timeout/5xx에서
 *    다음 peer로 1회 failover 허용. submit은 자동 peer 재시도 절대 금지 —
 *    timeout/network/5xx/decode처럼 broadcast 여부 불명이면 ambiguous=true
 *    (호출측이 UNRESOLVED 처리). 400은 pre-broadcast 확정 실패로만 취급.
 *    429는 rate_limited — 신규 제출 차단 + backoff, 자동 재시도 금지.
 *  - 플래그: GMX_API_READONLY_ENABLED / GMX_API_ORDER_SUBMISSION_ENABLED —
 *    정확히 문자열 "true"일 때만 활성 (그 외 전부 비활성).
 */

export const GMX_API_PEERS = [
  'https://arbitrum.gmxapi.io/v1',
  'https://arbitrum.gmxapi.ai/v1',
] as const;

/** peer host allowlist (호스트만 — 오류 문구에 host까지만 노출 허용) */
export const GMX_API_HOST_ALLOWLIST = ['arbitrum.gmxapi.io', 'arbitrum.gmxapi.ai'] as const;

export const GMX_API_MAX_READONLY_RESPONSE_BYTES = 1024 * 1024;
export const GMX_API_MAX_SUBMIT_RESPONSE_BYTES = 256 * 1024;
export const GMX_API_TIMEOUT_MS = 10_000;
export const GMX_API_CHAIN_ID = 42161;

export const GMX_API_READONLY_FLAG = 'GMX_API_READONLY_ENABLED';
export const GMX_API_SUBMISSION_FLAG = 'GMX_API_ORDER_SUBMISSION_ENABLED';

export type GmxApiErrorKind =
  | 'config'        // allowlist/플래그/입력 검증 실패 — 요청 발신 0회
  | 'timeout'       // 응답 시한 초과 (submit이면 ambiguous)
  | 'network'       // fetch 실패/응답 유실/크기 초과 (submit이면 ambiguous)
  | 'http_4xx'      // 4xx (429 제외) — pre-broadcast 확정 거부
  | 'rate_limited'  // 429 — 신규 제출 차단 + backoff, 자동 재시도 금지
  | 'http_5xx'      // 5xx — 외부 장애 (submit이면 ambiguous)
  | 'decode';       // Content-Type/JSON/구조 오류 (submit이면 ambiguous)

export interface GmxApiAttemptTrace {
  /** allowlist 검증된 host만 포함 — URL/path/query는 절대 보존하지 않는다. */
  peerHost: string;
  /** null은 해당 peer 호출 성공을 뜻한다. */
  kind: GmxApiErrorKind | null;
  /** 안전한 정수 HTTP status. 응답 자체를 받지 못했으면 null. */
  httpStatus: number | null;
}

export type GmxApiResult<T> =
  | {
      ok: true;
      data: T;
      peerHost: string;
      httpStatus?: number;
      attemptCount?: number;
      retryCount?: number;
      failoverCount?: number;
      attemptTrace?: GmxApiAttemptTrace[];
    }
  | {
      ok: false;
      kind: GmxApiErrorKind;
      httpStatus: number | null;
      /** true = broadcast/수락 여부 불명 — 호출측 UNRESOLVED 처리 필수 */
      ambiguous: boolean;
      /** sanitize된 고정 문구만 — URL query/서명/payload 전문 금지 */
      message: string;
      peerHost: string | null;
      attemptCount?: number;
      retryCount?: number;
      failoverCount?: number;
      attemptTrace?: GmxApiAttemptTrace[];
    };

export type GmxApiIntent = 'readonly' | 'submit';

export interface GmxApiTransport {
  readonly readonlyEnabled: boolean;
  readonly submissionEnabled: boolean;
  readonly peers: readonly string[];
  postJson<T = unknown>(path: string, body: unknown, intent: GmxApiIntent): Promise<GmxApiResult<T>>;
  getJson<T = unknown>(path: string): Promise<GmxApiResult<T>>;
}

function flagEnabled(env: Record<string, string | undefined>, name: string): boolean {
  return env[name] === 'true'; // 정확히 "true"만 — 그 외 전부 비활성
}

function hostOf(base: string): string {
  return new URL(base).host;
}

/** peer base URL 검증 — allowlist 밖은 전부 config fail-closed */
export function isAllowedPeer(base: string): boolean {
  try {
    const u = new URL(base);
    return u.protocol === 'https:'
      && (GMX_API_HOST_ALLOWLIST as readonly string[]).includes(u.host)
      && u.pathname === '/v1'
      && u.search === '' && u.hash === '' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

/** path 검증 — 절대 URL·프로토콜·역참조 금지, /로 시작하는 단순 경로만.
 *  GET 한정으로 엄격한 charset의 query string 1개를 허용한다 (SDK readonly 조회용). */
function isSafePath(path: string): boolean {
  const qIdx = path.indexOf('?');
  const base = qIdx === -1 ? path : path.slice(0, qIdx);
  const query = qIdx === -1 ? '' : path.slice(qIdx + 1);
  if (!/^\/[a-z0-9\-_/{}]*$/i.test(base) || base.includes('..') || base.includes('//')) return false;
  if (query !== '' && !/^[a-z0-9\-_=&%.,]*$/i.test(query)) return false;
  return !query.includes('..');
}

function bigIntReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) throw new Error('response too large');
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* noop */ }
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/** 단일 peer 1회 호출 — sanitize 보장 */
async function callOnce<T>(params: {
  base: string;
  path: string;
  method: 'GET' | 'POST';
  body: unknown;
  fetchImpl: typeof fetch;
  maxResponseBytes: number;
}): Promise<GmxApiResult<T>> {
  const peerHost = hostOf(params.base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GMX_API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await params.fetchImpl(params.base + params.path, {
      method: params.method,
      // 인증 헤더 없음 — 공개 API. Authorization/x-api-key 등 절대 금지.
      headers: params.method === 'POST'
        ? { 'Content-Type': 'application/json', Accept: 'application/json' }
        : { Accept: 'application/json' },
      body: params.method === 'POST' ? JSON.stringify(params.body, bigIntReplacer) : undefined,
      redirect: 'error', // redirect 추적 금지 — fail-closed
      signal: controller.signal,
    });
  } catch (e: unknown) {
    clearTimeout(timer);
    const aborted = (e as Error)?.name === 'AbortError';
    return {
      ok: false, kind: aborted ? 'timeout' : 'network', httpStatus: null, ambiguous: true,
      message: aborted ? `GMX API 응답 시한 초과 (peer=${peerHost})` : `GMX API 네트워크 오류 (peer=${peerHost})`,
      peerHost,
    };
  }
  clearTimeout(timer);

  if (res.status === 429) {
    return { ok: false, kind: 'rate_limited', httpStatus: 429, ambiguous: false,
      message: `GMX API rate limit (429, peer=${peerHost}) — 신규 제출 차단·backoff, 자동 재시도 금지`, peerHost };
  }
  if (res.status >= 500 && res.status < 600) {
    return { ok: false, kind: 'http_5xx', httpStatus: res.status, ambiguous: true,
      message: `GMX API 서버 오류 (5xx, peer=${peerHost})`, peerHost };
  }
  if (res.status >= 400) {
    return { ok: false, kind: 'http_4xx', httpStatus: res.status, ambiguous: false,
      message: `GMX API 요청 거부 (4xx, peer=${peerHost}) — pre-broadcast 확정`, peerHost };
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return { ok: false, kind: 'decode', httpStatus: res.status, ambiguous: true,
      message: `GMX API Content-Type 불일치 (peer=${peerHost})`, peerHost };
  }
  let text: string;
  try { text = await readBounded(res, params.maxResponseBytes); }
  catch {
    return { ok: false, kind: 'network', httpStatus: res.status, ambiguous: true,
      message: `GMX API 응답 크기/수신 오류 (peer=${peerHost})`, peerHost };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T, peerHost, httpStatus: res.status };
  } catch {
    return { ok: false, kind: 'decode', httpStatus: res.status, ambiguous: true,
      message: `GMX API JSON decode 실패 (peer=${peerHost})`, peerHost };
  }
}

/** failover 대상 판정 — readonly 전용 (network/timeout/5xx만) */
function isFailoverEligible(kind: GmxApiErrorKind): boolean {
  return kind === 'network' || kind === 'timeout' || kind === 'http_5xx';
}

function toAttemptTrace<T>(result: GmxApiResult<T>): GmxApiAttemptTrace | null {
  if (result.peerHost === null) return null;
  return {
    peerHost: result.peerHost,
    kind: result.ok ? null : result.kind,
    httpStatus: result.httpStatus ?? null,
  };
}

export function createGmxApiTransport(
  env: Record<string, string | undefined>,
  opts?: { fetchImpl?: typeof fetch; peers?: readonly string[] },
): GmxApiTransport {
  const peers = opts?.peers ?? GMX_API_PEERS;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const readonlyEnabled = flagEnabled(env, GMX_API_READONLY_FLAG);
  const submissionEnabled = flagEnabled(env, GMX_API_SUBMISSION_FLAG);

  // 구성 시점 allowlist 검증 — 위반 peer가 하나라도 있으면 모든 호출 차단
  const peersValid = peers.length > 0 && peers.every(isAllowedPeer);

  async function call<T>(path: string, method: 'GET' | 'POST', body: unknown, intent: GmxApiIntent): Promise<GmxApiResult<T>> {
    if (!peersValid) {
      return { ok: false, kind: 'config', httpStatus: null, ambiguous: false,
        message: 'GMX API peer allowlist 위반 — 호출 차단 (fail-closed)', peerHost: null,
        attemptCount: 0, retryCount: 0, failoverCount: 0, attemptTrace: [] };
    }
    if (!isSafePath(path)) {
      return { ok: false, kind: 'config', httpStatus: null, ambiguous: false,
        message: 'GMX API path 형식 위반 — 호출 차단 (fail-closed)', peerHost: null,
        attemptCount: 0, retryCount: 0, failoverCount: 0, attemptTrace: [] };
    }
    if (intent === 'submit') {
      if (!submissionEnabled) {
        return { ok: false, kind: 'config', httpStatus: null, ambiguous: false,
          message: `${GMX_API_SUBMISSION_FLAG}!=true — 제출 차단 (fail-closed)`, peerHost: null,
          attemptCount: 0, retryCount: 0, failoverCount: 0, attemptTrace: [] };
      }
      // submit: 단일 peer(첫 번째), 정확히 1회 — 자동 peer 재시도 금지
      const result = await callOnce<T>({
        base: peers[0], path, method, body, fetchImpl,
        maxResponseBytes: GMX_API_MAX_SUBMIT_RESPONSE_BYTES,
      });
      const trace = toAttemptTrace(result);
      return {
        ...result,
        attemptCount: 1,
        retryCount: 0,
        failoverCount: 0,
        attemptTrace: trace ? [trace] : [],
      };
    }
    if (!readonlyEnabled) {
      return { ok: false, kind: 'config', httpStatus: null, ambiguous: false,
        message: `${GMX_API_READONLY_FLAG}!=true — 조회 차단 (fail-closed)`, peerHost: null,
        attemptCount: 0, retryCount: 0, failoverCount: 0, attemptTrace: [] };
    }
    // readonly: peer 순차 시도 — network/timeout/5xx에서만 failover
    let last: GmxApiResult<T> | null = null;
    let attemptCount = 0;
    const attemptTrace: GmxApiAttemptTrace[] = [];
    for (const base of peers) {
      attemptCount += 1;
      const r = await callOnce<T>({
        base, path, method, body, fetchImpl,
        maxResponseBytes: GMX_API_MAX_READONLY_RESPONSE_BYTES,
      });
      const trace = toAttemptTrace(r);
      if (trace) attemptTrace.push(trace);
      const metadata = {
        attemptCount,
        retryCount: 0,
        failoverCount: Math.max(0, attemptCount - 1),
        attemptTrace: attemptTrace.map((entry) => ({ ...entry })),
      };
      if (r.ok) return { ...r, ...metadata };
      last = r;
      if (!isFailoverEligible(r.kind)) {
        return { ...r, ...metadata };
      } // 4xx/429/decode/config는 즉시 반환
    }
    return {
      ...(last as GmxApiResult<T>),
      attemptCount,
      retryCount: 0,
      failoverCount: Math.max(0, attemptCount - 1),
      attemptTrace: attemptTrace.map((entry) => ({ ...entry })),
    };
  }

  return {
    readonlyEnabled,
    submissionEnabled,
    peers,
    postJson: <T>(path: string, body: unknown, intent: GmxApiIntent) => call<T>(path, 'POST', body, intent),
    getJson: <T>(path: string) => call<T>(path, 'GET', null, 'readonly'),
  };
}

/**
 * @gmx-io/sdk GmxApiSdk에 주입하는 hardened api 클라이언트 (readonly 전용).
 * SDK 내부 HttpClient(무제한 30s·비검증 fetch)를 대체한다. SDK가 요구하는
 * 인터페이스: postJson(path, body, {transform}), fetchJson(path, {query, transform}).
 * path는 SDK가 '/v1/...'로 주므로 '/v1' prefix를 제거해 peer base('/v1')와 결합한다.
 * submit 계열 경로는 여기서도 구조적으로 차단한다 (SDK 경유 제출 금지).
 */
export function createSdkApiAdapter(transport: GmxApiTransport): {
  postJson: (path: string, body: unknown, opts?: { transform?: (raw: unknown) => unknown }) => Promise<unknown>;
  fetchJson: (path: string, opts?: { query?: Record<string, unknown>; transform?: (raw: unknown) => unknown }) => Promise<unknown>;
} {
  const SUBMIT_PATHS = ['/orders/txns/submit', '/relay/submit', '/gmx-account/withdraw/cross-chain/submit'];
  const strip = (p: string): string => (p.startsWith('/v1/') ? p.slice(3) : p);
  const ensure = <T>(r: GmxApiResult<T>): T => {
    if (!r.ok) throw new Error(r.message); // message는 이미 sanitize됨
    return r.data;
  };
  return {
    async postJson(path, body, opts) {
      const p = strip(path);
      if (SUBMIT_PATHS.includes(p)) {
        throw new Error('SDK 어댑터 경유 제출 금지 — 제출은 durable flow 전용 (fail-closed)');
      }
      const raw = ensure(await transport.postJson(p, body, 'readonly'));
      return opts?.transform ? opts.transform(raw) : raw;
    },
    async fetchJson(path, opts) {
      let p = strip(path);
      if (opts?.query) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.query)) {
          if (v !== undefined && v !== null) qs.set(k, String(v));
        }
        const s = qs.toString();
        if (s) p = `${p}?${s}`;
      }
      // query 포함 GET은 isSafePath를 우회해야 하므로 별도 검증
      if (p.includes('..') || /^https?:/i.test(p)) throw new Error('GMX API path 형식 위반 (fail-closed)');
      const raw = ensure(await transport.getJson(p));
      return opts?.transform ? opts.transform(raw) : raw;
    },
  };
}
