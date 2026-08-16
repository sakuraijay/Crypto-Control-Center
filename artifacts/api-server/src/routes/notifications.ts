/**
 * Notification routes — push-token registration, test send, server-side event log.
 *
 * Architecture notes:
 * - This server acts as the operator's single-user dashboard, so subscriptions are
 *   stored per-key in worker_state (no per-user auth required).
 * - Browser Notification API (desktop alert) is triggered client-side; this route
 *   records the outcome and provides a log so the operator can verify delivery.
 * - No secrets, device tokens, or private keys are logged or returned.
 */

import { Router } from "express";
import { db, workerStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const LOG_KEY   = "notificationTestLog";
const TOKEN_KEY = "notificationPushToken";
const MAX_LOG   = 20;

// ── Types ────────────────────────────────────────────────────────────────────

export interface NotifLogEntry {
  ts:      string;               // ISO timestamp
  channel: "browser" | "server" | "unknown";
  status:  "sent" | "denied" | "unsupported" | "error";
  msg:     string;               // short human-readable result
  /** Fingerprint only — never the full token */
  tokenHint?: string;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function loadLog(): Promise<NotifLogEntry[]> {
  try {
    const rows = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.key, LOG_KEY));
    return rows[0] ? (JSON.parse(rows[0].value) as NotifLogEntry[]) : [];
  } catch { return []; }
}

async function appendLog(entry: NotifLogEntry): Promise<void> {
  const existing = await loadLog();
  const updated  = [entry, ...existing].slice(0, MAX_LOG);
  const now = new Date();
  const rows = await db
    .select({ key: workerStateTable.key })
    .from(workerStateTable)
    .where(eq(workerStateTable.key, LOG_KEY));
  if (rows.length > 0) {
    await db
      .update(workerStateTable)
      .set({ value: JSON.stringify(updated), updatedAt: now })
      .where(eq(workerStateTable.key, LOG_KEY));
  } else {
    await db.insert(workerStateTable).values({
      key: LOG_KEY, value: JSON.stringify(updated), updatedAt: now,
    });
  }
}

/** Return a safe fingerprint of a push token for logging (never the full value). */
function tokenFingerprint(token: unknown): string | undefined {
  if (typeof token !== "string" || token.length < 8) return undefined;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/notifications/status
 * Returns the recent notification event log and current push-token registration status.
 * Never returns the actual token value.
 */
router.get("/notifications/status", async (_req, res) => {
  try {
    const log = await loadLog();
    // Check token registration status (without exposing the token)
    const tokenRows = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.key, TOKEN_KEY));
    const tokenRegistered = tokenRows.length > 0 && Boolean(tokenRows[0].value);
    const tokenHint = tokenRegistered
      ? tokenFingerprint(tokenRows[0].value)
      : undefined;
    res.json({
      tokenRegistered,
      tokenHint,
      log,
      logCount: log.length,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch notification status" });
  }
});

/**
 * POST /api/notifications/token
 * Register (or update) a push token from the client.
 * Accepts {token: string}. Stores only a fingerprint in the log; the full token
 * is stored in worker_state for server-side push (never logged or returned).
 *
 * Security: token is treated as opaque — validated only for basic string shape.
 */
router.post("/notifications/token", async (req, res) => {
  try {
    const { token } = req.body as { token?: unknown };
    if (typeof token !== "string" || token.trim().length < 8) {
      return res.status(400).json({ error: "Invalid token: must be a non-empty string ≥ 8 chars" });
    }
    const trimmed = token.trim();
    const now = new Date();
    const rows = await db
      .select({ key: workerStateTable.key })
      .from(workerStateTable)
      .where(eq(workerStateTable.key, TOKEN_KEY));
    if (rows.length > 0) {
      await db
        .update(workerStateTable)
        .set({ value: trimmed, updatedAt: now })
        .where(eq(workerStateTable.key, TOKEN_KEY));
    } else {
      await db.insert(workerStateTable).values({ key: TOKEN_KEY, value: trimmed, updatedAt: now });
    }
    // Log registration event (fingerprint only)
    await appendLog({
      ts:        now.toISOString(),
      channel:   "browser",
      status:    "sent",
      msg:       "푸시 토큰 등록됨",
      tokenHint: tokenFingerprint(trimmed),
    });
    return res.json({ ok: true, tokenHint: tokenFingerprint(trimmed) });
  } catch {
    return res.status(500).json({ error: "Failed to register token" });
  }
});

/**
 * DELETE /api/notifications/token
 * Unregister the stored push token.
 */
router.delete("/notifications/token", async (_req, res) => {
  try {
    await db
      .delete(workerStateTable)
      .where(eq(workerStateTable.key, TOKEN_KEY));
    await appendLog({
      ts: new Date().toISOString(), channel: "browser",
      status: "sent", msg: "푸시 토큰 등록 해제됨",
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to unregister token" });
  }
});

/**
 * POST /api/notifications/test
 * Called by the client after a browser notification attempt to log the result.
 * Body: { channel, status, msg }
 * - channel: 'browser' | 'server'
 * - status:  'sent' | 'denied' | 'unsupported' | 'error'
 * - msg:     short description (max 200 chars)
 *
 * This is also the route that was returning 404 — now implemented.
 */
router.post("/notifications/test", async (req, res) => {
  try {
    const {
      channel = "browser",
      status  = "sent",
      msg     = "테스트 알림",
    } = req.body as { channel?: string; status?: string; msg?: string };

    // Validate status values
    const validStatuses = ["sent", "denied", "unsupported", "error"];
    const safeStatus = validStatuses.includes(String(status))
      ? (status as NotifLogEntry["status"])
      : "error";

    const entry: NotifLogEntry = {
      ts:      new Date().toISOString(),
      channel: (["browser", "server"].includes(String(channel)) ? channel : "unknown") as NotifLogEntry["channel"],
      status:  safeStatus,
      msg:     String(msg).slice(0, 200),
    };
    await appendLog(entry);
    res.json({ ok: true, entry });
  } catch {
    res.status(500).json({ error: "Failed to log notification event" });
  }
});

export default router;
