# Virtual400 leverage 5–10x

Base: 02b596090b5f4bd79b27bf97359e95a8d7663c7b. User authorized
minimum 5x and maximum 10x for the existing aggressive virtual session.

Version virtual400-active/v2 changes only PAPER collateral allocation. Keep
0.5% trade risk, $200 notional, $100 margin, $0.40 cost, all loss/protection and
signal gates. Greater leverage does not by itself increase profit or trade frequency.
Shared Standard/Canary/LIVE sizing/profile limits remain unchanged.

The dedicated sizing path reuses shared risk/cost enforcement at 1x to determine
notional independently, then chooses the highest whole leverage in 5–10 satisfying
$1.10 minimum collateral and collateral >= 2 * (structural stop loss + $0.40).
If no leverage qualifies, reject; never inflate size, narrow stops or fall below 5x.
The final virtual PAPER executor rechecks scope, profile, PAPER mode, exposure,
leverage, stop-risk budget and buffer before writes. This PAPER cushion is not a
live-exchange liquidation model or guaranteed realized loss limit.

Migration accepts historical v1 without rewriting positions. Only an ACTIVE,
empty-inventory, no-pending/no-unresolved boundary promotes it. Session identity,
start time, financial history and protection remain intact. UI reads applied
server min/max; historical v1 remains accurately labelled while upgrade waits.

Local verification: API/Web TypeScript passed. Six focused API suites passed
186 tests before two additional boundary regressions; Web server-authority suite
passed seven tests. Covered 5x/10x and constrained intermediate leverage, missing
cost/stop/staleness, no size amplification, namespace isolation and legacy profile,
recovery-delayed upgrade, remount/GET-only, and actual executor simulated restart,
structural stop and net settlement. Full exact-head CI (including isolated real
PostgreSQL restart) and production identity/applied v2 remain rollout gates.

No production reset, forced signal, START/STOP, PIN change or LIVE unlock.
