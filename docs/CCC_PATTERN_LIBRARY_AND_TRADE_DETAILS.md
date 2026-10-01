# Pattern library and entry evidence

User requests, 2026-09-29 PHT: expand each trade's details with the actual patterns recorded at entry; add a CCC pattern destination immediately above the profit calendar, with all 38 illustrated rules and clickable explanations.

## Delivered behavior

- Workspace navigation: Activity → CCC 패턴 탐지 → PnL Calendar. `/futures-web/patterns` shows all 38 schematic SVG previews in a responsive grid, without pagination or hiding rules behind filters.
- Each card opens a keyboard-accessible dialog with a larger illustration, Korean name, rule ID, meaning, the implemented detection conditions, application and limitations. These are illustrative drawings, never fabricated live detections. The 20 candle and 18 structure identifiers match the deployed reference engine, including directional variants.
- Trade rows summarize the recorded patterns. The existing trade dialog shows timeframe, supporting/opposing/neutral direction, shape versus completed breakout, recorded rule basis, trigger/invalidation reference, exact recorded ranking adjustment and analysis time. References do not imply pattern-only entry or a predicted winning probability.
- Original entry audit only: historical records without pattern evidence remain explicitly unavailable. No present-day candles are used to explain old entries. A bounded allowlisted projection rejects mismatched symbol/side, future evidence and malformed patterns; the full internal audit is never returned.
- Trade detail adds initial notional, settlement notional, leverage, collateral and holding duration. Initial planned risk uses the persisted plan when present; settlement P&L/R remains labelled per settlement, not a fabricated whole-position result. Entry/exit/stop/reference prices show six decimal places.
- No trading policy, sizing, permissions, stop contracts, account funds or ledger history changed.

## Design and verification

Figma existing CCC file, pattern screen: https://www.figma.com/design/XkbzMFg3CL2bW6Z7cPILna?node-id=49-22

Detail example: https://www.figma.com/design/XkbzMFg3CL2bW6Z7cPILna?node-id=49-508

Existing CCC navigation/button instances, color/spacing tokens and Noto Sans KR styles were reused. 38 cards and detail composition were screenshot-checked. No new paid generation or trading-time model calls.

Tests cover every preview/dialog, navigation order, absent versus empty evidence, supporting/opposing records, temporal binding, bounded adjustment and private-field exclusion, plus existing trade journeys and worker runtime. Exact-head full CI and post-publish identity/ledger/safety checks gate release.
