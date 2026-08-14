---
name: VPS configuration persistence pattern
description: How VPS connection metadata is stored on web vs mobile
---

**Web app:** Uses `VpsContext` / `VpsProvider` wired into the global provider chain. Config persisted to `localStorage` with key `@futures_vps_config`. Exposes `config`, `status`, `latencyMs`, `errorMsg`, `saveConfig()`, `testConnection()`, `disconnect()`.

**Mobile app:** Uses local `useState` + `AsyncStorage` with key `@futures_vps_config` directly inside the Settings screen. No separate context — the screen manages its own VPS form state and persists on blur/test.

**Why:** The web has many pages that might need VPS status (sidebar badge, etc.), so a context is appropriate. The mobile VPS config only appears on the Settings tab, so a context would be overengineering.

**How to apply:** If mobile needs VPS status on other screens in the future, promote the state to a context at that point. For now, keep it local to the Settings screen.
