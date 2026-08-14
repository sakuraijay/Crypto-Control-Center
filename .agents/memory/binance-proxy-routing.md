---
name: Binance proxy routing in Replit monorepo
description: How to correctly proxy Binance REST calls from the web app — critical Replit path-routing constraint
---

# Binance Proxy Routing — Replit Monorepo

## The rule
Use the **API server** (`/api-server/api/binance/...`) for browser REST calls from the web app, **not** a Vite proxy.

**Why:** The Replit path proxy at port 80 routes `/futures-web/*` → Vite dev server and `/api-server/*` → Express server (port 8080). A browser call to `/binance-proxy/...` (unknown path) returns 404 from the Replit proxy. The Vite dev-server proxy config is never reached from the browser because the Replit proxy intercepts first.

**How to apply:** In `artifacts/futures-web/src/lib/binance/markPriceStream.ts`, REST seed calls use:
- `/api-server/api/binance/ticker24h?symbols=...` → 24h stats
- `/api-server/api/binance/markprices` → mark prices / funding rates

Replit strips the `/api-server` prefix before forwarding to Express, so the server receives `/api/binance/ticker24h`.

## Binance URL gotcha
- **REST API:** `https://fapi.binance.com/fapi/v1/` ← correct
- **WebSocket stream:** `wss://fstream.binance.com/stream` ← correct
- `fstream.binance.com` is WebSocket-only; using it for REST returns "Invalid request path".

## API server routes added
- `GET /api/binance/ticker24h?symbols=["SYM",...]` → proxies to `/ticker/24hr`
- `GET /api/binance/markprices` → proxies to `/premiumIndex`
Both return real Binance public data (868 symbols for mark prices).

## Mobile
React Native native fetch has no CORS restrictions; calls `fapi.binance.com` directly.
REST base in `artifacts/futures-terminal/services/binanceMarkPriceStream.ts` must be `fapi.binance.com` (not fstream).
