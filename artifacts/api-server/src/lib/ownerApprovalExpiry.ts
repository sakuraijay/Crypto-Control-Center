import { and, eq } from 'drizzle-orm';
import { db, subaccountApprovalSessionsTable } from '@workspace/db';
import { SESSION_STATUS } from './ownerApprovalSession';

const APPROVAL_PURPOSE = 'APPROVAL';
const UINT256_MAX = (1n << 256n) - 1n;
export const EXPIRED_OWNER_SIGNATURE_REASON =
  'OWNER_SIGNATURE_READY 만료 — startup DB-only 격리';

export interface OwnerApprovalExpiryResult {
  ok: boolean;
  scanned: number;
  invalidated: number;
  conflicts: number;
}

export function isExpiredOrMalformedOwnerApprovalTimestamp(
  value: string,
  nowSeconds: bigint,
): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return true;
  const parsed = BigInt(value);
  return parsed > UINT256_MAX || parsed <= nowSeconds;
}

/**
 * Expired owner-signature capabilities are invalidated before API readiness.
 *
 * This function performs DB reads and conditional DB updates only. It does not
 * decrypt signatures, initialize a signer, perform RPC/network I/O, authorize a
 * subaccount, submit an order, move funds, or alter LIVE execution gates.
 */
export async function invalidateExpiredOwnerSignatureReadySessions(
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<OwnerApprovalExpiryResult> {
  let rows: Array<{ id: string; expiresAt: string; deadline: string }>;
  try {
    rows = await db
      .select({
        id: subaccountApprovalSessionsTable.id,
        expiresAt: subaccountApprovalSessionsTable.expiresAt,
        deadline: subaccountApprovalSessionsTable.deadline,
      })
      .from(subaccountApprovalSessionsTable)
      .where(and(
        eq(subaccountApprovalSessionsTable.purpose, APPROVAL_PURPOSE),
        eq(
          subaccountApprovalSessionsTable.status,
          SESSION_STATUS.OWNER_SIGNATURE_READY,
        ),
      ));
  } catch {
    return { ok: false, scanned: 0, invalidated: 0, conflicts: 0 };
  }

  const expired = rows.filter((row) =>
    isExpiredOrMalformedOwnerApprovalTimestamp(row.expiresAt, nowSeconds)
    || isExpiredOrMalformedOwnerApprovalTimestamp(row.deadline, nowSeconds),
  );

  let invalidated = 0;
  let conflicts = 0;
  for (const row of expired) {
    try {
      const updated = await db
        .update(subaccountApprovalSessionsTable)
        .set({
          status: SESSION_STATUS.INVALIDATED,
          invalidReason: EXPIRED_OWNER_SIGNATURE_REASON,
          updatedAt: new Date(),
        })
        .where(and(
          eq(subaccountApprovalSessionsTable.id, row.id),
          eq(subaccountApprovalSessionsTable.purpose, APPROVAL_PURPOSE),
          eq(
            subaccountApprovalSessionsTable.status,
            SESSION_STATUS.OWNER_SIGNATURE_READY,
          ),
          eq(subaccountApprovalSessionsTable.expiresAt, row.expiresAt),
          eq(subaccountApprovalSessionsTable.deadline, row.deadline),
        ))
        .returning({ id: subaccountApprovalSessionsTable.id });
      if (updated.length === 1) invalidated += 1;
      else conflicts += 1;
    } catch {
      return {
        ok: false,
        scanned: rows.length,
        invalidated,
        conflicts,
      };
    }
  }

  return {
    ok: conflicts === 0,
    scanned: rows.length,
    invalidated,
    conflicts,
  };
}