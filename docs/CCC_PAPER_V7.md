# PAPER v7 — 2026-09-29 supervisor instruction

User approved a **5% daily cumulative net loss limit** and the loss-analysis improvements. This supersedes v6's daily 10% limit; it does not authorize real-money execution, new credits, a reset, or additional subscriptions.

## Applied rules

- Daily loss uses cumulative funded principal, as before: $1,000 => $50. Realized net plus negative unrealized net consumes the budget; deposits are not returns. Existing locks survive. PHT day rollover clears only daily locks. Gaps and execution delay can exceed thresholds.
- New-entry risk is 1% of current equity capped at $1,000; reduce to 0.5% after two consecutive losing settlements or equity below 80% of funded principal. Existing two-percent snapshots remain readable for prior positions but cannot authorize new daily entries.
- Three consecutive losses pause entries for four hours after the latest close, including across midnight. Weekly loss 10% of funded principal latches until normal PHT week rollover. Total equity <=70% of funded principal latches a hard stop, with protective close. The 30% cumulative cap includes existing losses; no new baseline erases them. Daily, weekly, cumulative remaining budgets also constrain sizing.
- Leverage remains 5–10; position notional <=$1,000, margin <=$100, concurrent positions <=1, 45-minute entry interval, 32-entry ceiling. No minimum turnover or guaranteed daily return. 5–20% remains a research aspiration; the 20% net realized cap stops entries, not protective exits.
- Official completed 15-minute bars only. Signal screening uses preceding/recent hourly momentum alignment, directional efficiency, ATR band, anti-chase candle size, or confirmed wick rejection near a range edge. Transition, weak and unsuitable volatility conditions abstain. These are transparent, unvalidated heuristics, not a trained regime predictor.
- All eligible GMX markets remain in the rotation. Up to three observed candidates are ranked by **net target/risk, directional efficiency, and observed price impact**, not raw momentum magnitude. This score is not verified expected return. Official market eligibility and exact-side/notional cost validation remain required; costs are refreshed/checked before dispatch. No fabricated liquidity values.
- Net reward/risk >=1.5 after estimated costs. The 2x price-distance target is unchanged: reject poor economics instead of moving the target away. The $2 maximum cost reserve remains conservative, and especially at small size may cause prolonged abstention. This is observable, not bypassed to manufacture trades.
- New immutable `virtual-cost-filtered/v1` plans exit non-profitable/no-progress positions after half their maximum horizon (intraday 30 minutes; swing two hours); all expire by the original one/four-hour maximum. This is an early no-progress trial, not verified trend-following trailing logic. Legacy v3/v4 positions retain their original exits and expiry.

## Measurement and validation

`runtime.performance` aggregates **all completed positions** by symbol, side and final close reason, summing partial settlements; includes net win rate, mean wins/losses, net profit factor, gross/net and modeled costs. It complements the recent-ten journal and daily calendar.

`runtime.comparison` records a prospective paired-candidate experiment in a separate session state key. The same observed candidate, notional, quote, target/stop and full-horizon estimated cost are used for the legacy exit arm and quality-filtered/early-exit arm. No orders or capital are allocated by the comparison. Only mature pairs enter metrics; estimates include 2x-cost stress, net expectancy, win rate and cumulative candidate drawdown. Restart restores samples; malformed evidence is preserved and reported unavailable, without blocking position protection. Storage is bounded at 2,000 candidates and explicitly reports CAP_REACHED instead of discarding old evidence.

Limitations: candidate observations occur only when production evaluates entries; this is **not an independent baseline portfolio or a validated backtest**. The baseline refers to unfiltered candidate acceptance and old exit rules at the current reduced size, not a replay of historical v6 account sizing. Full-horizon estimated costs are conservatively retained for early exits. Tick gaps and server restarts can change simulated exit prices. Market-regime selection and early exits can worsen returns. No statistical sufficiency or profitability claim is made.

Learning rows keep v7 quality/selection features and a separate strategy version. Existing purged chronological/walk-forward tools remain the evaluation path; training, optimized values, slippage-component stress and live eligibility have **not** been proven. Compare on later unseen data and different market conditions, preserving all historical losses. Do not tune on a few winners or promote automatically.

## Operations

Safety tightening applies to existing daily-policy accounting immediately. Entry policy migration waits until no held position/pending close/unresolved state. Never rewrite session, trades, contribution events, HWM or existing trade plans. The 4-hour report must include policy version, 5%/$50 limit, actual risk tier, net/cost metrics, blocking reasons and paired-comparison maturity; distinguish code/test/deployment completion from profitability validation.
