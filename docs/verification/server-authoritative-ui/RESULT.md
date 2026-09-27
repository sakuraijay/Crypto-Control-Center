# Server-authoritative Virtual400 UI

Supervision: CCC-SUPERVISION-20260920-04. User approved immediate removal/fix of the confusing browser AI panel and the previously proposed server-authoritative direction.

## Implementation and review

- Removed legacy AiState, browser market ranking, daily target, and synthetic health/pause displays. Deleted browser decision scheduler, tick analysis, automatic PAPER entry/CASH close, local risk-state synthesis and decision/approval creation from AiEngineContext.
- Retained persisted decision history, existing explicit approval/retry/rejection review, notification controls, server worker strategies/Risk/protection/settlement and manual trading routes. Pure strategy modules remain reusable/testable; they are no longer scheduled from the browser context.
- VirtualPaper400Provider supplies one read-only, bounded, non-overlapping polling stream shared by Dashboard, Sidebar, execution widget and AI history page. Newer requests supersede older responses. Unmount aborts polls. Server runtimeFresh plus heartbeat age <=120s is required; failed reads discard active claims and stale balances.
- Virtual card shows saved policy, last server judgment, NO_TRADE/blocked/STOP distinctions, per-symbol evidence and existing cost/PnL journal. START/STOP remains explicit and PIN-authenticated; no lifecycle writes occur on mount/reload. Unknown state disables START. Standard/history labels distinguish their account scope.
- No API-server, database, policy, session, authentication, deployment topology or safety-secret modifications. Deleting a view-only browser guard does not change the authoritative server Risk engine. Existing manual protection monitor remains mounted.

## Local validation

- Web TypeScript: PASS.
- Web complete suite: 33 files / 437 tests PASS (includes six new behavior regressions).
- Production Web build: PASS (existing sourcemap/chunk-size warnings only).
- New behavior tests cover saved policy/PnL after remount with GET only, a shared poll and offline recovery, stale/future/malformed heartbeat, STOP/MISSING/BLOCKED labels, explicit PIN STOP, and no browser decisions/orders/closures while timers advance three minutes.
- Actual diff reviewed: all legacy automatic order/decision creation and both UI auto toggles removed; consumers compile; server execution/protection paths untouched.

## Pre-deployment evidence / remaining gates

Previous production d9069a201d72e0876b32f14446d4054a9e543fa2 / tree a0abc3f7f6bfd5128e33eb264dd879b679bbc634; CI287 passed.
2026-09-20T15:36:18.409Z runtime: ACTIVE session vp400-8fca5a3d-e988-4c98-b4a3-f9953ff54289, startedAt 2026-09-20T14:21:14.615Z; policy virtual400-active/v1 appliedAt 2026-09-20T15:18:52.069Z; 400 equity, 0 realized PnL, 0 open positions/settlements, NORMAL, NO_TRADE.

This committed report records pre-deploy evidence. Exact-head CI and deployed identity/session continuity must be checked after push/publish and reported in the existing automation prompt. No claim of production completion based only on this file. Browser verification must preserve the existing PIN gate, never create/reset a PIN for QA. Natural trade lifecycle, raw-candle E2E, actual PostgreSQL restart and Alpha/Beta remain separate pending gates; no performance fabrication or forced entry.
