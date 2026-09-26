# VIRTUAL/PAPER400 executor evidence

- Worktree: `/tmp/ccc-virtual400-executor`; baseline `60a80c8c8fe92f27ffc8510d97235f08166e22fd`. No commit/push.
- Changed four files: `artifacts/api-server/src/workers/serverPaperExecutor.ts`, `artifacts/api-server/src/workers/aiWorker.ts`, and their matching `src/__tests__/*.test.ts`.
- OPEN accepts only Standard or the existing virtual strategy-tag contract (reuses `isVirtualPaper400StrategyTag`, no parallel validator). Mixed-session/Standard inventory blocks entry. Existing size, quote, cost, profile, slot and lifecycle gates remain.
- FULL/REDUCE70 persist the locked OPEN strategy exactly. Caller scope assertions and durable CLOSE recovery evidence reject other sessions/Standard contamination. Durable REDUCE70 reservation remains the existing implementation.
- Existing management ticks retain SL/TP/restart protection independently of entry eligibility. Legacy global pendingClose and reconstructed Standard CASH intents cannot close virtual positions. Standard decision risk actions and accounting exclude virtual sessions.
- Regression covers real executor OPEN -> protection -> FULL and durable REDUCE70 -> remainder SL -> net ledger; resets/restart and duplicate exits; malformed tags, foreign inventory, cross-session repair evidence, Standard intent isolation. Existing Standard lifecycle/worker regressions remain green.

## Validation

All commands used `env -i PATH="$PATH" HOME="$HOME" CI=true NODE_ENV=test`.

- Targeted Vitest: serverPaperExecutor, virtualPaper400Ledger, aiWorker, serverPaperE2eLifecycle, paperEpochNoImplicitActivation: **5 files / 229 tests passed**.
- API-only `tsc -p artifacts/api-server/tsconfig.json --noEmit`: **exit 0**.
- `git diff --check`: clean.
- Logs: `/tmp/ccc-virtual400-tests.log`, `/tmp/ccc-virtual400-typecheck.log`.
- Existing dependency/declaration symlinks were used for offline validation and removed afterward. No installs, app/workflow startup, actual DB/network calls, or credentials.

## Reachability / remaining scope

The only production OPEN caller is WorkerManager's Standard-only decision path. Baseline has no virtual session selector/activation persistence or runtime caller connecting a validated virtual session to OPEN. This change makes that executor seam safe and preserves protection for persisted virtual OPENs; it does **not** claim automatic production virtual entries are enabled. FIXED_BETA and LIVE gates remain intact. A future explicitly authorized session-selection/entry integration must pass the validated session tag and consume its dedicated net ledger; broader account/UI read surfaces were not enabled or certified here.

No LIVE/Relay/wallet/key/Secrets/PIN/HWM, operational DB, capital policy, UI, engine or strategy changes. Worker accounting exclusion prevents mixing virtual results into Standard capital; it does not change capital amounts/policy.
## Independent source review

PASS — no blocking regression found in the four-file diff against 60a80c8 for the bounded executor-seam scope. Read-only review; no edits, tests, app execution, or network. Also inspected the unchanged virtual ledger helper and /tmp/ccc-virtual400-result.md.

Supporting findings:
- serverPaperExecutor.ts:295–299 reuses the existing virtual-tag validator; :362–365 rejects foreign/Standard held inventory before OPEN. Existing quote, cost, profile, size and slot gates remain.
- :452–482 locks the actual OPEN and checks supported namespace, optional caller assertion, and same-namespace durable settlement evidence. :644 preserves the OPEN strategy on settlement; REDUCE70 also supplies expectedStrategy (:946), including FULL recovery namespace verification (:968).
- Idempotency remains tied to globally unique OPEN identity: FULL/REDUCE70 settlement uniqueness uses closesTradeId; reduction reservation includes symbol/side/OPEN UUID (:873–876). Restart recovery resolves that durable OPEN, not a currently selected session (:1170–1194). OPEN decision IDs remain globally unique, not session-local (:403; unchanged DB index). Future callers must provide globally unique decision IDs; collisions fail closed rather than mix ledgers.
- Standard decisions only act on Standard rows (aiWorker.ts:722, :759); Standard accounting excludes valid virtual tags (:1398–1400). Startup Standard CASH reconstruction and legacy pendingClose cannot liquidate virtual inventory (serverPaperExecutor.ts:1130, :1260). Persisted virtual SL/TP continues through the existing management path (:1270–1288).
- Added tests exercise malformed/foreign tags, scope mismatch and recovery evidence, mocked durable OPEN→REDUCE70→remaining SL settlement, duplicate exits, ledger net-cost accounting and Standard action/accounting isolation. Existing FIXED_BETA/LIVE gates are not relaxed.

Scope/evidence qualifications (not blockers): This is a safe callable seam, not production virtual activation or running E2E. Tag validation does not prove an activated/persisted session; that integration is explicitly absent. The lifecycle tests use mocked DB persistence and synthetic quotes, not live infrastructure. Entry-ineligible held management is preserved at the seam, but this does not mean protection runs after stopping the worker or during the pre-existing epoch-activation hold (aiWorker.ts:572–574). The evidence file appropriately disclaims production entry reachability; its reported 229 passing tests/typecheck were not independently rerun.