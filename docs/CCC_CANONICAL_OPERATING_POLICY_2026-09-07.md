# Crypto Control Center — Canonical Operating Policy

**Effective:** 2026-09-07 PHT  
**Status:** Owner-approved operating contract for ongoing CCC development  
**Canonical branch:** `codex/handover-20260820`  
**Canonical PR:** #1

**Latest milestone revision:** 2026-09-13 — the owner explicitly changed the fixed ALPHA start from noon to **2026-09-15 13:00 Asia/Manila (05:00 UTC)**: “반드시 15일 오후 1시부터 알파 테스트 가능하도록 진행할것.” The same real **400 USDC**, easy-use dashboard and autonomous-trading scope remain. **October 1 is BETA**, not final V1.0 release. Preparation deadlines are not automatically extended by the one-hour start-time change. See sections 12 and 14. This requirement update does not activate LIVE, create financial permissions, or prove readiness.

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

- **Fixed ALPHA schedule: 2026-09-15 13:00 Asia/Manila (UTC+08:00).** Required scope: an easy-to-use functioning dashboard and real autonomous trading with **400 USDC alpha capital**. The owner explicitly replaced the previous 12:00 start; the date and agreed scope are unchanged. See section 12.
- **BETA date: 2026-10-01, Asia/Manila.** This replaces the older October 1 final V1.0-release description. Beta start time, capital, duration and participant scope have not been specified; do not infer them. See section 14.
- **Final V1.0/public release date: not specified by the revised instruction.** Do not report October 1 as both beta and a completed final launch.
- Historical master-plan wording about a US$100/day delay penalty is not verified or amended by this engineering milestone correction. Do not infer a contractual waiver, extension or confirmed liability from changing alpha/beta labels.
- P0/P1 delivery blockers take priority over nonessential polish. Schedule pressure must never be used to remove Stop, idempotency, duplicate-order protection, settlement/reconciliation, drawdown/loss protection or other capital-loss P0 controls.

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
- Alpha UX must guide connection, review of the 400-USDC session limits, necessary owner authorization and Start from the application. Normal operation must not require command-line use, editing Replit Secrets, or navigating internal diagnostics to approve each trade. Advanced diagnostics may remain available separately. This is an acceptance requirement, not a claim that the current UI already meets it.

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
- **September 15 alpha capital:** 400 USDC, scoped separately as described in section 12. October 1 beta capital is not set by the schedule correction.
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

Mandatory runtime boundaries until a separately authorized bounded activation:

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

The alpha's no-routine-human-intervention requirement is a **product acceptance condition**, not a present authorization for ChatGPT to place trades or change these locks. Prepare one comprehensible, bounded session-activation flow. After the user has explicitly authorized and started that session, the product must execute eligible trades and manage protection/exit within those verified limits without asking for a fresh human trading decision or manual confirmation for every order. New or expanded permissions, expired authorization and out-of-scope actions are not covered by that session. See section 12.

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

- 기준 시각 / **9월 15일 13:00 ALPHA**, **10월 1일 BETA**까지의 일정;
- 지난 1시간 완료;
- GitHub/Codex HEAD + CI;
- Figma/UI progress and easy-start/no-routine-intervention acceptance status;
- Replit passive deployment/runtime status and whether Agent was used;
- PAPER scheduler / GMX RPC / positions when authoritative evidence is available;
- duplicate/missing-work check;
- overall progress and M0–M4 / separately approved capital-ladder impact where relevant;
- remaining P0/P1 / alpha or beta blockers;
- next low-cost automatic task;
- `DEFERRED_USER_ACTION` / blockers;
- PAPER / Canary / LIVE schedule impact;
- Replit Agent call count and Production publish count for the hour.

A posted development request is not a running coding task. Verify acknowledgement/task identity and completion evidence. On a confirmed environment/permission error, mark the requested task BLOCKED, do not repeatedly submit it, and continue independent safe work where possible while requesting only the necessary owner setup action. Do not call Replit Agent or buy credits just to hide a failed Codex handoff.

## 11. Source-of-truth rule

The 2026-09-01 Master Plan remains useful for architecture, launch scope and historical constraints, but sections that say **Replit Agent is the primary implementer or should automatically start work whenever paused** are superseded by this low-cost policy. Older references to **September 15 beta** and **October 1 final V1.0 release** are superseded by the 2026-09-11 owner correction to **September 15 alpha / October 1 beta**. The 2026-09-13 owner instruction further replaces the alpha's **12:00** start with **13:00 Asia/Manila**.

Historical instructions requiring human approval for every first LIVE-test order describe a prior test mode; they are not the acceptance definition of the September 15 autonomous alpha. They do not remove the need for the user's bounded session authorization or a separately approved preparatory manual test.

Existing internal identifiers such as `FIXED_BETA_400`, `fixedBeta*` files and schema keys may keep their historical names for compatibility. Do not rename runtime code, database keys or persisted state merely to relabel the milestone. User-facing schedule and reports must use ALPHA for September 15. A label change does not reset HWM or create a new capital allocation.

Any status snapshot embedded in older documents is historical only. Current status must come from GitHub/Replit/runtime evidence. Updating this file does not prove that another conversation or scheduler has read it.

## 12. September 15 fixed ALPHA deadline — easy use and 400 USDC autonomous trading

### Owner-confirmed schedule and scope

The owner originally fixed September 15 at noon for a dashboard and real 400-USDC automated-trading test, then clarified the objective: “400 usdc로 보여줘야하는건 손쉬운 사용법, 사람의 간섭 또는 제어 없이 자동으로 매매를 보여주는게 목표”. The owner then corrected the milestone names: “9월 15일 알파 - 10월 1일 베타”. The latest explicit start-time instruction is: “반드시 15일 오후 1시부터 알파 테스트 가능하도록 진행할것.” The earlier noon time is historical only.

- **Fixed ALPHA start: 2026-09-15T13:00:00+08:00**, 1 PM in Asia/Manila; **2026-09-15T05:00:00Z**.
- Deliverable A: a functioning, easy-to-use Production dashboard, including the approved Figma first-release UI and accurate runtime/capital/position/PnL/risk information.
- Deliverable B: a controlled real-money **autonomous** trading alpha using **400 USDC of dedicated alpha capital**, without routine human trading decisions or per-order approvals once the bounded session has been properly authorized and started. PAPER alone, a manually approved trade, or a chart animation does not satisfy this deliverable.
- Do not unilaterally reschedule, substitute a PAPER-only demonstration, or reduce the agreed scope. Relabeling beta to alpha does not waive the fixed date, real-money objective or safety gates.
- This alpha is not proof of sustainable profitability. The separate October 1 milestone is now BETA; see section 14.

### Capital meaning and unchanged safety boundary

- 400 USDC is the alpha trading-capital budget, not a required single-order notional, not a profit target, and not permission to lose the entire 400 USDC.
- Planned Seed remains 10,000 USDC. The existing 1,000 → 2,500 → 5,000 → 10,000 capital ladder remains separate; there is no automatic promotion or wallet top-up.
- Develop and test the scoped 400-USDC capital binding separately from legacy 1,000-USDC policy baselines, historical HWM/equity and actual available wallet collateral. Reuse the existing fixed-beta modules where applicable. Do not substitute a fake wallet balance or bypass capital-drift checks.
- Do not reset existing HARD_STOP/HWM, change Production DB/trading capital/Secrets, create a new signer, sign, authorize a subaccount, enable Relay/AUTO LIVE or submit orders merely because this milestone exists or its date arrives.
- Section 8 execution locks remain in force until separately authorized activation. Actual financial activation requires fresh preflight and explicit bounded approval, with the allowed markets, exposure/leverage, stop policy, loss budgets, authorization lifetime/action budget, test end/renewal and emergency procedure resolved.
- The latest owner directive does not specify an end time, test duration or full-capital loss tolerance. Do not infer an eight-hour session, a 20:00 end, indefinite authority, or permission for a 400-USDC loss from an assistant suggestion or summary.
- Preserve existing percentage-based risk constraints until any separate change is explicitly approved. For planning only, 0.25–0.5% of 400 is 1–2 USDC per trade and 1% is 4 USDC per day; these calculations do not themselves change runtime configuration or guarantee a maximum realized loss.

### Easy-start and no-routine-human-intervention acceptance

- Intended user flow: **connect existing wallet → review capital/session limits and complete required owner authorization → Start → observe**. Necessary wallet/security prompts must remain visible; do not promise that first setup always takes exactly one click.
- After authorized Start, the server must independently evaluate opportunities, choose eligible direction/size/timing within existing policy, submit permitted orders, confirm fills, establish protection, manage positions, close, clean up residual orders and reconcile actual costs/PnL. The user must not have to pick a symbol/direction, press Buy/Sell, approve each order in MetaMask/PIN, type a chat instruction, or manually advance each lifecycle step during normal operation.
- A ChatGPT conversation, Replit Agent session, open dashboard tab or online viewing device must not be required for normal server-side trading/protection. Test browser closure/reconnection and server restart/reconciliation without causing duplicate orders or lost protection. This is a verification requirement, not current runtime evidence.
- Preflight must prove that the delegated session's lifetime and action budget cover the intended demonstration plus protection/exit/recovery reserve. An approval expiring mid-demo or repeated manual renewal is not equivalent to uninterrupted autonomous operation. Do not extend existing permission limits silently to make the demonstration pass.
- On stale data, loss-limit breach, insufficient authority, missing Stop capability or unresolved settlement, automatically block new entries and follow the validated bounded protection/recovery path. Preserve monitoring and existing protection where possible; do not disable all position management merely because new entries stop. Display the reason clearly. Do not trade using stale or invented evidence.
- Emergency Stop and user revocation controls remain available. “No routine human interference” does not mean removing safety controls. Record an emergency intervention honestly rather than hiding it to claim an autonomous pass.
- Reuse the existing audit/decision/order/settlement records to capture session start, initial approvals, each eligible signal, transaction/order IDs, protection confirmation, close/settlement, pauses, errors and human interventions. Normal successful autonomous lifecycle acceptance requires **zero routine manual trading decisions or per-order confirmations after Start**. Initial setup and any exceptional safety intervention must be reported separately.

### Acceptance evidence — report A and B separately

A. Dashboard/ease of use: deployed source matches the exact CI-passing source; actual desktop rendering and navigation pass; guided setup does not require developer-only tools; capital/wallet/PAPER/LIVE/unknown data are unambiguous; market freshness, AI decisions, order/position state, PnL/costs and safety controls reflect authoritative data; reconnect and stale/error paths do not display false READY or fake zero balances. Record setup actions and time observed rather than inventing usability scores.

B. Autonomous execution: eligible signal → existing Risk/cost gates → confirmed GMX entry → confirmed protection → position management → confirmed close → residual order cleanup → settlement/readback are evidenced **without routine human trading decisions or per-order confirmation after authorized Start**. Price movement alone, an API acknowledgement, a signer-ready flag, a manually executed demonstration or a PAPER trade is not proof of autonomous real-trade completion. Duplicate submissions and unresolved settlements must not be hidden. Browser closure must not stop server-side operation/protection.

All current cost/Owner Approval/canonical delegation/action-budget/Stop/Risk/release/GMX gates must pass. Keep the $0.40 cost cap; do not loosen it, raise leverage or force an uneconomic order to demonstrate activity at the fixed start time. If there is no valid signal, record NO_TRADE and mark the actual-trade lifecycle UNVERIFIED rather than inventing a pass. A profitable short alpha is not proof of long-term positive expectancy.

### Internal delivery gates — working deadlines, not completion claims or installed jobs

All times are Asia/Manila (UTC+08:00). The revised 13:00 alpha start does not extend prior development/deployment deadlines. They do not claim that a worker/job has been started or that delivery is already assured.

- **September 10, 18:00 (original assessment deadline):** existing-source/runtime discrepancy assessment, remaining implementation scope and user-only dependencies. If this past milestone lacks evidence, mark it unverified; do not retroactively claim PASS.
- **September 11, 18:00:** close outstanding source/runtime evidence gaps through an authorized verification path without hourly Agent polling; confirm the existing 400-USDC modules' worker/Risk/execution wiring, easy-start flow and absence of routine per-order human gates in the intended authorized mode. Finish only missing alpha-critical connections and identify remaining user-only prerequisites. This retains the September 11 recovery checkpoint recorded in PR #1.
- **September 12, 18:00:** finish alpha-essential code and isolated PAPER/replay/regression validation for the dashboard, 400-USDC capital semantics, costs, autonomous entry/protection/close/settlement, browser independence, restart and duplicate suppression. Obtain exact-source CI evidence for the release candidate. Missing evidence is not a PASS.
- **September 13, 18:00:** complete any outstanding alpha-critical integration/tests and the necessary single-batch PAPER Production deployment of the validated candidate, actual browser acceptance, release-source parity and runtime smoke within existing permissions. Report missed earlier milestones honestly; do not defer a complete alpha release indefinitely to collect unrelated features.
- **September 14, 18:00:** complete the readiness rehearsal and report both deliverables' gate matrix, including routine-human-intervention evidence; freeze non-blocking code changes. Prepare the bounded activation request and user-only prerequisites early. Obtain/revalidate time-bound authorization close enough to the alpha to remain valid; do not repeatedly request signatures that expire while code work is unfinished.
- **September 15, 11:00–12:30:** final fresh runtime/cost/authorization/Stop/Risk checks and required user-controlled bounded activation steps. Do not leave known development or deployment blockers until this window.
- **September 15, 12:30:** final Go/No-Go with fresh evidence and the user's required bounded authorization; this checkpoint does not itself unlock LIVE.
- **September 15, 13:00:** fixed ALPHA session start. Real-money execution is permitted only within verified, explicitly authorized bounds. If a mandatory financial gate is still failed or unknown, do not execute through it; report live-scope non-delivery rather than claiming that dashboard/PAPER/manual-order results satisfied the autonomous alpha.

### Critical-path priority and early escalation

- Until alpha, work only on the agreed easy-use dashboard/400-USDC autonomous-trading delivery path and capital-loss-prevention defects. TradingAgents integration, extra paid agents, infrastructure migration, unrelated strategies and cosmetic expansion remain frozen.
- Reuse existing validated functions and audit records; do not create new diagnostics or documentation-only tasks unless they directly unblock this alpha, prevent unsafe execution or correct a material requirement conflict.
- During each actual development/reporting run, include the next internal deadline, achieved acceptance evidence and remaining blocker. Unknown runtime evidence must remain UNKNOWN and be assigned a concrete verification path, not copied as healthy from an old report.
- If a blocker threatens an internal deadline, flag **SCHEDULE_AT_RISK** in that run's report with the issue, evidence/time, dependency/owner, recovery action, estimated work and any single required user action. Do not wait until September 15 to disclose a known delay. An estimate is not a guarantee or an authorization to buy extra credits.
- Document changes do not count as implementation, deployment, actual trading or profitability progress. Do not use ungrounded completion percentages to imply readiness.

### Cost, priority and reporting

Retain the Codex/GitHub → GitHub Actions → Replit final-publish workflow and existing Figma source. No TradingAgents integration, extra paid research agents, infrastructure migration, cosmetic expansion or duplicate full-suite/deploy loops for this alpha. Deadline pressure does not override Agent-spend controls or authorize extra paid credits.

On a subsequent canonical run, read this same policy path and report the **fixed September 15 13:00 ALPHA deadline** and **October 1 BETA date**, with each relevant acceptance gate as PASS / FAIL / UNKNOWN / DEFERRED_USER_ACTION and source/time/version. Reading or updating this document is not proof that another conversation or scheduler has executed it. Do not claim an automatic launch, hourly push delivery, completed deployment, current GMX state or profitability without execution evidence.

## 13. Post-validation roadmap — user-selectable exchanges and reward comparison

**Roadmap item:** `RM-EXCHANGE-REWARDS-01`  
**Recorded:** 2026-09-09  
**Status:** `BACKLOG_ONLY` — owner-requested roadmap inclusion; implementation not started or scheduled.

### User rationale and scope

The owner clarified that exchange choice is not only about fees or familiarity: normal trading activity may qualify for exchange rewards, points or airdrops, and these benefits can be part of the user's selection criteria. The owner explicitly said this is not required immediately and requested roadmap inclusion.

- Extend the future user-selectable-exchange roadmap to compare execution quality, total costs, account eligibility and official rewards together.
- This is a post-beta-stabilization expansion candidate requiring reprioritization. It must not displace the fixed September 15 13:00 dashboard + 400-USDC ALPHA or October 1 BETA work. No new delivery date, paid service, venue migration or multi-user SaaS scope is approved by recording this item.
- The purpose is to help the user choose where to conduct independently justified trading, not to maximize turnover or manufacture activity for rewards.

### Proposed comparison and tracking requirements

1. **Execution and costs:** compare the same instrument exposure, order size, holding period and risk assumptions across eligible venues. Include commissions, funding/borrowing, spread/slippage/price impact, execution/cancel/retry fees and applicable transfer/conversion costs. Label estimates and missing data; do not infer venue compatibility or savings from a headline fee.
2. **Official campaign evidence:** record venue, campaign/season, official source URL, last verification time, terms version, start/end/snapshot/claim dates, reward type, allocation rule, caps, vesting/lockup and cancellation/clawback conditions. Distinguish announced, active, ended and unverified programs; a points program is not automatically a confirmed token distribution.
3. **Account and API eligibility:** verify residency/KYC/product restrictions and whether API/bot/third-party-interface trades count. Check relevant market/order type, subaccount versus wallet attribution, registration/opt-in/referral conditions and eligible volume exclusions. Unknown eligibility remains UNKNOWN, not eligible by default. Never bypass account or jurisdiction restrictions.
4. **Reward ledger:** separate trading net PnL, fee rebates/discounts, credited cash rewards, claimable but unreceived rewards, received token inventory and speculative points/possible airdrops. Points without a verified conversion are tracked as units and assigned zero in base-case realized PnL, usable capital and execution-cost gating. Indicative token valuations or optional scenarios are not realized cash and must show assumptions. Do not count a rebate twice when already reflected in net fees.
5. **User controls:** show fee-only and reward-aware comparisons separately, including a conservative scenario with no speculative airdrop. Let the user prefer lower cost, stronger execution or eligible rewards only among venues meeting mandatory safety requirements. Expose freshness/eligibility/uncertainty rather than presenting one unsupported guaranteed-return score.

### Safety and economic guardrails

- Existing Risk Engine, Stop/emergency-close, loss/exposure limits, authorization and settlement/reconciliation controls remain authoritative. Rewards never override a failed trading or safety gate. The current $0.40 cost cap is unchanged; uncertain rewards cannot be deducted to create a PASS.
- No forced extra trades, wash/self trading, artificial volume, sybil/self-referral abuse, leverage escalation or longer holding solely to farm points. Evaluate incremental costs and risks against collectible benefits without assuming a future token price or entitlement.
- Campaign expiry or unavailable reward data removes the reward assumption; it must not stop protection of existing positions. An initial venue switch requires no open positions, live orders or unresolved settlements, and account/venue-bound records remain intact.
- Selecting a venue is not authorization to transfer, bridge, convert, stake, claim rewards, sign, connect new financial permissions or activate LIVE. Those actions remain separately approved; initial scope is comparison/selection, not autonomous cross-venue routing or fund movement.

### Staged implementation proposal — no work has been queued

- **Stage A:** after beta stabilization and reprioritization, build or reuse a read-only comparison for a small number of candidates. First verify that CCC's intended API activity qualifies; estimate development and ongoing data/maintenance cost before adding an adapter.
- **Stage B:** add one owner-selected venue only if execution safety and conservative net benefits justify the integration. Reuse existing strategy/Risk boundaries and validate account reads, PAPER behavior and a separately approved bounded live lifecycle.
- **Stage C:** reconcile official eligible activity, awarded rewards and actual trading/AI/infra costs; expand only with measured value. A short-lived promotion alone does not justify a large irreversible integration.

When future canonical runs read this file, retain this item as deferred roadmap work, not an alpha/beta blocker or permission to start implementation. This documentation update does not prove that another chat or scheduler has read it.

## 14. October 1 BETA — revised milestone, not final release

- Owner-confirmed beta date: **2026-10-01**, Asia/Manila. The user did not specify a start time, beta capital, duration, number of participants, external release or paid-service scope. Do not infer 400/1,000/10,000-USDC funding or auto-promote capital on that date.
- Planning focus between alpha and beta: use actual alpha evidence to fix usability and autonomous-lifecycle defects; verify stability, protection/restart/reconciliation, cost accounting and observed strategy performance. These are preparation priorities, not claims that alpha has passed or that a brief test proves profitability.
- Keep the existing personal, desktop-first GMX scope and cost controls unless the owner separately changes them. Beta is not automatic approval for SaaS, additional exchanges, unlimited authority or continuous real-money execution beyond an approved session.
- Retain separate dashboard/ease-of-use, autonomous-execution, operational-reliability and economics results. Address each unknown or failed gate with evidence; do not equate CI green, stage naming or a profitable small sample with final-release readiness.
- Final public/V1.0 launch date remains unspecified. This schedule correction changes engineering milestone labels and priorities, not legal contract terms or runtime financial permissions.
