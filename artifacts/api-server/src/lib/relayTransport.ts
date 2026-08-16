/**
 * relayTransport — 실제 Gelato relay transport 어댑터 (4단계).
 *
 * 공식 근거 (gmx-interface master, sdk/utils/express/utils/gelatoRelayUtils.ts):
 *  - 제출: @gelatocloud/gasless 클라이언트의 sendTransaction({chainId,to,data}) —
 *    sponsor API key 기반. data = encodePacked(callData, to, feeToken, feeAmount).
 *    HTTP 등가: POST https://api.gelato.digital/relays/v2/sponsored-call
 *  - 상태: GET https://api.gelato.digital/tasks/status/{taskId}
 *    (gmx-interface sendExpressTransaction.ts GELATO_API 상수와 동일 host)
 *  - 취소: Gelato 공식 문서상 제출된 relay task의 사용자 취소 API는 지원되지
 *    않는다 (BaseGelatoRelayRouter 주석: "Once a transaction is signed and sent
 *    to a relay, it cannot be canceled"). cancelRelayTask는 구현하지 않는다.
 *  - fee: GMX는 callWithSyncFee 방식 — fee 산정은 DataStore gasLimits 기반
 *    (relayFeeQuote 모듈). Gelato fee oracle 병용 시
 *    GET https://api.gelato.digital/oracles/{chainId}/estimate
 *
 * 보안 (지시서 §3):
 *  - HTTPS만, host allowlist(api.gelato.digital), redirect 금지, 응답 256KB 제한,
 *    timeout, API key는 GELATO_RELAY_API_KEY Secret(이번 단계 미설정)로만 —
 *    로그·오류·URL query에 절대 미포함.
 *  - submit timeout·응답 유실 시 자동 재시도 금지, 같은 payload 재전송 금지.
 *  - quote 장애 시 fallback 숫자 금지.
 *  - 실제 transport는 DI로 주입 — 테스트는 mock transport만 사용.
 */

export const GELATO_HOST_ALLOWLIST = ['api.gelato.digital'] as const;
export const TRANSPORT_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 262_144; // 256KB
/** API key Secret 이름 — 값은 이번 단계에서 설정하지 않는다 */
export const GELATO_API_KEY_SECRET_NAME = 'GELATO_RELAY_API_KEY';

export type TransportErrorKind = 'timeout' | 'http' | 'decode' | 'network' | 'config';

export type QuoteResult =
  | { ok: true; estimatedFeeWei: bigint; quotedAtMs: number }
  | { ok: false; kind: TransportErrorKind; message: string };

export type SubmitResult =
  | { ok: true; taskId: string }
  /** ambiguous: 요청이 나갔을 수 있으나 taskId를 확보하지 못함 → UNRESOLVED, 재시도 금지 */
  | { ok: false; kind: TransportErrorKind; message: string; ambiguous: boolean };

export type TaskStatusResult =
  | {
      ok: true;
      taskState: string;            // Gelato taskState 원문 (CheckPending/ExecPending/ExecSuccess/ExecReverted/Cancelled/...)
      transactionHash: string | null;
      blockNumber: number | null;
    }
  | { ok: false; kind: TransportErrorKind; message: string };

/** 실제/모의 transport 공통 인터페이스 — 모든 호출측은 DI로만 사용 */
export interface RelayTransport {
  quoteRelayFee(params: { chainId: number; paymentToken: string; gasLimit: bigint }): Promise<QuoteResult>;
  submitRelayTask(params: { chainId: number; target: string; packedData: string }): Promise<SubmitResult>;
  getRelayTaskStatus(params: { taskId: string }): Promise<TaskStatusResult>;
}

function sanitizeTransportError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // URL·query·헤더 값이 섞여도 key 패턴 노출 방지
  return msg.replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]').slice(0, 200);
}

function validateUrl(url: string): { ok: true; parsed: URL } | { ok: false; message: string } {
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
  return { ok: true, parsed };
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

async function fetchGelato(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  const check = validateUrl(url);
  if (!check.ok) throw Object.assign(new Error(check.message), { kind: 'config' as TransportErrorKind });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TRANSPORT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ac.signal,
      redirect: 'error', // SSRF/redirect 방어
    });
    const text = await readBounded(res);
    return { status: res.status, text };
  } catch (e: unknown) {
    if ((e as Error).name === 'AbortError') {
      throw Object.assign(new Error('timeout'), { kind: 'timeout' as TransportErrorKind });
    }
    throw Object.assign(new Error(sanitizeTransportError(e)), { kind: 'network' as TransportErrorKind });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 실제 Gelato HTTP transport.
 * 이번 단계에서는 어떤 경로에서도 호출되지 않는다(활성화 env 미설정) —
 * 테스트는 전부 mock transport를 주입한다.
 */
export function createGelatoHttpTransport(env: NodeJS.ProcessEnv = process.env): RelayTransport {
  const base = 'https://api.gelato.digital';
  // 6단계 §2·§3 — 네트워크 권한 분리 (transport 내부 최종 방어, 호출측 게이트와 독립):
  //  - 읽기 전용 GET(quote/status): GMX_RELAY_READONLY_NETWORK_ENABLED === 'true' 필요.
  //    기존 submit 플래그들은 GET을 허용하지도, read-only 플래그를 암묵적으로
  //    켜지도 않는다.
  //  - sponsored-call POST(submit): read-only + submit network + submission +
  //    mode LIVE + API key + chainId 42161 + payload/target 검증 전부 통과해야
  //    fetch가 발신된다. 하나라도 빠지면 fetch 0회.
  const readonlyGate = (): { ok: false; kind: 'config'; message: string } | null => {
    if (env.GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true') {
      return { ok: false, kind: 'config', message: 'GMX_RELAY_READONLY_NETWORK_ENABLED 미설정 — 읽기 전용 네트워크 호출 차단 (fail-closed)' };
    }
    return null;
  };
  const submitGate = (): { ok: false; kind: 'config'; message: string } | null => {
    const missing: string[] = [];
    if (env.GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true') missing.push('GMX_RELAY_READONLY_NETWORK_ENABLED');
    if (env.GMX_RELAY_NETWORK_ENABLED !== 'true') missing.push('GMX_RELAY_NETWORK_ENABLED');
    if (env.GMX_RELAY_SUBMISSION_ENABLED !== 'true') missing.push('GMX_RELAY_SUBMISSION_ENABLED');
    if (env.GMX_RELAY_MODE !== 'LIVE') missing.push("GMX_RELAY_MODE !== 'LIVE'");
    if (missing.length > 0) {
      return { ok: false, kind: 'config', message: `submit 차단 (fail-closed): ${missing.join(', ')}` };
    }
    return null;
  };
  return {
    async quoteRelayFee({ chainId, paymentToken, gasLimit }) {
      const gateBlock = readonlyGate();
      if (gateBlock) return gateBlock;
      try {
        const url = `${base}/oracles/${chainId}/estimate?paymentToken=${encodeURIComponent(paymentToken)}&gasLimit=${gasLimit.toString()}`;
        const { status, text } = await fetchGelato(url, { method: 'GET' });
        if (status !== 200) return { ok: false, kind: 'http', message: `HTTP ${status}` };
        let json: unknown;
        try { json = JSON.parse(text); } catch { return { ok: false, kind: 'decode', message: 'JSON 파싱 실패' }; }
        const raw = (json as { estimatedFee?: string | number }).estimatedFee;
        if (raw === undefined || raw === null) return { ok: false, kind: 'decode', message: 'estimatedFee 없음' };
        let fee: bigint;
        try { fee = BigInt(String(raw)); } catch { return { ok: false, kind: 'decode', message: 'estimatedFee 형식 오류' }; }
        if (fee <= 0n) return { ok: false, kind: 'decode', message: 'estimatedFee 0 이하' };
        return { ok: true, estimatedFeeWei: fee, quotedAtMs: Date.now() };
      } catch (e: unknown) {
        const kind = ((e as { kind?: TransportErrorKind }).kind ?? 'network') as TransportErrorKind;
        return { ok: false, kind, message: sanitizeTransportError(e) };
      }
    },

    async submitRelayTask({ chainId, target, packedData }) {
      const gateBlock = submitGate();
      if (gateBlock) return { ...gateBlock, ambiguous: false };
      const apiKey = env[GELATO_API_KEY_SECRET_NAME];
      if (!apiKey) {
        // 요청이 나가기 전 실패 — ambiguous 아님 (재제출 판단은 호출측 게이트가 하되, broadcast 없음 확정)
        return { ok: false, kind: 'config', message: `${GELATO_API_KEY_SECRET_NAME} 미설정`, ambiguous: false };
      }
      // payload/target/chain 검증 — 하나라도 실패하면 fetch 0회 (요청 발신 전)
      if (chainId !== 42161) {
        return { ok: false, kind: 'config', message: `chainId ${chainId} ≠ 42161 — 제출 차단`, ambiguous: false };
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
        return { ok: false, kind: 'config', message: 'target 주소 형식 오류 — 제출 차단', ambiguous: false };
      }
      if (!/^0x[0-9a-fA-F]+$/.test(packedData) || packedData.length < 10) {
        return { ok: false, kind: 'config', message: 'packedData 형식 오류 — 제출 차단', ambiguous: false };
      }
      try {
        const { status, text } = await fetchGelato(`${base}/relays/v2/sponsored-call`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chainId: String(chainId), target, data: packedData, sponsorApiKey: apiKey }),
        });
        if (status !== 200 && status !== 201) {
          // 4xx는 거부 확정(비-ambiguous), 5xx는 수락 여부 불명(ambiguous)
          return { ok: false, kind: 'http', message: `HTTP ${status}`, ambiguous: status >= 500 };
        }
        let json: unknown;
        try { json = JSON.parse(text); } catch {
          return { ok: false, kind: 'decode', message: 'JSON 파싱 실패 — 수락 여부 불명', ambiguous: true };
        }
        const taskId = (json as { taskId?: string }).taskId;
        if (!taskId || typeof taskId !== 'string') {
          return { ok: false, kind: 'decode', message: 'taskId 없음 — 수락 여부 불명', ambiguous: true };
        }
        return { ok: true, taskId };
      } catch (e: unknown) {
        const kind = ((e as { kind?: TransportErrorKind }).kind ?? 'network') as TransportErrorKind;
        // timeout/network은 요청이 도달했을 수 있음 → ambiguous, 재시도 금지
        return { ok: false, kind, message: sanitizeTransportError(e), ambiguous: kind === 'timeout' || kind === 'network' };
      }
    },

    async getRelayTaskStatus({ taskId }) {
      const gateBlock = readonlyGate();
      if (gateBlock) return gateBlock;
      try {
        const { status, text } = await fetchGelato(`${base}/tasks/status/${encodeURIComponent(taskId)}`, { method: 'GET' });
        if (status !== 200) return { ok: false, kind: 'http', message: `HTTP ${status}` };
        let json: unknown;
        try { json = JSON.parse(text); } catch { return { ok: false, kind: 'decode', message: 'JSON 파싱 실패' }; }
        const task = (json as { task?: { taskState?: string; transactionHash?: string; blockNumber?: number } }).task;
        if (!task?.taskState) return { ok: false, kind: 'decode', message: 'taskState 없음' };
        return {
          ok: true,
          taskState: task.taskState,
          transactionHash: task.transactionHash ?? null,
          blockNumber: typeof task.blockNumber === 'number' ? task.blockNumber : null,
        };
      } catch (e: unknown) {
        const kind = ((e as { kind?: TransportErrorKind }).kind ?? 'network') as TransportErrorKind;
        return { ok: false, kind, message: sanitizeTransportError(e) };
      }
    },
  };
}
