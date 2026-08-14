/**
 * VPS proxy routes — GMX V2 / Arbitrum One
 *
 * The API server acts as a CORS bridge between clients and the private VPS.
 * When VPS is unreachable, returns a synthetic OFF status so clients degrade
 * gracefully without CORS / mixed-content errors.
 *
 * VPS status now reflects GMX connection health instead of Binance API keys:
 *   gmxConnected        — VPS ↔ GMX API / RPC is healthy
 *   walletAddress       — primary wallet monitored by VPS (never the private key)
 *   subaccountAddress   — delegated One-Click subaccount in use
 *   subaccountExpiresAt — ISO timestamp of subaccount authorization expiry
 *   subaccountActionsRemaining — remaining authorized actions
 *   networkChainId      — 42161 (Arbitrum One)
 */

import { Router } from "express";

const router = Router();
const TIMEOUT = 5_000;

function offStatus(extra: Record<string, unknown> = {}) {
  return {
    state: "OFF",
    unattendedArmed: false,
    uptimeSeconds: null,
    lastHeartbeat: null,
    heartbeatLatencyMs: null,
    lastMarketUpdate: null,
    lastStrategyCycle: null,
    lastRestart: null,
    reconciliation: { status: "idle", matchedPositions: 0, totalPositions: 0, lastAt: null },
    // GMX connection status
    gmxConnected: false,
    walletAddress: null,
    subaccountAddress: null,
    subaccountExpiresAt: null,
    subaccountActionsRemaining: null,
    networkChainId: 42161,
    strategyVersion: null,
    riskLock: null,
    vpsReachable: false,
    ...extra,
  };
}

function buildBase(host: string, port: string, ssl: string | boolean | undefined) {
  const scheme = (ssl === "true" || ssl === true) ? "https" : "http";
  return `${scheme}://${host.trim()}:${port ?? "8080"}`;
}

// ── GET /vps/status ───────────────────────────────────────────────────────────
router.get("/vps/status", async (req, res) => {
  const { host, port, ssl } = req.query as Record<string, string | undefined>;

  if (!host?.trim()) {
    return res.json(offStatus({ reason: "not_configured" }));
  }

  try {
    const base = buildBase(host, port ?? "8080", ssl);
    const start = Date.now();
    const response = await fetch(`${base}/api/status`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const latency = Date.now() - start;

    if (!response.ok) {
      return res.json(offStatus({ vpsReachable: true, httpStatus: response.status }));
    }

    const data = (await response.json()) as Record<string, unknown>;
    return res.json({ ...data, heartbeatLatencyMs: latency, vpsReachable: true });
  } catch {
    return res.json(offStatus({ vpsReachable: false }));
  }
});

// ── POST /vps/arm ─────────────────────────────────────────────────────────────
router.post("/vps/arm", async (req, res) => {
  const { host, port, ssl } = req.body as { host?: string; port?: string; ssl?: boolean };

  if (!host?.trim()) {
    return res.status(400).json({ ok: false, error: "VPS host is required" });
  }

  try {
    const base = buildBase(host, port ?? "8080", ssl);
    const response = await fetch(`${base}/api/arm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok) {
      return res.status(502).json({ ok: false, error: `VPS returned HTTP ${response.status}` });
    }
    return res.json(await response.json());
  } catch (e: unknown) {
    return res.status(502).json({ ok: false, error: "VPS unreachable", detail: (e as Error).message });
  }
});

// ── POST /vps/disarm ──────────────────────────────────────────────────────────
router.post("/vps/disarm", async (req, res) => {
  const { host, port, ssl } = req.body as { host?: string; port?: string; ssl?: boolean };

  if (!host?.trim()) {
    return res.status(400).json({ ok: false, error: "VPS host is required" });
  }

  try {
    const base = buildBase(host, port ?? "8080", ssl);
    const response = await fetch(`${base}/api/disarm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok) {
      return res.status(502).json({ ok: false, error: `VPS returned HTTP ${response.status}` });
    }
    return res.json(await response.json());
  } catch (e: unknown) {
    return res.status(502).json({ ok: false, error: "VPS unreachable", detail: (e as Error).message });
  }
});

// ── POST /vps/execute ─────────────────────────────────────────────────────────
// Forwards an operator-approved AI decision to the VPS for live GMX execution.
// The VPS holds only the GMX One-Click subaccount key; primary wallet stays safe.
router.post("/vps/execute", async (req, res) => {
  const { host, port, ssl } = req.query as Record<string, string | undefined>;

  // Without VPS config we can't forward — return a clear error so the UI can surface it
  if (!host?.trim()) {
    return res.status(400).json({
      ok: false,
      error: "VPS not configured — go to Settings and set the VPS host/port",
    });
  }

  const body = req.body as Record<string, unknown>;
  if (!body.symbol || !body.executionType) {
    return res.status(400).json({ ok: false, error: "Missing required fields: symbol, executionType" });
  }

  try {
    const base = buildBase(host, port ?? "8080", ssl);
    const response = await fetch(`${base}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return res.status(502).json({ ok: false, error: `VPS returned HTTP ${response.status}`, detail: text });
    }

    const data = (await response.json()) as Record<string, unknown>;
    return res.json({ ok: true, ...data });
  } catch (e: unknown) {
    return res.status(502).json({ ok: false, error: "VPS unreachable", detail: (e as Error).message });
  }
});

export default router;
