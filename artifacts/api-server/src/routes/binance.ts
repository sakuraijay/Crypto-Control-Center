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
 * Query params: symbols = JSON-encoded array, e.g. ["BTCUSDT","ETHUSDT"]
 * Returns Binance 24h ticker stats for the requested symbols.
 */
router.get("/binance/ticker24h", async (req, res) => {
  try {
    const { symbols } = req.query as { symbols?: string };
    const url = symbols
      ? `${FSTREAM}/ticker/24hr?symbols=${encodeURIComponent(symbols)}`
      : `${FSTREAM}/ticker/24hr`;

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

export default router;
