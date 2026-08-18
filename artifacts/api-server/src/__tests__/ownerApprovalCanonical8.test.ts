/**
 * ownerApprovalCanonical8 — 운영자 승인(2026-08-18): canonical maxAllowedCount 2→8.
 *
 * 근거: action budget 감사 — OPEN 전 필요 예산 requiredActionsBeforeOpen()=6
 * (최악 경로 5 + 비상 예약 1) + 비상 정리 여유 2회 = 8.
 *
 * 계약:
 *  - 서버 prepare는 클라이언트 요청값을 신뢰하지 않고 항상 canonical 8 생성
 *  - GMX API echo가 정확히 8이 아니면(2/5/6/9 등) 변조로 간주해 fail-closed 거부
 *  - expiresAt 최대 1시간 · 서명 deadline 10분 상한 유지
 *  - LIVE 안전 게이트(잠금·주문 제출 비활성)는 본 변경과 무관하게 불변
 */
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { APPROVAL_LIMITS } from '../lib/ownerApprovalSession';
import { validateGmxPreparedApproval } from '../lib/gmxApiApproval';
import { requiredActionsBeforeOpen, WORST_PATH_ACTIONS, RESERVED_EMERGENCY_ACTIONS } from '../lib/actionBudget';
import {
  GMX_RELAY_DOMAIN_NAME, GMX_RELAY_DOMAIN_VERSION,
} from '../lib/gmxEip712';

const GMX_API_CHAIN_ID = 42161;
const MAIN = '0x46c27887c5EC5E36b2a21E1Ec1BC69e7a593950e' as Address;
const SUB = '0xc56436F09039E15Aa2244659d0fC5b7f706DdbF6' as Address;
const ROUTER = '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6' as Address;
const NOW = 1_800_000_000n;

function approvalRaw(msgOverrides?: Record<string, unknown>) {
  return {
    typedData: {
      domain: {
        name: GMX_RELAY_DOMAIN_NAME, version: GMX_RELAY_DOMAIN_VERSION,
        chainId: GMX_API_CHAIN_ID, verifyingContract: ROUTER,
      },
      types: { SubaccountApproval: [{ name: 'subaccount', type: 'address' }] },
      message: {
        subaccount: SUB, shouldAdd: true, expiresAt: String(NOW + 3600n),
        maxAllowedCount: '8', actionType: `0x${'aa'.repeat(32)}`, nonce: '7',
        desChainId: '42161', deadline: String(NOW + 600n), integrationId: `0x${'bb'.repeat(32)}`,
        ...msgOverrides,
      },
    },
  };
}
const expected = {
  mainAccount: MAIN, subaccount: SUB,
  verifyingContract: ROUTER, canonicalNonce: 7n, nowSec: NOW,
};

describe('canonical maxAllowedCount = 8 (승인 정책)', () => {
  it('정책 상수: canonical 8 · 허용 범위 1~10 내', () => {
    expect(APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT).toBe(8n);
    expect(APPROVAL_LIMITS.DEFAULT_MAX_ALLOWED_COUNT).toBe(8n);
    expect(APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT >= APPROVAL_LIMITS.MIN_MAX_ALLOWED_COUNT).toBe(true);
    expect(APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT <= APPROVAL_LIMITS.MAX_MAX_ALLOWED_COUNT).toBe(true);
  });

  it('action budget 결속: 8 = requiredActionsBeforeOpen(6) + 비상 정리 여유 2', () => {
    expect(requiredActionsBeforeOpen()).toBe(6);
    expect(WORST_PATH_ACTIONS).toBe(5);
    expect(RESERVED_EMERGENCY_ACTIONS).toBe(1);
    expect(Number(APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT)).toBe(requiredActionsBeforeOpen() + 2);
    // OPEN 전 최소 예산 6 충족 (여유 포함)
    expect(Number(APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT)).toBeGreaterThanOrEqual(requiredActionsBeforeOpen());
  });

  it('expiry 최대 1시간 · deadline 10분 상한 불변', () => {
    expect(APPROVAL_LIMITS.MAX_EXPIRY_SECONDS).toBe(3600);
    expect(APPROVAL_LIMITS.DEFAULT_EXPIRY_SECONDS).toBe(3600);
    expect(APPROVAL_LIMITS.SIGNATURE_DEADLINE_SECONDS).toBe(600);
  });
});

describe('validateGmxPreparedApproval — canonical 8 정확 일치 강제', () => {
  it('echo=8 → ok (digest 서버 재계산)', () => {
    const r = validateGmxPreparedApproval({ raw: approvalRaw(), expected });
    expect(r.ok).toBe(true);
  });

  it.each(['2', '5', '6', '9', '1', '10', '0'])('echo=%s → 변조로 거부 (fail-closed)', (v) => {
    const r = validateGmxPreparedApproval({ raw: approvalRaw({ maxAllowedCount: v }), expected });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toContain('canonical');
  });

  it('expiry 1시간 초과 → 거부', () => {
    const r = validateGmxPreparedApproval({ raw: approvalRaw({ expiresAt: String(NOW + 7200n) }), expected });
    expect(r.ok).toBe(false);
  });

  it('deadline 10분 초과 → 거부', () => {
    const r = validateGmxPreparedApproval({ raw: approvalRaw({ deadline: String(NOW + 601n) }), expected });
    expect(r.ok).toBe(false);
  });

  it('expiresAt/deadline 과거 → 거부', () => {
    expect(validateGmxPreparedApproval({ raw: approvalRaw({ expiresAt: String(NOW - 1n) }), expected }).ok).toBe(false);
    expect(validateGmxPreparedApproval({ raw: approvalRaw({ deadline: String(NOW - 1n) }), expected }).ok).toBe(false);
  });
});
