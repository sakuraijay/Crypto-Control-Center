# Virtual400 active policy and onboarding repair

Status: implementation and local verification complete; deployment verification pending.

- Onboarding dismissal is presentation only. Poll loading, errors and disconnect do not reopen the completed wizard or manufacture trading readiness. Existing virtual sessions and explicit observation can view the dashboard without a wallet. Authentication remains required.
- Dedicated Virtual400 policy: BTC/ETH/SOL supported-source scans, 0.5% risk budget capped at current/400 capital, 2x leverage, $100 margin/$200 notional ceilings, 15-minute cooldown. Standard/LIVE profile validator and policies unchanged. The dedicated executor validator is restricted to the virtual namespace.
- Policy activation is persisted once per session under the existing worker lock after no held position/pending close/unresolved execution. Existing session, PnL, HWM, counters and protection remain intact.
- Reserve the complete $0.40 round-trip cost ceiling before sizing. Exact quoted notional is checked again; fixed costs and leverage cannot inflate the total modeled risk budget. Existing confidence, stop, freshness, cost and Risk vetoes remain authoritative.
- Dashboard shows applied policy, symbol analysis/rejections, unrealized net PnL, and the latest ten settlements with modeled costs, decision reasons and net R where evidence exists. No invented trades or profits.

Validation:
- API focused regression: 7 files / 173 tests PASS, including dedicated namespace acceptance/rejection, caps, promotion/recovery, Standard isolation, and legacy/active Signal→Risk→OPEN→process-local restart→SL→net settlement.
- Web onboarding regression: 2 files / 21 tests PASS, including background poll/error/disconnect, PIN gate, active virtual view and explicit wallet-free observation.
- API and Web TypeScript PASS. Web production build PASS (existing bundle-size/sourcemap warnings).
- The lifecycle replay uses a synthetic signal fixture and in-memory persistence, not real PostgreSQL or observed market performance. Full raw-candle and PostgreSQL restart validation remains on the existing workback schedule.

Deployment: require exact GitHub CI/source verification, publish the existing Reserved VM once, then confirm source identity, session continuity and runtime policy. Do not reset or restart the user's virtual session. This record does not claim deployment has occurred.

CI286 caught a replay-fixture wall-clock assumption: OPEN at 23:03 Manila and close one hour later correctly reset daily entries to zero. Fixed the synthetic replay to a constant same-day timestamp; production accounting is unchanged. CI286: 2667 passed, 2 fixture assertions failed; superseding exact-source CI required.
