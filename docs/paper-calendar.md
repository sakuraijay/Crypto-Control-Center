# PAPER profit calendar

The workspace sidebar links to `/calendar` immediately after Activity. It shows every day of the selected Gregorian month (including leap-day February), PHT/Asia-Manila daily cost-net realized PnL, OPEN entry count and FULL close count. Monthly totals use the same daily rows. Selecting a covered day shows gross/net PnL, estimated costs and settlement count including partial closes.

The worker adds `runtime.calendar` (`paper-calendar/v1`) from the complete reconciled current-session ledger, not the ten-entry journal. REDUCE70 settlements contribute PnL on their settlement date but do not count as completed positions. Deposits and unrealized PnL are excluded. No database migration, new poller, model calls, funding changes, trading policy changes or live-order permissions are introduced.

Coverage begins on the session start date and ends on the server's current PHT date. Covered empty dates are zero; dates before coverage and future dates are unavailable, never fabricated zeros. Stale runtime or failed aggregation shows an unavailable panel. A calendar aggregation error does not interrupt position protection. Previous/current month controls are bounded by available session coverage.

Figma: https://www.figma.com/design/XkbzMFg3CL2bW6Z7cPILna?node-id=45-5 (PnL Calendar page). Design examples are labelled as examples, not production performance.

Validation: API tests cover PHT midnight/month boundaries, partial/full settlements, more than ten records, empty coverage and invalid rows. Web tests cover month lengths/leap years, navigation, daily detail, stale states and sidebar placement. Production verification must check calendar freshness and sum daily net PnL against the session ledger after publish.
