/**
 * revokeSession — removeSubaccount(revoke) owner 서명 세션 (3단계).
 *
 * 공식 근거: SubaccountGelatoRelayRouter.removeSubaccount는 withRelay
 * isSubaccount=false — **main account(owner)가 서명**한다.
 * typehash: "RemoveSubaccount(address subaccount,bytes32 relayParams)".
 *
 * 이번 단계 범위: 준비 + owner 서명 저장 + dry-run까지. 실제 제출은 없다.
 * REVOKE 세션이 활성(PREPARED/READY)인 동안 신규 주문 relay는 차단된다
 * (relayAdapter.evaluateRelayGate의 activeRevokeSession).
 * canonical에서 subaccount 제거가 확인된 후에만 REVOKED로 마감한다.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { recoverAddress } from 'viem';
import {
  db, subaccountApprovalSessionsTable, type SubaccountApprovalSessionRow,
} from '@workspace/db';
import { buildMinimalRelayParams, type RelayParamsInput } from './gmxEip712';
import {
  computeRemoveSubaccountDigest, buildRemoveSubaccountTypedData,
} from './relayOrderAssembly';
import { ARBITRUM_ONE_CHAIN_ID } from './gmxLiveConfig';
import { encryptSensitiveHex } from './delegatedSigner';
import { SESSION_STATUS } from './ownerApprovalSession';

export const REVOKE_PURPOSE = 'REVOKE';
/** revoke 서명 유효시간 (초) — approval과 동일하게 짧게 유지 */
export const REVOKE_SIGNATURE_DEADLINE_SECONDS = 30 * 60;

export type RevokePrepareResult =
  | { ok: true; sessionId: string; typedData: unknown; digest: Hex; summary: Record<string, string> }
  | { ok: false; reason: string };

function rebuildRelayParams(row: SubaccountApprovalSessionRow): RelayParamsInput | null {
  if (!row.relayFeeToken || row.relayFeeAmount == null || row.relayUserNonce == null) return null;
  return buildMinimalRelayParams({
    feeToken: row.relayFeeToken as Address,
    feeAmount: BigInt(row.relayFeeAmount),
    userNonce: BigInt(row.relayUserNonce),
    deadline: BigInt(row.deadline),
  });
}

/**
 * revoke 세션 준비 — RemoveSubaccount typed data 생성 + durable 저장.
 * 기존 활성 REVOKE 세션은 새 prepare로 대체(INVALIDATED).
 */
export async function prepareRevokeSession(params: {
  mainAccount: Address;
  subaccount: Address;
  verifyingContract: Address;
  feeToken: Address;
  feeAmount: bigint;
  nowSec: bigint;
}): Promise<RevokePrepareResult> {
  const chainId = ARBITRUM_ONE_CHAIN_ID;
  const userNonce = params.nowSec; // 공식 interface 관행: epoch 초
  const deadline = params.nowSec + BigInt(REVOKE_SIGNATURE_DEADLINE_SECONDS);

  const relayParams = buildMinimalRelayParams({
    feeToken: params.feeToken, feeAmount: params.feeAmount, userNonce, deadline,
  });
  const digest = computeRemoveSubaccountDigest({
    chainId, verifyingContract: params.verifyingContract, relayParams, subaccount: params.subaccount,
  });
  const typedData = buildRemoveSubaccountTypedData({
    chainId, verifyingContract: params.verifyingContract, relayParams, subaccount: params.subaccount,
  });

  const sessionId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.update(subaccountApprovalSessionsTable)
        .set({ status: SESSION_STATUS.INVALIDATED, invalidReason: '새 revoke prepare로 대체됨', updatedAt: new Date() })
        .where(and(
          eq(subaccountApprovalSessionsTable.purpose, REVOKE_PURPOSE),
          inArray(subaccountApprovalSessionsTable.status, [SESSION_STATUS.PREPARED, SESSION_STATUS.OWNER_SIGNATURE_READY]),
        ));
      await tx.insert(subaccountApprovalSessionsTable).values({
        id: sessionId,
        mainAccount: params.mainAccount.toLowerCase(),
        subaccount: params.subaccount.toLowerCase(),
        chainId: String(chainId),
        verifyingContract: params.verifyingContract.toLowerCase(),
        actionType: 'REMOVE_SUBACCOUNT',
        shouldAdd: false,
        expiresAt: '0',
        maxAllowedCount: '0',
        approvalNonce: '0',
        desChainId: String(chainId),
        deadline: deadline.toString(),
        integrationId: `0x${'0'.repeat(64)}`,
        purpose: REVOKE_PURPOSE,
        relayFeeToken: params.feeToken.toLowerCase(),
        relayFeeAmount: params.feeAmount.toString(),
        relayUserNonce: userNonce.toString(),
        typedDataDigest: digest,
        encryptedSignature: null,
        status: SESSION_STATUS.PREPARED,
      });
    });
  } catch {
    return { ok: false, reason: 'revoke 세션 저장 실패 — prepare 중단 (fail-closed)' };
  }

  return {
    ok: true,
    sessionId,
    typedData,
    digest,
    summary: {
      mainAccount: params.mainAccount,
      subaccount: params.subaccount,
      verifyingContract: params.verifyingContract,
      feeToken: params.feeToken,
      feeAmount: params.feeAmount.toString(),
      userNonce: userNonce.toString(),
      deadline: deadline.toString(),
    },
  };
}

export type RevokeSubmitResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: string };

/**
 * owner 서명 제출 — 저장 파라미터로 digest 재계산 후 서명자 복구가
 * main account와 일치할 때만 암호화 저장 (변조 fail-closed).
 */
export async function submitRevokeSignature(params: {
  sessionId: string;
  signature: Hex;
  expectedOwner: Address;
  nowSec: bigint;
}): Promise<RevokeSubmitResult> {
  let row: SubaccountApprovalSessionRow | undefined;
  try {
    const rows = await db.select().from(subaccountApprovalSessionsTable)
      .where(eq(subaccountApprovalSessionsTable.id, params.sessionId)).limit(1);
    row = rows[0];
  } catch {
    return { ok: false, reason: '세션 조회 실패 (fail-closed)' };
  }
  if (!row || row.purpose !== REVOKE_PURPOSE) return { ok: false, reason: 'revoke 세션을 찾을 수 없습니다' };
  if (row.status !== SESSION_STATUS.PREPARED) {
    return { ok: false, reason: `세션 상태 ${row.status} — PREPARED에만 서명 제출 가능` };
  }
  if (BigInt(row.deadline) <= params.nowSec) {
    await markInvalid(row.id, '서명 deadline 경과');
    return { ok: false, reason: '서명 deadline 경과 — 새로 준비하세요' };
  }
  if (row.mainAccount !== params.expectedOwner.toLowerCase()) {
    await markInvalid(row.id, 'main account 불일치');
    return { ok: false, reason: '세션 main account가 서버 구성과 불일치' };
  }

  const relayParams = rebuildRelayParams(row);
  if (!relayParams) {
    await markInvalid(row.id, 'relayParams 구성값 손상');
    return { ok: false, reason: '세션 relayParams 손상 — 무효화' };
  }
  const digest = computeRemoveSubaccountDigest({
    chainId: Number(row.chainId),
    verifyingContract: row.verifyingContract as Address,
    relayParams,
    subaccount: row.subaccount as Address,
  });
  if (digest !== row.typedDataDigest) {
    await markInvalid(row.id, 'digest 불일치 (변조 의심)');
    return { ok: false, reason: '세션 무결성 검증 실패' };
  }

  let recovered: Address;
  try {
    recovered = await recoverAddress({ hash: digest, signature: params.signature });
  } catch {
    return { ok: false, reason: '서명 복구 실패 — 형식 오류' };
  }
  if (recovered.toLowerCase() !== params.expectedOwner.toLowerCase()) {
    return { ok: false, reason: '서명자가 owner(main account)와 불일치 — 거부' };
  }

  let encrypted: string;
  try {
    encrypted = encryptSensitiveHex(params.signature);
  } catch {
    return { ok: false, reason: '서명 암호화 실패 (fail-closed)' };
  }

  try {
    const updated = await db.update(subaccountApprovalSessionsTable)
      .set({ encryptedSignature: encrypted, status: SESSION_STATUS.OWNER_SIGNATURE_READY, updatedAt: new Date() })
      .where(and(
        eq(subaccountApprovalSessionsTable.id, row.id),
        eq(subaccountApprovalSessionsTable.status, SESSION_STATUS.PREPARED),
      ))
      .returning({ id: subaccountApprovalSessionsTable.id });
    if (updated.length !== 1) return { ok: false, reason: '상태 전환 실패 (경합)' };
  } catch {
    return { ok: false, reason: '서명 저장 실패 (fail-closed)' };
  }
  return { ok: true, sessionId: row.id };
}

export interface ActiveRevokeSummary {
  sessionId: string;
  status: string;
  subaccount: string;
  deadline: string;
  feeToken: string | null;
  feeAmount: string | null;
  userNonce: string | null;
  createdAt: string;
}

/** 활성 REVOKE 세션 조회 — 서명·암호문 미포함. 없으면 null. */
export async function getActiveRevokeSession(): Promise<ActiveRevokeSummary | null> {
  try {
    const rows = await db.select().from(subaccountApprovalSessionsTable)
      .where(and(
        eq(subaccountApprovalSessionsTable.purpose, REVOKE_PURPOSE),
        inArray(subaccountApprovalSessionsTable.status, [SESSION_STATUS.PREPARED, SESSION_STATUS.OWNER_SIGNATURE_READY]),
      ))
      .orderBy(desc(subaccountApprovalSessionsTable.createdAt)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      sessionId: row.id, status: row.status, subaccount: row.subaccount,
      deadline: row.deadline, feeToken: row.relayFeeToken, feeAmount: row.relayFeeAmount,
      userNonce: row.relayUserNonce, createdAt: row.createdAt.toISOString(),
    };
  } catch {
    // 조회 실패 시 null — 호출측은 canonicalConfirmed 게이트로 이미 fail-closed
    return null;
  }
}

/** revoke 세션 취소 (운영자) — 활성 세션만 INVALIDATED */
export async function cancelRevokeSession(sessionId: string): Promise<boolean> {
  try {
    const updated = await db.update(subaccountApprovalSessionsTable)
      .set({ status: SESSION_STATUS.INVALIDATED, invalidReason: '운영자 취소', updatedAt: new Date() })
      .where(and(
        eq(subaccountApprovalSessionsTable.id, sessionId),
        eq(subaccountApprovalSessionsTable.purpose, REVOKE_PURPOSE),
        inArray(subaccountApprovalSessionsTable.status, [SESSION_STATUS.PREPARED, SESSION_STATUS.OWNER_SIGNATURE_READY]),
      ))
      .returning({ id: subaccountApprovalSessionsTable.id });
    return updated.length === 1;
  } catch {
    return false;
  }
}

async function markInvalid(id: string, reason: string): Promise<void> {
  try {
    await db.update(subaccountApprovalSessionsTable)
      .set({ status: SESSION_STATUS.INVALIDATED, invalidReason: reason, updatedAt: new Date() })
      .where(eq(subaccountApprovalSessionsTable.id, id));
  } catch { /* 비치명 */ }
}
