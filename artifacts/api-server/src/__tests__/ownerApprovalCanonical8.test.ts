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
import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

// CI는 db-free — ownerApprovalSession의 @workspace/db import를 stub (본 테스트는 상수·검증기만 사용)
vi.mock('@workspace/db', () => ({
  db: {},
  subaccountApprovalSessionsTable: {},
}));

import { APPROVAL_LIMITS } from '../lib/ownerApprovalSession';
import { validateGmxPreparedApproval, buildGmxPrepareRequestBody } from '../lib/gmxApiApproval';
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

  it('#130 — API echo deadline=expiresAt(1h) 허용, 최종 메시지 deadline은 10분으로 clamp', () => {
    const r = validateGmxPreparedApproval({ raw: approvalRaw({ deadline: String(NOW + 3600n), expiresAt: String(NOW + 3600n) }), expected });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.deadline).toBe(NOW + BigInt(APPROVAL_LIMITS.SIGNATURE_DEADLINE_SECONDS));
  });

  it('#130 — echo deadline이 10분 이내면 그대로 사용 (clamp 미적용)', () => {
    const r = validateGmxPreparedApproval({ raw: approvalRaw({ deadline: String(NOW + 300n) }), expected });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.deadline).toBe(NOW + 300n);
  });

  it('deadline이 expiry 상한(1h) 초과 → 거부', () => {
    const r = validateGmxPreparedApproval({ raw: approvalRaw({ deadline: String(NOW + 3601n), expiresAt: String(NOW + 3600n) }), expected });
    expect(r.ok).toBe(false);
  });

  it('deadline > expiresAt → API echo 비정상으로 거부', () => {
    const r = validateGmxPreparedApproval({ raw: approvalRaw({ deadline: String(NOW + 3600n), expiresAt: String(NOW + 1800n) }), expected });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toContain('deadline > expiresAt');
  });

  it('expiresAt/deadline 과거 → 거부', () => {
    expect(validateGmxPreparedApproval({ raw: approvalRaw({ expiresAt: String(NOW - 1n) }), expected }).ok).toBe(false);
    expect(validateGmxPreparedApproval({ raw: approvalRaw({ deadline: String(NOW - 1n) }), expected }).ok).toBe(false);
  });
});

describe('#130 — buildGmxPrepareRequestBody 공식 스키마 계약', () => {
  const body = buildGmxPrepareRequestBody({ account: MAIN, subaccountAddress: SUB, nowSec: NOW });

  it('필드 집합이 정확히 공식 스키마 5개 (excess property 회귀 방지)', () => {
    expect(Object.keys(body).sort()).toEqual(['account', 'expiresAt', 'maxAllowedCount', 'shouldAdd', 'subaccountAddress']);
    // 과거 400 원인이었던 초과 필드가 절대 포함되지 않아야 함
    expect(body).not.toHaveProperty('chainId');
    expect(body).not.toHaveProperty('subaccount');
    expect(body).not.toHaveProperty('expirySeconds');
    expect(body).not.toHaveProperty('deadline');
  });

  it('maxAllowedCount는 문자열 "8" (숫자 8은 400 invalid string value)', () => {
    expect(body.maxAllowedCount).toBe('8');
    expect(typeof body.maxAllowedCount).toBe('string');
  });

  it('expiresAt은 절대 unix 초 문자열 = now + 3600', () => {
    expect(body.expiresAt).toBe(String(NOW + 3600n));
    expect(typeof body.expiresAt).toBe('string');
  });

  it('account/subaccountAddress/shouldAdd 결속', () => {
    expect(body.account).toBe(MAIN);
    expect(body.subaccountAddress).toBe(SUB);
    expect(body.shouldAdd).toBe(true);
  });
});
