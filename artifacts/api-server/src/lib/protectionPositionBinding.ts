export interface ProtectionPositionRequest {
  positionKey: string;
  marketAddress: string;
  isLong: boolean;
  sizeDeltaUsd: number;
}

export interface AuthoritativeProtectionPosition {
  positionKey?: string;
  marketAddress: string;
  collateralToken?: string;
  isLong: boolean;
  sizeUsd: number;
}

export type ProtectionPositionBindingResult =
  | { ok: true; position: AuthoritativeProtectionPosition }
  | { ok: false; reason: string };

/**
 * Protection prepare 직전 exact GMX position binding.
 * position key는 account+market+collateralToken+isLong을 포함하므로 market/side만
 * 일치하는 다른 collateral position으로 대체할 수 없다.
 */
export function bindExactProtectionPosition(
  request: ProtectionPositionRequest,
  positions: AuthoritativeProtectionPosition[],
  expectedCollateralToken: string,
): ProtectionPositionBindingResult {
  if (!/^0x[0-9a-fA-F]{64}$/.test(request.positionKey)
      || !Number.isFinite(request.sizeDeltaUsd) || request.sizeDeltaUsd <= 0) {
    return { ok: false, reason: '보호 요청 position key/size 비정상 — 제출 0회' };
  }
  const exact = positions.filter(
    (p) => p.positionKey?.toLowerCase() === request.positionKey.toLowerCase(),
  );
  if (exact.length !== 1) {
    return { ok: false, reason: `exact position key 일치 ${exact.length}건 — 제출 0회` };
  }
  const pos = exact[0];
  if (pos.marketAddress.toLowerCase() !== request.marketAddress.toLowerCase()
      || pos.isLong !== request.isLong) {
    return { ok: false, reason: 'exact position market/direction 불일치 — 제출 0회' };
  }
  if (!pos.collateralToken
      || pos.collateralToken.toLowerCase() !== expectedCollateralToken.toLowerCase()) {
    return { ok: false, reason: 'exact position collateral token 불일치 — 제출 0회' };
  }
  if (!Number.isFinite(pos.sizeUsd) || pos.sizeUsd <= 0) {
    return { ok: false, reason: 'exact position 현재 size 비정상/0 — 제출 0회' };
  }
  // 두 값은 같은 PositionReader 1e30 정수에서 나온 USD 수치다. JS 변환에 따른
  // 극미 오차만 허용하고, 부분 감소/증가된 포지션에는 stale full-size 주문을 금지한다.
  const tolerance = Math.max(1e-6, request.sizeDeltaUsd * 1e-9);
  if (Math.abs(pos.sizeUsd - request.sizeDeltaUsd) > tolerance) {
    return {
      ok: false,
      reason: `exact position size 변경(current=${pos.sizeUsd}, requested=${request.sizeDeltaUsd}) — 제출 0회`,
    };
  }
  return { ok: true, position: pos };
}