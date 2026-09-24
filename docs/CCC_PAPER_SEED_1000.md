# Approved PAPER funding experiment — 2026-09-24

The user approved adding **500 virtual USDC once** to the existing session
`vp400-8fca5a3d-e988-4c98-b4a3-f9953ff54289`. This is not a real transfer.

- Preserve initial capital 400 and the existing 100 contribution. New event:
  `user-approved-paper-credit-20260924-500`; total contributions 600, funded capital 1000.
- Preserve all trades, cost-inclusive PnL, settlement fingerprints and original event times.
  Evaluation equity remains funded capital plus actual simulated PnL, not a reset to 1000.
- The worker applies the allowlisted event within its existing advisory-locked transaction.
  A restart must not issue it again; no generic funding endpoint is added.
- Shift HWM only by the cash contribution. Preserve daily/week opening equity, accumulated
  losses, counters and locks. The next PHT day uses the funded, PnL-adjusted opening balance.
- Increase PAPER profile capital ceiling from 500 to 1000 so the existing 2% per-trade
  risk ceiling can recognize the additional capital (maximum 20 USDC). Keep notional 1000,
  margin 100, leverage 5–10, one position, 45-minute cooldown, 32 daily entries, cost ceiling 2,
  daily loss 10%, daily net profit entry cap 20%, and intraday maximum one hour unchanged.
- More capital does not guarantee larger orders or more profit: order caps, costs and the
  remaining daily loss budget still constrain entries. Do not bypass a loss budget on deposit.
- Compare the pre/post contribution segments using net returns, drawdown, costs and exposure;
  deposits are excluded from PnL and learning labels. Different market periods are a confounder.
- No real-money permissions, product free-tier allocation or billing policies are changed.

Pre-change observation: 2026-09-24 06:20 UTC, production source `fb286829e0c2628cbbfe07a380c43a3d1841903b`.
66 settlements, funded 500, net PnL +19.60777792, equity 519.60777792, no open positions.
PHT-day net -56.92091674 against opening 576.52869466; remaining loss budget below the
entry cost reserve, so new entries were correctly blocked by `PAPER_EXPERIMENT_BUDGET_EXHAUSTED`.
Implementation and test completion do not establish production application; verify the event
and funded capital from the public runtime after deployment before reporting completion.
