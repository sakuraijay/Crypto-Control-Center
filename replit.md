# Crypto Control Center

A personal, single-operator crypto trading control center built on GMX V2 (Arbitrum One). The AI autonomously selects the operating state (SPOT / LONG / SHORT / HEDGE / CASH), symbol, sizing, leverage, TP/SL, and hedging every 60 seconds. The operator's role is monitoring, pause/resume, Emergency Stop, and force-close only.

Login is **disabled in dev** (bypassed automatically). Never re-enable via code — use an env var.

---

## Architecture

### Three services, one product

| Service | Dir | Purpose |
|---|---|---|
| API Server | `artifacts/api-server/` | Express 5 proxy — GMX oracle prices (3 s poll), candles, markets, VPS state, AI decision persistence |
| Web app | `artifacts/futures-web/` | Vite + React 19 dark dashboard — primary operator surface |
| Mobile app | `artifacts/futures-terminal/` | Expo SDK 54 React Native — companion monitoring app |

### AI Engine (5-State)

The trading engine lives in `artifacts/futures-web/src/lib/ai/`:
- `types.ts` — `AiOperatingState`, `AiEngineDecision`, `SymbolAnalysis`, `IndicatorValues`, `HedgeParams`, `AiEngineStats`
- `indicators.ts` — EMA, RSI, ATR%, momentum, composite bull/bear scoring
- `stateEngine.ts` — `runAiEngine()` pure function: selects state + symbol + all trade params + risk gates
- `../context/AiEngineContext.tsx` — React context: 60 s cycle, price buffer, paper auto-execution, decision persistence

**Operator controls only:** Emergency Stop · Pause/Resume · Force-close all positions. AI decides everything else.

### Data flow

```
GMX oracle (arbitrum-api.gmxinfra.io)
  ↓ every 3 s
API Server /api/gmx/prices
  ↓ poll
Web/Mobile WatchlistContext (price buffer)
  ↓ every 60 s
AiEngineContext → runAiEngine() → AiEngineDecision
  ↓ paper mode
TradingContext.placeOrder()   (simulated locally)
  ↓ live mode (future)
VPS → GMX One-Click subaccount → Arbitrum One
```

### GMX V2 specifics

- **Price source:** `arbitrum-api.gmxinfra.io/prices/tickers` (REST, not WebSocket)
- **Candles:** `stats.gmx.io/api/candleSticks` with synthetic random-walk fallback
- **Symbols:** GMX index symbols — `"ETH"`, `"BTC"`, `"SOL"`, `"ARB"`, `"LINK"` — displayed as `"ETH/USD"`. No USDT suffix anywhere.
- **Position model:** USD-denominated — `sizeInUsd` + `collateralUsd` (not `size` + `margin`)
- **Maintenance margin:** 1% (GMX standard)
- **Collateral:** USDC
- **Network:** Arbitrum One, chainId 42161

### VPS safety model

The VPS holds only a GMX One-Click **subaccount** key — never the primary wallet key. The web/mobile apps never hold any trading credentials. ARM → RUNNING flow requires the operator to explicitly authorise unattended trading.

---

## Running the project

```bash
# Start all services
pnpm --filter @workspace/api-server run dev       # API server
pnpm --filter @workspace/futures-web run dev      # Web app
pnpm --filter @workspace/futures-terminal run dev # Mobile (Expo)
```

Or use the Replit workflow buttons — they inject PORT and EXPO_* env vars automatically.

**Mobile:** scan the QR code in Expo dev server output with Expo Go.

---

## Key file locations

### Web (`artifacts/futures-web/src/`)
```
pages/
  dashboard.tsx    — AiStateCard (primary view), VPS panel, KPI bar
  positions.tsx    — Open positions (sizeInUsd / collateralUsd)
  watchlist.tsx    — GMX perpetuals price monitor
  strategy.tsx     — Risk limits (read-only KPIs for AI)
  ai-log.tsx       — 5-state decision history with full indicator detail
  backtest.tsx     — GMX candle backtester (BTC/ETH/SOL/ARB/LINK…)
  history.tsx      — Trade history + CSV export
  settings.tsx     — VPS config (host/port/SSL, GMX wallet/subaccount)

lib/
  ai/types.ts          — All AI type definitions
  ai/indicators.ts     — EMA, RSI, ATR%, momentum, bull/bear scoring
  ai/stateEngine.ts    — Pure state-selection logic
  backtest/engine.ts   — OHLCV backtester (parseGmxCandles)
  gmx/markets.ts       — MARKET_BY_SYMBOL Map, displaySymbol()
  gmx/priceStream.ts   — GmxPriceStream class (polls API server)
  context/
    AiEngineContext.tsx   — 60 s decision cycle, paper execution
    AppContext.tsx         — EngineState, Emergency Stop
    TradingContext.tsx     — Paper positions, placeOrder(), closeAllPositions()
    WatchlistContext.tsx   — Price feed (change24h field)
    VpsContext.tsx         — VPS ARM/DISARM, operating mode
    StrategyContext.tsx    — Risk limits

components/
  dashboard/AiStateCard.tsx     — State badge, confidence, reasoning, auto-execute toggle
  shell/Sidebar.tsx              — Nav + CRYPTO CTL logo
  vps/VpsStatusPanel.tsx         — VPS connection + ARM button
  trading/RiskAlertMonitor.tsx   — Real-time risk breach alerts
```

### Mobile (`artifacts/futures-terminal/`)
```
app/(tabs)/
  index.tsx      — Dashboard (account, positions overview)
  positions.tsx  — Position cards
  watchlist.tsx  — Price monitor
  strategy.tsx   — Risk limits
  backtest.tsx   — GMX candle backtester
  history.tsx    — Trade history
  settings.tsx   — VPS config + Crypto Control Center version

contexts/
  TradingContext.tsx    — closeAllPositions() (not clearAllPositions)
  WatchlistContext.tsx  — GMX price feed
  VpsContext.tsx        — VPS state

services/
  gmxPriceStream.ts    — Mobile GMX oracle stream
  notifications.ts     — Push notification helpers

utils/
  backtestEngine.ts    — parseGmxCandles() + runBacktest()
```

### API Server (`artifacts/api-server/src/routes/`)
```
gmx.ts   — /api/gmx/prices · /api/gmx/markets · /api/gmx/candles
vps.ts   — /api/vps/status · /api/vps/arm · /api/vps/disarm
ai.ts    — POST /api/ai/decisions (persist AI decision log)
```

---

## Important constraints

- **Vite proxy doesn't work in Replit** — browser must use `/api-server/api/…` prefix directly
- **Express 5 wildcards** — use `/{*path}` or regex, never `*` or `(.*)`
- **CORS** — `cors({ origin: true, credentials: true })` via `app.use()` only (no `app.options(...)`)
- **expo-notifications** — must be `~0.32.17` for Expo SDK 54; v57.x crashes Metro
- **Mobile uses `closeAllPositions`** — not `clearAllPositions` (EngineContext API name differs)
- **WatchlistSymbol price-change field** — `change24h` (not `changePercent24h`)
- **MARKET_BY_SYMBOL** — is a `Map<string, GmxMarket>`, use `.get(sym)` not bracket access
- **EngineState values** — `'PAPER_TRADING' | 'LIVE_READY' | 'LIVE_TRADING' | 'RISK_LOCKED' | 'EMERGENCY_STOP'` — no `'RUNNING'`
- **calendar.tsx + spinner.tsx** — pre-existing React 19 ref-type TS errors; ignore
- **NEVER create app.config.ts/js** — use app.json only (required for Expo Launch)

## User preferences

- Private single-operator app. No multi-user, no cloud sync.
- Login/auth is disabled in dev. Always-dark theme. Never flip to light mode.
- AI controls all trading decisions. Operator = monitor + emergency stop only.
- GMX V2 on Arbitrum One is the **only** exchange. No Binance. No USDT pairs.
- Collateral is USDC. Sizing is always USD-denominated (`sizeInUsd`).
- Daily target is a monitoring KPI only — never enforced by logic.
