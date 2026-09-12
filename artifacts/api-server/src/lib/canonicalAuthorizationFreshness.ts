import type { CanonicalSnapshot } from './relayActivationStatus';

/**
 * Controlled Canary에서 canonical authorization readback을 실행 근거로 인정하는 최대 age.
 * 수동 preflight와 실제 OPEN 직전 activation gate가 동일 값을 사용한다.
 */
export const CANONICAL_AUTHORIZATION_FRESHNESS_MS = 60_000;

export type CanonicalAuthorizationFreshness =
  | { ok: true; ageMs: number }
  | { ok: false; detail: string };

/**
 * 저장된 canonical readback의 시각 증거만 검증한다.
 * 외부 RPC/서명/prepare/submit은 수행하지 않으며, 누락·비정상·미래·stale은 전부 fail-closed.
 */
export function evaluateCanonicalAuthorizationFreshness(
  snapshot: CanonicalSnapshot | null,
  nowMs: number,
): CanonicalAuthorizationFreshness {
  if (!snapshot) {
    return { ok: false, detail: 'canonical API v2 readback 없음 — freshness 검증 불가 (fail-closed)' };
  }
  if (!Number.isFinite(nowMs) || nowMs <= 0) {
    return { ok: false, detail: '현재 시각 비정상 — canonical freshness 검증 불가 (fail-closed)' };
  }

  const atMs = snapshot.atMs;
  if (!Number.isFinite(atMs) || !Number.isInteger(atMs) || atMs <= 0) {
    return { ok: false, detail: 'canonical readback 시각 누락/비정상 — OPEN 차단 (fail-closed)' };
  }
  if (atMs > nowMs) {
    return { ok: false, detail: 'canonical readback 시각이 현재보다 미래 — OPEN 차단 (fail-closed)' };
  }

  const ageMs = nowMs - atMs;
  if (ageMs > CANONICAL_AUTHORIZATION_FRESHNESS_MS) {
    return {
      ok: false,
      detail: `canonical readback stale (${ageMs}ms > ${CANONICAL_AUTHORIZATION_FRESHNESS_MS}ms) — readiness refresh 필요`,
    };
  }

  return { ok: true, ageMs };
}
