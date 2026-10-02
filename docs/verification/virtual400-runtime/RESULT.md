# Virtual 400 PAPER runtime integration — 2026-09-20

Baseline: a4b5c8f21d9ea08aae6531909ad8d41466a75d1c, existing draft PR #1,
branch codex/handover-20260820. This is implementation/test evidence, not
ALPHA_TESTED, BETA_TESTED, or production runtime acceptance.

## Implementation

- Existing explicit virtual session selects a separate server worker cycle before
  Standard/fixed-beta decision/accounting processing. Missing session alone permits
  Standard fallback. Invalid/stopped sessions cannot accidentally enable Standard.
- Reuses completed 4h/1h/15m candle strategy evidence, Risk adapter, Risk state
  machine, order sizing, server PAPER OPEN, SL/TP/REDUCE70, close and settlement.
  BTC is the initial symbol. No synthetic signal fallback exists in runtime.
- Dedicated session-scoped risk checkpoint starts at 400 USDC. Net settlement,
  modeled fees/holding costs, HWM, loss counts and sticky stops survive reload.
  Closed-trade hashes and monotonically increasing row counts reject rewritten or
  deleted settlement evidence. Closed OPEN without FULL settlement blocks entry.
- PostgreSQL advisory coordination serializes START/STOP with virtual cycles.
  Checkpoint and decision claims commit before executor dispatch. Existing executor
  idempotency and protection remain in use. No schema migration or balance reset.
- Explicit STOP vetoes entries while normal server protection continues. Daily
  profit protection reduces 70%; an entry veto alone does not close all positions.
- Conservative initial limits: 1x, one position, 30-minute cooldown, confidence 80,
  risk 0.25%, margin at most 100 USDC, 0.40 USDC round-trip cost gate. Structural
  stop comes from signal; PAPER target is explicitly 2R from current entry/stop.
- Dashboard card: VIRTUAL 400 USDC / PAPER, SIMULATED / ESTIMATED costs, fresh
  account/PnL/positions, server operator PIN START/STOP. Missing/stale evidence
  displays unknown rather than a fictitious 400 balance. Legacy trade endpoint
  excludes virtual rows; client writes cannot forge their reserved namespace.

## Role-separated passes by one Codex writer

Architect: namespace and durable evidence boundaries; reuse executor; preserve
real-money restrictions; no Standard/fixed-beta migration.

Implementation: worker/accounting/routes/card plus regressions.

Reviewer: inspected actual diff. Fixed profit-protection entry veto incorrectly
becoming close-all, pre-commit control response, uncommitted pre-dispatch risk
writes, stale submission timestamps, settlement mutation/deletion and missing
FULL settlement. Rechecked these through the focused regressions.

SRE: 315 tests across 11 suites PASS; API and web TypeScript PASS; web production
build PASS. Backend build correctly refused dirty/uncommitted product source;
repeat on committed exact source and use GitHub authoritative CI. No production
credentials used by tests.

## Meaning and limits of REPLAY evidence

serverPaperE2eLifecycle includes an explicitly synthetic strategy-contract signal
through actual Risk + sizing + executor OPEN + process-local reset + SL management
+ CLOSE + net settlement. In-memory DB fixtures preserve the ledger between
resets. It verifies nonzero loss/costs, structural stop, duplicate suppression and
Standard sentinel isolation. It is NOT raw candles-to-signal end-to-end coverage,
NOT a real PostgreSQL process restart, and NOT live market performance.

Runtime adapter tests exercise routing, fail-closed reads, stopped-session restore,
missing risk with history and advisory lock contention with an in-memory DB double.
`virtualPaper400Runtime.postgres.test.ts` now exercises the adapter against an
isolated temporary PostgreSQL instance. It stops and restarts the actual database
process, reloads the runtime from a fresh Node process, and verifies the same
session id, strategy namespace, start time, HWM, sticky hard stop, and
Standard/fixed-beta sentinels. It also holds the shared advisory lock from a
separate PostgreSQL session and proves a competing runtime cycle performs no
writes. This is isolated test-PostgreSQL evidence, not a Production database
restart and not natural market execution.
Strategy advisory lifecycle/regime history continuity also requires follow-up;
actual order duplicate suppression is already durable and independently enforced.

## Raw-candle lifecycle follow-up — 2026-09-21

The deterministic Virtual400 regression now starts with explicit synthetic,
closed 4h/1h/15m candle arrays and runs the actual candle foundation, regime,
strategy ensemble/arbiter, signal lifecycle, net-edge research evidence, Virtual400
Risk and sizing, server PAPER OPEN, simulated process-local restart, structural
Stop close and cost-aware settlement. The selected SHADOW record remains
evidence-only; the explicit Virtual400 session plus Risk/sizing grants PAPER
authority. The test also preserves a Standard risk-state sentinel and verifies a
single net settlement with modeled cost and loss accounting.

This closes the deterministic raw-candle-to-settlement REPLAY coverage gap only.
The candles, quotes and costs are synthetic/estimated, the DB is still an
in-memory fixture, and this is not live market performance, a natural production
trade, an actual PostgreSQL process restart, or ALPHA/BETA acceptance. Exact-head
CI remains required after the test commit is delivered.

## Deployment/UI evidence and remaining gates

At 2026-09-20T05:30Z the public release identity reported source
399351cd5243a6f00420821afc2329074ab8d23b (built 2026-09-06), not current GitHub.
Public safety returned PAPER, no pending/unresolved PAPER position; do not infer
latest deployment from passive publish success. Browser reached the existing
production Dashboard and its Set Master PIN overlay; no PIN was entered/changed.
Cloud browser access to local preview was blocked (ERR_BLOCKED_BY_CLIENT), so the
new card has build/typecheck coverage but no browser acceptance yet.

Remaining: natural server PAPER OPEN/protection/CLOSE/settlement observation;
and Alpha/Beta execution evidence.
A natural NO_TRADE remains valid and is not represented as a market trade.

Rollback: preserve all virtual keys/rows and any protected open position. STOP
new virtual entries via the existing authenticated action. Review open/pending
positions before any code rollback; never delete session/risk/HWM/ledger data.
The previous executor already understands virtual tags/protection, but old source
must not be assumed to preserve every newly added risk control.

Deadline remains 2026-10-01 18:00 Asia/Manila; internal full lifecycle checkpoint
2026-09-23 18:00. These gates are not yet certified and no date is guaranteed.
