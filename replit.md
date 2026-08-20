# Crypto Control Center

A personal, single-operator crypto trading control center built on GMX V2 (Arbitrum One). The AI autonomously selects the operating state (SPOT / LONG / SHORT / HEDGE / CASH), symbol, sizing, leverage, TP/SL, and hedging every 60 seconds. The operator's role is monitoring, LIVE order approval gate, Emergency Stop, and force-close only.

Login is **disabled in dev** (bypassed automatically). Never re-enable via code — use an env var.

---

## ✅ READ-ONLY ACCOUNT VALIDATION READY

**Status as of 2026-08-15 — All regression checks PASS. GitHub origin/main synced to `454f7a0`.**

The system is cleared for read-only real-wallet connection and account verification.
No signing, no on-chain transactions, no private key storage. `LIVE_EXECUTION_LOCKED = true as const`.

See "Read-Only 연결 검증" checklist at the bottom of the Settings page in the app.

---

## Architecture

### Three services, one product

| Service | Dir | Purpose |
|---|---|---|
| API Server | `artifacts/api-server/` | Express 5 — GMX oracle prices (3 s poll), candles, markets, executor status, AI decision persistence |
| Web app | `artifacts/futures-web/` | Vite + React 19 dark dashboard — primary operator surface |
| Mobile app | `artifacts/futures-terminal/` | Expo SDK 54 React Native — companion monitoring app |

### AI Engine (5-State)

The trading engine lives in `artifacts/futures-web/src/lib/ai/`:
- `types.ts` — `AiOperatingState`, `AiEngineDecision`, `SymbolAnalysis`, `IndicatorValues`, `HedgeParams`, `AiEngineStats`
- `indicators.ts` — EMA, RSI, ATR%, momentum, composite bull/bear scoring
- `stateEngine.ts` — `runAiEngine()` pure function: selects state + symbol + all trade params + risk gates
- `../context/AiEngineContext.tsx` — React context: 60 s cycle, price buffer, paper auto-execution, LIVE approval queue, decision persistence

**Operator controls only:** Emergency Stop · Pause/Resume · LIVE order approve/reject · Force-close all positions. AI decides everything else.

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
TradingContext.placeOrder()         (simulated locally)
  ↓ live mode (task #32)
GMX One-Click subaccount → Arbitrum One
```

### GMX V2 specifics

- **Price source:** `arbitrum-api.gmxinfra.io/prices/tickers` (REST, not WebSocket)
- **Candles:** `stats.gmx.io/api/candleSticks` with synthetic random-walk fallback
- **Symbols:** GMX index symbols — `"ETH"`, `"BTC"`, `"SOL"`, `"ARB"`, `"LINK"` — displayed as `"ETH/USD"`. No USDT suffix anywhere.
- **Position model:** USD-denominated — `sizeInUsd` + `collateralUsd` (not `size` + `margin`)
- **Maintenance margin:** 1% (GMX standard)
- **Collateral:** USDC
- **Network:** Arbitrum One, chainId 42161

### Security model

GMX private keys and seed phrases are **never stored in Replit**. The web/mobile apps hold no trading credentials. For LIVE execution, a GMX One-Click delegated subaccount key is held only by the GMX protocol — Replit sends signed approval decisions, not on-chain transactions (task #32 implements on-chain execution).

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
  dashboard.tsx    — AiStateCard (primary view), executor status widget, KPI bar
  positions.tsx    — Open positions (sizeInUsd / collateralUsd)
  watchlist.tsx    — GMX perpetuals price monitor
  strategy.tsx     — Risk limits (read-only KPIs for AI)
  ai-log.tsx       — 5-state decision history with full indicator detail + LIVE approval history
  backtest.tsx     — GMX candle backtester (BTC/ETH/SOL/ARB/LINK…)
  history.tsx      — Trade history + CSV export
  settings.tsx     — System status, GMX executor health, emergency controls

lib/
  ai/types.ts          — All AI type definitions
  ai/indicators.ts     — EMA, RSI, ATR%, momentum, bull/bear scoring
  ai/stateEngine.ts    — Pure state-selection logic
  backtest/engine.ts   — OHLCV backtester (parseGmxCandles)
  gmx/markets.ts       — MARKET_BY_SYMBOL Map, displaySymbol()
  gmx/priceStream.ts   — GmxPriceStream class (polls API server)
  context/
    AiEngineContext.tsx   — 60 s decision cycle, paper execution, LIVE approval queue, operatingMode
    AppContext.tsx         — EngineState, Emergency Stop
    TradingContext.tsx     — Paper positions, placeOrder(), closeAllPositions()
    WatchlistContext.tsx   — Price feed (change24h field)
    StrategyContext.tsx    — Risk limits

components/
  dashboard/AiStateCard.tsx          — State badge, confidence, reasoning, auto-execute toggle
  dashboard/ExecutorStatusWidget.tsx — Replit executor health (RPC status, deployment mode, AI cycle)
  shell/Sidebar.tsx                  — Nav + CRYPTO CTL logo
  trading/RiskAlertMonitor.tsx       — Real-time risk breach alerts
```

### Mobile (`artifacts/futures-terminal/`)
```
app/(tabs)/
  index.tsx      — Dashboard (account, positions overview, live approval gate)
  positions.tsx  — Position cards
  watchlist.tsx  — Price monitor
  strategy.tsx   — Risk limits
  backtest.tsx   — GMX candle backtester
  history.tsx    — Trade history
  settings.tsx   — GMX executor status, emergency controls, notifications

contexts/
  AiEngineContext.tsx   — AI engine + operatingMode + LIVE approval queue
  TradingContext.tsx    — closeAllPositions() (not clearAllPositions)
  WatchlistContext.tsx  — GMX price feed

services/
  gmxPriceStream.ts    — Mobile GMX oracle stream
  notifications.ts     — Push notification helpers

utils/
  backtestEngine.ts    — parseGmxCandles() + runBacktest()
```

### API Server (`artifacts/api-server/src/routes/`)
```
gmx.ts      — /api/gmx/prices · /api/gmx/markets · /api/gmx/candles
executor.ts — /api/executor/status · /api/executor/execute
ai.ts       — POST/GET /api/ai/decisions (persist AI decision log)
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
- **Executor status field** — `gmxConnected` is the canonical field; `gmxRpcHealthy` is an alias for backwards compatibility; `networkChainId` is always 42161

## User preferences

- Private single-operator app. No multi-user, no cloud sync.
- Login/auth is disabled in dev. Always-dark theme. Never flip to light mode.
- AI controls all trading decisions. Operator = monitor + LIVE approval gate + emergency stop only.
- GMX V2 on Arbitrum One is the **only** exchange. No Binance. No USDT pairs.
- Collateral is USDC. Sizing is always USD-denominated (`sizeInUsd`).
- Daily target is a monitoring KPI only — never enforced by logic.

## Development focus (current priority)

**Desktop-first web app only.** Do not add new mobile (Expo/React Native) features.

- Optimize `artifacts/futures-web/` for desktop monitors (1280px+ / laptop browsers).
- Responsive CSS is kept as a basic fallback only — do **not** actively optimize for mobile.
- The `artifacts/futures-terminal/` (Expo) codebase is preserved but frozen — no new UI/nav/push-notification work.
- Priority areas: dashboard usability, GMX V2 market/position/order flows, AI decision logs, risk controls, emergency controls, Internal Executor/Reserved VM execution health, Paper/Testnet/LIVE modes, GMX One-Click connection status.
- Internal Replit Executor (`/api/executor/*`) is the default execution path. GMX One-Click on-chain execution is task #32.
- Mobile-specific tasks (push notifications, mobile Settings UI) are cancelled — focus is the web terminal.
- **모든 에이전트 메시지/상태 보고/설명은 한국어로 작성.** (Agent language: Korean only)

## Agent user-input and HOLD policy

- 사용자 입력 또는 수동 조작이 필요하면 요청 시각, 필요한 행동, 재개 조건을 기록하고 기다린다.
- 1시간 동안 응답이 없어도 승인으로 추정하거나 필요한 행동을 우회하지 않는다. 해당 항목만 안전한 `HOLD`로 전환하고, 의존하지 않는 개발·테스트·문서화만 계속한다.
- 사용자가 돌아오면 현재 코드, 배포, CI, 잠금, signer 및 보안 상태를 먼저 다시 검증한 뒤 최신 사실에 따라 재개한다.
- LIVE 잠금 해제, 실제 서명·주문·자금 이동, Owner Approval, delegated signer 활성화/복호화, DB 초기화·삭제, HWM 또는 trading capital 변경, force push, rebase/history rewrite, PR merge는 항상 별도의 명시적 승인이 필요하다. 1시간 규칙으로 절대 우회하지 않는다.

### Current manual-action HOLDs

Request recorded at: `2026-08-20T13:59:15Z`

| HOLD | Required action | Resume condition |
|---|---|---|
| Owner Approval | 운영자가 현재 owner-wallet payload를 명시적으로 승인 | 사용자 복귀 후 release SHA, PAPER/LIVE 잠금, payload, deployment 재검증 |
| MetaMask signature | 운영자가 정확한 payload를 직접 검토하고 서명 | 최신 보안 상태 재검증 후 wallet 사용 가능 확인 |
| Delegated signer activation | binding/revocation 검토 후 별도 활성화 승인 | 최신 read-only signer/deployment 검사와 명시적 승인 |
| LIVE Canary | 모든 blocker 해소 후 bounded Canary 별도 승인 | 최신 CI/release/deployment/RPC/decimals/cost/stop evidence와 안전 검토 |
| Real orders/funds | 정확한 주문/자금 action 별도 승인 | action-specific 승인; 시간 경과로 추정 금지 |

이 HOLD들은 독립적인 PAPER read-only diagnostics를 막지 않는다. Owner Approval 준비,
MetaMask 호출, signer 초기화/복호화, preflight token, 서명, prepare/submit, 주문,
자금 이동, DB write, HWM 또는 trading capital 변경을 자동으로 유발해서는 안 된다.
