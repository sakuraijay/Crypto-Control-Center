/**
 * relayTransport — Gelato 신규 JSON-RPC transport (6F-2 §3·§4).
 *
 * 공식 근거 (pin — PROJECT_STATE.md §GMX pin 참조):
 *  - gmx-interface commit e27759a2835c7dc2197f41b6a6043bf07b935621 (2026-08-13)
 *  - @gmx-io/sdk v1.7.0, @gelatocloud/gasless v0.0.10
 *  - 계약: POST https://api.gelato.cloud/rpc — JSON-RPC 2.0, 전 호출 X-API-Key 헤더.
 *    · relayer_sendTransaction({chainId:string,to,data}) → 32-byte hex taskId
 *    · relayer_getStatus({id}) → { status: 100|110|200|400|500, hash?, receipt?, message? }
 *      (gasless v0.0.10 schema: Pending=100, Submitted=110, Success=200,
 *       Rejected=400, Reverted=500; terminal = 200/400/500)
 *    · gelato_getBalance(params:[]) → { balance, decimals, unit }
 *  - legacy REST(api.gelato.digital, /oracles/, /relays/v2/sponsored-call,
 *    /tasks/status/)는 이 코드베이스의 실행 경로에서 완전히 제거됐다.
 *    legacy 세대 taskId는 신형 endpoint로 절대 조회하지 않는다
 *    (UNRESOLVED_LEGACY_TRANSPORT — reconciler/readiness에서 분류).
 *
 * 구조적 능력 분리 (§4):
 *  - read-only transport: relayer_getStatus + gelato_getBalance만.
 *  - submit transport: relayer_sendTransaction만.
 *  - method allowlist는 transport 내부(rpcCall)에서 최종 강제 — allowlist 밖
 *    method는 fetch 0회. 게이트(플래그·API key·chainId·manifest) 하나라도
 *    빠지면 fetch 0회 (fail-closed).
 *
 * 보안:
 *  - HTTPS만, host allowlist(api.gelato.cloud), redirect 금지, 10s timeout,
 *    응답 256KB 제한, Content-Type/JSON-RPC schema 검증, 재시도 금지.
 *  - API key Secret 이름은 GELATO_API_KEY 하나만 (alias/fallback 없음).
 *    값은 로그·오류·URL·응답 어디에도 절대 미포함.
 */

import { GMX_DEPLOYMENT_MANIFEST, getBlockedAddressReason } from './gmxDeploymentManifest';

export const GELATO_HOST_ALLOWLIST = ['api.gelato.cloud'] as const;
export const GELATO_RPC_URL = 'https://api.gelato.cloud/rpc';
export const TRANSPORT_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 262_144; // 256KB
/** API key Secret 이름 — 신규 통일 이름. 값은 이번 단계에서 설정하지 않는다 */
export const GELATO_API_KEY_SECRET_NAME = 'GELATO_API_KEY';
/** transport 계약 세대 식별자 — relay_tasks.transport_gen에 기록 */
export const TRANSPORT_GENERATION = 'jsonrpc-gasless-0.0.10';

/** capability별 method allowlist — transport 내부 최종 강제 (§4) */
export const READONLY_RPC_METHODS = ['relayer_getStatus', 'gelato_getBalance'] as const;
export const SUBMIT_RPC_METHODS = ['relayer_sendTransaction'] as const;

/** gasless v0.0.10 schema.js StatusCode — 정확 일치 필수 (§9) */
export const GELATO_STATUS = {
  PENDING: 100,
  SUBMITTED: 110,
  SUCCESS: 200,
  REJECTED: 400,
  REVERTED: 500,
} as const;
export type GelatoStatusCode = (typeof GELATO_STATUS)[keyof typeof GELATO_STATUS];
const KNOWN_STATUS_CODES: readonly number[] = Object.values(GELATO_STATUS);

export type TransportErrorKind = 'timeout' | 'http' | 'decode' | 'network' | 'config' | 'rpc';

export type SubmitResult =
  | { ok: true; taskId: string }
  /**
   * ambiguous: 요청이 나갔을 수 있으나 taskId를 확보하지 못함 → UNRESOLVED, 재시도 금지.
   * 비-ambiguous: 명시적 4xx/JSON-RPC pre-broadcast rejection 또는 발신 전 차단.
   */
  | { ok: false; kind: TransportErrorKind; message: string; ambiguous: boolean };

export type TaskStatusResult =
  | {
      ok: true;
      statusCode: GelatoStatusCode;
      transactionHash: string | null;
      blockNumber: number | null;
    }
  | { ok: false; kind: TransportErrorKind; message: string; httpStatus?: number };

export type SponsorBalanceResult =
  | { ok: true; balance: bigint; decimals: number; unit: string }
  | { ok: false; kind: TransportErrorKind; message: string; httpStatus?: number };

/** 읽기 전용 transport — 상태·잔액 조회만. submit 능력은 구조적으로 없다 */
export interface RelayReadonlyTransport {
  getRelayTaskStatus(params: { taskId: string }): Promise<TaskStatusResult>;
  getSponsorBalance(): Promise<SponsorBalanceResult>;
}

/** submit transport — relayer_sendTransaction만 */
export interface RelaySubmitTransport {
  submitRelayTask(params: { chainId: number; target: string; packedData: string }): Promise<SubmitResult>;
}

/** 호출측 DI 편의를 위한 결합 인터페이스 — 내부 구현은 능력별로 분리돼 있다 */
export interface RelayTransport extends RelayReadonlyTransport, RelaySubmitTransport {}

export function isValidGelatoTaskId(taskId: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(taskId);
}

function sanitizeTransportError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '[url-redacted]')
    .replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .slice(0, 200);
}

function validateUrl(url: string): { ok: true } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: 'URL 파싱 실패' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, message: 'HTTPS만 허용' };
  if (!GELATO_HOST_ALLOWLIST.includes(parsed.hostname as (typeof GELATO_HOST_ALLOWLIST)[number])) {
    return { ok: false, message: `허용되지 않은 host: ${parsed.hostname}` };
  }
  return { ok: true };
}

async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  let total = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('응답 크기 제한 초과');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type RpcCallResult =
  | { ok: true; result: unknown }
  /** rpcError: JSON-RPC error 응답 (HTTP 200이어도 명시적 거부) — code 정수만 노출 */
  | { ok: false; kind: TransportErrorKind; message: string; httpStatus?: number; rpcErrorCode?: number };

let rpcIdCounter = 0;

/**
 * 단일 JSON-RPC 호출 — capability별 method allowlist를 여기서 최종 강제한다.
 * allowlist 밖 method·API key 미설정은 fetch 0회.
 */
async function rpcCall(
  env: NodeJS.ProcessEnv,
  allowedMethods: readonly string[],
  method: string,
  params: unknown,
): Promise<RpcCallResult> {
  // §4 — transport 내부 최종 method allowlist (호출측 게이트와 독립)
  if (!allowedMethods.includes(method)) {
    return { ok: false, kind: 'config', message: `method allowlist 위반: ${method} — fetch 0회 (fail-closed)` };
  }
  const apiKey = env[GELATO_API_KEY_SECRET_NAME];
  if (!apiKey) {
    return { ok: false, kind: 'config', message: `${GELATO_API_KEY_SECRET_NAME} 미설정 — fetch 0회 (fail-closed)` };
  }
  const urlCheck = validateUrl(GELATO_RPC_URL);
  if (!urlCheck.ok) return { ok: false, kind: 'config', message: urlCheck.message };

  const id = ++rpcIdCounter;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TRANSPORT_TIMEOUT_MS);
  let status: number;
  let contentType: string;
  let text: string;
  try {
    const res = await fetch(GELATO_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: ac.signal,
      redirect: 'error', // SSRF/redirect 방어
    });
    status = res.status;
    contentType = res.headers.get('content-type') ?? '';
    text = await readBounded(res);
  } catch (e: unknown) {
    if ((e as Error).name === 'AbortError') {
      return { ok: false, kind: 'timeout', message: 'timeout' };
    }
    return { ok: false, kind: 'network', message: sanitizeTransportError(e) };
  } finally {
    clearTimeout(timer);
  }

  // 고정 형식 메시지 + 정수 status만 — 응답 본문·헤더·URL은 절대 미포함
  if (status !== 200) {
    return { ok: false, kind: 'http', httpStatus: Math.trunc(status), message: `HTTP ${Math.trunc(status)}` };
  }
  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, kind: 'decode', message: 'Content-Type이 JSON이 아님' };
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, kind: 'decode', message: 'JSON 파싱 실패' }; }
  if (typeof json !== 'object' || json === null) return { ok: false, kind: 'decode', message: 'JSON-RPC 응답 형식 오류' };
  const body = json as { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
  if (body.jsonrpc !== '2.0' || body.id !== id) {
    return { ok: false, kind: 'decode', message: 'JSON-RPC envelope 불일치 (jsonrpc/id)' };
  }
  if (body.error !== undefined && body.error !== null) {
    const code = typeof body.error.code === 'number' && Number.isInteger(body.error.code) ? body.error.code : null;
    // upstream error message 문자열은 그대로 노출하지 않는다 — code 정수만
    return {
      ok: false, kind: 'rpc', rpcErrorCode: code ?? undefined,
      message: code !== null ? `JSON-RPC 오류 (code ${code})` : 'JSON-RPC 오류 (code 불명)',
    };
  }
  if (!('result' in body)) return { ok: false, kind: 'decode', message: 'JSON-RPC result 없음' };
  return { ok: true, result: body.result };
}

// ── 게이트 (플래그) ───────────────────────────────────────────────────────────

function readonlyGate(env: NodeJS.ProcessEnv): { ok: false; kind: 'config'; message: string } | null {
  if (env.GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true') {
    return { ok: false, kind: 'config', message: 'GMX_RELAY_READONLY_NETWORK_ENABLED 미설정 — 읽기 전용 네트워크 호출 차단 (fail-closed)' };
  }
  return null;
}

function submitGate(env: NodeJS.ProcessEnv): { ok: false; kind: 'config'; message: string } | null {
  const missing: string[] = [];
  if (env.GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true') missing.push('GMX_RELAY_READONLY_NETWORK_ENABLED');
  if (env.GMX_RELAY_NETWORK_ENABLED !== 'true') missing.push('GMX_RELAY_NETWORK_ENABLED');
  if (env.GMX_RELAY_SUBMISSION_ENABLED !== 'true') missing.push('GMX_RELAY_SUBMISSION_ENABLED');
  if (env.GMX_RELAY_MODE !== 'LIVE') missing.push("GMX_RELAY_MODE !== 'LIVE'");
  if (missing.length > 0) {
    return { ok: false, kind: 'config', message: `submit 차단 (fail-closed): ${missing.join(', ')}` };
  }
  return null;
}

// ── 응답 파서 (순수 — 테스트 대상) ────────────────────────────────────────────

/** relayer_getStatus result 파싱 — schema 불일치는 전부 decode 오류 (fail-closed) */
export function parseRelayerStatusResult(result: unknown): TaskStatusResult {
  if (typeof result !== 'object' || result === null) {
    return { ok: false, kind: 'decode', message: 'status result 형식 오류' };
  }
  const r = result as { status?: unknown; hash?: unknown; receipt?: unknown };
  if (typeof r.status !== 'number' || !KNOWN_STATUS_CODES.includes(r.status)) {
    return { ok: false, kind: 'decode', message: `알 수 없는 StatusCode — gasless v0.0.10 (100/110/200/400/500) 아님` };
  }
  let txHash: string | null = null;
  let blockNumber: number | null = null;
  const receipt = (typeof r.receipt === 'object' && r.receipt !== null)
    ? (r.receipt as { transactionHash?: unknown; blockNumber?: unknown })
    : null;
  const rawHash = receipt?.transactionHash ?? r.hash;
  if (typeof rawHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(rawHash)) txHash = rawHash;
  const rawBlock = receipt?.blockNumber;
  if (typeof rawBlock === 'number' && Number.isInteger(rawBlock)) blockNumber = rawBlock;
  else if (typeof rawBlock === 'string' && /^0x[0-9a-fA-F]+$/.test(rawBlock)) blockNumber = Number.parseInt(rawBlock, 16);
  return { ok: true, statusCode: r.status as GelatoStatusCode, transactionHash: txHash, blockNumber };
}

/** gelato_getBalance result 파싱 — 단위 불명확·schema 불일치는 거부 (§10) */
export function parseSponsorBalanceResult(result: unknown): SponsorBalanceResult {
  if (typeof result !== 'object' || result === null) {
    return { ok: false, kind: 'decode', message: 'balance result 형식 오류' };
  }
  const r = result as { balance?: unknown; decimals?: unknown; unit?: unknown };
  let balance: bigint;
  try {
    if (typeof r.balance === 'bigint') balance = r.balance;
    else if (typeof r.balance === 'string' || typeof r.balance === 'number') balance = BigInt(r.balance);
    else return { ok: false, kind: 'decode', message: 'balance 형식 오류' };
  } catch {
    return { ok: false, kind: 'decode', message: 'balance 형식 오류' };
  }
  if (balance < 0n) return { ok: false, kind: 'decode', message: 'balance 음수 — 거부' };
  if (typeof r.decimals !== 'number' || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 36) {
    return { ok: false, kind: 'decode', message: 'decimals 형식 오류 — 단위 불명확 (UNVERIFIED)' };
  }
  if (typeof r.unit !== 'string' || r.unit.length === 0) {
    return { ok: false, kind: 'decode', message: 'unit 없음 — 단위 불명확 (UNVERIFIED)' };
  }
  return { ok: true, balance, decimals: r.decimals, unit: r.unit };
}

// ── transport 생성자 ──────────────────────────────────────────────────────────

/** 읽기 전용 transport — relayer_getStatus·gelato_getBalance만. submit 능력 없음 */
export function createGelatoReadonlyTransport(env: NodeJS.ProcessEnv = process.env): RelayReadonlyTransport {
  return {
    async getRelayTaskStatus({ taskId }) {
      const gateBlock = readonlyGate(env);
      if (gateBlock) return gateBlock;
      if (!isValidGelatoTaskId(taskId)) {
        return { ok: false, kind: 'config', message: 'taskId가 32-byte hex가 아님 — 조회 차단 (fail-closed)' };
      }
      const r = await rpcCall(env, READONLY_RPC_METHODS, 'relayer_getStatus', { id: taskId });
      if (!r.ok) return { ok: false, kind: r.kind, message: r.message, ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}) };
      return parseRelayerStatusResult(r.result);
    },

    async getSponsorBalance() {
      const gateBlock = readonlyGate(env);
      if (gateBlock) return gateBlock;
      const r = await rpcCall(env, READONLY_RPC_METHODS, 'gelato_getBalance', []);
      if (!r.ok) return { ok: false, kind: r.kind, message: r.message, ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}) };
      return parseSponsorBalanceResult(r.result);
    },
  };
}

/** submit transport — relayer_sendTransaction만 */
export function createGelatoSubmitTransport(env: NodeJS.ProcessEnv = process.env): RelaySubmitTransport {
  return {
    async submitRelayTask({ chainId, target, packedData }) {
      const gateBlock = submitGate(env);
      if (gateBlock) return { ...gateBlock, ambiguous: false };
      if (!env[GELATO_API_KEY_SECRET_NAME]) {
        return { ok: false, kind: 'config', message: `${GELATO_API_KEY_SECRET_NAME} 미설정`, ambiguous: false };
      }
      // payload/target/chain 검증 — 하나라도 실패하면 fetch 0회 (요청 발신 전)
      if (chainId !== 42161) {
        return { ok: false, kind: 'config', message: `chainId ${chainId} ≠ 42161 — 제출 차단`, ambiguous: false };
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
        return { ok: false, kind: 'config', message: 'target 주소 형식 오류 — 제출 차단', ambiguous: false };
      }
      const blockedReason = getBlockedAddressReason(target);
      if (blockedReason) {
        return { ok: false, kind: 'config', message: `target 차단 주소 — ${blockedReason} — 제출 차단`, ambiguous: false };
      }
      if (target.toLowerCase() !== GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter.toLowerCase()) {
        return { ok: false, kind: 'config', message: `target이 manifest v${GMX_DEPLOYMENT_MANIFEST.manifestVersion} 감사 router와 불일치 — 제출 차단 (fail-closed)`, ambiguous: false };
      }
      if (!/^0x[0-9a-fA-F]+$/.test(packedData) || packedData.length < 10) {
        return { ok: false, kind: 'config', message: 'packedData 형식 오류 — 제출 차단', ambiguous: false };
      }

      const r = await rpcCall(env, SUBMIT_RPC_METHODS, 'relayer_sendTransaction', {
        chainId: String(chainId), to: target, data: packedData,
      });
      if (!r.ok) {
        // 분류 (§8): 명시적 4xx·JSON-RPC error = pre-broadcast rejection 확정(비-ambiguous).
        // timeout/network/5xx/decode = 수락 여부 불명(ambiguous) → UNRESOLVED, 재시도 금지.
        if (r.kind === 'rpc') return { ok: false, kind: 'rpc', message: r.message, ambiguous: false };
        if (r.kind === 'config') return { ok: false, kind: 'config', message: r.message, ambiguous: false };
        if (r.kind === 'http') {
          const s = r.httpStatus ?? 0;
          return { ok: false, kind: 'http', message: r.message, ambiguous: !(s >= 400 && s < 500) };
        }
        return { ok: false, kind: r.kind, message: r.message, ambiguous: true };
      }
      const taskId = r.result;
      if (typeof taskId !== 'string' || !isValidGelatoTaskId(taskId)) {
        return { ok: false, kind: 'decode', message: 'taskId가 32-byte hex가 아님 — 수락 여부 불명', ambiguous: true };
      }
      return { ok: true, taskId };
    },
  };
}

/**
 * 결합 transport — DI 호환용. 내부적으로 능력별 분리 구현에 위임하며,
 * 각 구현의 method allowlist·게이트가 그대로 적용된다.
 */
export function createGelatoHttpTransport(env: NodeJS.ProcessEnv = process.env): RelayTransport {
  const ro = createGelatoReadonlyTransport(env);
  const sub = createGelatoSubmitTransport(env);
  return {
    getRelayTaskStatus: (p) => ro.getRelayTaskStatus(p),
    getSponsorBalance: () => ro.getSponsorBalance(),
    submitRelayTask: (p) => sub.submitRelayTask(p),
  };
}
