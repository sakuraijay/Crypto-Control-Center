# Crypto Control Center — Canonical Operating Policy

**Effective:** 2026-09-07 PHT  
**Status:** Owner-approved operating contract for ongoing CCC development  
**Canonical branch:** `codex/handover-20260820`  
**Canonical PR:** #1

## 1. Authority and precedence

1. The **current ChatGPT conversation** is the only canonical CCC development and reporting session.
2. All other CCC conversations are superseded/read-only. They must not originate new development, Replit Agent commands, GitHub writes, deployments, reporting automations, LIVE/signing/subaccount/fund actions, or reactivate legacy CCC automations.
3. For development decisions, precedence is:
   1. latest explicit owner instruction in the canonical conversation;
   2. this policy;
   3. the 2026-09-01 CCC Master Plan where it does not conflict with newer owner instructions;
   4. historical PR comments, task trackers, handoff notes and old sessions.
4. Live status values such as HEAD SHA, CI run, deployment SHA, scheduler cycle, wallet balance, readiness and positions are **not** frozen into this policy. They must be freshly read from authoritative sources.

## 2. Delivery target

- Official V1.0 launch target remains **2026-10-01** unless the owner explicitly changes it.
- The existing master plan states a contractual **US$100/day delay penalty after 2026-10-01**; therefore P0/P1 launch work has priority over nonessential polish.
- Schedule pressure must never be used to remove Stop, idempotency, duplicate-order protection, settlement/reconciliation, drawdown/loss protection or other capital-loss P0 controls.

## 3. Low-cost development model — supersedes Replit-first development

### Primary responsibilities

- **ChatGPT/Codex + GitHub:** primary implementation for backend, frontend/UI code, tests, migrations, documentation, refactoring and release preparation.
- **Figma:** UI/UX source-of-truth. Approved direction: **Institutional Trading Terminal**. Current design file: `Crypto Control Center — Trading Terminal UX v1`.
- **GitHub Actions:** authoritative CI/build/test gate.
- **Replit:** Reserved VM / Production runtime, Secrets, deployment, browser/runtime validation and final publishing layer.
- **Replit Agent:** exception tool only for a genuinely Replit-specific deployment, environment, runtime or last-mile rendering problem.

### Prohibited cost pattern

Do not use Replit Agent for:

- hourly idle/busy polling;
- repeated read-only audits of unchanged state;
- general code exploration already possible through GitHub/Codex;
- duplicate implementation or duplicate testing;
- small cosmetic UI changes;
- full-suite reruns on an already validated identical SHA;
- repeated publish of an unchanged SHA.

### Cost controls

- Replit Agent target: **0 calls in a normal hour** and at most **one consolidated batch per day, preferably less**, unless a real outage or deployment-specific safety regression requires it.
- Production publish target: at most **one validated release batch per day**, except real outage/safety regression.
- Use focused tests while developing; run the full GitHub CI once for a release candidate or materially changed HEAD.
- Do not rerun full CI or deployment merely for reporting.
- Preserve Replit credits primarily for Reserved VM/runtime and true Replit-specific blockers.
- Do not initiate or assume approval for extra paid credit/top-up purchases.
- Every non-launch-critical task must have a clear ROI justification before execution.

## 4. Release flow

1. Reconcile current owner instructions, this policy, PR #1 HEAD/CI and existing implementation.
2. Confirm the work is not already implemented by inspecting commit/test/task history.
3. Implement one consolidated Codex/GitHub batch.
4. Run focused tests as needed.
5. Push normally to `codex/handover-20260820`; no force push, rebase or history rewrite.
6. Run/observe exact-head GitHub CI.
7. If CI fails, fix from GitHub/Codex first; do not hand the coding problem to Replit.
8. When a meaningful release batch is complete, publish the exact validated source to the existing Replit Reserved VM.
9. Run one post-deploy smoke/attestation pass; do not continuously re-audit unchanged Production.

Codex and Replit Agent must never concurrently edit the same code area.

## 5. Figma / UI migration contract

- Preserve existing backend, Risk Engine, GMX integration, PAPER/LIVE safety gates and data contracts while migrating UI.
- The redesign must remain desktop-first.
- Key operator information hierarchy:
  1. Planned Seed / Active Capital / Risk Equity / PnL / GMX positions;
  2. Market + AI Decision;
  3. Canary readiness;
  4. System health and execution locks;
  5. Positions / performance / detailed diagnostics.
- Planned Seed, wallet balance, Active Trading Capital, Reserve Capital and runtime Risk Equity must never be visually or semantically conflated.
- Runtime readiness badges must be derived from server evidence; do not label signer, Canary or LIVE as ready from a browser/config flag alone.
- Reuse the existing React + TypeScript + Tailwind/shadcn component stack; do not introduce a replacement frontend framework solely for the redesign.

## 6. AI Trading Core requirements

The existing AI/Risk/GMX architecture is preserved and extended, not replaced.

- Closed-candle analysis: **4H / 1H / 15m**, closed candles only.
- Tick/oracle prices are for execution freshness/risk checks, not candle strategy substitution.
- Missing/stale/invalid market evidence fails closed; no synthetic candles and no fake zero-volume substitution.
- Indicators include EMA, RSI, ATR, ADX/DI, Bollinger, Keltner, Donchian, slopes and volatility features.
- Market structure includes HH/HL/LH/LL, BOS, CHoCH, swing high/low, support/resistance, range and breakout/retest logic without look-ahead.
- Regime states include TREND_UP, TREND_DOWN, RANGE, BREAKOUT_READY, HIGH_VOLATILITY, TRANSITION and UNKNOWN with confidence/hysteresis/minimum hold.
- Strategy ensemble includes Trend Pullback, Volatility Breakout and Range Mean Reversion plus relative-strength ranking as expansion allows.
- Existing Risk Engine remains the final **ALLOW / REDUCE / REJECT** authority.
- Execution economics must consider fees, funding, borrowing, gas/relay, slippage and price impact before expected-value approval.
- Exit/reliability must preserve Structural Stop, TP, REDUCE70/profit protection, trailing, emergency close, idempotency, restart recovery, duplicate suppression and settlement/reconciliation.

## 7. Capital and risk policy

- **Planned Seed:** 10,000 USDC.
- Keep distinct: actual wallet balance, Planned Seed, Active Trading Capital, Reserve Capital and runtime Risk Equity/HWM.
- Active Capital ladder: **1,000 → 2,500 → 5,000 → 10,000 USDC**. Contract schedule may compress practical validation to 1K → 5K → 10K, but no stage is automatically promoted.
- Stage increase requires positive expectancy after all costs, reliable GMX order/fill/settlement behavior, executable Stop/emergency close, unresolved mismatch = 0, loss/DD compliance, successful Canary validation and explicit owner approval.
- Maximum actual loss per trade: approximately **0.25–0.5% of Active Capital**.
- Daily maximum loss: **≤1% of Active Capital**.
- Total drawdown stop: **8–10%**.
- 5–10% daily profit is not a forced target; it is an overheat/reinvestment cap, not a guarantee.
- No leverage auto-escalation, forced trade count, revenge sizing, averaging/martingale or cost-gate bypass.

## 8. Execution safety and approvals

Approved configuration values that may be maintained/verified:

- `DELEGATED_SIGNER_ENABLED=true`
- `GMX_API_ORDER_SUBMISSION_ENABLED=true`
- `LIVE_TEST_EXECUTION_LOCKED=false`

Mandatory runtime boundaries:

- `WORKER_ENGINE_MODE=PAPER`
- `AUTO_WORKER_LIVE_ENABLED=false`
- Relay submission OFF
- Relay submit network OFF

The approved configuration flags above **do not authorize a real order**.

Without a new explicit owner approval, never perform:

- actual order submission;
- actual fund movement;
- on-chain subaccount authorization;
- LIVE unlock / AUTO LIVE;
- a new MetaMask signature;
- secret disclosure or secret mutation that requires the owner;
- Production DB/HWM/trading-capital mutation;
- PR merge, force push or rebase.

Owner Approval was historically completed to `OWNER_SIGNATURE_READY`, but readiness is time-bound. Always revalidate the current usable session; never reuse expired consent as a new authorization. User silence is never approval.

If a protected financial step becomes the only next step, defer **only that item** as `DEFERRED_USER_ACTION` and request exactly one user action. A prior project rule allows approximately 30 minutes for a requested user-only action; after that, continue independent safe work and leave only the blocked item deferred.

## 9. Controlled Canary blockers and immutable gates

Do not declare Controlled Canary ready until all relevant gates are concurrently fresh and valid, including:

- Owner Approval;
- canonical subaccount/delegation and sufficient action budget;
- immutable round-trip cost cap **$0.40** using exact observed evidence, no interpolation/extrapolation;
- Stop capability;
- Risk Engine entry permission / HARD_STOP resolution through an explicitly approved safe process;
- release identity / safety attestation;
- GMX/RPC/open-position consistency;
- explicit approval for any real financial action.

Historical cost failures remain evidence of prior economics, but stale/401/unavailable evidence must never be inferred as a pass.

## 10. Hourly canonical automation

The only active CCC automation should be **`CCC 시간별 개발`**. `CCC 자동화 감시` and legacy CCC automations remain disabled unless the owner explicitly changes this policy.

Every hourly run must be low-cost and delta-oriented:

1. Check PR #1 state, HEAD and exact-head CI.
2. Check Replit publish/deployment using passive status tools only when possible.
3. Check PAPER/GMX/readiness/locks using passive read-only evidence when available. If unavailable, report `UNKNOWN`; do not spend Replit Agent usage merely to learn a status.
4. Continue the highest-value safe Codex/GitHub/Figma batch that is launch-critical or explicitly approved.
5. Do not deploy every hour.

Hourly Korean report should include:

- 기준 시각 / D-Day to 2026-10-01;
- 지난 1시간 완료;
- GitHub/Codex HEAD + CI;
- Figma/UI progress;
- Replit passive deployment/runtime status and whether Agent was used;
- PAPER scheduler / GMX RPC / positions when authoritative evidence is available;
- duplicate/missing-work check;
- overall progress and M0–M4 / 1K→5K→10K test impact where relevant;
- remaining P0/P1 / launch blockers;
- next low-cost automatic task;
- `DEFERRED_USER_ACTION` / blockers;
- PAPER / Canary / LIVE schedule impact;
- Replit Agent call count and Production publish count for the hour.

## 11. Source-of-truth rule

The 2026-09-01 Master Plan remains useful for architecture, launch scope and historical constraints, but sections that say **Replit Agent is the primary implementer or should automatically start work whenever paused** are superseded by this 2026-09-07 low-cost policy.

Any status snapshot embedded in older documents is historical only. Current status must come from GitHub/Replit/runtime evidence.
