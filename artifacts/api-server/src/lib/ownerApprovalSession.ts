/**
 * ownerApprovalSession — GMX delegated trading 2단계.
 *
 * MetaMask owner(main account)의 SubaccountApproval EIP-712 서명 세션을
 * 준비(prepare)·검증(verify)·영속(persist)한다.
 *
 * 보안 원칙:
 *  - owner signature는 capability다. 저장은 SESSION_SECRET 기반 AES-256-GCM
 *    암호문(encrypted_signature)으로만 하고, API 응답·로그·오류 메시지에
 *    signature 전문·암호문을 절대 포함하지 않는다.
 *  - 클라이언트가 보낸 digest·typed data는 신뢰하지 않는다. 서버가 저장된
 *    세션 파라미터로 typed data를 재구성해 서명을 검증한다.
 *  - recovered owner는 GMX_WALLET_ADDRESS와 정확히 일치해야 한다.
 *  - canonical nonce(라우터 subaccountApprovalNonces)가 세션 nonce와 다르면
 *    저장된 서명은 무효(INVALIDATED)다. main account·signer 변경 시에도 무효.
 *  - 서명 검증 성공 후 상태는 OWNER_SIGNATURE_READY까지만 — AUTHORIZED는
 *    canonical 온체인 조회로만 도달한다. LIVE 잠금·Gelato 제출은 절대 없다.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, subaccountApprovalSessionsTable, type SubaccountApprovalSessionRow } from '@workspace/db';
import type { Address, Hex } from 'viem';
import {
  buildSubaccountApprovalTypedData,
  hashSubaccountApproval,
  verifySubaccountApprovalSignature,
  computeGmxRelayDomainSeparator,
  computeRelayDigest,
  type SubaccountApprovalMessage,
} from './gmxEip712';
import { SUBACCOUNT_ORDER_ACTION } from './gmxDataStore';
import { encryptSensitiveHex } from './delegatedSigner';
import { ARBITRUM_ONE_CHAIN_ID } from './gmxLiveConfig';

// ── 서버 강제 한도 (사용자 입력은 이 범위로 클램프) ──────────────────────────
export const APPROVAL_LIMITS = {
  /** 승인 유효기간(초): 기본 1시간, 최소 5분, 최대 1시간 */
  DEFAULT_EXPIRY_SECONDS: 3600,
  MIN_EXPIRY_SECONDS: 300,
  MAX_EXPIRY_SECONDS: 3600,
  /** maxAllowedCount: 기본 2, 최소 1, 최대 10 */
  DEFAULT_MAX_ALLOWED_COUNT: 2n,
  MIN_MAX_ALLOWED_COUNT: 1n,
  MAX_MAX_ALLOWED_COUNT: 10n,
  /** 서명 deadline(초): prepare 시점 + 10분 (짧게 유지) */
  SIGNATURE_DEADLINE_SECONDS: 600,
} as const;

export const SESSION_STATUS = {
  PREPARED: 'PREPARED',
  OWNER_SIGNATURE_READY: 'OWNER_SIGNATURE_READY',
  INVALIDATED: 'INVALIDATED',
  CONSUMED: 'CONSUMED',
  REVOKED: 'REVOKED',
} as const;

/** 기본 integrationId — GMX 공식 배정 없음 → zero bytes32 */
export const DEFAULT_INTEGRATION_ID: Hex = `0x${'0'.repeat(64)}`;

export interface PreparedApproval {
  sessionId: string;
  typedData: ReturnType<typeof buildSubaccountApprovalTypedData>;
  digest: Hex;
  summary: {
    mainAccount: Address;
    subaccount: Address;
    chainId: number;
    verifyingContract: Address;
    actionType: Hex;
    shouldAdd: boolean;
    expiresAt: string;
    maxAllowedCount: string;
    nonce: string;
    desChainId: string;
    deadline: string;
    integrationId: Hex;
  };
}

export type PrepareResult = { ok: true; prepared: PreparedApproval } | { ok: false; reason: string };

function clampBigint(v: bigint, min: bigint, max: bigint): bigint {
  return v < min ? min : v > max ? max : v;
}
function clampNumber(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** GMX_WALLET_ADDRESS (main account). 미설정 시 null — prepare/submit 전부 실패. */
export function getConfiguredMainAccount(): Address | null {
  const v = process.env.GMX_WALLET_ADDRESS?.trim();
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  return v as Address;
}

function rowToMessage(row: SubaccountApprovalSessionRow): SubaccountApprovalMessage {
  return {
    subaccount: row.subaccount as Address,
    shouldAdd: row.shouldAdd,
    expiresAt: BigInt(row.expiresAt),
    maxAllowedCount: BigInt(row.maxAllowedCount),
    actionType: row.actionType as Hex,
    nonce: BigInt(row.approvalNonce),
    desChainId: BigInt(row.desChainId),
    deadline: BigInt(row.deadline),
    integrationId: row.integrationId as Hex,
  };
}

function computeSessionDigest(chainId: number, verifyingContract: Address, msg: SubaccountApprovalMessage): Hex {
  const ds = computeGmxRelayDomainSeparator(chainId, verifyingContract);
  return computeRelayDigest(ds, hashSubaccountApproval({ chainId, verifyingContract, approval: msg }));
}

/**
 * 승인 세션 준비 — canonical nonce는 호출측이 라우터에서 읽어 전달한다.
 * 기존 PREPARED/READY 세션은 새 prepare 시 전부 INVALIDATED (단일 활성 세션).
 */
export async function prepareApprovalSession(params: {
  mainAccount: Address;          // 서버 구성값(GMX_WALLET_ADDRESS)과 일치 확인 후 전달
  subaccount: Address;           // delegated signer 공개 주소
  verifyingContract: Address;    // SubaccountGelatoRelayRouter
  canonicalNonce: bigint;        // router.subaccountApprovalNonces(mainAccount)
  nowSec: bigint;
  requestedExpirySeconds?: number;
  requestedMaxAllowedCount?: number;
}): Promise<PrepareResult> {
  const chainId = ARBITRUM_ONE_CHAIN_ID;

  const expirySec = clampNumber(
    Math.floor(params.requestedExpirySeconds ?? APPROVAL_LIMITS.DEFAULT_EXPIRY_SECONDS),
    APPROVAL_LIMITS.MIN_EXPIRY_SECONDS,
    APPROVAL_LIMITS.MAX_EXPIRY_SECONDS,
  );
  const maxAllowedCount = clampBigint(
    BigInt(Math.floor(params.requestedMaxAllowedCount ?? Number(APPROVAL_LIMITS.DEFAULT_MAX_ALLOWED_COUNT))),
    APPROVAL_LIMITS.MIN_MAX_ALLOWED_COUNT,
    APPROVAL_LIMITS.MAX_MAX_ALLOWED_COUNT,
  );

  const message: SubaccountApprovalMessage = {
    subaccount: params.subaccount,
    shouldAdd: true,
    expiresAt: params.nowSec + BigInt(expirySec),
    maxAllowedCount,
    actionType: SUBACCOUNT_ORDER_ACTION,
    nonce: params.canonicalNonce,
    desChainId: BigInt(chainId),
    deadline: params.nowSec + BigInt(APPROVAL_LIMITS.SIGNATURE_DEADLINE_SECONDS),
    integrationId: DEFAULT_INTEGRATION_ID,
  };

  const digest = computeSessionDigest(chainId, params.verifyingContract, message);
  const sessionId = randomUUID();

  try {
    // 단일 활성 세션: invalidate+insert를 단일 트랜잭션으로 묶는다.
    // DB 수준의 partial unique index(migration 0015: main_account당 활성 1개)가
    // 동시 prepare 경합의 최종 방어선 — 경합 시 한쪽 insert가 실패해 롤백된다.
    await db.transaction(async (tx) => {
      await tx.update(subaccountApprovalSessionsTable)
        .set({ status: SESSION_STATUS.INVALIDATED, invalidReason: '새 prepare로 대체됨', updatedAt: new Date() })
        .where(and(
          eq(subaccountApprovalSessionsTable.purpose, APPROVAL_PURPOSE),
          inArray(subaccountApprovalSessionsTable.status, [SESSION_STATUS.PREPARED, SESSION_STATUS.OWNER_SIGNATURE_READY]),
        ));

      await tx.insert(subaccountApprovalSessionsTable).values({
        id: sessionId,
        mainAccount: params.mainAccount.toLowerCase(),
        subaccount: params.subaccount.toLowerCase(),
        chainId: String(chainId),
        verifyingContract: params.verifyingContract.toLowerCase(),
        actionType: message.actionType,
        shouldAdd: message.shouldAdd,
        expiresAt: message.expiresAt.toString(),
        maxAllowedCount: message.maxAllowedCount.toString(),
        approvalNonce: message.nonce.toString(),
        desChainId: message.desChainId.toString(),
        deadline: message.deadline.toString(),
        integrationId: message.integrationId,
        typedDataDigest: digest,
        encryptedSignature: null,
        status: SESSION_STATUS.PREPARED,
        purpose: APPROVAL_PURPOSE,   // REVOKE 세션과 격리 (DB default와 동일하지만 명시)
      });
    });
  } catch {
    return { ok: false, reason: '승인 세션 저장 실패 — prepare 중단 (fail-closed)' };
  }

  return {
    ok: true,
    prepared: {
      sessionId,
      typedData: buildSubaccountApprovalTypedData({ chainId, verifyingContract: params.verifyingContract, approval: message }),
      digest,
      summary: {
        mainAccount: params.mainAccount,
        subaccount: params.subaccount,
        chainId,
        verifyingContract: params.verifyingContract,
        actionType: message.actionType,
        shouldAdd: message.shouldAdd,
        expiresAt: message.expiresAt.toString(),
        maxAllowedCount: message.maxAllowedCount.toString(),
        nonce: message.nonce.toString(),
        desChainId: message.desChainId.toString(),
        deadline: message.deadline.toString(),
        integrationId: message.integrationId,
      },
    },
  };
}

/** APPROVAL 세션 purpose — REVOKE 세션(revokeSession.ts)과 격리 */
export const APPROVAL_PURPOSE = 'APPROVAL';

export type SubmitResult =
  | { ok: true; sessionId: string; status: typeof SESSION_STATUS.OWNER_SIGNATURE_READY }
  | { ok: false; reason: string };

/**
 * MetaMask 서명 제출 — 서버가 세션 저장값으로 typed data를 재구성해 검증.
 * 성공 시에만 서명을 암호화 저장하고 OWNER_SIGNATURE_READY로 전환.
 */
export async function submitApprovalSignature(params: {
  sessionId: string;
  signature: Hex;
  canonicalNonce: bigint;   // 제출 시점 router nonce 재확인
  expectedOwner: Address;   // GMX_WALLET_ADDRESS
  nowSec: bigint;
}): Promise<SubmitResult> {
  let row: SubaccountApprovalSessionRow | undefined;
  try {
    const rows = await db.select().from(subaccountApprovalSessionsTable)
      .where(eq(subaccountApprovalSessionsTable.id, params.sessionId)).limit(1);
    row = rows[0];
  } catch {
    return { ok: false, reason: '세션 조회 실패 — 서명 저장 중단 (fail-closed)' };
  }
  if (!row) return { ok: false, reason: '세션을 찾을 수 없습니다' };
  if (row.purpose !== APPROVAL_PURPOSE) {
    return { ok: false, reason: 'APPROVAL 세션이 아닙니다 — revoke 세션은 별도 경로 사용' };
  }
  if (row.status !== SESSION_STATUS.PREPARED) {
    return { ok: false, reason: `세션 상태 ${row.status} — PREPARED 세션에만 서명을 제출할 수 있습니다` };
  }
  if (BigInt(row.deadline) <= params.nowSec) {
    await markInvalid(row.id, '서명 deadline 경과');
    return { ok: false, reason: '서명 deadline이 경과했습니다 — 새로 준비하세요' };
  }
  if (row.mainAccount !== params.expectedOwner.toLowerCase()) {
    await markInvalid(row.id, 'main account 불일치');
    return { ok: false, reason: '세션의 main account가 서버 구성과 일치하지 않습니다' };
  }
  if (BigInt(row.approvalNonce) !== params.canonicalNonce) {
    await markInvalid(row.id, 'canonical nonce 변경');
    return { ok: false, reason: 'canonical nonce가 변경되었습니다 — 세션 무효, 새로 준비하세요' };
  }

  const message = rowToMessage(row);
  const chainId = Number(row.chainId);
  const verifyingContract = row.verifyingContract as Address;

  // 저장 파라미터 무결성: digest 재계산이 저장 digest와 일치해야 함 (변조 검사)
  const digest = computeSessionDigest(chainId, verifyingContract, message);
  if (digest !== row.typedDataDigest) {
    await markInvalid(row.id, 'digest 불일치 (세션 데이터 변조 의심)');
    return { ok: false, reason: '세션 데이터 무결성 검증 실패' };
  }

  const verify = await verifySubaccountApprovalSignature({
    chainId,
    verifyingContract,
    approval: message,
    signature: params.signature,
    expectedOwner: params.expectedOwner,
    expectedNonce: params.canonicalNonce,
    nowSec: params.nowSec,
  });
  if (!verify.ok) {
    // 서명 원문·recovered 주소 외 정보 비노출 — verify.reason은 sanitize된 사유만 포함
    return { ok: false, reason: `서명 검증 실패: ${verify.reason}` };
  }

  let encrypted: string;
  try {
    encrypted = encryptSensitiveHex(params.signature);
  } catch {
    return { ok: false, reason: '서명 암호화 실패 — 저장 중단 (fail-closed)' };
  }

  try {
    // 조건부 전환: PREPARED 상태일 때만 READY로 (경합 차단)
    const updated = await db.update(subaccountApprovalSessionsTable)
      .set({ encryptedSignature: encrypted, status: SESSION_STATUS.OWNER_SIGNATURE_READY, updatedAt: new Date() })
      .where(and(
        eq(subaccountApprovalSessionsTable.id, row.id),
        eq(subaccountApprovalSessionsTable.status, SESSION_STATUS.PREPARED),
      ))
      .returning({ id: subaccountApprovalSessionsTable.id });
    if (updated.length !== 1) {
      return { ok: false, reason: '세션 상태 전환 실패 — 저장되지 않음 (fail-closed)' };
    }
  } catch {
    return { ok: false, reason: '서명 저장 실패 — READY 전환되지 않음 (fail-closed)' };
  }

  return { ok: true, sessionId: row.id, status: SESSION_STATUS.OWNER_SIGNATURE_READY };
}

async function markInvalid(id: string, reason: string): Promise<void> {
  try {
    await db.update(subaccountApprovalSessionsTable)
      .set({ status: SESSION_STATUS.INVALIDATED, invalidReason: reason, updatedAt: new Date() })
      .where(eq(subaccountApprovalSessionsTable.id, id));
  } catch { /* 무효화 실패는 비치명 — 이후 조회에서 재검증됨 */ }
}

/**
 * 온체인 반영 감지 → CONSUMED 전이 (4단계 §6).
 * router subaccountApprovalNonces가 세션 nonce보다 커졌으면(= 승인이 온체인
 * 반영되어 nonce가 증가) READY 세션을 CONSUMED로 마감한다.
 * relay task accepted만으로는 절대 CONSUMED 금지 — canonical nonce 증거만 인정.
 */
export async function markConsumedIfNonceAdvanced(params: {
  canonicalNonce: bigint;
}): Promise<{ consumed: boolean }> {
  let rows: SubaccountApprovalSessionRow[];
  try {
    rows = await db.select().from(subaccountApprovalSessionsTable)
      .where(and(
        eq(subaccountApprovalSessionsTable.purpose, APPROVAL_PURPOSE),
        eq(subaccountApprovalSessionsTable.status, SESSION_STATUS.OWNER_SIGNATURE_READY),
      ));
  } catch {
    return { consumed: false };
  }
  let consumed = false;
  for (const row of rows) {
    if (params.canonicalNonce > BigInt(row.approvalNonce)) {
      try {
        const updated = await db.update(subaccountApprovalSessionsTable)
          .set({ status: SESSION_STATUS.CONSUMED, invalidReason: `canonical nonce ${params.canonicalNonce} > 세션 nonce ${row.approvalNonce} — 온체인 반영 확인`, updatedAt: new Date() })
          .where(and(
            eq(subaccountApprovalSessionsTable.id, row.id),
            eq(subaccountApprovalSessionsTable.status, SESSION_STATUS.OWNER_SIGNATURE_READY),
          ))
          .returning({ id: subaccountApprovalSessionsTable.id });
        if (updated.length === 1) consumed = true;
      } catch { /* 다음 조회에서 재시도 */ }
    }
  }
  return { consumed };
}

export interface ActiveSessionSummary {
  sessionId: string;
  status: string;
  mainAccount: string;
  subaccount: string;
  approvalNonce: string;
  expiresAt: string;
  maxAllowedCount: string;
  deadline: string;
  createdAt: string;
}

/**
 * 활성(READY) 세션 요약 — 서명·암호문 절대 미포함.
 * canonical nonce/account/signer와 불일치하면 즉시 INVALIDATED 처리 후 null.
 */
export async function getActiveReadySession(params: {
  expectedOwner: Address | null;
  expectedSubaccount: Address | null;
  canonicalNonce: bigint | null;   // null = canonical 미확인 (무효화 판단 보류)
}): Promise<ActiveSessionSummary | null> {
  let rows: SubaccountApprovalSessionRow[];
  try {
    rows = await db.select().from(subaccountApprovalSessionsTable)
      .where(and(
        eq(subaccountApprovalSessionsTable.purpose, APPROVAL_PURPOSE),
        eq(subaccountApprovalSessionsTable.status, SESSION_STATUS.OWNER_SIGNATURE_READY),
      ))
      .orderBy(desc(subaccountApprovalSessionsTable.createdAt)).limit(1);
  } catch {
    return null;
  }
  const row = rows[0];
  if (!row) return null;

  if (params.expectedOwner && row.mainAccount !== params.expectedOwner.toLowerCase()) {
    await markInvalid(row.id, 'main account 변경');
    return null;
  }
  if (params.expectedSubaccount && row.subaccount !== params.expectedSubaccount.toLowerCase()) {
    await markInvalid(row.id, 'signer 변경');
    return null;
  }
  if (params.canonicalNonce !== null && BigInt(row.approvalNonce) !== params.canonicalNonce) {
    await markInvalid(row.id, 'canonical nonce 변경');
    return null;
  }

  return {
    sessionId: row.id,
    status: row.status,
    mainAccount: row.mainAccount,
    subaccount: row.subaccount,
    approvalNonce: row.approvalNonce,
    expiresAt: row.expiresAt,
    maxAllowedCount: row.maxAllowedCount,
    deadline: row.deadline,
    createdAt: row.createdAt.toISOString(),
  };
}
