import {
  aiDecisionsTable,
  db,
  liveApprovalsTable,
  tradesTable,
} from '@workspace/db';
import { and, eq, gt } from 'drizzle-orm';
import { countBlockingIntentsOrNull } from './executionIntents';
import { countOpenRelayTasksOrNull } from './relayLifecycle';
import { listBlockingProtections } from './protectionOrders';

export interface RuntimeDbSafetyEvidence {
  observedAt: string;
  complete: boolean;
  pendingApprovalCount: number | null;
  openPositionCount: number | null;
  blockingIntentCount: number | null;
  openRelayTaskCount: number | null;
  blockingProtectionCount: number | null;
  unsettledTradeCount: number | null;
  duplicateDecisionClaimCount24h: number | null;
}

async function countRows<T>(read: () => Promise<T[]>): Promise<number | null> {
  try {
    return (await read()).length;
  } catch {
    return null;
  }
}

async function countDuplicateDecisionClaims24h(nowMs: number): Promise<number | null> {
  try {
    const rows = await db.select({ fullJson: aiDecisionsTable.fullJson })
      .from(aiDecisionsTable)
      .where(gt(aiDecisionsTable.createdAt, new Date(nowMs - 24 * 60 * 60_000)));
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.fullJson === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.fullJson);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== 'object') return null;
      const id = (parsed as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0) return null;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.values()].filter((count) => count > 1).length;
  } catch {
    return null;
  }
}

export async function readRuntimeDbSafetyEvidence(
  now = new Date(),
): Promise<RuntimeDbSafetyEvidence> {
  const [
    pendingApprovalCount,
    openPositionCount,
    blockingIntentCount,
    openRelayTaskCount,
    protectionResult,
    unsettledTradeCount,
    duplicateDecisionClaimCount24h,
  ] = await Promise.all([
    countRows(() => db.select({ id: liveApprovalsTable.id }).from(liveApprovalsTable)
      .where(eq(liveApprovalsTable.status, 'PENDING'))),
    countRows(() => db.select({ id: tradesTable.id }).from(tradesTable)
      .where(and(eq(tradesTable.action, 'OPEN'), eq(tradesTable.closeTime, 0)))),
    countBlockingIntentsOrNull(),
    countOpenRelayTasksOrNull(),
    listBlockingProtections(),
    countRows(() => db.select({ id: tradesTable.id }).from(tradesTable)
      .where(eq(tradesTable.settlementStatus, 'UNSETTLED'))),
    countDuplicateDecisionClaims24h(now.getTime()),
  ]);
  const blockingProtectionCount = protectionResult.ok ? protectionResult.rows.length : null;
  const values = [
    pendingApprovalCount,
    openPositionCount,
    blockingIntentCount,
    openRelayTaskCount,
    blockingProtectionCount,
    unsettledTradeCount,
    duplicateDecisionClaimCount24h,
  ];
  return {
    observedAt: now.toISOString(),
    complete: values.every((value) => value !== null),
    pendingApprovalCount,
    openPositionCount,
    blockingIntentCount,
    openRelayTaskCount,
    blockingProtectionCount,
    unsettledTradeCount,
    duplicateDecisionClaimCount24h,
  };
}