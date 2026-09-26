# Aggressive daily PAPER experiment — v14

User explicitly authorized losses and requested daily production-hosted virtual trading, with immediate deployment. This supersedes earlier assistant-written bans on turnover-oriented PAPER entries and the old Virtual400 frequency/risk caps. No LIVE permission is granted.

## Implemented behavior

The production worker explicitly selects a dedicated daily PAPER policy at an empty, reconciled position boundary. Existing session, $400 seed, historical losses, HWM, mode selection and immutable older trade plans are retained. Daily mode persists across restart. Standard/Canary/LIVE paths and their validators are unchanged.

This is an explicitly labeled momentum experiment, not a fabricated successful ensemble signal. Eligible GMX markets are rotated in existing three-symbol batches. Sixteen consecutive completed, validated GMX 15m candles determine one-hour momentum and ATR; direction follows momentum (last candle body, then LONG on a flat tie). Stop distance is a declared experimental volatility budget bounded 0.2–0.8% of price, not a claim of structural support. Target distance is twice that stop. No confidence or proven positive expectancy is invented. Three candle reads occur only when entry is due; there is no paid LLM call in this execution rule.

Policy: 5–10x, one open position, one-hour entry cooldown, maximum24 entries per PHT day, risk2% of current equity capped at $400 basis, notional maximum$1000 and margin maximum$100, full cost reserve/cap$2. Actual cost is validated for the selected market/side/notional and maximum holding period. The remaining daily loss budget also bounds each new planned loss. INTRADAY expires after30 minutes; SWING after4 hours in this experiment. Price stops, net margin-loss10%, target exits and authoritative fee/funding/borrow settlement remain active.

Daily loss10% pauses new entries until the next PHT day and closes held exposure. The former8% HWM and weekly/profit/consecutive-loss gates do not create new locks in this experimental policy; HWM is still recorded. Preexisting hard/unresolved locks are preserved; exhausted capital does not auto-refill. Missing/stale candles, market identity, quotes, costs, DB consistency, STOP and recovery prevent entries. Daily execution is therefore a policy goal under usable data/capital, not an unconditional guarantee during outages or exhaustion. Price gaps can exceed planned stops; losses are never clipped or erased.

An immutable claim binds candidate, purpose, policy, price plan and cost; final executor revalidates namespace/PAPER/profile/5–10x/risk/cost/target/time. Persistent unique claims and existing single-worker lock prevent duplicate dispatch. UI and journal say AGGRESSIVE_PAPER_EXPERIMENT / PAPER_DAILY_MOMENTUM_EXPERIMENT. These fills must not be presented as natural ensemble success, OOS validation or proof of 5–10% daily returns. Existing risk acceptance is not a strategy profitability study.

## Verification and release

Figma XkbzMFg3CL2bW6Z7cPILna node23:22 was updated and screenshot-verified before matching UI. Local full API excluding isolated PostgreSQL:2791 tests; web464 tests before added display case. New tests cover candle quality/no look-ahead, profile isolation, loss tolerance/limits, immutable plans, no-signal entry, LIVE/STOP/duplicate refusal, real executor entry→restart→TP/SL/expiry→net settlement and changed-cost rejection. Added runtime migration/persistence and UI experiment labeling cases; final CI is authoritative.

Preserved upstream0b8495b diagnostic improvements. This commit records implementation; exact-source CI and production identity/first fill are pending at commit time. Do not report a deployment or fill based on this document alone. Completion evidence is handed to the existing hourly automation after production readback.

## Usage discipline

User reports only9% weekly GPT allowance remaining. Keep existing hourly cadence, but read latest state/deltas instead of entire historical logs, avoid duplicate coding or repeated full tests after required gates pass, and reserve Replit for validated-source sync/publish/readback. No subscription change, credit purchase or budget increase was made. Deployed server execution is independent of this chat's allowance; future assistant work still depends on available usage.
