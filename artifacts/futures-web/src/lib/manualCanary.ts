/**
 * manualCanary — #135 Manual Controlled Canary 웹 API 헬퍼.
 *
 * 원칙:
 *  - 하드캡은 서버 강제 — UI는 읽기 전용 표시만 하고 확대 입력을 만들지 않는다.
 *  - preflight(1단계, read-only) → confirm 문구 입력 → execute(2단계) 순서 고정.
 *  - PIN은 x-operator-pin 헤더로만 전송, 어디에도 저장/출력하지 않는다.
 *  - 실패는 전체 항목을 그대로 표시 (부분 은닉 금지).
 */
import { apiUrl, apiUrlWithQuery, readApiJson } from './apiUrl';

export const CANARY_CONFIRM_OPEN = 'EXECUTE-CANARY-OPEN';
export const CANARY_CONFIRM_CLOSE = 'EXECUTE-CANARY-CLOSE';

export interface CanaryCaps {
  maxCollateralUsd: number;
  maxLeverage: number;
  maxNotionalUsd: number;
  maxOpenPositions: number;
  maxAccumLossUsd: number;
  maxOrdersPerDay: number;
  maxRoundTripCostUsd: number;
  maxPriceDriftFraction: number;
  allowedSymbols: string[];
  preflightTtlMs: number;
}

export interface CanaryPreflightItem { id: string; label: string; ok: boolean; detail: string }

export interface CanaryPreflightResponse {
  ok: boolean;
  atMs: number;
  preflightId: string | null;
  items: CanaryPreflightItem[];
  priceUsd: number | null;
  caps?: CanaryCaps;
}

export interface CanaryExecuteResponse {
  ok: boolean;
  phase: 'REJECTED' | 'SIMULATED' | 'SUBMITTED' | 'ERROR';
  reason: string | null;
  intentId: string | null;
  failures: CanaryPreflightItem[];
}

export interface CanaryStage { status: string; detail: string }

export interface CanaryStatusResponse {
  ok: boolean;
  caps: CanaryCaps;
  dayKey: string;
  daily: {
    dayKey: string; opens: number; openIntentId: string | null;
    closeIntentId: string | null; emergencyCloseUsed: boolean; openedAt: string | null;
  } | null;
  stages: {
    open: CanaryStage; stop: CanaryStage; close: CanaryStage;
    confirmed: CanaryStage; readback: CanaryStage;
  };
}

export type CanaryFetchResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'auth' }
  | { kind: 'error'; message: string };

async function parse<T>(res: Response): Promise<CanaryFetchResult<T>> {
  if (res.status === 401 || res.status === 403) return { kind: 'auth' };
  const body = await readApiJson(res);
  if (body.kind !== 'json') {
    return {
      kind: 'error',
      message: body.kind === 'route_mismatch' ? 'API 라우팅 오류' : '응답 파싱 실패',
    };
  }
  return { kind: 'ok', data: body.json as T };
}

export async function fetchCanaryStatus(pin: string): Promise<CanaryFetchResult<CanaryStatusResponse>> {
  try {
    const res = await fetch(apiUrl('/executor/canary/status'), { headers: { 'x-operator-pin': pin } });
    return await parse<CanaryStatusResponse>(res);
  } catch { return { kind: 'error', message: '네트워크 오류' }; }
}

export async function fetchCanaryPreflight(
  pin: string, symbol: string, direction: string,
): Promise<CanaryFetchResult<CanaryPreflightResponse>> {
  try {
    const res = await fetch(apiUrlWithQuery('/executor/canary/preflight', { symbol, direction }), {
      headers: { 'x-operator-pin': pin },
    });
    return await parse<CanaryPreflightResponse>(res);
  } catch { return { kind: 'error', message: '네트워크 오류' }; }
}

export async function postCanaryExecute(pin: string, body: {
  preflightId: string; confirm: string; symbol: string; direction: string;
}): Promise<CanaryFetchResult<CanaryExecuteResponse>> {
  try {
    const res = await fetch(apiUrl('/executor/canary/execute'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-pin': pin },
      body: JSON.stringify(body),
    });
    return await parse<CanaryExecuteResponse>(res);
  } catch { return { kind: 'error', message: '네트워크 오류' }; }
}

export async function postCanaryClose(pin: string, body: {
  confirm: string; mode?: 'emergency';
}): Promise<CanaryFetchResult<CanaryExecuteResponse>> {
  try {
    const res = await fetch(apiUrl('/executor/canary/close'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-pin': pin },
      body: JSON.stringify(body),
    });
    return await parse<CanaryExecuteResponse>(res);
  } catch { return { kind: 'error', message: '네트워크 오류' }; }
}

/** 단계 표시용 톤 매핑 — 온체인 증거 기반 상태만 성공 취급 */
export function stageTone(status: string): 'ok' | 'warn' | 'error' | 'idle' {
  if (['CONFIRMED', 'ACTIVE', 'DONE'].includes(status)) return 'ok';
  if (['PENDING'].includes(status)) return 'idle';
  if (['UNKNOWN', 'MISSING', 'FAILED', 'TX_REVERTED'].includes(status)) return 'error';
  return 'warn'; // SUBMITTING/SUBMITTED/UNRESOLVED 등 — 조사 대상
}
