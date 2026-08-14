# Futures Terminal

A personal Binance USD-M Futures trading control center for iOS and Android. Professional dark trading interface running in Paper/Mock mode — designed to later connect to a separate private VPS execution service.

## Run & Operate

- `pnpm --filter @workspace/futures-terminal run dev` — run the Expo dev server
- Scan the QR code in the Expo dev server output with **Expo Go** to test on a real device
- The app runs fully locally — no backend required for the first version

## Stack

- Expo SDK 54, React Native 0.81, TypeScript 5.9
- Expo Router (file-based routing)
- React Context for shared state (AuthContext, EngineContext, TradingContext, WatchlistContext, StrategyContext)
- AsyncStorage for persistence (PIN, strategy config, watchlist, engine state)
- Inter font (400/500/600/700) via @expo-google-fonts/inter
- @expo/vector-icons (Feather + SF Symbols on iOS)
- expo-haptics for feedback, expo-blur for tab bar

## Where things live

- `artifacts/futures-terminal/` — entire Expo app
- `app/(tabs)/` — 6 main screens: index (Dashboard), positions, watchlist, strategy, history, settings
- `app/login.tsx` — PIN auth screen (setup + verify)
- `contexts/` — AuthContext, EngineContext, TradingContext, WatchlistContext, StrategyContext
- `components/` — EngineStatusBadge, PositionCard, WatchlistItem, ScoreBar, ConfirmModal
- `constants/colors.ts` — always-dark trading theme (primary #00C4FF, accent #F0B90B)
- `constants/mockData.ts` — all mock positions, trades, watchlist, strategy logs

## Architecture decisions

- **Always-dark theme**: both light and dark color schemes use the same dark palette — trading terminals never flip to light mode
- **PAPER mode locked**: default is PAPER_TRADING; live trading cannot enable automatically (state machine guard)
- **No backend for v1**: all state in AsyncStorage + React Context; VPS connection is a v2 feature
- **Credential-free mobile client**: sensitive API keys stay on VPS — the mobile app never holds trading credentials
- **Engine state machine**: OFFLINE → MONITORING → PAPER_TRADING → LIVE_READY → LIVE_TRADING (with RISK_LOCKED and EMERGENCY_STOP as interrupt states)
- **Double-confirm for close-all**: two sequential confirmation dialogs before closing all positions

## Product

- **Login**: 4-digit PIN setup and verification. "PAPER TRADING MODE" badge always visible.
- **Dashboard**: Account balance, margin, PNL (today/unrealized/weekly), position count, quick controls (stop new orders, cancel orders), prominent Emergency Stop button.
- **Positions**: Live-ticking mock positions (BTC, ETH, SOL) with entry/mark/liq prices, unrealized P&L, ROE, and individual close buttons.
- **Watchlist**: Dynamic symbol list (add/remove). Each symbol shows price, 24h change, multi-timeframe scores (1H/4H/1D), and combined LONG/SHORT bias.
- **Strategy**: Toggle-based indicator config (EMA, RSI, MACD, BB, Volume Breakout, Price Breakout, MTF Trend, Funding Rate Filter, BTC Direction, Combined Scoring) + 10 risk limit sliders.
- **History**: Trade history with P&L per trade and strategy logs with level badges (INFO/WARN/TRADE).
- **Settings**: Engine mode display, VPS config placeholder, engine controls (stop orders / cancel orders / close-all with double confirm), Emergency Stop, lock app.

## User preferences

- This is a private, single-user app. No multi-user or cloud sync.
- Default mode is always PAPER/MOCK. Live trading must never enable automatically.
- Credentials (Binance API keys) must never be stored on the mobile device.
- Designed for eventual App Store (iOS) and Google Play (Android) submission.

## Gotchas

- Run `pnpm --filter @workspace/futures-terminal run dev` via the workflow tool, not directly in the shell — the workflow injects PORT and EXPO_* env vars.
- NEVER create app.config.ts or app.config.js — use app.json only (required for Expo Launch).
- The `useColors()` hook returns both standard tokens AND custom trading tokens (long, short, warning, surface2) — never hardcode hex values in components.
- Price simulation runs every 3 seconds via setInterval in TradingContext and WatchlistContext — do not add additional intervals for price updates.

## Pointers

- See the `expo` skill for Expo-specific patterns and pitfalls.
- See the `pnpm-workspace` skill for monorepo structure details.
