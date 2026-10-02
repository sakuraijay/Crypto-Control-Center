# PAPER v10 point-in-time replay

This is a read-only, retrospective PAPER comparison. It does not contact a worker,
bootstrap the database, place orders, or request paid data. Raw observations and
the replay are separate from the immutable PAPER v9 evidence.

## Reproduce

```sh
node scripts/paper-v10-capture.mjs
node scripts/paper-v10-replay.mjs
node --test scripts/paper-v10-replay.test.mjs
```

The capture script uses only the official free GMX Arbitrum candle endpoint
(`https://arbitrum-api.gmxinfra.io/prices/candles`), with 200 requested rows for
each of BTC, SOL, XRP, ETH, and LINK at 15m, 1h, and 4h. It refuses to overwrite
an existing evidence file. BTC/SOL/XRP are primary; ETH/LINK are supplementary.
Each symbol/timeframe has its raw response, response SHA-256, filtered completed
bars, and the overall capture has its own SHA-256. Replay validates all hashes
and rebuilds the closed-bar filter from the immutable raw responses.

## Capture and results

- Requested decision window (PHT): **2026-10-02 00:00 through 2026-10-03 00:00**.
- Capture cutoff: **2026-10-02T14:39:19.096Z**; therefore this replay observes
  only the captured portion of the requested window, not the remaining 81 minutes.
- Coverage: **199 completed candles per symbol/timeframe**; latest closes were
  14:30Z (15m), 14:00Z (1h), and 12:00Z (4h). At least 60 completed warmup
  candles are retained for every detector timeframe.
- Capture SHA-256: `6d278a94a59038b73f04092cd2b0550229a5edae1b8dd68d066c49a0287796c4`.
- Exact engine registry: **38** pattern IDs.
- Across all five assets: **177** unique v10 candidate events; **68** passed
  post-confirmation, next-bar-open proxy checks and stop validation and became eligible for portfolio
  simulation. Declines: **12** stale confirmations, **39** stop bounds,
  **4** trigger failures, and **54** candidates withheld for cross-timeframe
  directional disagreement.
- Primary candidates: **113** raw / **43** eligible. Supplementary:
  **64** raw / **25** eligible.
- Unique neutral WAIT events: **179**. Unique conflict events: **27**; same-timeframe
  opposite evidence is withheld, not directionally selected.
- Cross-timeframe opposing evidence is also checked per symbol and evaluation
  snapshot (**55 conflict event IDs**); when directions disagree, all candidates
  for that symbol are withheld.
- Leading eligible pattern IDs: SPINNING_TOP (33), DOJI (20),
  GRAVESTONE_DOJI (4), DRAGONFLY_DOJI (3), BULLISH_MARUBOZU (3).
  Eligible evidence occurred on 15m (62) and 1h (6); none occurred on 4h.
- The report includes the earliest 30 candidate event IDs, formation and
  confirmation times, timeframe, trigger, observed stop/target, evaluatedAt,
  modeled entryAt, quoteProxyAt, and proxy basis. Full accepted/declined
  evidence and modeled trades are in the JSON.

### Reproducible actionable evidence fixture (not an exchange fill)

The replay contains a real BTC 15m neutral-formation event suitable for
downstream audit/UI fixture checks:

- Event / durable formation ID: `BTC:15m:DOJI:1790871300000`
- Formation: `2026-10-01T16:15:00Z`; first completed downside confirmation:
  `2026-10-01T17:00:00Z`
- Direction / trigger: SHORT at or below **84,223.84**. The 15m close is
  `decisionAt=2026-10-01T17:00:00Z`; evaluation and modeled `entryAt` are
  `2026-10-01T17:00:02Z`. `quoteProxyAt=17:00:00Z` uses the next candle's
  **84,160.11** open strictly as `NEXT_BAR_OPEN_ASSUMPTION`, not as a current
  quote, observed entry price, or fill.
- Observed protective stop: **84,387.44**; stop distance at the candle-open
  reference is about **0.270%**. No observed target exists, so `targetPrice`
  is explicitly `null`.
- Maximum hold: **1 hour** (the current INTRADAY engine rule). In the modeled
  10 bps scenario the first completed OHLC bar ending `17:15Z` touched the stop;
  the precise intrabar path/stop time is unknown. This is a retrospective
  conservative OHLC proxy, not a real execution or account result.

This fixture demonstrates an observed formation, completed confirmation,
trigger, protective stop, and time-based exit contract without inventing a
target or claiming a fill.

### Paired candidates and modeled portfolio

V9 uses the existing `dailyPaperCandidate(..., 'v9', 'INTRADAY')` source and its
old signal, structural stop, observed target, horizon, and modeled net-RR/cost
gates. It is not treated as v10. Initial-state modeled old-gate acceptances were
3 at 10 bps and 0 at 20 bps across the five-symbol set. Actual chronological
portfolio entries (including one-position, cooldown, and loss limits) were:

| Pool / candidate path | 10 bps model entries | 20 bps model entries |
| --- | ---: | ---: |
| Primary v10 | 18 | 18 |
| Primary old v9 baseline | 0 | 0 |
| Supplementary v10 | 16 | 16 |
| Supplementary old v9 baseline | 2 | 0 |

V10 does **not** apply legacy quality, momentum, regime, target-horizon,
net-positive, or net-RR admission gates. The 10/20 bps estimates are explicit
cost assumptions and modeled PnL only, not expected or actual results.
V10 rechecks protective stop direction and the executor 0.2%-0.8% stop bounds
using the next 15m candle open as a price assumption and timestamps modeled
entry at evaluation (the close plus two seconds), one position, a 1% risk budget
less the $2 policy reserve, a $1,000 notional cap, 5-10x leverage, a $100 margin
cap, and 5% daily / 10% weekly / 30% cumulative loss budgets. Its new v10 policy
does not apply the old v9 45-minute cooldown, 32-entry daily cap, or 20% profit
cap; the replay adds only a 1,000-entry global ceiling to bound computation.
The v10 worker calls `dailyPaperRiskPct(consecutiveLossCount, null, now)`, so
the helper's 0.5x recent-loss branch is not active; this model therefore uses
the worker's effective 1.0x sizing. These are named account protections, not
signal-quality filters.

Entry evidence is checked against the worker's current conditions at
`evaluatedAt=decisionAt+2s`: confirmation must be no more than 60 seconds old,
the next-bar-open price proxy must remain beyond its trigger, and price must
stay within 2% of the detector reference. The proxy bar contributes only its
open to candidate selection; its later high/low/close are not consulted then.
Declines for freshness/trigger checks are listed separately from stop-bound
declines. Candidate patterns stay independent and are deterministically ranked
by confirmation time, timeframe, then event ID.

Stops and observed targets are tested on completed OHLC bars starting with the
entry-proxy bar; gaps use the adverse/open price and a same-bar stop/target tie
resolves to the stop. The first two seconds after the candle open precede the
modeled evaluation time, but their intrabar path is unknowable; treating any
first-bar stop touch as adverse is conservative, not a claim of stop chronology.
If the detector provides no target, no synthetic price target is created; the
modeled exit uses observed stop or the first completed close at/after the
maximum-hold deadline. Pending positions remain pending and block later entries
through the capture cutoff.

## Formal performance and limitations

`formalFinancialEvidence` intentionally reports actual net PnL, actual maximum
drawdown, actual win rate, and actual entry-price delta as `null`, classified
`UNAVAILABLE`. There is no point-in-time account state, exact-notional quote,
exchange fill, impact, fee/funding ledger, or actual entry evidence in this
capture. The modeled trade outcomes cannot establish formal financial
performance. There is no contemporaneous quote at the modeled entryAt; the
candle open is only a price proxy. OHLC bars also do not reveal intrabar path,
especially the first two seconds before evaluation; stop-first/conservative
time-based bar resolution is not an actual execution chronology.

The capture cutoff precedes the end of the PHT day; no prices after that cutoff
are inferred. ETH and LINK remain clearly supplementary and are not mixed into
the primary result.

## Source pins for this replay

The JSON contains the complete SHA-256 pins. At replay time they were:

- `patternEntryStrategies.ts`: `f37b6c8ff2e47a9d6a418c3bae305d50dc5ed0cb2a1bc23bf805eb57acac1d9d`
- `chartPatterns.ts`: `c53aaa78e51b0c5b0cf8c17aa5a5a8015c348ad92bace41ed8e5701786a3632e`
- `virtualPaper400Runtime.ts`: `63efb2e9e0a3bc0f6576441381aa935730221a6fc5618bc60972bf54e759aa2b`
- `virtualPaperPatternDailyCycle.ts`: `42e6f2509a0d32136a8ebef627b707143c277181fef63f37ca4bc89b3b89774f`
- v9 `virtualPaperDailyCandidate.ts`: `9e414adaf49b20ea1ee3515733ca13c76c9f243e5f4f96f5089293fe3bccff35`
- v9/v10 `virtualPaperDailyPolicy.ts`: `b8d614550482a83edd76b99cbda4879b5d7bc0bf1a4664577e08701c60549dd4`

These source pins are reproducibility identifiers, not attestations of actual
trade execution.