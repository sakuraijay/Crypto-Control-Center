# Crypto Control Center — Canonical Operating Policy

**Effective:** 2026-09-07 PHT  
**Status:** Owner-approved operating contract for ongoing CCC development  
**Canonical branch:** `codex/handover-20260820`  
**Canonical PR:** #1

**Latest milestone revision:** 2026-09-09 — the owner has confirmed **2026-09-15 12:00 Asia/Manila** as the fixed beta schedule, not a tentative target. Dashboard acceptance and real 400 USDC automated trading remain the required scope. See section 12 for the fixed deadline, earlier internal delivery gates and unchanged financial approval boundaries. A fixed schedule is not evidence of readiness, runtime activation or a scheduled financial action.

## 1. Authority and precedence

1. The **current ChatGPT conversation** is the only canonical CCC development and reporting session.
2. All other CCC conversations are superseded/read-only. They must not originate new development, Replit Agent commands, GitHub writes, deployments, reporting automations, LIVE/signing/subaccount/fund actions, or reactivate legacy CCC automations.
3. For development decisions, precedence is:
   1. latest explicit owner instruction in the canonical conversation;
   2. this policy;
   3. the 2026-09-01 CCC Master Plan where it does not conflict with newer owner instructions;
   4. historical PR comments, task trackers, handoff notes and old sessions.
4. Live status values such as HEAD SHA, CI run, deployment SHA, scheduler cycle, wallet balance, readiness and positions are **not** frozen into this policy. They must be freshly read from authoritative sources.

## 2. Delivery schedule

- **Fixed beta schedule: 2026-09-15 12:00 Asia/Manila (UTC+08:00).** This is owner-confirmed and must not be described as tentative or unilaterally postponed. Required scope: functioning dashboard and real automated-trading test with **400 USDC beta capital**. See section 12 for acceptance gates and approval boundaries.
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

## 12. September 15 fixed beta deadline — dashboard and 400 USDC automated trading

### Owner-confirmed schedule and scope

The owner specified: “9월 15일 오후12시 베타 테스트 진행 예정. 테스트 범위 - 대시보드 정상 동작, 실제 400usdc로 자동 매매 목표.”

The owner then explicitly confirmed: “9월 15일 베타 테스트는 이미 확정 스케쥴이니 반드시 일정 준수 할것”. This supersedes the earlier tentative wording for the beta schedule.

- **Fixed beta start: 2026-09-15T12:00:00+08:00**, noon in Asia/Manila; **2026-09-15T04:00:00Z**.
- Deliverable A: a functioning Production dashboard, including the approved Figma first-release UI and accurate runtime/capital/position/PnL/risk information.
- Deliverable B: a controlled real-money automated-trading beta using **400 USDC of dedicated beta capital**. PAPER alone does not satisfy this real-money deliverable.
- Do not unilaterally reschedule, substitute a PAPER-only demonstration, or reduce the agreed beta scope. Any proposed schedule/scope change requires explicit owner decision.
- This fixed beta milestone does not replace the separate October 1 V1.0 target or prove sustainable profitability.

### Capital meaning and unchanged safety boundary

- 400 USDC is the beta trading-capital budget, not a required single-order notional, not a profit target, and not permission to lose the entire 400 USDC.
- Planned Seed remains 10,000 USDC. The existing 1,000 → 2,500 → 5,000 → 10,000 post-beta capital ladder remains separate; there is no automatic promotion or wallet top-up.
- Develop and test a scoped beta-capital binding that distinguishes 400 USDC from legacy 1,000-USDC policy baselines, historical HWM/equity and actual available wallet collateral. Do not substitute a fake wallet balance or bypass capital-drift checks.
- Do not reset existing HARD_STOP/HWM, change Production DB/trading capital/Secrets, create a new signer, sign, authorize a subaccount, enable Relay/AUTO LIVE or submit orders merely because this milestone exists or its date arrives.
- Section 8 execution locks remain in force. Actual financial activation requires fresh preflight and separate explicit bounded activation approval, with the authorized markets, exposure/leverage, stop policy, loss budgets, authorization lifetime/action budget, test end/renewal and emergency procedure resolved.
- The latest owner directive does not specify an end time, test duration or full-capital loss tolerance. Do not infer an eight-hour session, a 20:00 end, or permission for a 400-USDC loss from an assistant suggestion or summary.
- Preserve existing percentage-based risk constraints until any separate change is explicitly approved. For planning only, 0.25–0.5% of 400 is 1–2 USDC per trade and 1% is 4 USDC per day; these calculations do not themselves change runtime configuration or guarantee a maximum realized loss.

### Acceptance evidence — report A and B separately

A. Dashboard: deployed source matches the exact CI-passing source; actual browser rendering and navigation pass; capital/wallet/PAPER/LIVE/unknown data are unambiguous; market freshness, AI decisions, order/position state, PnL/costs and safety controls reflect authoritative data; reconnect and stale/error paths do not display false READY or fake zero balances.

B. Automated execution: eligible signal → existing Risk/cost gates → confirmed GMX entry → confirmed protection → position management → confirmed close → residual order cleanup → settlement/readback are evidenced. Price movement alone, an API acknowledgement, a signer-ready flag or a PAPER trade is not proof of a completed live lifecycle. Duplicate submissions and unresolved settlements must not be hidden. Browser closure must not stop server-side protection.

All current cost/Owner Approval/canonical delegation/action-budget/Stop/Risk/release/GMX gates must pass. Keep the $0.40 cost cap; do not loosen it, raise leverage or force an uneconomic order to demonstrate activity at noon. If there is no valid signal, record NO_TRADE and mark the actual-trade lifecycle UNVERIFIED rather than inventing a pass. A profitable short beta is not proof of long-term positive expectancy.

### Internal delivery gates — working deadlines, not completion claims or installed jobs

The following internal workback deadlines replace the previous broad preparation windows. All times are Asia/Manila (UTC+08:00). These deadlines do not claim that a worker/job has been started or that delivery is already assured.

- **September 10, 18:00:** complete the existing-source/runtime discrepancy assessment and minimal remaining implementation scope; identify beta-blocking code, deployment, cost, risk, signer/authorization and operator-action dependencies. Confirm the path to a scoped 400-USDC beta-capital binding without Production mutation. Reuse existing code and tests.
- **September 12, 18:00:** finish beta-essential code and isolated PAPER/replay/regression validation for the dashboard, 400-USDC capital semantics, costs, entry/protection/close/settlement, restart and duplicate suppression. Obtain exact-source CI evidence for the release candidate. Missing evidence is not a PASS.
- **September 13, 18:00:** complete the necessary single-batch PAPER Production deployment of the validated candidate, actual browser acceptance, release-source parity and runtime smoke within existing permissions. Do not defer a complete beta release indefinitely to collect unrelated features.
- **September 14, 18:00:** complete the readiness rehearsal and report both deliverables' gate matrix; freeze non-blocking code changes. Prepare the exact bounded activation request and any user-only prerequisites early. Time-bound Owner Approval is obtained/revalidated close enough to the beta to remain valid; do not repeatedly request signatures that expire while code work is unfinished.
- **September 15, 11:00–12:00:** final fresh runtime/cost/authorization/Stop/Risk checks and required user-controlled activation decision. Do not leave known development or deployment blockers until this window.
- **September 15, 12:00:** fixed beta session start. Real-money execution is permitted only within verified, explicitly authorized bounds. If a mandatory financial gate is still failed or unknown, do not execute through it; report the live-scope non-delivery candidly rather than claiming that a dashboard/PAPER-only result satisfied the agreed beta.

### Critical-path priority and early escalation

- Until beta, work only on the agreed dashboard/400-USDC automated-trading delivery path and capital-loss-prevention defects. TradingAgents integration, extra paid agents, infrastructure migration, unrelated strategies and cosmetic expansion remain frozen.
- Reuse existing validated functions; do not create new diagnostics or documentation-only tasks unless they directly unblock this beta, prevent unsafe execution or correct a material requirement conflict.
- During each actual development/reporting run, include the next internal deadline, achieved acceptance evidence and remaining blocker. Unknown runtime evidence must remain UNKNOWN and be assigned a concrete verification path, not copied as healthy from an old report.
- If a blocker threatens an internal deadline, flag **SCHEDULE_AT_RISK** in that run's report with the issue, evidence/time, dependency/owner, recovery action, estimated work and any single required user action. Do not wait until September 15 to disclose a known delay. An estimate is not a guarantee or an authorization to buy extra credits.
- Document changes do not count as implementation, deployment, actual trading or profitability progress. Do not use ungrounded completion percentages to imply beta readiness.

### Cost, priority and reporting

Retain the Codex/GitHub → GitHub Actions → Replit final-publish workflow and the existing Figma source. No TradingAgents integration, extra paid research agents, infrastructure migration, cosmetic expansion or duplicate full-suite/deploy loops for this beta. Deadline pressure does not override the existing Agent-spend controls or authorize extra paid credits.

On a subsequent canonical run, read this same policy path and report the **fixed September 15 12:00 beta deadline** plus each acceptance gate as PASS / FAIL / UNKNOWN / DEFERRED_USER_ACTION with source/time/version. Reading or updating this document is not proof that another conversation or scheduler has executed it. Do not claim an automatic launch, hourly push delivery, completed deployment, current GMX state or profitability without corresponding execution evidence.
