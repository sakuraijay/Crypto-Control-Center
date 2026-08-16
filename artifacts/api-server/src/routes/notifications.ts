/**
 * Notification routes — Web Push (VAPID), subscription management, server-side event log.
 *
 * Architecture:
 * - Single-operator dashboard: one push subscription stored in worker_state.
 * - VAPID keys MUST be supplied via VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env vars.
 *   This file NEVER generates or stores private key material.
 * - If VAPID keys are absent → vapidReady = false → all push calls are silent no-ops.
 * - Subscription JSON stored under worker_state key "pushSubscription".
 * - Call sendPushToOperator() from any server route to deliver a push notification.
 *   It is fail-closed: if anything is wrong (no keys, no subscription, 410 expired) it
 *   silently returns without throwing.
 *
 * Routes:
 *   GET    /api/notifications/vapid-key   — public VAPID key for SW subscription
 *   POST   /api/notifications/subscribe   — store push subscription from browser
 *   DELETE /api/notifications/subscribe   — unsubscribe
 *   GET    /api/notifications/status      — push readiness + event log
 *   POST   /api/notifications/test        — log a browser notification result (+ push if ready)
 */

import { Router } from "express";
import webPush from "web-push";
import { db, workerStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

// ── VAPID configuration ───────────────────────────────────────────────────────
// Keys are read once at startup. Never generated here — operator sets env vars.
// To generate keys: npx web-push generate-vapid-keys
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  ?? "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_EMAIL   = process.env.VAPID_EMAIL       ?? "mailto:admin@localhost";

let vapidReady = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
    vapidReady = true;
    console.info("[Push] VAPID 설정 완료 — Web Push 활성");
  } catch (err) {
    console.warn("[Push] VAPID 설정 실패 (잘못된 키 형식):", (err as Error).message);
  }
} else {
  console.info("[Push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 미설정 — Web Push 비활성 (fail-closed)");
}

// ── worker_state keys ─────────────────────────────────────────────────────────
const LOG_KEY          = "notificationTestLog";
const SUBSCRIPTION_KEY = "pushSubscription";
const MAX_LOG          = 20;

// ── Types ────────────────────────────────────────────────────────────────────

export interface NotifLogEntry {
  ts:      string;
  channel: "browser" | "server" | "unknown";
  status:  "sent" | "denied" | "unsupported" | "error";
  msg:     string;
  tokenHint?: string;
}

export interface PushPayload {
  title:               string;
  body:                string;
  tag?:                string;
  requireInteraction?: boolean;
  url?:                string;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function loadLog(): Promise<NotifLogEntry[]> {
  try {
    const rows = await db.select().from(workerStateTable).where(eq(workerStateTable.key, LOG_KEY));
    return rows[0] ? (JSON.parse(rows[0].value) as NotifLogEntry[]) : [];
  } catch { return []; }
}

async function appendLog(entry: NotifLogEntry): Promise<void> {
  try {
    const existing = await loadLog();
    const updated  = [entry, ...existing].slice(0, MAX_LOG);
    const now      = new Date();
    const rows     = await db
      .select({ key: workerStateTable.key })
      .from(workerStateTable)
      .where(eq(workerStateTable.key, LOG_KEY));
    if (rows.length > 0) {
      await db.update(workerStateTable)
        .set({ value: JSON.stringify(updated), updatedAt: now })
        .where(eq(workerStateTable.key, LOG_KEY));
    } else {
      await db.insert(workerStateTable).values({ key: LOG_KEY, value: JSON.stringify(updated), updatedAt: now });
    }
  } catch { /* fire-and-forget */ }
}

async function loadSubscription(): Promise<webPush.PushSubscription | null> {
  try {
    const rows = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.key, SUBSCRIPTION_KEY));
    if (!rows[0]?.value) return null;
    return JSON.parse(rows[0].value) as webPush.PushSubscription;
  } catch { return null; }
}

async function saveSubscription(sub: webPush.PushSubscription): Promise<void> {
  const now = new Date();
  const rows = await db
    .select({ key: workerStateTable.key })
    .from(workerStateTable)
    .where(eq(workerStateTable.key, SUBSCRIPTION_KEY));
  if (rows.length > 0) {
    await db.update(workerStateTable)
      .set({ value: JSON.stringify(sub), updatedAt: now })
      .where(eq(workerStateTable.key, SUBSCRIPTION_KEY));
  } else {
    await db.insert(workerStateTable).values({
      key: SUBSCRIPTION_KEY, value: JSON.stringify(sub), updatedAt: now,
    });
  }
}

async function deleteSubscription(): Promise<void> {
  await db.delete(workerStateTable).where(eq(workerStateTable.key, SUBSCRIPTION_KEY));
}

// ── Push send — exported for use by other routes ─────────────────────────────

/**
 * sendPushToOperator — deliver a Web Push notification to the stored subscription.
 * Fail-closed: returns silently if VAPID is not configured, no subscription exists,
 * or any error occurs. Expired (410) subscriptions are auto-removed from DB.
 * Non-blocking: caller should `void sendPushToOperator(...).catch(() => {})`.
 */
export async function sendPushToOperator(payload: PushPayload): Promise<void> {
  if (!vapidReady) return;
  const sub = await loadSubscription();
  if (!sub) return;
  try {
    await webPush.sendNotification(sub, JSON.stringify(payload), { timeout: 8_000 });
    await appendLog({
      ts: new Date().toISOString(), channel: "server", status: "sent",
      msg: `Push 전송: ${payload.title.slice(0, 80)}`,
    });
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 410 || statusCode === 404) {
      // Subscription expired or invalid — remove from DB
      await deleteSubscription().catch(() => {});
      console.info("[Push] 만료된 구독 제거됨 (HTTP", statusCode, ")");
    } else {
      console.warn("[Push] 전송 실패:", (err as Error).message?.slice(0, 100));
    }
    await appendLog({
      ts: new Date().toISOString(), channel: "server", status: "error",
      msg: `Push 오류 (${statusCode ?? "?"}): ${(err as Error).message?.slice(0, 80)}`,
    });
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/notifications/vapid-key
 * Returns the VAPID public key for browser-side PushManager.subscribe().
 * Returns 503 when VAPID is not configured so the client can show a diagnostic.
 * NEVER returns the private key.
 */
router.get("/notifications/vapid-key", (_req, res) => {
  if (!vapidReady) {
    return res.status(503).json({
      ok: false,
      reason: "VAPID_UNCONFIGURED",
      hint: "서버에 VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY 환경 변수를 설정하세요. 생성: npx web-push generate-vapid-keys",
    });
  }
  return res.json({ ok: true, publicKey: VAPID_PUBLIC });
});

/**
 * GET /api/notifications/status
 * Returns push readiness, subscription status (fingerprint only), and event log.
 */
router.get("/notifications/status", async (_req, res) => {
  try {
    const log           = await loadLog();
    const sub           = await loadSubscription();
    const subscribed    = sub !== null;
    const endpointHint  = sub?.endpoint
      ? `${sub.endpoint.slice(0, 30)}…${sub.endpoint.slice(-12)}`
      : null;
    res.json({
      vapidConfigured: vapidReady,
      subscribed,
      endpointHint,
      log,
      logCount: log.length,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch notification status" });
  }
});

/**
 * POST /api/notifications/subscribe
 * Stores the PushSubscription JSON from the browser.
 * Body: { endpoint, keys: { p256dh, auth } }
 * The endpoint URL is stored for delivery; no private key material is accepted.
 */
router.post("/notifications/subscribe", async (req, res) => {
  try {
    const body = req.body as { endpoint?: unknown; keys?: unknown };
    if (typeof body.endpoint !== "string" || !body.endpoint.startsWith("https://")) {
      return res.status(400).json({ error: "Invalid subscription: endpoint must be an https:// URL" });
    }
    const sub = body as webPush.PushSubscription;
    await saveSubscription(sub);
    await appendLog({
      ts: new Date().toISOString(), channel: "browser", status: "sent",
      msg: "Web Push 구독 등록됨",
      tokenHint: `${sub.endpoint.slice(0, 30)}…`,
    });
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: "Failed to save subscription" });
  }
});

/**
 * DELETE /api/notifications/subscribe
 * Removes the stored push subscription. Idempotent.
 */
router.delete("/notifications/subscribe", async (_req, res) => {
  try {
    await deleteSubscription();
    await appendLog({
      ts: new Date().toISOString(), channel: "browser", status: "sent",
      msg: "Web Push 구독 해제됨",
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to remove subscription" });
  }
});

/**
 * POST /api/notifications/test
 * Called by the client to log a browser notification result.
 * Also sends a server-side push (if VAPID + subscription are ready).
 * Body: { channel, status, msg }
 */
router.post("/notifications/test", async (req, res) => {
  try {
    const {
      channel = "browser",
      status  = "sent",
      msg     = "테스트 알림",
    } = req.body as { channel?: string; status?: string; msg?: string };

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

    // Also send a server-side push if ready (fail-closed — never throws)
    if (safeStatus === "sent" && vapidReady) {
      void sendPushToOperator({
        title: "Crypto CTL — 알림 테스트",
        body:  "서버 측 Web Push 테스트 알림입니다. ✅",
        tag:   "ccc-test",
      });
    }

    res.json({ ok: true, entry, pushAttempted: safeStatus === "sent" && vapidReady });
  } catch {
    res.status(500).json({ error: "Failed to log notification event" });
  }
});

// ── Legacy: push token (kept for backward compat, maps to subscription) ───────
// Old clients may call POST /notifications/token; this is now superseded by
// POST /notifications/subscribe which uses the standard PushSubscription shape.
router.post("/notifications/token", async (req, res) => {
  return res.status(410).json({
    error: "Endpoint deprecated. Use POST /api/notifications/subscribe with a PushSubscription JSON.",
  });
});
router.delete("/notifications/token", async (_req, res) => {
  return res.status(410).json({ error: "Endpoint deprecated. Use DELETE /api/notifications/subscribe." });
});

export default router;
