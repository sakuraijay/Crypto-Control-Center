/**
 * #124 Canary — USDC allowance 카드 순수 헬퍼 adversarial 테스트.
 *
 * 잘못된 chain/account/token/spender/금액/unlimited/receipt reverted/readback 부족/
 * 중복 클릭 전부 fail-closed. approve 금액은 정확히 15 USDC만 구성 가능.
 */

import { describe, expect, it } from 'vitest';
import {
  canAttemptCanaryApprove, buildCanaryApproveCalldata, isExactCanaryApproveCalldata,
  evaluateApproveCompletion, formatAllowanceUnits, isExpectedCanarySigner,
  CANARY_APPROVE_AMOUNT_UNITS, EXPECTED_CANARY_SIGNER, ERC20_APPROVE_SELECTOR, UINT256_MAX,
  type CanaryAllowanceServerInfo,
} from '../canaryAllowance';

const SPENDER = '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const MAIN = '0x46c27887c5EC5E36b2a21E1Ec1BC69e7a593950e';

function goodServer(overrides?: Partial<CanaryAllowanceServerInfo>): CanaryAllowanceServerInfo {
  return {
    ok: true, verified: true, reasons: [], chainId: 42161,
    usdcAddress: USDC, spenderAddress: SPENDER, amountUnits: '15000000',
    mainAddress: MAIN, allowanceUnits: '0',
    ...overrides,
  };
}

function goodWallet() {
  return {
    walletStatus: 'connected',
    walletAddress: MAIN,
    walletChainId: 42161,
    isArbitrum: true,
    busy: false,
  };
}

describe('canAttemptCanaryApprove — adversarial fail-closed', () => {
  it('전부 정상 → ok', () => {
    expect(canAttemptCanaryApprove({ server: goodServer(), ...goodWallet() }).ok).toBe(true);
  });

  it('서버 응답 없음/실패 → 차단', () => {
    expect(canAttemptCanaryApprove({ server: null, ...goodWallet() }).ok).toBe(false);
    expect(canAttemptCanaryApprove({ server: goodServer({ ok: false }), ...goodWallet() }).ok).toBe(false);
  });

  it('verified=false → 차단 (spender 노출돼도 무시)', () => {
    const g = canAttemptCanaryApprove({ server: goodServer({ verified: false, reasons: ['교차검증 실패'] }), ...goodWallet() });
    expect(g.ok).toBe(false);
  });

  it('잘못된 chainId(서버/지갑) → 차단', () => {
    expect(canAttemptCanaryApprove({ server: goodServer({ chainId: 1 }), ...goodWallet() }).ok).toBe(false);
    expect(canAttemptCanaryApprove({ server: goodServer(), ...goodWallet(), walletChainId: 1, isArbitrum: false }).ok).toBe(false);
    // isArbitrum true인데 chainId가 42161이 아니면(상태 불일치) 여전히 차단
    expect(canAttemptCanaryApprove({ server: goodServer(), ...goodWallet(), walletChainId: 421614 }).ok).toBe(false);
  });

  it('잘못된 token/spender 형식 → 차단', () => {
    expect(canAttemptCanaryApprove({ server: goodServer({ usdcAddress: '0x123' }), ...goodWallet() }).ok).toBe(false);
    expect(canAttemptCanaryApprove({ server: goodServer({ spenderAddress: null }), ...goodWallet() }).ok).toBe(false);
    expect(canAttemptCanaryApprove({ server: goodServer({ spenderAddress: 'not-an-address' }), ...goodWallet() }).ok).toBe(false);
  });

  it('금액이 15 USDC가 아니면 차단 (unlimited 포함)', () => {
    expect(canAttemptCanaryApprove({ server: goodServer({ amountUnits: '16000000' }), ...goodWallet() }).ok).toBe(false);
    expect(canAttemptCanaryApprove({ server: goodServer({ amountUnits: UINT256_MAX.toString() }), ...goodWallet() }).ok).toBe(false);
    expect(canAttemptCanaryApprove({ server: goodServer({ amountUnits: '0' }), ...goodWallet() }).ok).toBe(false);
  });

  it('MetaMask 계정 ≠ main wallet → 차단 (대소문자 무시 일치만 허용)', () => {
    expect(canAttemptCanaryApprove({ server: goodServer(), ...goodWallet(), walletAddress: '0x' + 'ab'.repeat(20) }).ok).toBe(false);
    expect(canAttemptCanaryApprove({ server: goodServer(), ...goodWallet(), walletAddress: null }).ok).toBe(false);
    // 대소문자만 다른 동일 주소는 허용
    expect(canAttemptCanaryApprove({ server: goodServer(), ...goodWallet(), walletAddress: MAIN.toLowerCase() }).ok).toBe(true);
  });

  it('지갑 미연결 → 차단', () => {
    expect(canAttemptCanaryApprove({ server: goodServer(), ...goodWallet(), walletStatus: 'disconnected' }).ok).toBe(false);
  });

  it('busy(진행 중) → 중복 클릭 차단', () => {
    expect(canAttemptCanaryApprove({ server: goodServer(), ...goodWallet(), busy: true }).ok).toBe(false);
  });
});

describe('buildCanaryApproveCalldata — 정확히 15 USDC만', () => {
  it('올바른 approve(spender, 15e6) calldata 생성', () => {
    const data = buildCanaryApproveCalldata(SPENDER)!;
    expect(data.startsWith(ERC20_APPROVE_SELECTOR)).toBe(true);
    expect(data.length).toBe(10 + 64 + 64);
    // spender 인자
    expect(data.slice(10, 74)).toBe(SPENDER.slice(2).toLowerCase().padStart(64, '0'));
    // amount 인자 = 정확히 15_000_000 (0xe4e1c0)
    expect(BigInt('0x' + data.slice(74))).toBe(CANARY_APPROVE_AMOUNT_UNITS);
  });

  it('금액 인자를 받지 않으므로 unlimited calldata는 구성 불가 — max 값은 절대 미포함', () => {
    const data = buildCanaryApproveCalldata(SPENDER)!;
    expect(data.includes('f'.repeat(64))).toBe(false);
    expect(BigInt('0x' + data.slice(74)) < UINT256_MAX).toBe(true);
  });

  it('spender 형식 오류 → null (fail-closed)', () => {
    expect(buildCanaryApproveCalldata('0x123')).toBeNull();
    expect(buildCanaryApproveCalldata('')).toBeNull();
  });

  it('isExactCanaryApproveCalldata — 변조된 calldata 거부', () => {
    const data = buildCanaryApproveCalldata(SPENDER)!;
    expect(isExactCanaryApproveCalldata(data, SPENDER)).toBe(true);
    // 금액 1 unit 변조 → 거부
    const tampered = data.slice(0, -1) + (data.endsWith('0') ? '1' : '0');
    expect(isExactCanaryApproveCalldata(tampered, SPENDER)).toBe(false);
    // unlimited로 변조 → 거부
    const unlimited = data.slice(0, 74) + 'f'.repeat(64);
    expect(isExactCanaryApproveCalldata(unlimited, SPENDER)).toBe(false);
  });
});

describe('evaluateApproveCompletion — receipt+readback 이중 확인', () => {
  it('receipt success + readback ≥15 → complete', () => {
    expect(evaluateApproveCompletion({ receiptStatus: '0x1', allowanceReadbackUnits: '15000000' })).toBe('complete');
    expect(evaluateApproveCompletion({ receiptStatus: '0x1', allowanceReadbackUnits: '20000000' })).toBe('complete');
  });

  it('receipt reverted(0x0) → not_complete', () => {
    expect(evaluateApproveCompletion({ receiptStatus: '0x0', allowanceReadbackUnits: '15000000' })).toBe('not_complete');
  });

  it('receipt 불명확(null/이상값) → not_complete (fail-closed)', () => {
    expect(evaluateApproveCompletion({ receiptStatus: null, allowanceReadbackUnits: '15000000' })).toBe('not_complete');
    expect(evaluateApproveCompletion({ receiptStatus: 'success', allowanceReadbackUnits: '15000000' })).toBe('not_complete');
  });

  it('readback 부족/실패 → not_complete', () => {
    expect(evaluateApproveCompletion({ receiptStatus: '0x1', allowanceReadbackUnits: '14999999' })).toBe('not_complete');
    expect(evaluateApproveCompletion({ receiptStatus: '0x1', allowanceReadbackUnits: null })).toBe('not_complete');
    expect(evaluateApproveCompletion({ receiptStatus: '0x1', allowanceReadbackUnits: 'garbage' })).toBe('not_complete');
  });
});

describe('formatAllowanceUnits', () => {
  it('정상 변환 및 실패 표시', () => {
    expect(formatAllowanceUnits('15000000')).toBe('15.00 USDC');
    expect(formatAllowanceUnits('0')).toBe('0.00 USDC');
    expect(formatAllowanceUnits('12345678')).toBe('12.34 USDC');
    expect(formatAllowanceUnits(null)).toBe('조회 실패');
    expect(formatAllowanceUnits('not-a-number')).toBe('조회 실패');
  });
});

describe('#124-C isExpectedCanarySigner — Prepare 게이트', () => {
  it('정확 일치(대소문자 무시)만 허용', () => {
    expect(isExpectedCanarySigner(EXPECTED_CANARY_SIGNER)).toBe(true);
    expect(isExpectedCanarySigner(EXPECTED_CANARY_SIGNER.toLowerCase())).toBe(true);
  });

  it('불일치/null/undefined → 차단', () => {
    expect(isExpectedCanarySigner('0x' + 'ab'.repeat(20))).toBe(false);
    expect(isExpectedCanarySigner(null)).toBe(false);
    expect(isExpectedCanarySigner(undefined)).toBe(false);
    expect(isExpectedCanarySigner('')).toBe(false);
  });
});
