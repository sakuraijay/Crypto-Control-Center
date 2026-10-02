# PAPER pattern-led entry engine v10

`PATTERN_ENTRY_VERSION` is `paper-pattern-entry/v10`. This engine is a separate
paper-only interpretation of the 38 IDs in the chart-pattern catalog. The
existing `paper-chart-reference/v1` detector and its consumers retain their
reference-only semantics. The engine recomputes from official raw candles,
uses only completed bars, and uses right-confirmed pivots for structures.
There are no global momentum, quality, volatility, or regime gates in front
of pattern detection. Intrinsic pattern context such as a prior trend remains
part of the pattern's own formation rule.

## Explicit 38-pattern contract

Every row specifies formation, confirmation, direction, entry trigger,
observed invalidation stop, and exit criteria. “Completed close” means the
bar close, never a live/incomplete bar. The current v10 engine emits
`targetPrice: null` and `targetBasis: null` for every pattern because it has no
implemented observed-target detector. It does not synthesize an R-multiple or
expected-profit target.

| Pattern ID | Formation | Confirmation | Direction | Entry trigger | Invalidation stop | Exit criteria |
|---|---|---|---|---|---|---|
| DOJI | Completed body <=10% of range | First later completed close outside formation range | Neutral until first close | Close above high = LONG; below low = SHORT | Opposite side of doji range | Observed stop or max hold; no target detector |
| DRAGONFLY_DOJI | Doji with lower wick >=70% of range | First later completed close outside formation range | Neutral until first close | Close above high = LONG; below low = SHORT | Opposite side of doji range | Observed stop or max hold; no target detector |
| GRAVESTONE_DOJI | Doji with upper wick >=70% of range | First later completed close outside formation range | Neutral until first close | Close above high = LONG; below low = SHORT | Opposite side of doji range | Observed stop or max hold; no target detector |
| SPINNING_TOP | Small body <=30% range with both wicks >= body | First later completed close outside formation range | Neutral until first close | Close above high = LONG; below low = SHORT | Opposite side of candle range | Observed stop or max hold; no target detector |
| HAMMER | Lower wick >=2 bodies after prior downtrend | Completed reversal candle | LONG | Formation confirmation close | Formation low | Observed stop or max hold; no target detector |
| HANGING_MAN | Lower wick >=2 bodies after prior uptrend | Completed reversal candle | SHORT | Formation confirmation close | Formation high | Observed stop or max hold; no target detector |
| INVERTED_HAMMER | Upper wick >=2 bodies after prior downtrend | Completed reversal candle | LONG | Formation confirmation close | Formation low | Observed stop or max hold; no target detector |
| SHOOTING_STAR | Upper wick >=2 bodies after prior uptrend | Completed reversal candle | SHORT | Formation confirmation close | Formation high | Observed stop or max hold; no target detector |
| BULLISH_MARUBOZU | Bull body >=90% range and >=0.7 ATR | Completed strong candle | LONG | Formation confirmation close | Formation low | Observed stop or max hold; no target detector |
| BEARISH_MARUBOZU | Bear body >=90% range and >=0.7 ATR | Completed strong candle | SHORT | Completed confirmation close | Formation high | Observed stop or max hold; no target detector |
| BULLISH_ENGULFING | Bull body engulfs prior bear body after downtrend | Completed engulfing candle | LONG | Formation confirmation close | Lower formation extreme | Observed stop or max hold; no target detector |
| BEARISH_ENGULFING | Bear body engulfs prior bull body after uptrend | Completed engulfing candle | SHORT | Formation confirmation close | Upper formation extreme | Observed stop or max hold; no target detector |
| BULLISH_HARAMI | Small bull body inside prior bear body after downtrend | Completed contained-body formation | LONG | Formation confirmation close | Lower formation extreme | Observed stop or max hold; no target detector |
| BEARISH_HARAMI | Small bear body inside prior bull body after uptrend | Completed contained-body formation | SHORT | Formation confirmation close | Upper formation extreme | Observed stop or max hold; no target detector |
| PIERCING | Close recovers prior bear-body midpoint after downtrend | Completed midpoint recovery | LONG | Formation confirmation close | Lower formation extreme | Observed stop or max hold; no target detector |
| DARK_CLOUD_COVER | Close loses prior bull-body midpoint after uptrend | Completed midpoint loss | SHORT | Formation confirmation close | Upper formation extreme | Observed stop or max hold; no target detector |
| MORNING_STAR | Three-candle reversal after downtrend | Third close above first-body midpoint | LONG | Third-candle close | Three-candle low | Observed stop or max hold; no target detector |
| EVENING_STAR | Three-candle reversal after uptrend | Third close below first-body midpoint | SHORT | Third-candle close | Three-candle high | Observed stop or max hold; no target detector |
| THREE_WHITE_SOLDIERS | Three strong rising bodies after downtrend | Third soldier close | LONG | Third-candle close | Sequence low | Observed stop or max hold; no target detector |
| THREE_BLACK_CROWS | Three strong falling bodies after uptrend | Third crow close | SHORT | Third-candle close | Sequence high | Observed stop or max hold; no target detector |
| DOUBLE_TOP | Two spaced right-confirmed highs and selected neckline low | Completed close breaks neckline | SHORT | Neckline close-break | Higher of the two confirmed highs | Observed stop or max hold; no target detector |
| DOUBLE_BOTTOM | Two spaced right-confirmed lows and selected neckline high | Completed close breaks neckline | LONG | Neckline close-break | Lower of the two confirmed lows | Observed stop or max hold; no target detector |
| TRIPLE_TOP | Three spaced right-confirmed highs and selected neckline lows | Completed close breaks neckline | SHORT | Neckline close-break | Highest of the three confirmed highs | Observed stop or max hold; no target detector |
| TRIPLE_BOTTOM | Three spaced right-confirmed lows and selected neckline highs | Completed close breaks neckline | LONG | Neckline close-break | Lowest of the three confirmed lows | Observed stop or max hold; no target detector |
| HEAD_SHOULDERS | Three right-confirmed highs; center is head | Completed close breaks fitted neckline | SHORT | Fitted neckline close-break | Observed right-shoulder high (detector invalidation) | Observed stop or max hold; no target detector |
| INVERSE_HEAD_SHOULDERS | Three right-confirmed lows; center is head | Completed close breaks fitted neckline | LONG | Fitted neckline close-break | Observed right-shoulder low (detector invalidation) | Observed stop or max hold; no target detector |
| RECTANGLE | Bounded range with three confirmed touches per edge | Completed close beyond fitted edge | Break direction (LONG or SHORT) | Upper-edge break LONG; lower-edge break SHORT | Opposite fitted edge at breakout | Observed stop or max hold; no target detector |
| ASCENDING_TRIANGLE | Flat highs and rising lows, three touches each | Completed close beyond fitted edge | Break direction (LONG or SHORT) | Upper-edge break LONG; lower-edge break SHORT | Opposite fitted edge at breakout | Observed stop or max hold; no target detector |
| DESCENDING_TRIANGLE | Flat lows and falling highs, three touches each | Completed close beyond fitted edge | Break direction (LONG or SHORT) | Upper-edge break LONG; lower-edge break SHORT | Opposite fitted edge at breakout | Observed stop or max hold; no target detector |
| SYMMETRICAL_TRIANGLE | Converging confirmed boundaries | Completed close beyond fitted edge | Break direction (LONG or SHORT) | Upper-edge break LONG; lower-edge break SHORT | Opposite fitted edge at breakout | Observed stop or max hold; no target detector |
| RISING_WEDGE | Rising, converging confirmed boundaries | Completed close beyond fitted edge | Break direction (LONG or SHORT) | Upper-edge break LONG; lower-edge break SHORT | Opposite fitted edge at breakout | Observed stop or max hold; no target detector |
| FALLING_WEDGE | Falling, converging confirmed boundaries | Completed close beyond fitted edge | Break direction (LONG or SHORT) | Upper-edge break LONG; lower-edge break SHORT | Opposite fitted edge at breakout | Observed stop or max hold; no target detector |
| BROADENING | Expanding confirmed boundaries | Completed close beyond fitted edge | Break direction (LONG or SHORT) | Upper-edge break LONG; lower-edge break SHORT | Opposite fitted edge at breakout | Observed stop or max hold; no target detector |
| PRICE_CHANNEL | Parallel sloping boundaries with confirmed touches | Completed close beyond fitted edge | Break direction (LONG or SHORT) | Upper-edge break LONG; lower-edge break SHORT | Opposite fitted edge at breakout | Observed stop or max hold; no target detector |
| BULL_FLAG | Bull pole plus bounded channel | Completed continuation boundary break | LONG | Continuation boundary close-break | Observed lower channel boundary at breakout | Observed stop or max hold; no target detector |
| BEAR_FLAG | Bear pole plus bounded channel | Completed continuation boundary break | SHORT | Continuation boundary close-break | Observed upper channel boundary at breakout | Observed stop or max hold; no target detector |
| BULL_PENNANT | Bull pole plus bounded converging pennant | Completed continuation boundary break | LONG | Continuation boundary close-break | Observed lower pennant boundary at breakout | Observed stop or max hold; no target detector |
| BEAR_PENNANT | Bear pole plus bounded converging pennant | Completed continuation boundary break | SHORT | Continuation boundary close-break | Observed upper pennant boundary at breakout | Observed stop or max hold; no target detector |

## Result contract

`evaluatePatternEntries(symbol, rawCandlesByTimeframe, now, mode)` returns
`{version, candidates, waiting, conflicts}`. Candidate evidence contains
`eventId`, `durableFormationId`, symbol, exact catalog `patternId`, timeframe,
LONG/SHORT direction, formation and confirmation timestamps, trigger and
reference prices, observed stop, nullable target and basis, expiry, maximum
hold, same-side supporting IDs, opposite-side conflicting IDs, and structured
explanatory auxiliary evidence. Every pattern retains its own candidate and
stop; same-side IDs are explanatory support, not merged-away candidates.
Opposing completed signals on a timeframe suppress both directional candidates
and produce explicit conflict and waiting records.

The event and durable-formation identities use actual formation-anchor
timestamps, not the break candle timestamp. Candle keys include timestamps of
their one-, two-, or three-candle formations. Double/triple structures use the
selected right-confirmed peaks and neckline pivots. Head-and-shoulders use the
three selected pivots and two selected neckline pivots. Consolidation keys use
the six confirmed fitted-boundary anchors; flags and pennants include the
pole-start timestamp too. A later recross of unchanged geometry therefore
retains the same identity, while genuinely changed anchor timestamps identify
a new formation.

Neutral formations, including the newest completed neutral candle, remain
WAITING until a completed close breaks one boundary. The first completed
post-formation boundary break freezes the direction, confirmation and expiry.
A later crossing of the other boundary never reverses or re-arms that event;
the event waits as invalidated if its observed stop was subsequently hit, or
as expired once its original entry window passes.

`mode` changes only maximum hold: INTRADAY is 1 hour; SWING is 4 hours. Mode is
not a setup veto. Stop distance/direction are not clamped here; downstream
safety must validate them. No minimum net-RR gate exists in this engine.
Execution costs remain downstream safety/auxiliary data. Targets are always
null in this implementation; it contains no observed-target criteria detector.
`isIssuedPatternEntry(e)` (alias `isTrustedPatternEntryEvidence(e)`) recognizes
only evidence objects constructed by this module in the current process.
Runtime integrations should recompute from raw candles rather than trust
arbitrary caller-supplied pattern labels.