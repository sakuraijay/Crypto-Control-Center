import { pgTable, text, integer, boolean, numeric, timestamp } from "drizzle-orm/pg-core";

/**
 * 6I-1 §12 — Market Intelligence / Opportunity / Shadow 영속화 (migration 0026).
 *
 * 원칙:
 *  - 시장이 열리지 않은 미래 결과 기록 금지 — outcome은 horizon 경과 후 별도 enrichment.
 *  - outcome 미확보 = null + complete=false (0 기록 금지).
 *  - candidateId unique — 중복 enrichment 방지 (idempotent).
 */

export const marketIntelligenceSnapshotsTable = pgTable("market_intelligence_snapshots", {
  id:              text("id").primaryKey(),          // cycle 결정적 id (mi:<cycleId>)
  cycleId:         text("cycle_id").notNull(),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  universeCount:   integer("universe_count").notNull(),
  shortlistCount:  integer("shortlist_count").notNull(),
  regimeJson:      text("regime_json").notNull(),     // market→RegimeResult 요약
  dataQuality:     text("data_quality").notNull(),    // GOOD|DEGRADED|UNAVAILABLE
  degradedReason:  text("degraded_reason"),
  decision:        text("decision").notNull(),        // SELECTED|NO_TRADE|BLOCKED
  noTradeReasons:  text("no_trade_reasons"),
  snapshotHash:    text("snapshot_hash").notNull(),
  fullJson:        text("full_json"),
  // 6I-2 §3 — cycle 수명주기 상태 (SUCCESS|FAILED|TIMEOUT|BLOCKED)
  status:          text("status").notNull().default("SUCCESS"),
  startedAtMs:     numeric("started_at_ms", { precision: 16, scale: 0 }),
  finishedAtMs:    numeric("finished_at_ms", { precision: 16, scale: 0 }),
});

export const opportunityCandidatesTable = pgTable("opportunity_candidates", {
  id:               text("id").primaryKey(),           // oc:<cycleId>:<market>:<dir>
  snapshotId:       text("snapshot_id").notNull(),
  cycleId:          text("cycle_id").notNull(),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAtMs:      numeric("decided_at_ms", { precision: 16, scale: 0 }).notNull(),
  symbol:           text("symbol").notNull(),
  marketAddress:    text("market_address").notNull(),
  direction:        text("direction").notNull(),       // LONG|SHORT
  regime:           text("regime").notNull(),
  dataQuality:      text("data_quality").notNull(),
  rawSignalScore:   numeric("raw_signal_score", { precision: 10, scale: 4 }).notNull(),
  winProbability:   numeric("win_probability", { precision: 8, scale: 6 }),   // null=미보정
  calibrationStatus: text("calibration_status").notNull(),
  expectedEntryPrice: numeric("expected_entry_price", { precision: 18, scale: 8 }),
  stopPrice:        numeric("stop_price", { precision: 18, scale: 8 }),
  takeProfitPrice:  numeric("take_profit_price", { precision: 18, scale: 8 }),
  finalNotionalUsd: numeric("final_notional_usd", { precision: 18, scale: 4 }),
  expectedNetValueUsd: numeric("expected_net_value_usd", { precision: 18, scale: 6 }),
  expectedRMultiple: numeric("expected_r_multiple", { precision: 10, scale: 4 }),
  uncalibratedRankingScore: numeric("uncalibrated_ranking_score", { precision: 10, scale: 4 }),
  totalExpectedCostUsd: numeric("total_expected_cost_usd", { precision: 18, scale: 6 }),
  costBreakdownJson: text("cost_breakdown_json"),
  featureJson:      text("feature_json"),              // 판단 당시 feature snapshot (재현용)
  rank:             integer("rank"),
  selected:         boolean("selected").notNull().default(false),
  decision:         text("decision").notNull(),        // ELIGIBLE|SHADOW_ONLY|REJECTED|DATA_UNAVAILABLE
  rejectionReasons: text("rejection_reasons"),
});

export const shadowOutcomesTable = pgTable("shadow_outcomes", {
  id:              text("id").primaryKey(),            // so:<candidateId>
  candidateId:     text("candidate_id").notNull(),     // unique (migration index)
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  measuredAtMs:    numeric("measured_at_ms", { precision: 16, scale: 0 }),
  outcome1hNetUsd: numeric("outcome_1h_net_usd", { precision: 18, scale: 6 }),
  outcome4hNetUsd: numeric("outcome_4h_net_usd", { precision: 18, scale: 6 }),
  grossPnl4hUsd:   numeric("gross_pnl_4h_usd", { precision: 18, scale: 6 }),
  totalCostUsd:    numeric("total_cost_usd", { precision: 18, scale: 6 }),
  maxFavorableExcursionPct: numeric("max_favorable_excursion_pct", { precision: 10, scale: 4 }),
  maxAdverseExcursionPct:   numeric("max_adverse_excursion_pct", { precision: 10, scale: 4 }),
  firstTouch:      text("first_touch"),                // STOP|TARGET|NONE|AMBIGUOUS_INTRABAR
  complete:        boolean("complete").notNull().default(false),
  incompleteReason: text("incomplete_reason"),
  // 6I-2 §7 — per-horizon 상태·증거 필드
  outcomeStatus1h: text("outcome_status_1h"),          // COMPLETE|INCOMPLETE|AMBIGUOUS_INTRABAR|DATA_UNAVAILABLE
  outcomeStatus4h: text("outcome_status_4h"),
  firstTouch1h:    text("first_touch_1h"),
  outcome1hGrossUsd: numeric("outcome_1h_gross_usd", { precision: 18, scale: 6 }),
  decisionObservedAtMs: numeric("decision_observed_at_ms", { precision: 16, scale: 0 }),
  horizonEnd1hMs:  numeric("horizon_end_1h_ms", { precision: 16, scale: 0 }),
  horizonEnd4hMs:  numeric("horizon_end_4h_ms", { precision: 16, scale: 0 }),
  sourceCandleFromMs: numeric("source_candle_from_ms", { precision: 16, scale: 0 }),
  sourceCandleToMs:   numeric("source_candle_to_ms", { precision: 16, scale: 0 }),
  entryReferencePrice: numeric("entry_reference_price", { precision: 18, scale: 8 }),
  dataCoverage:    numeric("data_coverage", { precision: 8, scale: 6 }),
  attempts:        integer("attempts").notNull().default(0),
  completedAt:     timestamp("completed_at", { withTimezone: true }),
});
