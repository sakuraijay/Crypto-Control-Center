---
name: Offline backtest evidence classification
description: When an immutable offline dataset is sufficient for an OK walk-forward report
---

An immutable raw market capture does not make the whole backtest evidence observed. If execution costs are modeled or historical risk state is assumed, the public report must remain `UNAVAILABLE` even when OHLCV and funding checksums are valid.

**Why:** Modeled slippage, impact, fee assumptions, or permissive risk snapshots can produce reproducible numbers without providing the point-in-time evidence required to trust them for PAPER readiness.

**How to apply:** Track market, cost, and risk evidence kinds separately. Only emit an `OK` report when required cost and risk evidence are observed and time-bounded; otherwise preserve provenance and coverage while failing closed.