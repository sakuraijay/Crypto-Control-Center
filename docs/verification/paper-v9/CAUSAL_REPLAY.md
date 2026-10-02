# PAPER v9 causal replay — 2026-10-02

## Decision

Retain a 1.5 net reward/risk floor for now. The captured OHLC sample shows
reproducible structural eligibility and model sensitivity, but not a feasible
measured execution-economics case for relaxing that gate. Point-in-time
side-specific exact-notional fees, impact, funding, borrowing, and account risk
state are absent; measured net PnL, drawdown, and win rate therefore remain
`UNAVAILABLE` / `null`. The scenario PnL below is assumption-driven and is not
proof of performance, an expected return, or a profit guarantee.

## Independently captured v8 stop failure

The read-only production observation in [`root-observation.json`](./root-observation.json)
at 2026-10-02 13:47:21Z recorded `NO_TRADE` with `V8_STOP_INVALID` for **SUI,
SOL, and BTC**. All three had a `null` `v8_stop_fraction`; their distinct v7
legacy stop fractions were 0.008, 0.004725092901510832, and
0.003007171830037441 respectively (each legacy stop condition passed). The
raw candidate evidence and condition arrays are preserved there. This
reproduces the requested operating failure; it does not impute the v7 stop to
the v8 arm.

The same capture shows the active production policy was still
`virtual400-daily/v8`. This replay is offline and does not change that state.

Before the worker edits, the v8 source snapshot was taken from HEAD
`e8a6502618a2e971c6e5f91a3d43dcea2aff71bd` into `/tmp`:

| Baseline source | SHA-256 |
| --- | --- |
| candidate | `c1be76e7213bc0aefed5d162d7c35f28ed052f68b33da921343a8837e7a17ded` |
| cycle | `f37ad1496ffb6d978a02400d9aef891b5497295b55d37308c4bf34e573d425a2` |
| policy | `63abe080105dfeaf246c260b6577225843700cba3534a89f75013bbd816e6fbd` |
| trading mode | `2a1e0af84fc343035a0a028e5dd080d9cc33daa35351d559641f3f8b4875cf2c` |

The replay invokes the candidate's explicit preserved `v8` branch and `v9`
branch at every timestamp; the default selection is not used to choose the
baseline arm. The candidate source hash below pins the exact implementation
used to reproduce both branches.

## Immutable market sample

The source is the official free GMX candle endpoint:
`https://arbitrum-api.gmxinfra.io/prices/candles?tokenSymbol={symbol}&period=15m&limit=200`.
The endpoint contract is the existing source contract: `candles` array rows
with Unix-seconds open time followed by OHLC numbers. `stats.gmx.io` is not
used. [`gmx-candles-2026-10-02.json`](./gmx-candles-2026-10-02.json) preserves
each exact response string, its SHA-256, and the normalized candles used for
replay. The replay verifies both response and capture hashes and rebuilds the
closed-candle arrays from raw responses before use.

- Captured 2026-10-02 13:40:54.979Z UTC.
- BTC, SOL, XRP, LINK, ETH: **199 completed, contiguous 15m candles each**,
  from 2026-09-30 11:45Z through 2026-10-02 13:30Z.
- Replay decisions are restricted to the **Oct 2 PHT day**:
  `[2026-10-01T16:00Z, 2026-10-02T16:00Z)`. The capture covers only through
  2026-10-02 13:30Z (21:30 PHT), so this is a partial day, not a complete-day
  claim. The earlier candles serve only as causal lookback and holding-path
  data.
- Open/future candles are excluded. Gaps, malformed rows, response-hash
  mismatch, capture-hash mismatch, or a future candle cause replay failure.
- Capture SHA-256:
  `245e9a0644cfef2f0cd8680b1c5955491b047975eea9d50864d4730af9130e2b`.
- The candidate was evaluated through the same pure candidate function used
  by the worker, explicitly selecting `v8` or `v9`. Candidate source SHA-256
  for this run: `9e414adaf49b20ea1ee3515733ca13c76c9f243e5f4f96f5089293fe3bccff35`.

## Causal replay method

At every 15m close, the decision sees only the latest 16 consecutive candles
ending at that close. It enters no earlier than the next candle's open, using
that open for stop/target revalidation. v8 and v9 use their own side, observed
stop, target, candidate gate, and resulting notional. Targets remain the
candidate's observed swing/range-structure prices; the replay does not extend
them to make a threshold pass. A stop and target touched within one OHLC bar
resolve stop-first, and stop gaps fill at the adverse open. The maximum hold is
60 minutes (four bars). If multiple symbols offer a same-time entry, the model
chooses by descending absolute momentum, then symbol name, before applying the
one-position rule.

BTC/SOL/XRP form the **primary pool** and are simulated together; ETH/LINK are
reported separately as a supplementary pool. Each pool/arm gets its own
independent modeled $400 account so the supplementary names do not alter the
primary results.

The stateful model applies one open position, 45m entry cooldown, the preserved
32 entries/day cap, max $100 margin, 5–10x leverage, and $1,000 notional cap.
Sizing uses `min(current modeled equity, $1,000) × riskPct`, bounded by
remaining assumed $400-principal daily (-$20), weekly (-$40), and cumulative
(-$120) loss budgets, then includes the preserved $2 risk reserve. Daily
profit-cap and daily/weekly/cumulative loss locks are applied. Account-loss
date buckets are UTC; only the market-decision slice is PHT.

Because no time-bounded historical account/risk snapshot is captured, all of
those historical account inputs are **model assumptions**, not a forensic
reconstruction. The model begins the PHT window at an assumed flat $400,
zero prior-day/week losses, and zero loss streak; subsequent state is updated
only from earlier replay settlements. The baseline v8 branch includes its
modeled three-consecutive-loss/4h block; v9 has no such block. A separate
`POLICY_HALF_AFTER_2_LOSSES_4H` mode applies the existing common half-risk
profile after two settled losses within four hours to both arms; the alternate
`NO_HALF_RISK_SENSITIVITY` is explicitly only a sensitivity.

OHLC does not reveal the intratrade mark path. Reported modeled drawdown is
therefore **settlement-only peak-to-trough**; it is not total or
mark-to-market drawdown. Stop gaps fill at the adverse next-bar open.

The 10 bps and 20 bps round-trip cost schedules are **illustrative modeled
sensitivity only**, applied separately to each arm's own simulated notional.
They are not GMX quotes and do not stand in for observed fees, price impact,
funding, or borrowing. `structuralEconomicsPassesAtInitialState` counts structurally eligible
observations passing that scenario's RR/cost checks; `entries` additionally
applies the separate modeled single-position/cooldown/daily/weekly/cumulative
account guards. Overlapping candidate observations are not independent
trades.

The automated parity test compares in-window BTC/SOL/XRP v8 decisions with the
candidate implementation at the original HEAD, including selected side,
target, horizon evidence, eligibility, and all eligible stop prices. When the
original implementation rejected a stop and emitted no stop price, the newer
source may retain a diagnostic observed stop; the parity test confirms the
candidate still remains ineligible with null `stopFraction` rather than
promoting that evidence to an executable stop.

## Results

The primary BTC/SOL/XRP pool has 258 decision observations per arm (86
timestamps per symbol); supplementary ETH/LINK has 172 (86 per symbol), for
430 observations per arm across all five symbols. Only decisions and next-open
entries inside the PHT half-open window are counted. Structural/signal
eligibility is before costs and simulated account-state filters:

| Pool / symbol | Decisions per arm | v8 eligible | v9 eligible | Difference v9−v8 | Common declines v8 | Common declines v9 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Primary BTC | 86 | 2 | 28 | +26 | no signal 69; prior horizon 6; stop bounds 5; no target 4 | no signal 26; horizon 19; stop bounds 7; no target 6 |
| Primary SOL | 86 | 2 | 19 | +17 | no signal 68; prior horizon 3; stop bounds 9; no target 3; other no-score 1 | no signal 41; horizon 15; stop bounds 6; no target 4; other no-score 1 |
| Primary XRP | 86 | 4 | 32 | +28 | no signal 71; prior horizon 3; stop bounds 7; no target 1 | no signal 25; horizon 15; stop bounds 10; no target 3; other next-open stop 1 |
| **Primary total** | **258** | **8** | **79** | **+71** | **no signal 208; horizon 12; stop bounds 21; no target 8; other no-score 1** | **no signal 92; horizon 49; stop bounds 23; no target 13; other next-open stop 1/no-score 1** |
| Supplementary ETH | 86 | 0 | 26 | +26 | no signal 74; prior horizon 4; stop bounds 8 | no signal 33; horizon 17; stop bounds 8; no target 2 |
| Supplementary LINK | 86 | 3 | 17 | +14 | no signal 73; prior horizon 1; stop bounds 8; other no-score 1 | no signal 44; horizon 12; stop bounds 13 |
| **Supplementary total** | **172** | **3** | **43** | **+40** | **no signal 147; horizon 5; stop bounds 16; other no-score 1** | **no signal 77; horizon 29; stop bounds 21; no target 2** |
| **All five (descriptive only)** | **430** | **11** | **122** | **+111** | **no signal 355; horizon 17; stop bounds 37; no target 8; other no-score 2** | **no signal 169; horizon 78; stop bounds 44; no target 15; other next-open stop 1/no-score 1** |

v9's mode-aware admission validates the specific setup's stop and observed
target horizon before ranking; therefore more candidates survive its broader
signal admission, while target-horizon and stop failures remain separately
visible rather than being counted as eligible. The supplementary and all-five
totals are descriptive; neither is merged into primary-pool economics.

“No signal” here counts decisions where no explainable pattern was selected;
per-setup reason tallies and every scenario trade are in the machine-readable
replay JSON. Totals may include more than one failed condition per decision.

Illustrative modeled sensitivity (USD; not measured). The table shows the
policy-matched half-risk-after-two-losses scenario; the replay JSON also
includes the no-half-risk sensitivity. The sample did not reach two settled
losses, so both risk modes happened to agree on these particular outcomes.
`passes` is the initial-state $400 modeled economics count; entries include
the stateful limits. DD is realized-settlement peak-to-trough only.

| Primary pool / arm | RR floor | Cost assumption | Economics passes | Modeled entries | Modeled net PnL | Settled DD |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| v8 | 1.50 | 10 bps RT | 0 | 0 | 0.00 | 0.00 |
| v9 | 1.50 | 10 bps RT | 0 | 0 | 0.00 | 0.00 |
| v8 | 1.25 | 10 bps RT | 1 | 1 | -1.16 | 1.16 |
| v9 | 1.25 | 10 bps RT | 1 | 1 | -1.16 | 1.16 |
| v8 | 1.00 | 10 bps RT | 1 | 1 | -1.16 | 1.16 |
| v9 | 1.00 | 10 bps RT | 2 | 2 | -3.96 | 3.96 |
| v8 | 1.50 | 20 bps RT | 0 | 0 | 0.00 | 0.00 |
| v9 | 1.50 | 20 bps RT | 0 | 0 | 0.00 | 0.00 |
| v8 | 1.25 | 20 bps RT | 0 | 0 | 0.00 | 0.00 |
| v9 | 1.25 | 20 bps RT | 0 | 0 | 0.00 | 0.00 |
| v8 | 1.00 | 20 bps RT | 1 | 1 | -1.92 | 1.92 |
| v9 | 1.00 | 20 bps RT | 1 | 1 | -1.92 | 1.92 |

Supplementary modeled sensitivity is kept separate: at 10 bps, RR 1.5 / 1.25 /
1.0 produced v8 1 / 1 / 1 entries and v9 2 / 2 / 2; at 20 bps, RR 1.5 / 1.25 /
1.0 produced v8 0 / 1 / 1 and v9 0 / 2 / 2. These supplementary results do
not establish primary-pool feasibility.

These very small assumption-driven samples cannot select a threshold on
returns. In the primary pool, RR 1.5 and 1.25 produced no modeled economic pass
at either cost assumption; RR 1.0 admitted one/two entries, both negative in
the illustrative scenarios. The missing observed costs still cannot establish
whether a production policy is infeasible or whether a lower floor is
warranted. Keep 1.5 and gather actual time-bounded cost/risk evidence before
reconsidering.

## Reproduction

Node 20+ runs the script directly. The pure TypeScript candidate source is
transformed with the existing api-server esbuild package and imported from an
in-memory data URL; this does not bootstrap the app, worker, or DB.

```sh
node scripts/paper-v9-replay.mjs \
  docs/verification/paper-v9/gmx-candles-2026-10-02.json \
  docs/verification/paper-v9/causal-replay-2026-10-02.json
node --test scripts/paper-v9-replay.test.mjs
```

Capture another sample to a new, nonexistent filename (the script refuses to
overwrite an immutable capture):

```sh
node scripts/paper-v9-capture.mjs /tmp/paper-v9-capture-NEW-UTC-DATE.json
node scripts/paper-v9-replay.mjs \
  /tmp/paper-v9-capture-NEW-UTC-DATE.json /tmp/paper-v9-replay-NEW-UTC-DATE.json
```

The tests verify future-bar isolation, adverse-first ambiguous OHLC resolution,
v8 parity with the original HEAD source across in-window BTC/SOL/XRP candidate
inputs, PHT bounds/pool separation, 32/day and loss-streak controls, and the
distinction between modeled sensitivity and unavailable measured financial
evidence.