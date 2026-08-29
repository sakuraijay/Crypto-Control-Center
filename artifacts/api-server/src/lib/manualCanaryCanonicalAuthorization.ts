import { evaluateActionBudget } from './actionBudget';
import type { CanonicalSnapshot } from './relayActivationStatus';
import type { CheckOutcome } from './manualCanary';

/**
 * Manual Canary OPEN 전용 canonical delegated-authorization 판정.
 * 저장된 readback만 평가하며 RPC, 서명, prepare, submit을 수행하지 않는다.
 */
export function evaluateManualCanaryCanonicalAuthorization(
  snapshot: CanonicalSnapshot | null,
  nowMs: number,
  inFlightReservedActions: number | null,
): CheckOutcome {
  if (!snapshot) {
    return { ok: false, detail: 'canonical API v2 readback 없음 — readiness refresh 필요 (fail-closed)' };
  }
  if (!snapshot.confirmed) {
    return {
      ok: false,
      detail: snapshot.reason
        ? `canonical API v2 readback 미확인 — ${snapshot.reason} (fail-closed)`
        : 'canonical API v2 readback 미확인 (fail-closed)',
    };
  }
  if (snapshot.isSubaccountListed !== true) {
    return { ok: false, detail: 'canonical API v2 delegated authorization 비활성 — Owner Approval 필요' };
  }
  if (snapshot.featureDisabled !== false || snapshot.integrationDisabled !== false) {
    return { ok: false, detail: 'canonical API v2 delegated authorization feature/integration 상태 미확인·비활성 (fail-closed)' };
  }
  if (
    snapshot.expiresAt === null
    || !/^\d+$/.test(snapshot.expiresAt)
    || BigInt(snapshot.expiresAt) * 1000n <= BigInt(nowMs)
  ) {
    return { ok: false, detail: 'canonical API v2 delegated authorization 만료/만료시각 불명 — OPEN 차단 (fail-closed)' };
  }

  const budget = evaluateActionBudget({
    remaining: snapshot.remaining,
    expiresAt: snapshot.expiresAt,
    nowMs,
    inFlightReservedActions,
  });
  if (!budget.sufficient) {
    return {
      ok: false,
      detail: budget.reasons[0] ?? 'canonical action budget 확인 실패 — OPEN 차단 (fail-closed)',
    };
  }

  return {
    ok: true,
    detail: `canonical API v2 authorization 활성·OPEN 안전 action budget 충족 (remaining ${budget.remainingActions}, required ${budget.requiredActions})`,
  };
}