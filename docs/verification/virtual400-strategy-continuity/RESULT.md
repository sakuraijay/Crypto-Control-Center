# Virtual400 strategy continuity verification

Status: local implementation and focused regression PASS; exact-head CI and production runtime verification pending.

## Finding

The active Virtual400 path returns from `aiWorker` before the general worker's
Strategy SHADOW persistence block. Its own call to
`runStrategyShadowWorkerReadOnly()` did not restore or persist the lifecycle and
regime snapshots. Consequently each Virtual400 cycle started with empty regime
hysteresis even though the general worker path had continuity support.

This explains the absence of a Virtual400 regime snapshot after deployment. It
does not, by itself, prove that the continuity gap caused the observed
`NO_TRADE` result.

## Fix

- Added a versioned, session-scoped worker-state key for Virtual400 Strategy
  lifecycle and regime continuity.
- Restored the validated snapshot before every Virtual400 Strategy SHADOW read
  and passed it as `lifecycleSnapshot`, `previousRegimes`, and the fixed
  BTC/ETH/SOL symbol allowlist.
- Advanced and persisted only authority-free, validation-passing SHADOW
  evidence inside the existing Virtual400 database transaction.
- Bound each symbol to its last accepted completed-candle close. Repeated or
  out-of-order records from the one-minute worker cadence are removed before
  they can inflate `heldCandles`, advance pending hysteresis, or authorize an
  entry.
- Bound the state to the active session ID. Malformed, future-dated, symbol-
  mismatched, or cross-session state blocks only new entries and is not replaced
  with an empty baseline.
- Existing position protection, reduction, close, and settlement handling runs
  before this entry veto and remains active.
- Added read-only continuity evidence to the existing Virtual400 runtime
  snapshot. It does not grant Risk, PAPER, or LIVE execution authority.

No signal, confidence, cost, sizing, leverage, Risk, Standard, Canary, or LIVE
threshold was changed.

## Local evidence

- API/root TypeScript project build: PASS.
- Focused regression: 5 files, 156 tests PASS.
- Covered session isolation, process-local restart-equivalent restore, missing
  legacy baseline, corrupt JSON, future state, invalid session binding,
  NOT_EVALUATED preservation, runtime input wiring, and continued protection of
  an existing position while continuity state is corrupt. A duplicate-candle
  regression verifies that the record becomes NOT_EVALUATED and the cursor and
  hysteresis state do not advance.
- `git diff --check`: PASS.

## Remaining verification

- Exact-head full CI must pass after delivery.
- Production must show the new session-scoped continuity key and runtime
  summary advancing on a real worker cycle.
- A later eligible completed candle must demonstrate BTC/ETH/SOL regime
  `heldCandles`/pending state continuity across successive cycles or a process
  restart.
- Natural PAPER OPEN/protection/CLOSE/settlement and Alpha/Beta remain separate,
  unverified gates. Synthetic replay is not a natural trade or realized profit.
