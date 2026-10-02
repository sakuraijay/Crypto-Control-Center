# CCC desktop workspace redesign

Instruction: CCC-SUPERVISION-20260920-05. Research and implementation: 2026-09-20.

## Research scope and judgment

The user requested the best usability/design patterns from comparable global products. We reviewed official public product descriptions, feature pages and publicly available interface material for 14 candidates. This is a bounded comparative review, not a worldwide census, paid-account hands-on benchmark or an objective ranking. JS-only trading pages and timed-out visual resources provide insufficient evidence for detailed interaction claims. No account, subscription or integration was purchased.

Selection criteria: clarity of account and execution state; ability to explain a decision and PnL; navigation cost; visual hierarchy and density; fit with CCC's existing server PAPER workflow. Patterns below are design judgments based on those public sources, not measured user-study results.

| Official source | Useful pattern / assessment | CCC decision |
|---|---|---|
| [Kraken Pro](https://pro.kraken.com/) | Modular workspace, clear account/market hierarchy | Primary shell and panel hierarchy; no widget-dragging complexity |
| [Coinbase Advanced](https://www.coinbase.com/advanced-trade) | Arranged trading workspace and clear portfolio context | Distinct Virtual/Standard workspaces and restrained card hierarchy |
| [TradingView](https://www.tradingview.com/features/) | Analysis centered around charts and watchlists | Market radar and evidence details; no ornamental candles or unsupported time ranges |
| [3Commas](https://3commas.io/) | Central bot overview with strategy/status controls | Server automation panel and explicit start/stop confirmation; no DCA/martingale adoption |
| [Composer](https://www.composer.trade/) | Readable strategy logic and performance overview | Plain-language waiting reasons and visible applied policy |
| [Altrady](https://www.altrady.com/) | Discover/execute/analyze workflow and journal | Filterable journal, evidence drawer/dialog and CSV |
| [Bitsgap](https://bitsgap.com/) | Broad bot/multi-exchange suite | Secondary reference; no new exchange integrations |
| [Cryptohopper](https://www.cryptohopper.com/) | Bot settings and marketplace workflow | Secondary reference; avoid marketplace/promotional density |
| [QuantConnect](https://www.quantconnect.com/) | Developer-oriented research/workflows | Keep technical research on a separate screen |
| [OKX bots](https://www.okx.com/trading-bot) | Bot catalog and setup entry points | No rankings/marketing ROI cards in operational overview |
| [Binance bots](https://www.binance.com/en/trading-bots) | Bot catalog and strategy choices | Avoid mixing discovery/promotions with current account evidence |
| [Bybit bots](https://www.bybit.com/en/tradingbot/) | Bot offerings and setup flows | Secondary reference; no gamified performance claims |
| [GMX](https://app.gmx.io/trade) | Protocol trading terminal; JS shell limited inspection | Retain existing GMX read-only integration, no copied terminal |
| [Hyperliquid](https://app.hyperliquid.xyz/trade) | Protocol trading terminal; JS shell limited inspection | Insufficient inspected UI evidence to claim a detailed interaction comparison |

## Implemented hierarchy

- Common shell: charcoal surfaces, mint actions/status, red losses, consistent border/spacing, stronger text contrast, keyboard focus, skip link and reduced-motion support.
- Overview: Virtual400 identity and fresh status → four financial metrics → real settlement performance + current automation → per-market evidence → positions → recent journal.
- Standard: existing separate PAPER dashboard/positions/manual flow retained at /standard. Strategy page explicitly names its Standard scope.
- System: runtime health, risk, and SHADOW research use separate tabs. Technical panels are no longer all mounted on the overview.
- Activity: Virtual400 journal, separate link to Standard history.
- Search: Ctrl/Cmd+K, Korean/English menu search, Enter/Tab navigation. Sidebar collapse is a visual preference persisted locally, not an execution switch.

## Data and interaction contracts

One shared Virtual400 snapshot/poll remains authoritative. Failed/stale evidence cannot display a fresh active account. No browser trading engine, trading timer, synthetic prices, invented return curves, chart time-range claims or reset-to-default execution settings were added.

The performance chart uses only returned settlements (current API maximum 10), sorted by actual close time and anchored to the server's realized ledger balance. It is not lifetime or mark-to-market history. No settlements means an honest empty state. Invalid/duplicate settlement evidence produces no curve. Costs remain unknown if any component is unavailable. CSV preserves losses, simulation/cost labels, UTC fields and formula-safe text.

Start/stop opens a PIN-confirmed dialog. STOP describes new-entry suspension with protection continuing. It does not write on load. Trading policies, wallet onboarding/authentication, approvals, protection, sizing, cost gates and ledger are unchanged.

## Validation and limitations

- Frontend: 35 files / 455 tests PASS; TypeScript and production Vite build PASS.
- Includes existing server authority remount/offline/stale/GET-only/PIN STOP coverage plus 18 added financial presentation and journal/navigation tests.
- Production build retains existing sourcemap and large-chunk warnings; neither is claimed resolved by this UI change.
- Browser preview is limited by local-preview policy and production Master PIN gate. No gate bypass, PIN mutation or authenticated visual acceptance is claimed. DOM/component checks do not replace visual user acceptance.
- Exact committed CI and publication/source identity remain pending at this document's commit. Final verified deployment evidence will be recorded in the existing supervisor automation handoff; avoid a documentation-only duplicate deployment.
- Natural market fill, actual PostgreSQL restart and Alpha/Beta acceptance remain separate gates.

## Cost, rollout and rollback

No dependency, backend, subscription, hosting tier or new paid tool. Existing GitHub validation and one authorized existing PAPER deployment only. Replit's role is exact-source sync/build and the existing Reserved VM publication, not a second implementation. Preserve active session id, startedAt, policy appliedAt, balances, protection and all risk/financial locks.

If a frontend regression requires rollback, restore the previous UI source by an additive commit and redeploy the verified tree. Never reset the DB/session/ledger or undo protected trading state to roll back a screen.
