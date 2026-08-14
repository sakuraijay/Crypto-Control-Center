/**
 * Server-side proxy for Binance USD-M Futures public REST endpoints.
 * Avoids browser CORS restrictions — the server fetches from Binance directly.
 * No API key required; all data is publicly available.
 */

import { Router } from "express";

const router = Router();

// REST API base — note: fapi.binance.com (not fstream, which is WebSocket-only)
const FSTREAM = "https://fapi.binance.com/fapi/v1";

/**
 * GET /api/binance/ticker24h
 * Returns Binance 24h ticker stats for ALL USD-M futures symbols.
 * Clients should filter the response to the symbols they care about.
 *
 * Note: Binance's `symbols` array filter param is silently ignored regardless
 * of encoding — the endpoint always returns all symbols. Client-side filtering
 * is the only reliable approach (same pattern as /api/binance/markprices).
 */
router.get("/binance/ticker24h", async (_req, res) => {
  try {
    const url = `${FSTREAM}/ticker/24hr`;

    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: "upstream error from Binance" });
      return;
    }
    const data = await upstream.json();
    // Cache 60 s — public data changes infrequently
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(data);
  } catch {
    res.status(502).json({ error: "Failed to fetch 24h stats from Binance" });
  }
});

/**
 * GET /api/binance/markprices
 * Returns mark prices and funding rates for all USD-M futures symbols.
 * Clients should filter client-side to the symbols they care about.
 */
router.get("/binance/markprices", async (_req, res) => {
  try {
    const upstream = await fetch(`${FSTREAM}/premiumIndex`);
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: "upstream error from Binance" });
      return;
    }
    const data = await upstream.json();
    res.setHeader("Cache-Control", "public, max-age=10");
    res.json(data);
  } catch {
    res.status(502).json({ error: "Failed to fetch mark prices from Binance" });
  }
});

/**
 * GET /api/binance/klines
 * Query params: symbol, interval (1m|5m|15m|1h|4h|1d), limit (max 1500), startTime, endTime
 * Returns OHLCV kline data for backtesting.
 */
router.get("/binance/klines", async (req, res) => {
  try {
    const { symbol, interval = "1h", limit = "500", startTime, endTime } = req.query as Record<string, string>;
    if (!symbol) { res.status(400).json({ error: "symbol is required" }); return; }

    const params = new URLSearchParams({ symbol, interval, limit: String(Math.min(Number(limit), 1500)) });
    if (startTime) params.set("startTime", startTime);
    if (endTime) params.set("endTime", endTime);

    const upstream = await fetch(`${FSTREAM}/klines?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) { res.status(upstream.status).json({ error: "upstream error from Binance" }); return; }
    const data = await upstream.json();
    // Cache 5 min — historical candles don't change
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(data);
  } catch {
    res.status(502).json({ error: "Failed to fetch klines from Binance" });
  }
});

export default router;
