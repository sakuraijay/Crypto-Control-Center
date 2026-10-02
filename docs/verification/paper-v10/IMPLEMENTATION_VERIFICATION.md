# PAPER v10 implementation and local verification

## Scope

This completes the additional approval to make each of the 38 registered
chart/candle patterns an independent PAPER entry strategy. This is not a new
account, ledger reset, LIVE permission, signer/key change, paid data subscription,
PR merge, forced Git update, or production publish.

`virtual400-daily/v10` uses `paper-pattern-entry/v10`. Existing v7/v8/v9
policies, historical trades, deposits, losses, comparisons and entry plans remain
distinct. Activation requires an ACTIVE, flat session with no pending close or
unresolved executor state and records append-only provenance.

## Behavior

- Each contract defines formation, completed confirmation, direction, entry
  trigger, observed invalidation stop and stop/time exit. Neutral formations do
  not choose a direction before their first later completed breakout.
- Incomplete candles and unconfirmed pivots are not entry evidence. Event IDs
  remain bound to their formation anchors, including after a recross.
- Same-side patterns remain separate candidates with support IDs. Opposing
  completed evidence within or across timeframes is explained and withheld.
- Legacy quality, score, momentum, regime, ATR, horizon, net-positive and
  net-reward/risk conditions are auxiliary, not hidden admission vetoes.
  The former 45-minute entry cooldown, 32/day cap and profit KPI are not v10
  entry vetoes.
- Daily 5%, weekly 10%, cumulative 30%, 1% account risk, one position, 5–10x
  leverage, $1,000 notional and $100 margin protections remain. Exact-size,
  fresh market/cost evidence, the $2 cost reserve/cap and observed protective
  stop checks remain mandatory; missing evidence does not become zero.
- The executor independently matches the exact cached cost snapshot to the
  durable audit, including direction, market, size, clock, source and rates.
  Invalid pattern IDs/frames, stale or changed snapshots and unbound plans fail
  closed. Failed opens retain their event claim for at-most-once safety.
- Targets are null rather than fabricated. INTRADAY holds at most one hour,
  SWING at most four hours. Existing positions use their immutable entry plan.
- The dashboard/journal distinguish leading entry patterns from older
  reference-only evidence; stale or absent snapshots show a waiting state, not
  assumed zero counts. Image analysis and explanatory drawings never authorize
  an order. Existing screenshot and PIN-removal work is preserved.

## Local checks, 2026-10-02

| Check | Result |
| --- | --- |
| Full workspace TypeScript check, including shared libraries | PASS |
| API regression suite | 201 files, 3,056 tests PASS |
| Web regression suite | 42 files, 514 tests PASS |
| v9 immutable replay regressions and stop reproduction | 6 tests PASS |
| v10 chronology, conflict, ranking and evidence replay regressions | 10 tests PASS |
| Git whitespace check | PASS |

The expected API failure-status fixtures are passing tests, not production
requests. Source-bound deployment builds require the committed source; no
security provenance check is bypassed to build a dirty working tree.

## Research limits

See [README.md](README.md) and the separate captured/report JSON files.
The official free GMX capture contains 199 closed bars per symbol/timeframe for
BTC/SOL/XRP primary and ETH/LINK supplementary at 15m/1h/4h. Its cutoff is
2026-10-02T14:39:19Z, before the end of the PHT day.

The final causal model has 177 unique pattern events, 68 next-open-proxy eligible
events, 179 neutral waiting formation IDs, 27 same-timeframe conflict events and
55 cross-timeframe conflict IDs. Primary v10 modeled entries are 14 at either
assumed 10/20 bps; old v9 primary entries are zero. Supplementary v10 modeled
entries are 13; old v9 has two/zero respectively.

Those counts are modeled, not actual fills. The model records entry no earlier
than the completed-candle decision plus two seconds and labels the earlier
next-bar open as a price proxy. Actual net PnL, drawdown, win rate and entry delta
remain null/UNAVAILABLE. This sample does not establish profitability or
demonstrate that all 38 patterns occurred today.

## Source and service status

Build, GitHub source preservation/CI, and running-preview checks are verified
after the committed source is created and reported separately. Production was
observed on `virtual400-daily/v8`; this work does not publish v10.