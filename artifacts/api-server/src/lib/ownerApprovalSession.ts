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
  /**
   * maxAllowedCount: canonical 8 (운영자 승인 — 2026-08-18).
   * 근거: action budget 감사(actionBudget.requiredActionsBeforeOpen()=6:
   * 최악 경로 5 + 비상 예약 1) + 비상 정리 여유 2회 = 8.
   * 서버 prepare는 클라이언트 요청값을 신뢰하지 않고 항상 이 값을 생성하며,
   * GMX API echo가 정확히 8이 아니면 변조로 간주해 fail-closed 거부한다.
   */
  CANONICAL_MAX_ALLOWED_COUNT: 8n,
  DEFAULT_MAX_ALLOWED_COUNT: 8n,
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

/**
 * #134 — 세션 결속 digest는 지갑이 실제 서명하는 canonical EIP-712 typed-data
 * digest(hashTypedData) 그대로 저장한다. 제출 시 동일 함수로 재계산·대조 후에만
 * recover 단계로 진행한다 (서버 권위, 클라이언트 digest는 참고용).
 */
function computeSessionDigest(chainId: number, verifyingContract: Address, msg: SubaccountApprovalMessage): Hex {
  return hashSubaccountApproval({ chainId, verifyingContract, approval: msg });
}

/** 구세대(v1) digest 스킴 — canonical digest를 0x1901로 재래핑하던 값. 레거시 세션 판별 전용. */
function computeLegacySessionDigest(chainId: number, verifyingContract: Address, msg: SubaccountApprovalMessage): Hex {
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
  /**
   * 6G-1 §5 — 공식 GMX API prepareSubaccountApproval이 권위 원천인 경우,
   * 검증(gmxApiApproval.validateGmxPreparedApproval)을 통과한 message를 그대로
   * 저장한다. 호출측이 chainId·nonce·기간·count 전부 검증 완료했을 때만 전달.
   */
  externalMessage?: SubaccountApprovalMessage;
}): Promise<PrepareResult> {
  const chainId = ARBITRUM_ONE_CHAIN_ID;

  const expirySec = clampNumber(
    Math.floor(params.requestedExpirySeconds ?? APPROVAL_LIMITS.DEFAULT_EXPIRY_SECONDS),
    APPROVAL_LIMITS.MIN_EXPIRY_SECONDS,
    APPROVAL_LIMITS.MAX_EXPIRY_SECONDS,
  );
  // canonical 강제 — 클라이언트 requestedMaxAllowedCount는 신뢰하지 않는다 (무시).
  const maxAllowedCount = APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT;

  const message: SubaccountApprovalMessage = params.externalMessage ?? {
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
  // externalMessage도 canonical nonce·subaccount 결속은 여기서 이중 확인 (fail-closed)
  if (params.externalMessage) {
    if (message.nonce !== params.canonicalNonce) return { ok: false, reason: 'external message nonce ≠ canonical nonce — prepare 중단' };
    if (message.subaccount.toLowerCase() !== params.subaccount.toLowerCase()) return { ok: false, reason: 'external message subaccount 불일치 — prepare 중단' };
    if (!message.shouldAdd) return { ok: false, reason: 'external message shouldAdd=false — prepare 중단' };
  }

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
  /** #134 — 브라우저가 서명 직전 계산한 canonical digest (진단 참고용, 서버 권위 아님) */
  clientDigest?: Hex | null;
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
  // canonical 8 불변식 — 정책 변경(2→8) 이전에 생성된 레거시 세션 서명 차단 (fail-closed)
  if (BigInt(row.maxAllowedCount) !== APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT) {
    await markInvalid(row.id, `maxAllowedCount ${row.maxAllowedCount} ≠ canonical ${APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT}`);
    return { ok: false, reason: '세션 maxAllowedCount가 canonical 정책(8)과 다릅니다 — 새로 준비하세요' };
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

  // 저장 파라미터 무결성: canonical digest 재계산이 저장 digest와 일치해야 함 (변조 검사)
  const digest = computeSessionDigest(chainId, verifyingContract, message);
  if (digest !== row.typedDataDigest) {
    // #134 — canonical 스킴 전환 이전(v1 재래핑 스킴) 세션은 변조가 아니라 레거시.
    // 어느 쪽이든 재사용 금지 — 명확한 사유로 무효화하고 새 prepare를 요구한다.
    const legacy = computeLegacySessionDigest(chainId, verifyingContract, message);
    if (legacy === row.typedDataDigest) {
      await markInvalid(row.id, '레거시 digest 스킴(v1) 세션 — canonical 스킴 전환으로 재사용 불가');
      return { ok: false, reason: '세션이 구버전 스킴으로 생성되었습니다 — 새로 준비하세요' };
    }
    await markInvalid(row.id, 'digest 불일치 (세션 데이터 변조 의심)');
    return { ok: false, reason: '세션 데이터 무결성 검증 실패' };
  }
  // 클라이언트 참고 digest 대조 (진단용 — 서버 권위 판정에는 사용하지 않음)
  const clientDigestMatch: boolean | null =
    params.clientDigest != null ? params.clientDigest.toLowerCase() === digest.toLowerCase() : null;

  // #134 — durable claim-first: 검증 시도 전에 PREPARED → INVALIDATED(claim)로
  // 원자 전환(조건부 UPDATE, 결과 확인). 이후 어떤 실패(검증 실패·저장 실패)에도
  // 세션은 이미 터미널 상태라 재사용 불가 — 무효화 기록 실패로 인한 재사용 창이 없다.
  // 검증 성공 시에만 claim 상태에서 READY로 전환한다.
  try {
    const claimed = await db.update(subaccountApprovalSessionsTable)
      .set({ status: SESSION_STATUS.INVALIDATED, invalidReason: SUBMIT_CLAIM_REASON, updatedAt: new Date() })
      .where(and(
        eq(subaccountApprovalSessionsTable.id, row.id),
        eq(subaccountApprovalSessionsTable.status, SESSION_STATUS.PREPARED),
      ))
      .returning({ id: subaccountApprovalSessionsTable.id });
    if (claimed.length !== 1) {
      return { ok: false, reason: '세션 클레임 실패 — 동시 제출 또는 상태 변경, 저장되지 않음 (fail-closed)' };
    }
  } catch {
    return { ok: false, reason: '세션 클레임 저장 실패 — 서명 저장 중단 (fail-closed)' };
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
    // #134 — 세션은 이미 claim 단계에서 durable하게 INVALIDATED. 사유만 구체화
    // (best-effort — 실패해도 세션은 터미널 상태 유지).
    await markInvalid(row.id, `서명 검증 실패: ${verify.reason}`);
    const digestNote = clientDigestMatch == null
      ? 'client digest 미제공'
      : `client/server digest ${clientDigestMatch ? '일치' : '불일치'}`;
    return { ok: false, reason: `서명 검증 실패: ${verify.reason} · ${digestNote} · 세션 무효화됨 — 새로 준비하세요` };
  }

  let encrypted: string;
  try {
    encrypted = encryptSensitiveHex(params.signature);
  } catch {
    return { ok: false, reason: '서명 암호화 실패 — 저장 중단 (fail-closed)' };
  }

  try {
    // 조건부 전환: 이 제출이 claim한 세션만 READY로 (경합 차단)
    const updated = await db.update(subaccountApprovalSessionsTable)
      .set({ encryptedSignature: encrypted, status: SESSION_STATUS.OWNER_SIGNATURE_READY, invalidReason: null, updatedAt: new Date() })
      .where(and(
        eq(subaccountApprovalSessionsTable.id, row.id),
        eq(subaccountApprovalSessionsTable.status, SESSION_STATUS.INVALIDATED),
        eq(subaccountApprovalSessionsTable.invalidReason, SUBMIT_CLAIM_REASON),
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

/** #134 — 제출 처리 claim 마커. 이 사유의 INVALIDATED 세션만 READY로 전환 가능. */
const SUBMIT_CLAIM_REASON = '#134 서명 제출 처리 중 (claim)';

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
  persistInvalidation?: boolean;   // status/readiness 조회는 false: 논리적 차단만, DB write 금지
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

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const isExpiredOrMalformed = (value: string): boolean => {
    if (!/^(0|[1-9]\d*)$/.test(value)) return true;
    try {
      const parsed = BigInt(value);
      return parsed > ((1n << 256n) - 1n) || parsed <= nowSeconds;
    } catch {
      return true;
    }
  };
  // 만료/비정상 READY는 조회 시 논리적으로만 무효화한다. Persistent cleanup은
  // 명시적 operator action 전용이며 status/startup에서 자동 UPDATE하지 않는다.
  if (
    params.persistInvalidation === false
    && (isExpiredOrMalformed(row.expiresAt) || isExpiredOrMalformed(row.deadline))
  ) {
    return null;
  }

  const invalidateIfAllowed = async (reason: string): Promise<void> => {
    if (params.persistInvalidation !== false) await markInvalid(row.id, reason);
  };
  if (params.expectedOwner && row.mainAccount !== params.expectedOwner.toLowerCase()) {
    await invalidateIfAllowed('main account 변경');
    return null;
  }
  if (params.expectedSubaccount && row.subaccount !== params.expectedSubaccount.toLowerCase()) {
    await invalidateIfAllowed('signer 변경');
    return null;
  }
  if (params.canonicalNonce !== null && BigInt(row.approvalNonce) !== params.canonicalNonce) {
    await invalidateIfAllowed('canonical nonce 변경');
    return null;
  }
  // canonical 8 불변식 — 레거시(≠8) READY 세션은 즉시 무효화 (fail-closed)
  if (BigInt(row.maxAllowedCount) !== APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT) {
    await invalidateIfAllowed(`maxAllowedCount ${row.maxAllowedCount} ≠ canonical ${APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT}`);
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
