# CCC chart references — paper-chart-reference/v1

User request: collect internet and crypto-community pattern approaches and make them available before PAPER entries. Research date: 2026-09-29 PHT. This is an original heuristic implementation, not a trained AI or a TA-Lib port. No winning probability or profitability has been established.

## Sources and research catalogue

Primary definitions: [StockCharts](https://chartschool.stockcharts.com/table-of-contents/chart-analysis/chart-patterns), [TA-Lib function index](https://ta-lib.org/functions/), [Binance Academy](https://www.binance.com/en/academy/articles/how-to-read-the-most-popular-crypto-candlestick-patterns). User reference: [bluemiv](https://bluemiv.tistory.com/83).

Community review: [Leon Tech on Binance Square](https://www.binance.com/en/square/post/317359) discusses regime, price location, higher timeframe context and objective rules. These are research suggestions, not verified performance. TradingView public search surfaced Double Top/Bottom Detector and Classic Pattern Engine, but full retrieval was unavailable during this pass; their code was not copied or treated as verified. Internet content never becomes executable instructions or an order source.

The catalogue contains 61 named TA-Lib candle families and 20 classical research entries below. Catalogue membership does not mean implementation; aliases and bullish/bearish variants are not independent evidence. This is a bounded research pass, not an exhaustive collection of the internet.

### Candle families (61 research entries)

CDL2CROWS, CDL3BLACKCROWS, CDL3INSIDE, CDL3LINESTRIKE, CDL3OUTSIDE, CDL3STARSINSOUTH, CDL3WHITESOLDIERS, CDLABANDONEDBABY, CDLADVANCEBLOCK, CDLBELTHOLD, CDLBREAKAWAY, CDLCLOSINGMARUBOZU, CDLCONCEALBABYSWALL, CDLCOUNTERATTACK, CDLDARKCLOUDCOVER, CDLDOJI, CDLDOJISTAR, CDLDRAGONFLYDOJI, CDLENGULFING, CDLEVENINGDOJISTAR, CDLEVENINGSTAR, CDLGAPSIDESIDEWHITE, CDLGRAVESTONEDOJI, CDLHAMMER, CDLHANGINGMAN, CDLHARAMI, CDLHARAMICROSS, CDLHIGHWAVE, CDLHIKKAKE, CDLHIKKAKEMOD, CDLHOMINGPIGEON, CDLIDENTICAL3CROWS, CDLINNECK, CDLINVERTEDHAMMER, CDLKICKING, CDLKICKINGBYLENGTH, CDLLADDERBOTTOM, CDLLONGLEGGEDDOJI, CDLLONGLINE, CDLMARUBOZU, CDLMATCHINGLOW, CDLMATHOLD, CDLMORNINGDOJISTAR, CDLMORNINGSTAR, CDLONNECK, CDLPIERCING, CDLRICKSHAWMAN, CDLRISEFALL3METHODS, CDLSEPARATINGLINES, CDLSHOOTINGSTAR, CDLSHORTLINE, CDLSPINNINGTOP, CDLSTALLEDPATTERN, CDLSTICKSANDWICH, CDLTAKURI, CDLTASUKIGAP, CDLTHRUSTING, CDLTRISTAR, CDLUNIQUE3RIVER, CDLUPSIDEGAP2CROWS, CDLXSIDEGAP3METHODS.

### Classical research entries (20)

Double top; double bottom; triple top; triple bottom; head/shoulders; inverse head/shoulders; ascending triangle; descending triangle; symmetrical triangle; rising wedge; falling wedge; rectangle; broadening; price channel; flag; pennant; rounding bottom; cup/handle; measured move; bump/run.

## Implemented outputs (38 identifiers; bullish/bearish variants included)

Candles (20): DOJI, DRAGONFLY_DOJI, GRAVESTONE_DOJI, SPINNING_TOP, HAMMER, HANGING_MAN, INVERTED_HAMMER, SHOOTING_STAR, BULLISH_MARUBOZU, BEARISH_MARUBOZU, BULLISH_ENGULFING, BEARISH_ENGULFING, BULLISH_HARAMI, BEARISH_HARAMI, PIERCING, DARK_CLOUD_COVER, MORNING_STAR, EVENING_STAR, THREE_WHITE_SOLDIERS, THREE_BLACK_CROWS.

Structures (18): DOUBLE_TOP, DOUBLE_BOTTOM, TRIPLE_TOP, TRIPLE_BOTTOM, HEAD_SHOULDERS, INVERSE_HEAD_SHOULDERS, ASCENDING_TRIANGLE, DESCENDING_TRIANGLE, SYMMETRICAL_TRIANGLE, RISING_WEDGE, FALLING_WEDGE, RECTANGLE, BROADENING, PRICE_CHANNEL, BULL_FLAG, BEAR_FLAG, BULL_PENNANT, BEAR_PENNANT.

All other catalogue entries are RESEARCH_ONLY, not active detectors. Complex harmonic, Elliott and Wyckoff interpretations are not implemented. Naming overlap with a library is not mathematical equivalence. Candle thresholds are explicit custom rules; star patterns relax traditional session gaps for continuous crypto markets. Shapes are labelled SHAPE, structural close breaks BREAKOUT. Retest tracking, volume confirmation and target-probability estimation are not implemented.

## Data and detection rules

- Official GMX OHLC only, separate 15m/1h/4h requests of up to 240 bars. At least 60 contiguous completed bars; 2-second close grace. Reject invalid OHLC, gaps, duplicate timestamps, nonpositive/nonfinite values and stale frames.
- A local extreme needs two closed candles on both sides. A structure may use a pivot only after the right-side confirmation exists. Record evidence at the current completed close, never at a historical peak.
- Reversal rules require spaced pivots, prior trend, ATR-scaled similarity/depth and a fresh neckline crossing. Head/shoulder necklines can slope.
- Consolidations require three confirmed touches on each fitted boundary, bounded residuals, price containment and a fresh close break. Flags/pennants additionally require a preceding impulse and bounded consolidation.
- Missing GMX volume is explicitly UNAVAILABLE. Candlestick shapes are not called volume-confirmed signals. No synthetic candles or community prices enter the runtime.

## Application and audit

Every daily PAPER candidate carries the three frames and their evidence. A normalized reference adjustment in [-0.10,+0.10] changes candidate ranking only AFTER existing market-quality, freshness, cost, net reward/risk, margin and budget gates pass. Each timeframe casts at most one directional reference; conflicting evidence cancels, neutral shapes do not vote, duplicates do not multiply influence. Missing patterns contribute zero. Patterns cannot originate orders, reverse the original candidate side, increase sizing, move stops or enable LIVE.

Candidate evidence and adjustment are persisted in the entry audit and exported with settled learning samples. Existing dashboard market-analysis rows show timeframe, detected pattern and direction. No model training or successful out-of-sample evaluation is implied. Historic trades are not relabelled as having used these features.

Daily cumulative loss remains 5% of funded principal, including adverse unrealized P&L; weekly/cumulative protection, existing positions, contribution ledger and prior stop contracts remain intact. No configuration/permission changes accompany this feature.

## Cost control and validation

Persist candles per symbol/timeframe; refresh after a new close and retry failed reads no faster than 60 seconds. No per-trade GPT requests, no paid data subscription, no extra automation schedule. Initially at most nine candle reads for three symbols, then cache reuse.

Synthetic tests cover temporal isolation, confirmation delay, trend context, mirrored reversal fixtures, malformed/stale data, bounded conflicting evidence and cache restart behavior. These test software behavior, not market profitability. Existing PAPER execution/risk tests must also pass. Before increasing the pattern weight or promoting to real-money use, collect untouched forward samples and evaluate cost-adjusted outcomes by pattern/timeframe/regime with purged chronological validation; include failed detections and 2x cost stress. No claimed win rate until that evidence exists.
