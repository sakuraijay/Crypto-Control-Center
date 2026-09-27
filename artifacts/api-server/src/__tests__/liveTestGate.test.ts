/**
 * liveTestGate.ts 단위 테스트
 *
 * 실제 온체인 호출 없이 14단계 하드캡 게이트 순수 로직 검증.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.mock('../lib/gmxContracts', () => ({
  USDC_ADDRESS: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  ARB_ADDRESS:  '0x912CE59144191C1204E64559FE8253a0e49E6548',
}));

// LIVE_TEST_EXECUTION_LOCKED=false 로 게이트 1(잠금) 통과
beforeAll(() => { process.env.LIVE_TEST_EXECUTION_LOCKED = 'false'; });
afterAll(()  => { delete process.env.LIVE_TEST_EXECUTION_LOCKED; });

import { checkLiveTestGate, isLiveTestExecutionLocked, LIVE_TEST_CAPS } from '../lib/liveTestGate';
import type { GateInput } from '../lib/liveTestGate';
import type { DelegationStatus } from '../lib/gmxSubaccount';

// ── 기본 통과 조건 픽스처 ──────────────────────────────────────────────────────

const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ARB  = '0x912CE59144191C1204E64559FE8253a0e49E6548';

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
    signerEthWei:      BigInt('5000000000000000'), // 0.005 ETH
    delegation:        validDelegation(),
    ...overrides,
  };
}

// ── 테스트 ──────────────────────────────────────────────────────────────────

describe('isLiveTestExecutionLocked', () => {
  it('LIVE_TEST_EXECUTION_LOCKED=false 이면 unlocked', () => {
    expect(isLiveTestExecutionLocked()).toBe(false);
  });

  it('환경변수 unset 이면 locked', () => {
    delete process.env.LIVE_TEST_EXECUTION_LOCKED;
    expect(isLiveTestExecutionLocked()).toBe(true);
    process.env.LIVE_TEST_EXECUTION_LOCKED = 'false'; // restore
  });
});

describe('checkLiveTestGate — 통과 조건', () => {
  it('모든 조건 충족 시 allowed=true', () => {
    const result = checkLiveTestGate(validInput());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });
});

describe('checkLiveTestGate — 차단 조건', () => {
  it('DB 쿼리 실패 → fail-closed', () => {
    const result = checkLiveTestGate(validInput({ dbOk: false }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/DB/);
  });

  it('RPC 실패 → fail-closed', () => {
    const result = checkLiveTestGate(validInput({ rpcOk: false }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/RPC/);
  });

  it('reconciliation 미완료 → 차단', () => {
    const result = checkLiveTestGate(validInput({ reconciled: false }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/reconciliation|재시작/);
  });

  it('delegation.queryOk=false → 차단 (위임 조회 실패)', () => {
    const result = checkLiveTestGate(validInput({
      delegation: validDelegation({ queryOk: false }),
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/위임/);
  });

  it('isAuthorized=false (만료 아님) → 차단', () => {
    const result = checkLiveTestGate(validInput({
      delegation: validDelegation({ isAuthorized: false, isExpired: false }),
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/위임/);
  });

  it('isExpired=true → 만료 메시지', () => {
    const result = checkLiveTestGate(validInput({
      delegation: validDelegation({ isAuthorized: false, isExpired: true }),
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/만료/);
  });

  it('remainingActions=0 → 차단', () => {
    const result = checkLiveTestGate(validInput({
      delegation: validDelegation({ remainingActions: 0 }),
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/액션/);
  });

  it('signerEthWei 부족 → 차단', () => {
    const result = checkLiveTestGate(validInput({
      signerEthWei: BigInt('1000000000000000'), // 0.001 ETH (< 0.003 ETH)
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/사이너|ETH/);
  });

  it('포지션 수 >= 1 && orderType=open → 차단', () => {
    const result = checkLiveTestGate(validInput({ openPositionCount: 1, orderType: 'open' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/포지션/);
  });

  it('포지션 수 >= 1 && orderType=close → 통과', () => {
    const result = checkLiveTestGate(validInput({ openPositionCount: 1, orderType: 'close' }));
    expect(result.allowed).toBe(true);
  });

  it('누적 손실 >= $3 → 차단', () => {
    const result = checkLiveTestGate(validInput({ accumLossUsd: 3 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/손실/);
  });

  it('누적 손실 < $3 → 통과', () => {
    const result = checkLiveTestGate(validInput({ accumLossUsd: 2.99 }));
    expect(result.allowed).toBe(true);
  });

  it('USDC 이외 담보 → 차단', () => {
    const result = checkLiveTestGate(validInput({ collateralToken: ARB }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/USDC|담보/);
  });

  it('ARB 심볼 → 차단', () => {
    const result = checkLiveTestGate(validInput({ symbol: 'ARB' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/ARB/);
  });

  it('leverage > 2 → 차단', () => {
    const result = checkLiveTestGate(validInput({ leverage: 3 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/레버리지/);
  });

  it('sizeUsd > $15 → 차단', () => {
    const result = checkLiveTestGate(validInput({ sizeUsd: 16 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/크기|포지션/);
  });

  it('collateralUsd > $15 → 차단', () => {
    const result = checkLiveTestGate(validInput({ collateralUsd: 16 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/담보/);
  });
});

describe('LIVE_TEST_CAPS 상수 불변성', () => {
  it('하드캡 값이 정확하다', () => {
    expect(LIVE_TEST_CAPS.maxCapitalUsd).toBe(15);
    expect(LIVE_TEST_CAPS.maxLossUsd).toBe(3);
    expect(LIVE_TEST_CAPS.maxPositions).toBe(1);
    expect(LIVE_TEST_CAPS.maxLeverage).toBe(2);
    expect(LIVE_TEST_CAPS.maxActions).toBe(10);
    expect(LIVE_TEST_CAPS.validHours).toBe(24);
  });
});
