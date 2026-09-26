import type { DatabasePoolClient } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { RISK_POLICY } from "./riskPolicy";
import type { RiskLimits } from "../workers/serverTypes";

export const RISK_PROFILE_VERSION = "risk-profile/v1" as const;
export type RiskProfileName = "conservative" | "aggressive";

export interface RiskProfileDerivedLimits {
  immediateEntryThreshold: number;
  maxRiskPerTradePct: number;
  reserveCashPct: number;
  maxMarginPerTradeUsd: number;
  maxConcurrentPositions: number;
  cooldownMinutes: number;
  maxLeverage: number;
  maxTotalExposureUsd: number;
  allocatedTradingCapitalUsd: number;
  maxRiskPerTradeUsd: number;
}

export interface AppliedRiskProfileSnapshot {
  name: RiskProfileName;
  version: typeof RISK_PROFILE_VERSION;
  appliedAt: string;
  derivedLimits: RiskProfileDerivedLimits;
}

export interface DesiredRiskProfile {
  name: RiskProfileName;
  version: typeof RISK_PROFILE_VERSION;
  requestedAt: string;
}

export interface RiskProfileStatus {
  desired: DesiredRiskProfile;
  applied: AppliedRiskProfileSnapshot;
  pending: boolean;
  safeBoundary: boolean;
  reason: string | null;
}

interface PersistedAppliedRiskProfile {
  name: RiskProfileName;
  version: typeof RISK_PROFILE_VERSION;
  appliedAt: string;
}

const DESIRED_KEY = "riskProfileDesiredV1";
const APPLIED_KEY = "riskProfileAppliedV1";
const SERVER_PAPER_PENDING_CLOSE_KEY = "serverPaperPendingClose";

const finite = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function isAppliedRiskProfileSnapshot(value: unknown): value is AppliedRiskProfileSnapshot {
  if (!isExactRecord(value, ["name", "version", "appliedAt", "derivedLimits"])) return false;
  const name = parseRiskProfileName(value.name);
  if (!name || value.version !== RISK_PROFILE_VERSION || !isCanonicalIso(value.appliedAt)) return false;
  const d = value.derivedLimits;
  if (!isExactRecord(d, [
    "immediateEntryThreshold", "maxRiskPerTradePct", "reserveCashPct",
    "maxMarginPerTradeUsd", "maxConcurrentPositions", "cooldownMinutes",
    "maxLeverage", "maxTotalExposureUsd", "allocatedTradingCapitalUsd",
    "maxRiskPerTradeUsd",
  ])) return false;
  const numeric = Object.values(d);
  if (!numeric.every(item => typeof item === "number" && Number.isFinite(item) && item >= 0)) return false;
  const limits = d as unknown as RiskProfileDerivedLimits;
  if (limits.maxLeverage > RISK_POLICY.baseMaxLeverage
    || limits.maxConcurrentPositions < 1
    || limits.maxConcurrentPositions > RISK_POLICY.maxProfileConcurrentPositions
    || Math.abs(
      limits.maxRiskPerTradeUsd
      - limits.allocatedTradingCapitalUsd * limits.maxRiskPerTradePct / 100
    ) > 1e-8) return false;
  if (name === "conservative") {
    return limits.immediateEntryThreshold === 80
      && limits.maxRiskPerTradePct === RISK_POLICY.baseRiskPerTradePercent
      && limits.maxConcurrentPositions === RISK_POLICY.maxConcurrentPositions;
  }
  return limits.immediateEntryThreshold === 80
    && limits.maxRiskPerTradePct === RISK_POLICY.maxRiskPerTradePercent
    && limits.reserveCashPct >= 20
    && limits.maxMarginPerTradeUsd <= RISK_POLICY.maxMarginPerTradeUsd
    && limits.maxConcurrentPositions === 1
    && limits.cooldownMinutes >= 30
    && limits.maxLeverage <= 3
    && limits.maxTotalExposureUsd <= Math.min(
      limits.allocatedTradingCapitalUsd * 3,
      3_000,
    );
}

export const PROFILE_FALLBACK_LIMITS: RiskLimits = {
  dailyLossLimitUSDT: 10,
  maxDrawdownPercent: 8,
  consecutiveLossLimit: 3,
  maxLeverage: 3,
  maxMarginPerTrade: 334,
  maxTotalExposureUSDT: 3_000,
  tradingCapital: 1_000,
  reserveCashPct: 20,
  maxSimultaneousPositions: 1,
  cooldownMinutes: 30,
};

export function profileBaseLimits(raw: unknown): RiskLimits {
  return {
    ...PROFILE_FALLBACK_LIMITS,
    ...(raw && typeof raw === "object" ? raw as Partial<RiskLimits> : {}),
  };
}

function conservativeDesired(nowIso: string): DesiredRiskProfile {
  return { name: "conservative", version: RISK_PROFILE_VERSION, requestedAt: nowIso };
}

export function deriveRiskProfileLimits(
  name: RiskProfileName,
  base: RiskLimits,
): RiskProfileDerivedLimits {
  const capital = Math.max(
    0,
    Math.min(finite(base.tradingCapital, 0), RISK_POLICY.maxRiskCapitalUsd),
  );

  if (name === "aggressive") {
    // 이름은 하위 호환을 위해 유지하되 자본·빈도·신뢰도 안전 한도는 완화하지 않는다.
    const reserveCashPct = Math.max(20, finite(base.reserveCashPct, 20));
    return {
      immediateEntryThreshold: 80,
      maxRiskPerTradePct: RISK_POLICY.maxRiskPerTradePercent,
      reserveCashPct,
      maxMarginPerTradeUsd: Math.max(
        0,
        Math.min(
          finite(base.maxMarginPerTrade, RISK_POLICY.maxMarginPerTradeUsd),
          capital * (1 - reserveCashPct / 100),
          RISK_POLICY.maxMarginPerTradeUsd,
        ),
      ),
      maxConcurrentPositions: RISK_POLICY.maxProfileConcurrentPositions,
      cooldownMinutes: Math.max(30, finite(base.cooldownMinutes, 30)),
      maxLeverage: Math.min(3, RISK_POLICY.baseMaxLeverage),
      maxTotalExposureUsd: Math.max(
        0,
        Math.min(capital * 3, 3_000, RISK_POLICY.maxRiskCapitalUsd * RISK_POLICY.baseMaxLeverage),
      ),
      allocatedTradingCapitalUsd: capital,
      maxRiskPerTradeUsd: capital * RISK_POLICY.maxRiskPerTradePercent / 100,
    };
  }

  const maxRiskPct = RISK_POLICY.baseRiskPerTradePercent;
  return {
    immediateEntryThreshold: 80,
    maxRiskPerTradePct: maxRiskPct,
    reserveCashPct: Math.max(20, Math.min(100, finite(base.reserveCashPct, 20))),
    maxMarginPerTradeUsd: Math.max(
      0,
      Math.min(finite(base.maxMarginPerTrade, 0), RISK_POLICY.maxMarginPerTradeUsd),
    ),
    maxConcurrentPositions: 1,
    cooldownMinutes: Math.max(0, finite(base.cooldownMinutes, 30)),
    maxLeverage: Math.max(1, Math.min(finite(base.maxLeverage, 1), RISK_POLICY.baseMaxLeverage)),
    maxTotalExposureUsd: Math.max(
      0,
      Math.min(
        finite(base.maxTotalExposureUSDT, 0),
        RISK_POLICY.maxRiskCapitalUsd * RISK_POLICY.baseMaxLeverage,
      ),
    ),
    allocatedTradingCapitalUsd: capital,
    maxRiskPerTradeUsd: capital * maxRiskPct / 100,
  };
}

export function applyRiskProfileToLimits(
  base: RiskLimits,
  profile: AppliedRiskProfileSnapshot,
): RiskLimits {
  const d = profile.derivedLimits;
  return {
    ...base,
    tradingCapital: d.allocatedTradingCapitalUsd,
    reserveCashPct: Math.max(20, d.reserveCashPct),
    maxMarginPerTrade: Math.min(RISK_POLICY.maxMarginPerTradeUsd, d.maxMarginPerTradeUsd),
    maxSimultaneousPositions: Math.min(RISK_POLICY.maxConcurrentPositions, d.maxConcurrentPositions),
    maxLeverage: d.maxLeverage,
    maxTotalExposureUSDT: d.maxTotalExposureUsd,
    cooldownMinutes: Math.max(30, d.cooldownMinutes),
  };
}

export function parseRiskProfileName(value: unknown): RiskProfileName | null {
  return value === "conservative" || value === "aggressive" ? value : null;
}

export function parsePersistedDesiredRiskProfile(raw: string | null): DesiredRiskProfile | null {
  try {
    const value = raw ? JSON.parse(raw) as unknown : null;
    if (!isExactRecord(value, ["name", "version", "requestedAt"])) return null;
    const name = parseRiskProfileName(value.name);
    if (!name || value.version !== RISK_PROFILE_VERSION || !isCanonicalIso(value.requestedAt)) return null;
    return {
      name,
      version: RISK_PROFILE_VERSION,
      requestedAt: value.requestedAt,
    };
  } catch {
    return null;
  }
}

export function parsePersistedAppliedRiskProfile(
  raw: string | null,
): PersistedAppliedRiskProfile | null {
  try {
    const value = raw ? JSON.parse(raw) as unknown : null;
    if (!isExactRecord(value, ["name", "version", "appliedAt"])) return null;
    const name = parseRiskProfileName(value.name);
    if (!name || value.version !== RISK_PROFILE_VERSION || !isCanonicalIso(value.appliedAt)) return null;
    return {
      name,
      version: RISK_PROFILE_VERSION,
      appliedAt: value.appliedAt,
    };
  } catch {
    return null;
  }
}

function toSnapshot(
  applied: PersistedAppliedRiskProfile,
  base: RiskLimits,
): AppliedRiskProfileSnapshot {
  return {
    ...applied,
    derivedLimits: deriveRiskProfileLimits(applied.name, base),
  };
}

async function readState(key: string): Promise<string | null> {
  const { db, workerStateTable } = await import("@workspace/db");
  const rows = await db.select({ value: workerStateTable.value })
    .from(workerStateTable).where(eq(workerStateTable.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

async function writeState(key: string, value: unknown): Promise<void> {
  const { db, workerStateTable } = await import("@workspace/db");
  await db.insert(workerStateTable)
    .values({ key, value: JSON.stringify(value), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: workerStateTable.key,
      set: { value: JSON.stringify(value), updatedAt: new Date() },
    });
}

async function writeStateWithClient(client: DatabasePoolClient, key: string, value: unknown): Promise<void> {
  await client.query(
    `INSERT INTO worker_state (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

async function inspectSafeBoundaryWithClient(client: DatabasePoolClient): Promise<{ safe: boolean; reason: string | null }> {
  const result = await client.query<{
    open_trade: boolean;
    pending_approval: boolean;
    unfinished_intent: boolean;
    unfinished_relay: boolean;
    pending_protection: boolean;
    pending_close: boolean;
  }>(`
    SELECT
      EXISTS (SELECT 1 FROM trades WHERE action = 'OPEN' AND close_time = 0) AS open_trade,
      EXISTS (SELECT 1 FROM live_approvals WHERE status = 'PENDING') AS pending_approval,
      EXISTS (
        SELECT 1 FROM execution_intents
        WHERE status IN ('PREPARED','SUBMITTING','SUBMITTED','UNRESOLVED')
      ) AS unfinished_intent,
      EXISTS (
        SELECT 1 FROM relay_tasks
        WHERE status IN (
          'PREPARED','DRY_RUN_VALIDATED','SUBMITTING','TASK_ACCEPTED',
          'TX_SUBMITTED','ORDER_CREATED','UNRESOLVED'
        )
      ) AS unfinished_relay,
      EXISTS (
        SELECT 1 FROM protection_orders
        WHERE status IN (
          'PLANNED','PREPARED','SUBMITTING','SUBMITTED',
          'ACTIVE','UNRESOLVED','FROZEN'
        )
      ) AS pending_protection,
      EXISTS (
        SELECT 1 FROM worker_state
        WHERE key = $1
          AND value IS NOT NULL
          AND btrim(value) <> ''
          AND value <> 'null'
      ) AS pending_close
  `, [SERVER_PAPER_PENDING_CLOSE_KEY]);
  const row = result.rows[0];
  if (!row) throw new Error("risk profile boundary query returned no row");
  const reasons = [
    row.open_trade ? "open positions exist" : null,
    row.pending_approval ? "pending approvals exist" : null,
    row.unfinished_intent ? "unfinished execution intents exist" : null,
    row.unfinished_relay ? "unfinished relay tasks exist" : null,
    row.pending_protection ? "pending protection orders exist" : null,
    row.pending_close ? "pending close state exists" : null,
  ].filter((reason): reason is string => reason !== null);
  return { safe: reasons.length === 0, reason: reasons.join("; ") || null };
}

async function inspectSafeBoundary(): Promise<{ safe: boolean; reason: string | null }> {
  try {
    const {
      db,
      executionIntentsTable,
      liveApprovalsTable,
      protectionOrdersTable,
      relayTasksTable,
      tradesTable,
    } = await import("@workspace/db");
    const [openTrades, approvals, intents, relayTasks, protectionOrders, pendingClose] = await Promise.all([
      db.select({ id: tradesTable.id }).from(tradesTable)
        .where(and(eq(tradesTable.action, "OPEN"), eq(tradesTable.closeTime, 0))).limit(1),
      db.select({ id: liveApprovalsTable.id }).from(liveApprovalsTable)
        .where(eq(liveApprovalsTable.status, "PENDING")).limit(1),
      db.select({ id: executionIntentsTable.id }).from(executionIntentsTable)
        .where(inArray(executionIntentsTable.status, [
          "PREPARED", "SUBMITTING", "SUBMITTED", "UNRESOLVED",
        ])).limit(1),
      db.select({ id: relayTasksTable.id }).from(relayTasksTable)
        .where(inArray(relayTasksTable.status, [
          "PREPARED", "DRY_RUN_VALIDATED", "SUBMITTING", "TASK_ACCEPTED",
          "TX_SUBMITTED", "ORDER_CREATED", "UNRESOLVED",
        ])).limit(1),
      db.select({ id: protectionOrdersTable.id }).from(protectionOrdersTable)
        .where(inArray(protectionOrdersTable.status, [
          "PLANNED", "PREPARED", "SUBMITTING", "SUBMITTED",
          "ACTIVE", "UNRESOLVED", "FROZEN",
        ])).limit(1),
      readState(SERVER_PAPER_PENDING_CLOSE_KEY),
    ]);
    const reasons = [
      openTrades.length > 0 ? "open positions exist" : null,
      approvals.length > 0 ? "pending approvals exist" : null,
      intents.length > 0 ? "unfinished execution intents exist" : null,
      relayTasks.length > 0 ? "unfinished relay tasks exist" : null,
      protectionOrders.length > 0 ? "pending protection orders exist" : null,
      pendingClose ? "pending close state exists" : null,
    ].filter((reason): reason is string => Boolean(reason));
    return { safe: reasons.length === 0, reason: reasons.join("; ") || null };
  } catch {
    return { safe: false, reason: "safe-boundary state unavailable (fail-closed)" };
  }
}

export async function requestRiskProfile(name: RiskProfileName): Promise<DesiredRiskProfile> {
  const desired: DesiredRiskProfile = {
    name,
    version: RISK_PROFILE_VERSION,
    requestedAt: new Date().toISOString(),
  };
  await writeState(DESIRED_KEY, desired);
  return desired;
}

export async function getRiskProfileStatus(base: RiskLimits): Promise<RiskProfileStatus> {
  const nowIso = new Date().toISOString();
  const [desiredRaw, appliedRaw, boundary] = await Promise.all([
    readState(DESIRED_KEY),
    readState(APPLIED_KEY),
    inspectSafeBoundary(),
  ]);
  const desired = parsePersistedDesiredRiskProfile(desiredRaw) ?? conservativeDesired(nowIso);
  const appliedState = parsePersistedAppliedRiskProfile(appliedRaw) ?? {
    name: "conservative" as const,
    version: RISK_PROFILE_VERSION,
    appliedAt: nowIso,
  };
  const applied = toSnapshot(appliedState, base);
  return {
    desired,
    applied,
    pending: desired.name !== applied.name || desired.version !== applied.version,
    safeBoundary: boundary.safe,
    reason: boundary.reason,
  };
}

export async function promoteRiskProfileAtSafeBoundary(
  base: RiskLimits,
): Promise<RiskProfileStatus> {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('risk_profile_promotion_v1'))");
    await client.query(`
      LOCK TABLE worker_state, trades, live_approvals, execution_intents,
        relay_tasks, protection_orders IN SHARE ROW EXCLUSIVE MODE
    `);

    const rows = await client.query<{ key: string; value: string }>(
      `SELECT key, value FROM worker_state WHERE key IN ($1, $2) FOR UPDATE`,
      [DESIRED_KEY, APPLIED_KEY],
    );
    const state = new Map(rows.rows.map(row => [row.key, row.value]));
    const desiredRaw = state.get(DESIRED_KEY) ?? null;
    const appliedRaw = state.get(APPLIED_KEY) ?? null;
    const desired = parsePersistedDesiredRiskProfile(desiredRaw);
    const applied = parsePersistedAppliedRiskProfile(appliedRaw);

    // 존재하는 프로필 상태 중 하나라도 손상됐다면 요청을 승격하지 않고 보수적으로 복구한다.
    if ((desiredRaw !== null && desired === null) || (appliedRaw !== null && applied === null)) {
      const nowIso = new Date().toISOString();
      const repairedDesired = conservativeDesired(nowIso);
      const repairedApplied: PersistedAppliedRiskProfile = {
        name: "conservative",
        version: RISK_PROFILE_VERSION,
        appliedAt: nowIso,
      };
      await writeStateWithClient(client, DESIRED_KEY, repairedDesired);
      await writeStateWithClient(client, APPLIED_KEY, repairedApplied);
      await client.query("COMMIT");
      return {
        desired: repairedDesired,
        applied: toSnapshot(repairedApplied, base),
        pending: false,
        safeBoundary: false,
        reason: "corrupt risk profile state repaired to conservative",
      };
    }

    const nowIso = new Date().toISOString();
    const effectiveDesired = desired ?? conservativeDesired(nowIso);
    const effectiveApplied: PersistedAppliedRiskProfile = applied ?? {
      name: "conservative",
      version: RISK_PROFILE_VERSION,
      appliedAt: nowIso,
    };
    const boundary = await inspectSafeBoundaryWithClient(client);
    const pending = effectiveDesired.name !== effectiveApplied.name;

    if (!pending || !boundary.safe) {
      await client.query("COMMIT");
      return {
        desired: effectiveDesired,
        applied: toSnapshot(effectiveApplied, base),
        pending,
        safeBoundary: boundary.safe,
        reason: boundary.reason,
      };
    }

    const promoted: PersistedAppliedRiskProfile = {
      name: effectiveDesired.name,
      version: RISK_PROFILE_VERSION,
      appliedAt: new Date().toISOString(),
    };
    await writeStateWithClient(client, APPLIED_KEY, promoted);
    await client.query("COMMIT");
    return {
      desired: effectiveDesired,
      applied: toSnapshot(promoted, base),
      pending: false,
      safeBoundary: true,
      reason: null,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}