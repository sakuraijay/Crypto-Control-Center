# Strategy regime continuity verification

Date: 2026-09-21 PHT  
Supervision contract: `CCC-SUPERVISION-20260921-08`

## Scope

This change closes the SHADOW-only regime hysteresis continuity gap found after
the Virtual400 v2 PostgreSQL lifecycle replay. The worker previously supplied
`previousRegimes: {}` on every cycle, so `heldCandles`, `pendingRegime`, and
`pendingCount` could not survive either the next cycle or a process restart.

The implementation:

- passes a validated per-symbol previous regime into the existing pure Strategy
  SHADOW runner;
- writes an explicit `strategy-regime-snapshot/v1` inside the already-durable
  AI decision envelope;
- advances in-memory state only after the decision claim is durable;
- preserves the last valid state across `NOT_EVALUATED` cycles;
- restores the explicit snapshot after restart;
- treats pre-snapshot decisions as an empty legacy baseline instead of inferring
  state from an older persistence contract; and
- rejects duplicate, unexpected-symbol, malformed, or future-dated state.

The snapshot is explainability/research state only. It grants no Risk, sizing,
approval, PAPER/LIVE mutation, relay, signer, or order authority. No strategy
threshold, Virtual400 leverage/risk/cost policy, Standard/Canary/LIVE profile,
position protection, or settlement path changes in this patch.

## Local verification

- API TypeScript: PASS.
- Focused regime/runner/envelope/evidence/lifecycle/batch/worker regression:
  7 files / 171 tests PASS.
- Broader API run: 177 files / 2,673 tests PASS, 3 skipped; 5 suites were blocked
  only by the local environment (`DATABASE_URL` absent and `initdb` unavailable).
- `git diff --check`: PASS.

Exact-head CI and deployment/runtime verification are recorded separately after
the commit is delivered. This change does not by itself prove a natural market
OPEN, protection, CLOSE, settlement, Alpha, or Beta result.
