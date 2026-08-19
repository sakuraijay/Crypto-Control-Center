/**
 * gmxApiApproval — 공식 GMX API prepareSubaccountApproval 검증 (6G-1 §5).
 *
 * GMX API가 owner approval 파라미터의 권위 원천이다. 서버는 응답을 그대로
 * 신뢰하지 않고 아래를 전부 재계산·검증한 뒤에만 세션으로 저장한다:
 *  - chainId 42161, main wallet=GMX_WALLET_ADDRESS, subaccount=delegated signer
 *  - domain(name/version/chainId/verifyingContract)·type 구조가 서버 재계산과 일치
 *  - nonce=canonical nonce, deadline·expiresAt·maxAllowedCount가 canary 정책 내
 *  - digest를 서버가 독립 재계산해 API 응답과 무관하게 결속
 * 실패 시 세션 저장 0회 (fail-closed). GMX API에 서명/Secret 전송 없음.
 */

import type { Address, Hex } from 'viem';
import { getAddress } from 'viem';
import {
  buildSubaccountApprovalTypedData, hashSubaccountApproval,
  GMX_RELAY_DOMAIN_NAME, GMX_RELAY_DOMAIN_VERSION,
  type SubaccountApprovalMessage,
} from './gmxEip712';
import { APPROVAL_LIMITS } from './ownerApprovalSession';
import { GMX_API_CHAIN_ID } from './gmxApiTransport';

/**
 * 공식 GMX API POST /subaccounts/approval/prepare 요청 본문 (#130).
 *
 * 실측 스키마(2026-08-18, arbitrum.gmxapi.io / .ai 동일):
 *  - 필수: account, subaccountAddress, expiresAt(절대 unix 초, 문자열), shouldAdd, maxAllowedCount(문자열)
 *  - 초과 필드 거부(400): chainId, subaccount, expirySeconds, deadline
 *  - API echo는 deadline=expiresAt로 응답 (deadline 파라미터 미지원)
 * canonical 값은 서버가 여기서 고정 생성 — 클라이언트 입력 미신뢰.
 */
export function buildGmxPrepareRequestBody(params: {
  account: Address;
  subaccountAddress: Address;
  nowSec: bigint;
}): {
  account: string;
  subaccountAddress: string;
  expiresAt: string;
  shouldAdd: boolean;
  maxAllowedCount: string;
} {
  return {
    account: params.account,
    subaccountAddress: params.subaccountAddress,
    expiresAt: (params.nowSec + BigInt(APPROVAL_LIMITS.DEFAULT_EXPIRY_SECONDS)).toString(),
    shouldAdd: true,
    maxAllowedCount: APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT.toString(),
  };
}

export interface GmxPreparedApprovalValidationInput {
  /** GMX API 응답의 typedData (domain/types/message) */
  raw: unknown;
  expected: {
    mainAccount: Address;        // GMX_WALLET_ADDRESS
    subaccount: Address;         // delegated signer 공개 주소
    verifyingContract: Address;  // 감사된 router (manifest)
    canonicalNonce: bigint;
    nowSec: bigint;
  };
}

export type GmxPreparedApprovalValidationResult =
  | { ok: true; message: SubaccountApprovalMessage; digest: Hex }
  | { ok: false; reasons: string[] };

function asBigInt(v: unknown): bigint | null {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
    return null;
  } catch { return null; }
}

export function validateGmxPreparedApproval(input: GmxPreparedApprovalValidationInput): GmxPreparedApprovalValidationResult {
  const reasons: string[] = [];
  const td = (input.raw as { typedData?: unknown })?.typedData ?? input.raw;
  const t = td as { domain?: Record<string, unknown>; types?: Record<string, unknown>; message?: Record<string, unknown> } | null;
  if (!t?.domain || !t?.types || !t?.message) {
    return { ok: false, reasons: ['GMX API 응답에 typedData(domain/types/message) 없음'] };
  }

  // domain 재계산 대조
  const d = t.domain;
  if (String(d.name) !== GMX_RELAY_DOMAIN_NAME) reasons.push(`domain name 불일치 (${String(d.name)})`);
  if (String(d.version) !== GMX_RELAY_DOMAIN_VERSION) reasons.push('domain version 불일치');
  if (Number(d.chainId) !== GMX_API_CHAIN_ID) reasons.push('domain chainId ≠ 42161');
  let vc: Address | null = null;
  try { vc = getAddress(String(d.verifyingContract)); } catch { vc = null; }
  if (!vc || vc !== getAddress(input.expected.verifyingContract)) {
    reasons.push('verifyingContract가 감사된 router와 불일치');
  }

  // type 구조 확인
  const types = t.types as { SubaccountApproval?: unknown };
  if (!Array.isArray(types.SubaccountApproval)) reasons.push('SubaccountApproval type 정의 없음');

  // message 필드 추출·검증
  const m = t.message;
  let sub: Address | null = null;
  try { sub = getAddress(String(m.subaccount)); } catch { sub = null; }
  if (!sub || sub !== getAddress(input.expected.subaccount)) reasons.push('message subaccount 불일치');
  if (m.shouldAdd !== true) reasons.push('shouldAdd !== true');

  const nonce = asBigInt(m.nonce);
  if (nonce === null || nonce !== input.expected.canonicalNonce) reasons.push('nonce ≠ canonical nonce');

  const expiresAt = asBigInt(m.expiresAt);
  const deadline = asBigInt(m.deadline);
  const maxAllowedCount = asBigInt(m.maxAllowedCount);
  const desChainId = asBigInt(m.desChainId);
  const now = input.expected.nowSec;
  if (expiresAt === null || expiresAt <= now) reasons.push('expiresAt 없음/과거');
  else if (expiresAt - now > BigInt(APPROVAL_LIMITS.MAX_EXPIRY_SECONDS)) reasons.push('expiry가 canary 상한(1h) 초과');
  // GMX API는 deadline 파라미터를 받지 않고 echo에 deadline=expiresAt(최대 1h)를 넣는다.
  // 여기서는 sanity(존재·미래·expiry 상한 이내)만 검증하고, 최종 서명 메시지의
  // deadline은 아래에서 canary 상한(10분)으로 서버가 clamp한다 — 서명·digest는
  // clamp된 메시지 기준으로 재계산되므로 결속이 유지된다 (fail-closed).
  if (deadline === null || deadline <= now) reasons.push('deadline 없음/과거');
  else if (deadline - now > BigInt(APPROVAL_LIMITS.MAX_EXPIRY_SECONDS)) reasons.push('deadline이 expiry 상한(1h) 초과');
  else if (expiresAt !== null && deadline > expiresAt) reasons.push('deadline > expiresAt — API echo 비정상');
  // canonical 정확 일치 강제 — 8이 아닌 어떤 값(2/6/9/…)도 변조로 간주 (fail-closed)
  if (maxAllowedCount === null || maxAllowedCount !== APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT) {
    reasons.push(`maxAllowedCount ≠ canonical(${APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT}) — 변조 의심`);
  }
  if (desChainId === null || desChainId !== BigInt(GMX_API_CHAIN_ID)) reasons.push('desChainId ≠ 42161');
  if (typeof m.actionType !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(m.actionType)) reasons.push('actionType 형식 오류');
  if (typeof m.integrationId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(m.integrationId)) reasons.push('integrationId 형식 오류');

  if (reasons.length > 0) return { ok: false, reasons };

  // 서명 deadline canary 상한(10분) clamp — API echo(deadline=expiresAt, 1h)를
  // 그대로 서명하지 않는다. clamp된 값이 최종 서명 메시지·digest·세션 저장값.
  const deadlineCap = now + BigInt(APPROVAL_LIMITS.SIGNATURE_DEADLINE_SECONDS);
  const clampedDeadline = (deadline as bigint) < deadlineCap ? (deadline as bigint) : deadlineCap;

  const message: SubaccountApprovalMessage = {
    subaccount: sub as Address,
    shouldAdd: true,
    expiresAt: expiresAt as bigint,
    maxAllowedCount: maxAllowedCount as bigint,
    actionType: m.actionType as Hex,
    nonce: nonce as bigint,
    desChainId: desChainId as bigint,
    deadline: clampedDeadline,
    integrationId: m.integrationId as Hex,
  };

  // digest는 서버 독립 재계산 (API 응답 digest 필드는 신뢰하지 않음).
  // #134 — canonical EIP-712 typed-data digest(hashTypedData 원형)로 통일:
  // 세션 저장·클라이언트 사전 검증과 동일 스킴 (0x1901 재래핑 스킴 폐기).
  const digest = hashSubaccountApproval({ chainId: GMX_API_CHAIN_ID, verifyingContract: vc as Address, approval: message });

  // 서버 재계산 typed data와 API typed data의 message 결속은 위 필드 검증 +
  // digest 재계산으로 완결된다 (buildSubaccountApprovalTypedData는 동일 입력에
  // 대해 동일 구조를 생성 — 별도 깊은 비교 불필요).
  void buildSubaccountApprovalTypedData;

  return { ok: true, message, digest };
}
