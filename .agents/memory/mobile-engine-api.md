---
name: Mobile EngineContext vs TradingContext APIs
description: Which context owns which function — critical for mobile settings/dashboard screens
---

In the Expo mobile app:

- `useEngine()` from `EngineContext` exposes: `closeAllPositions` (async, engine-level), `cancelOpenOrders`, `triggerEmergencyStop`, `resetFromEmergency`, `toggleStopNewOrders`, `stopNewOrdersActive`, `engineState`
- `useTrading()` from `TradingContext` exposes: `clearAllPositions` (sync, state reset), `closePosition`, `placeOrder`, `updatePositionRisk`, `account`, `positions`, `trades`

**Why:** The engine context manages the state machine; the trading context manages position/trade state. They use different function names for "close all" — mixing them up causes runtime errors.

**How to apply:** When implementing settings/controls screens, destructure `closeAllPositions` from `useEngine()` for the engine-side call, and `clearAllPositions` from `useTrading()` for the state reset. Do not cross-import.
