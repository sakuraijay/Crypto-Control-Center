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

export interface CanaryCostComponentDiagnostic {
  componentId: 'TICKERS' | 'MARKETS_INFO' | 'SDK_PRICE_IMPACT' | 'FUNDING' | 'BORROWING';
  sourceId: 'GMX_API_MARKETS_TICKERS' | 'GMX_API_MARKETS_INFO' | 'GMX_SDK_PRICE_IMPACT';
  state: 'SUCCESS' | 'FAILED' | 'MISSING' | 'STALE';
  code: string;
  observedAtMs: number | null;
  ageMs: number | null;
  fresh: boolean;
}

export interface BoundedCanaryEconomics {
  status: 'AVAILABLE' | 'UNECONOMIC' | 'UNAVAILABLE';
  symbol: 'BTC' | 'ETH';
  failureId: string | null;
  detail: string;
  failedNotionalUsd: number | null;
  componentDiagnostics: CanaryCostComponentDiagnostic[];
}

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
  blockers: CanaryBlocker[];
  boundedCanaryEconomics?: Record<'BTC' | 'ETH', BoundedCanaryEconomics>;
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
    const res = await fetch(apiUrl('/executor/canary/preflight'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-pin': pin },
      body: JSON.stringify({ symbol, direction }),
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

// ── Blocker groups (#142) ─────────────────────────────────────────────────────

/**
 * 서버가 반환하는 단일 blocker 항목.
 *  - category: CODE | CONFIGURATION | OPERATOR_MANUAL_ACTION | GITHUB_CI — 그 외는 UNKNOWN 취급
 *  - id: 안정적 식별자 (렌더 key 용도)
 *  - message: 운영자용 한국어 설명 (비밀·PIN·RPC URL·서명 포함 금지)
 *  - blocking: true면 이 항목이 실행을 실제로 막고 있음
 */
export interface CanaryBlocker {
  category: string;
  id: string;
  message: string;
  blocking: boolean;
}

/**
 * 허용된 blocker category 목록.
 * 이 목록 외 category는 UI에서 UNKNOWN으로 안전 처리 (fail-closed).
 */
export const ALLOWED_BLOCKER_CATEGORIES = [
  'CODE',
  'CONFIGURATION',
  'OPERATOR_MANUAL_ACTION',
  'GITHUB_CI',
] as const;

export type AllowedBlockerCategory = (typeof ALLOWED_BLOCKER_CATEGORIES)[number];

/** Category별 한국어 레이블 */
export const BLOCKER_CATEGORY_LABELS: Record<AllowedBlockerCategory, string> = {
  CODE: '코드 오류',
  CONFIGURATION: '설정 오류',
  OPERATOR_MANUAL_ACTION: '운영자 수동 조치 필요',
  GITHUB_CI: 'GitHub CI 상태',
};

/**
 * category를 허용 목록과 대조해 AllowedBlockerCategory 또는 null 반환.
 * 목록 외 값은 null — GITHUB_CI unknown 포함 (fail-closed).
 */
export function classifyBlockerCategory(category: unknown): AllowedBlockerCategory | null {
  if (typeof category !== 'string') return null;
  if ((ALLOWED_BLOCKER_CATEGORIES as readonly string[]).includes(category)) {
    return category as AllowedBlockerCategory;
  }
  return null;
}

/**
 * blocker message에서 비밀 패턴을 제거한다 (fail-closed).
 * PIN/RPC URL/지갑 주소/서명/비밀 키 형식은 절대 렌더하지 않는다.
 *
 * 안전: 이 함수가 반환하는 문자열만 UI에 표시한다.
 */
const SECRET_PATTERNS = [
  // hex 비밀 키(32 bytes = 64 chars)
  /0x[0-9a-fA-F]{64}/g,
  // 지갑 주소(20 bytes = 40 chars + 0x prefix, checksum 포함)
  /0x[0-9a-fA-F]{40}/g,
  // RPC/WS URL
  /https?:\/\/[^\s"'<>]+/gi,
  /wss?:\/\/[^\s"'<>]+/gi,
  // 서명(65 bytes = 130 chars + 0x)
  /0x[0-9a-fA-F]{130}/g,
  // 일반 긴 hex(>32 chars)
  /0x[0-9a-fA-F]{33,}/g,
  // base64 인코딩된 긴 문자열(시크릿 후보)
  /[A-Za-z0-9+/]{60,}={0,2}/g,
] as const;

export function sanitizeBlockerMessage(message: unknown): string {
  if (typeof message !== 'string') return '(메시지 없음)';
  let s = message.trim();
  // 빈 문자열
  if (s.length === 0) return '(메시지 없음)';
  // 비밀 패턴 치환 (순서: 긴 hex 먼저)
  s = s.replace(/0x[0-9a-fA-F]{130}/g, '[서명 은닉]');
  s = s.replace(/0x[0-9a-fA-F]{64}/g, '[키 은닉]');
  s = s.replace(/0x[0-9a-fA-F]{40}/g, '[주소 은닉]');
  s = s.replace(/0x[0-9a-fA-F]{33,}/g, '[hex 은닉]');
  s = s.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL 은닉]');
  s = s.replace(/wss?:\/\/[^\s"'<>]+/gi, '[URL 은닉]');
  s = s.replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '[인코딩 은닉]');
  // 최대 길이 제한 (안전 표시)
  return s.slice(0, 200);
}

/**
 * blockers 배열을 category별로 그룹화한다.
 * 알 수 없는 category는 포함하지 않는다 (fail-closed).
 */
export function groupBlockersByCategory(
  blockers: CanaryBlocker[],
): Map<AllowedBlockerCategory, CanaryBlocker[]> {
  const map = new Map<AllowedBlockerCategory, CanaryBlocker[]>();
  let unknownSeen = false;
  for (const b of blockers) {
    const cat = classifyBlockerCategory(b.category);
    if (cat === null) {
      unknownSeen = true;
      continue;
    }
    const safeBlocker: CanaryBlocker = {
      category: cat,
      id: typeof b.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b.id)
        ? b.id
        : `${cat}_UNKNOWN_BLOCKER`,
      message: typeof b.message === 'string'
        ? b.message
        : '차단 상세 메시지가 없어 실행을 차단합니다.',
      blocking: b.blocking !== false,
    };
    const list = map.get(cat);
    if (list) list.push(safeBlocker);
    else map.set(cat, [safeBlocker]);
  }
  if (unknownSeen) {
    const unknownBlocker: CanaryBlocker = {
      category: 'CODE',
      id: 'UNKNOWN_BLOCKER_CATEGORY',
      message: '지원되지 않는 차단 범주가 감지되어 실행을 차단합니다.',
      blocking: true,
    };
    const code = map.get('CODE');
    if (code) code.push(unknownBlocker);
    else map.set('CODE', [unknownBlocker]);
  }
  return map;
}

export function normalizeCanaryBlockers(blockers: unknown): CanaryBlocker[] {
  if (!Array.isArray(blockers)) {
    return [{
      category: 'GITHUB_CI',
      id: 'GITHUB_CI_STATUS_MISSING',
      message: 'GitHub CI 차단 상태를 확인할 수 없어 실행을 차단합니다.',
      blocking: true,
    }];
  }
  return blockers as CanaryBlocker[];
}
