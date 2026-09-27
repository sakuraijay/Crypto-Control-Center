# Fixed Beta 400 — Source / Runtime Gate Assessment

**Assessment date:** 2026-09-10 PHT  
**Scope:** source/runtime discrepancy assessment required before the 2026-09-10 18:00 internal gate  
**Canonical branch:** `codex/handover-20260820`  
**Pre-assessment source baseline:** `fb50121b2c4089076d5d1a71d2c34ece24862839` / exact-head CI #251 success

> This is a launch-critical engineering assessment, not financial authorization, not runtime readiness evidence, and not a Production mutation plan. The current canonical ChatGPT owner instruction and `CCC_CANONICAL_OPERATING_POLICY_2026-09-07.md` remain authoritative.

## 1. Gate conclusion

The scoped 400-USDC beta-capital path is **source-feasible without mutating Production trading capital, HWM, wallet balance or PAPER epoch state**.

The remaining P0 is not a new Risk Engine or a new capital subsystem. Existing Fixed-Beta primitives already exist. The missing work is a minimal, explicit worker integration that makes the same selected 400-USDC capital meaning reach every relevant risk/equity/AI/sizing consumer while preserving the standard 1,000-USDC path as the default.

Current classification:

- Fixed-Beta capital-cap primitive: **IMPLEMENTED**.
- Fixed-Beta $368 / $400 HARD_STOP binding primitive: **IMPLEMENTED / fail-closed**.
- Fixed-Beta worker end-to-end selection and propagation: **MISSING / P0**.
- Production exact-release attestation: **UNKNOWN** until fresh runtime evidence is available.
- PAPER scheduler / GMX RPC / positions / current locks / Stop evidence: **UNKNOWN** when fresh authoritative runtime reads are unavailable.
- Controlled Canary: **NO-GO / fail-closed** until all canonical gates pass together.

## 2. Existing source to reuse — do not duplicate

### `artifacts/api-server/src/lib/riskCapital.ts`

Existing `FIXED_BETA_RISK_CAPITAL_SCOPE` reuses the authoritative 400-USDC allocation and can lower the risk-capital cap for:

- `dailyRiskCapital(...)`
- `weeklyRiskCapital(...)`
- `positionSizingCapital(...)`

The module explicitly does not mutate DB/HWM/Active Capital and cannot raise the current approved Active Capital ceiling.

### `artifacts/api-server/src/lib/activeCapitalSemantics.ts`

Existing `FIXED_BETA_400` policy context distinguishes the dedicated 400-USDC beta meaning from the normal Active Trading Capital meaning.

Existing `RISK_STATE_MACHINE_EXPLICIT_PAIR_V1` capability allows the RiskStateMachine pair to be emitted only when all of the following are explicit and aligned:

- Fixed-Beta context selected;
- runtime capital aligned with the Fixed-Beta capital meaning;
- historical HARD_STOP does not require sticky review;
- the explicit RiskStateMachine binding capability is present.

The emitted pair is:

- HARD_STOP policy equity: **368 USDC**;
- policy reference capital: **400 USDC**.

Missing capability, capital drift or historical HARD_STOP remains fail-closed. `betaExecutionAuthorized` remains separate and false unless independently authorized.

## 3. Confirmed worker discrepancy

### `artifacts/api-server/src/workers/aiWorker.ts`

`evaluateWorkerRiskState()` currently calls `buildActiveCapitalWorkerBinding()` without:

- `policyContext: 'FIXED_BETA_400'`;
- `hardStopThresholdBindingCapability: 'RISK_STATE_MACHINE_EXPLICIT_PAIR_V1'`.

The worker also directly consumes `limits.tradingCapital` in multiple capital-sensitive paths, including:

- current-equity / period-PnL reference calculation;
- RiskStateMachine runtime-capital input;
- AI Engine account balance / available balance;
- AI Engine `tradingCapital` input;
- PAPER sizing cap / tier cap;
- LIVE-test collateral and sizing context.

Therefore, wiring only the RiskStateMachine to 400/368 would create a capital-domain mismatch where Risk sees 400 while other worker consumers can still see the legacy 1,000-USDC value.

That partial patch is **rejected**.

## 4. Minimal P0 implementation scope

Implement one explicit, non-persistent Fixed-Beta selection seam inside the worker path and reuse existing primitives.

Required properties:

1. Default remains `STANDARD_ACTIVE`; existing 1,000 / 920 behavior must be unchanged when Fixed Beta is not explicitly selected.
2. Fixed Beta must never be inferred from calendar date, wallet balance, `limits.tradingCapital === 400`, Planned Seed, or user silence.
3. Fixed Beta selection must not mutate Production DB, HWM, `tradingCapital`, Secrets, PAPER epoch state, signer state, Relay state, LIVE mode or authorization state.
4. The same effective 400-USDC beta capital meaning must feed all capital-sensitive worker consumers that currently rely on the legacy `limits.tradingCapital` domain where beta semantics are intended.
5. Pass `FIXED_BETA_RISK_CAPITAL_SCOPE` to daily/weekly/position sizing helpers when and only when Fixed Beta is explicitly selected.
6. Pass `FIXED_BETA_400` plus `RISK_STATE_MACHINE_EXPLICIT_PAIR_V1` to the existing active-capital worker binding when and only when Fixed Beta is explicitly selected.
7. Preserve historical HARD_STOP sticky behavior. No automatic HWM/HARD_STOP reset or clear.
8. Preserve `WORKER_ENGINE_MODE=PAPER`, `AUTO_WORKER_LIVE_ENABLED=false`, Relay submission OFF and Relay submit network OFF during implementation and validation.
9. Configuration values approved by the owner may be maintained/verified, but they are not real-order authorization.
10. Keep actual 400-USDC financial activation as a separate fresh bounded approval step.

## 5. Regression requirements before release candidate

Worker-level integration tests must prove at least:

- Standard default remains 1,000 / 920.
- Explicit Fixed-Beta path is 400 / 368.
- No date-based activation.
- No wallet-balance or Planned-Seed substitution.
- Missing explicit capability fails closed.
- Capital drift fails closed.
- Historical HARD_STOP remains sticky / review-required.
- `betaExecutionAuthorized=false` is not bypassed by source selection.
- Daily/weekly risk-cap and position-sizing consumers use the same Fixed-Beta scope.
- AI Engine account/trading-capital inputs and risk/equity reference use the same selected beta capital meaning.
- Existing Stop, emergency-close, idempotency, restart, settlement and duplicate-protection contracts remain unchanged.

After the focused tests pass, exact-head GitHub Actions CI is the authoritative code/build/test gate.

## 6. Explicitly prohibited shortcuts

Do not use any of the following to make the beta appear ready:

- set Production `tradingCapital` to 400;
- reset or rewrite Production HWM/HARD_STOP;
- repurpose canonical 1,000-USDC PAPER epoch activation as the beta selector;
- infer activation from 2026-09-15 arrival;
- infer activation from a 400-USDC wallet/runtime value;
- loosen the immutable $0.40 round-trip cap;
- increase leverage or force a trade to create activity;
- mark unavailable runtime evidence as PASS;
- reuse stale `OWNER_SIGNATURE_READY` consent;
- merge/rebase/force-push without explicit owner approval;
- use Replit Agent for ordinary code implementation.

## 7. Runtime / deployment blockers that remain independent of source implementation

Fresh authoritative evidence is still required before Controlled Canary:

- exact deployed source identity matches the exact CI-passing release source;
- Production dashboard renders and navigates correctly against authoritative runtime data;
- PAPER scheduler health and fresh cycle evidence;
- GMX RPC health and open-position consistency;
- current Stop capability;
- current Risk permission / HARD_STOP-safe resolution;
- canonical subaccount/delegation and sufficient action budget;
- exact-observation round-trip cost <= **$0.40** with no interpolation/extrapolation;
- fresh Owner Approval and separate explicit financial activation approval;
- bounded authorized markets, exposure/leverage, stop policy, loss budgets, authorization lifetime/action budget and emergency procedure.

Unavailable, stale, 401 or unreachable evidence remains `UNKNOWN`, never PASS.

## 8. Dashboard / Figma acceptance impact

The approved first-release direction remains `Crypto Control Center — Trading Terminal UX v1` / Institutional Trading Terminal.

Dashboard acceptance must keep these values semantically distinct:

- Planned Seed;
- wallet balance;
- Active Trading Capital;
- dedicated 400-USDC Beta Capital when selected;
- Reserve Capital;
- runtime Risk Equity / HWM;
- PAPER / Canary / LIVE / UNKNOWN readiness.

A browser/config flag must never display false READY when authoritative server evidence is unavailable.

## 9. Schedule impact

- **2026-09-10 18:00 PHT gate:** source discrepancy and minimal implementation scope are now defined by this assessment. Source feasibility is YES; runtime readiness is not implied.
- **2026-09-12 18:00 PHT gate:** worker integration + focused regressions + exact-head CI remain the critical implementation target.
- **2026-09-15 12:00 PHT fixed beta:** still requires Dashboard acceptance plus controlled real-money 400-USDC automated trading, subject to fresh approval and all safety/economic gates.
- **2026-10-01 V1.0:** unchanged.

## 10. Recommended next action

**Highest-value next automatic task:** implement the smallest worker-only integration that reuses `FIXED_BETA_RISK_CAPITAL_SCOPE` and `ActiveCapitalSemantics`, adds worker-level regression coverage, and preserves Standard/PAPER behavior by default.

Do not publish Production until that implementation is exact-head CI GREEN and a single validated release batch is ready.
