# AI analysis activity — 2026-09-21

Base: 9dfb8a7daaa05592fabe43ce7003158f618d8ed4, existing draft PR #1.
The isolated PostgreSQL recovery coverage in that parent is preserved.

## User goal and design

October 1 Alpha/Beta must demonstrate functioning virtual trading in the existing
CCC system. Dashboard users should see what the engine is doing and which symbols
it is analyzing, rather than a single automatic-trading label.

Figma was edited first, inspected for overflow, then read through design-to-code:
https://www.figma.com/design/XkbzMFg3CL2bW6Z7cPILna?node-id=20-22
The native editable panel uses the existing charcoal/mint system and three symbol
cards. Its static analyzing illustration is explicitly a design state example.

## Implementation boundaries

- Process-local, session-bound activity observer records actual runtime boundaries.
  It adds no network reads, database writes, timers, order authority or financial
  policy changes. Only the transaction-owning cycle begins activity; stale writer
  generations cannot replace a newer cycle. Completion is published after commit.
- Cost and MTF analysis are batch operations over BTC/ETH/SOL. The display does
  not fabricate a sequential current symbol or percent-complete counter.
- Current phase, observed phases, bounded event history, per-symbol reasons,
  analysis completion time, cycle outcome and update time are exposed on the
  existing observational session GET endpoint. No operator secrets/raw errors.
- Restart clears live activity; no data is invented to bridge that gap. A different
  session cannot receive the old session's activity. Stale/future timestamps are
  not shown as current work. The durable financial ledger remains unchanged.
- React uses the existing provider and GET polling. STOP overrides running status;
  old backend analysis is labelled historical. No browser trading or random/poll-
  driven stage animation. No new dependencies or hosting services.

## Validation and rollout

Focused regressions cover actual in-flight batch observation, completion/error,
cross-session isolation, restart/staleness/future dates, no invented completed
analysis, no financial writes, shared GET reads, and STOP precedence. Existing
Virtual400 routing, Risk/cost, server-authority and PostgreSQL tests remain gates.
Authoritative exact-head CI and production identity must be verified after commit.
Do not call Figma imagery an authenticated production browser acceptance test.

Local validation: API/Web TypeScript and production Web build passed; four focused
API suites passed 48 tests and two Web suites passed 12 tests. After the final
per-symbol decision-reason adjustment, the three affected API suites passed 24
tests again. The isolated PostgreSQL suite could not initialize locally because
`initdb` is absent; it remains an exact-head CI gate with PostgreSQL installed.

Natural PAPER OPEN/protection/CLOSE/settlement and user Alpha/Beta remain separate
delivery gates. At 02:52 PHT the prior release still had zero trades/settlements.
An analysis activity panel is observability, not proof of profitable execution.
