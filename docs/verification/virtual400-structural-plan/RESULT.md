# Virtual400 structural plan and durable diagnostics

Status: implemented and locally verified; exact-source CI and production deployment pending at commit time. This file is historical evidence, not live release identity.

## Cause and chosen correction

A trend candidate can target 2 times price risk, while the previous plan demanded at least 2 times (price risk + full $0.40 reserve), plus a fixed position ROE target. Positive costs made these contracts incompatible for many candidates. The previous 3%/5% margin stop ceiling also rejected valid structural stops at 5–10x.

New Virtual400 PAPER entries preserve the strategy's first price target and structural stop. They require net reward / (price risk + estimated entry, exit and maximum-holding costs) >= 1.5, matching the existing strategy arbiter floor. This is a deliberate PAPER policy change from the previous 2R reserve-based gate, not a profitability claim. The margin stop ceiling is 10%; integer leverage remains 5–10. Reserved account risk still includes the full $0.40 cost cap. Account risk 0.5%, notional $200, margin $100, daily-loss/HWM/cooldown/frequency limits remain enforced. No signal is fabricated or high-volatility gate removed.

Immutable v1 plans retain their old exits. New v2 plans are reconstructed and validated at execution, bound to the signal target and current cost evidence. Restart, actual net losses including gaps, expiry and settlement remain authoritative. A stop trigger is not a guaranteed maximum realized loss.

## Diagnostics and UI

Session-scoped durable diagnostics retain up to 24 UTC hourly buckets, deduplicate completed candles across restarts, count observed minutes separately from candidate and entry stages, retain sanitized reasons, and expose actual OPEN/CLOSE ledger counts. Coverage begins on deployment; missing historical records are not reconstructed. Invalid diagnostic state is preserved and reported UNAVAILABLE without disabling protective runtime paths. Existing shared API/polling is reused.

Figma XkbzMFg3CL2bW6Z7cPILna node23:22 was updated and visually checked before matching UI wording: unverified account daily goal 5–10%, strategy-price exits, net R:R 1.5, margin stop ceiling 10%. Browser mode selection remains authenticated and server-persisted.

## Verification

Local API excluding isolated PostgreSQL: 184 files / 2778 tests passed, followed by 15 runtime tests including one added persistence/corruption integration case. Local web: 36 files / 463 tests passed, followed by 9 authority tests including one added new-policy UI case. Real executor lifecycle cases cover structural profit, gap stop, deadline, changed-cost rejection and restart; legacy cases pass. Final exact-source CI must also run isolated PostgreSQL, pinned settlement tests, types and deploy build before publishing.

Historical entry compatibility only: run `node --import ./scripts/node_modules/tsx/dist/loader.mjs scripts/virtual-plan-compatibility-replay.ts`. The complete fixed committed BTC corpus after 239 warmup candles yields 760 completed-candle steps, no parameter/period search. See compatibility-result.json for provenance and counts. Base costs: 17 candidates, 5 below confidence and 3 over holding-cost cap; of 9 remaining, legacy plan compatible 1, structural 2. Double costs: 8 candidates; all fail confidence or holding cost, zero compatible plans.

This is not a portfolio replay, final CandleSignal execution validation, walk-forward/OOS profitability study, historical GMX cost/fill study or multi-coin proof. No daily return, drawdown distribution or daily-trading success is established. Existing exposure/frequency constraints still materially limit the daily account target.

## Operational continuation

User directs immediate correction when problems are found. Reports must state cause, selected remedy, executed result/evidence, remaining blocker and next action, then deadline impact. DEADLINE_AT_RISK or a countdown alone is insufficient. Next: exact-source CI → preserve existing session/ledger and deploy PAPER → verify fresh diagnostics → use rejection evidence to select the next strategy/data correction and time-separated profitability validation. Synthetic lifecycle success must not be reported as a natural production fill. No extra paid plan, LIVE activation, seed reset or forced trade is authorized by this change.
