/**
 * #124 Canary blocker — signer gas 0 ETH (GMX API v2) + USDC allowance authoritative 파라미터.
 *
 * A) checkLiveTestGate: submitPath='gmx_api_v2'이면 signer ETH 0에서도 통과 (다른 게이트는 불변),
 *    legacy_broadcast/미지정(fail-closed 기본)이면 MIN_ETH 요구 유지.
 * B) buildCanaryAllowanceInfo: pinned SDK/canonical 교차검증 실패 시 verified=false + spender 미노출,
 *    금액은 항상 정확히 15 USDC(15_000_000 units).
 */

import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/gmxContracts', () => ({
  USDC_ADDRESS: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  ARB_ADDRESS:  '0x912CE59144191C1204E64559FE8253a0e49E6548',
}));

beforeAll(() => { process.env.LIVE_TEST_EXECUTION_LOCKED = 'false'; });
afterAll(()  => { delete process.env.LIVE_TEST_EXECUTION_LOCKED; });

import { checkLiveTestGate } from '../lib/liveTestGate';
import type { GateInput } from '../lib/liveTestGate';
import type { DelegationStatus } from '../lib/gmxSubaccount';
import {
  buildCanaryAllowanceInfo,
  resolveSdkSyntheticsRouter,
  isExpectedCanarySigner,
  CANARY_ALLOWANCE_AMOUNT_UNITS,
  PINNED_SYNTHETICS_ROUTER,
  PINNED_CANONICAL_USDC,
  EXPECTED_CANARY_SIGNER,
} from '../lib/canaryAllowanceInfo';

const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const MAIN = '0x46c27887c5EC5E36b2a21E1Ec1BC69e7a593950e';

function validDelegation(overrides?: Partial<DelegationStatus>): DelegationStatus {
  return {
    isAuthorized:     true,
    remainingActions: 5,
    expiresAtUnix:    Math.floor(Date.now() / 1000) + 3600,
    isExpired:        false,
    queryOk:          true,
    mainAddress:      '0xMainAddr12345678901234567890123456789',
    signerAddress:    '0xSignerAddr1234567890123456789012345678',
    ...overrides,
  };
}

function validInput(overrides?: Partial<GateInput>): GateInput {
  return {
    orderType:         'open',
    collateralToken:   USDC,
    sizeUsd:           10,
    collateralUsd:     5,
    leverage:          2,
    accumLossUsd:      0,
    openPositionCount: 0,
    dbOk:              true,
    rpcOk:             true,
    reconciled:        true,
    signerEthWei:      0n, // ETH 0 — v2 경로에서는 무관해야 함
    delegation:        validDelegation(),
    submitPath:        'gmx_api_v2',
    ...overrides,
  };
}

describe('#124-A checkLiveTestGate — GMX API v2 signer gas 0 ETH', () => {
  it('gmx_api_v2 + signer ETH 0 → allowed=true, signerHasGas=true', () => {
    const r = checkLiveTestGate(validInput());
    expect(r.allowed).toBe(true);
    expect(r.checks.signerHasGas).toBe(true);
  });

  it('legacy_broadcast + signer ETH 0 → 차단 (ETH 요구 유지)', () => {
    const r = checkLiveTestGate(validInput({ submitPath: 'legacy_broadcast' }));
    expect(r.allowed).toBe(false);
    expect(r.checks.signerHasGas).toBe(false);
    expect(r.reason).toContain('ETH 부족');
  });

  it('submitPath 미지정 → fail-closed 기본 legacy_broadcast, ETH 0 차단', () => {
    const input = validInput();
    delete (input as Partial<GateInput>).submitPath;
    const r = checkLiveTestGate(input);
    expect(r.allowed).toBe(false);
    expect(r.checks.signerHasGas).toBe(false);
  });

  it('legacy_broadcast + 충분한 ETH(0.005) → 기존과 동일하게 통과', () => {
    const r = checkLiveTestGate(validInput({ submitPath: 'legacy_broadcast', signerEthWei: 5_000_000_000_000_000n }));
    expect(r.allowed).toBe(true);
  });

  // 다른 게이트 불변 — v2 경로가 signer gas 외 어떤 것도 완화하지 않는다
  it('gmx_api_v2에서도 위임 비활성은 여전히 차단', () => {
    const r = checkLiveTestGate(validInput({ delegation: validDelegation({ isAuthorized: false }) }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('위임');
  });

  it('gmx_api_v2에서도 DB 실패는 여전히 fail-closed', () => {
    const r = checkLiveTestGate(validInput({ dbOk: false }));
    expect(r.allowed).toBe(false);
  });

  it('gmx_api_v2에서도 코드 수준 잠금은 여전히 차단', () => {
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'true';
    const r = checkLiveTestGate(validInput());
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('LIVE_TEST_EXECUTION_LOCKED');
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
  });

  it('gmx_api_v2에서도 reconciliation 미완료는 여전히 차단', () => {
    const r = checkLiveTestGate(validInput({ reconciled: false }));
    expect(r.allowed).toBe(false);
  });
});

describe('#124-B buildCanaryAllowanceInfo — 교차검증 fail-closed', () => {
  const good = {
    sdkRouter: PINNED_SYNTHETICS_ROUTER,
    usdcAddress: PINNED_CANONICAL_USDC,
    mainAddress: MAIN,
    allowanceUnits: 0n,
  };

  it('pinned SDK 런타임 해석값이 pinned 상수와 일치', () => {
    const resolved = resolveSdkSyntheticsRouter();
    expect(resolved).not.toBeNull();
    expect(resolved!.toLowerCase()).toBe(PINNED_SYNTHETICS_ROUTER.toLowerCase());
  });

  it('전부 일치 → verified=true, spender 노출, 금액 정확히 15 USDC', () => {
    const info = buildCanaryAllowanceInfo(good);
    expect(info.verified).toBe(true);
    expect(info.spenderAddress).toBe(PINNED_SYNTHETICS_ROUTER);
    expect(info.amountUnits).toBe('15000000');
    expect(CANARY_ALLOWANCE_AMOUNT_UNITS).toBe(15_000_000n);
    expect(info.chainId).toBe(42161);
    expect(info.usdcAddress).toBe(PINNED_CANONICAL_USDC);
  });

  it('SDK router 해석 실패(null) → verified=false, spender 미노출', () => {
    const info = buildCanaryAllowanceInfo({ ...good, sdkRouter: null });
    expect(info.verified).toBe(false);
    expect(info.spenderAddress).toBeNull();
    expect(info.reasons.join(' ')).toContain('해석 실패');
  });

  it('SDK router가 pinned와 불일치 → verified=false (스푸핑 차단)', () => {
    const info = buildCanaryAllowanceInfo({ ...good, sdkRouter: '0x' + '11'.repeat(20) });
    expect(info.verified).toBe(false);
    expect(info.spenderAddress).toBeNull();
  });

  it('USDC 주소 불일치 → verified=false', () => {
    const info = buildCanaryAllowanceInfo({ ...good, usdcAddress: '0x' + '22'.repeat(20) });
    expect(info.verified).toBe(false);
    // 응답 usdcAddress는 항상 canonical 상수만 노출 (오염 주소 미전파)
    expect(info.usdcAddress).toBe(PINNED_CANONICAL_USDC);
  });

  it('main wallet 미설정 → verified=false, mainAddress null', () => {
    const info = buildCanaryAllowanceInfo({ ...good, mainAddress: null });
    expect(info.verified).toBe(false);
    expect(info.mainAddress).toBeNull();
  });

  it('allowance 조회 실패(null) → allowanceUnits null (0으로 위장 금지), verified에는 영향 없음', () => {
    const info = buildCanaryAllowanceInfo({ ...good, allowanceUnits: null });
    expect(info.allowanceUnits).toBeNull();
    expect(info.verified).toBe(true);
  });

  it('금액은 입력과 무관하게 항상 15000000 고정 (unlimited 불가)', () => {
    const info = buildCanaryAllowanceInfo(good);
    expect(BigInt(info.amountUnits)).toBe(15_000_000n);
    expect(BigInt(info.amountUnits) < (1n << 256n) - 1n).toBe(true);
  });
});

describe('#124-C isExpectedCanarySigner — 서버 측 prepare 강제 헬퍼', () => {
  it('정확 일치(대소문자 무시)만 허용', () => {
    expect(isExpectedCanarySigner(EXPECTED_CANARY_SIGNER)).toBe(true);
    expect(isExpectedCanarySigner(EXPECTED_CANARY_SIGNER.toLowerCase())).toBe(true);
    expect(isExpectedCanarySigner(EXPECTED_CANARY_SIGNER.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('불일치/null/undefined/빈 문자열 → 차단', () => {
    expect(isExpectedCanarySigner('0x' + 'ab'.repeat(20))).toBe(false);
    expect(isExpectedCanarySigner(null)).toBe(false);
    expect(isExpectedCanarySigner(undefined)).toBe(false);
    expect(isExpectedCanarySigner('')).toBe(false);
  });
});

describe('#124 회귀 — signer ETH 충전 안내 문구 부재', () => {
  it('livetest 라우트 소스에 signer 충전 유도 문구가 없다', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../routes/livetest.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/0\.02 ETH 이상을.*전송하면 주문 실행/);
    expect(src).not.toMatch(/사이너 지갑에 가스비 충전/);
    expect(src).toContain('GMX_API_V2_ZERO_ETH');
  });
});
