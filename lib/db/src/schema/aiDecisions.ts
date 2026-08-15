import { pgTable, serial, text, real, integer, timestamp, boolean } from "drizzle-orm/pg-core";
// fullJson stores the complete AiEngineDecision JSON for full-fidelity replay after page refresh.
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * AI Decision Log — records every autonomous trading decision made by the AI engine.
 *
 * The AI independently selects symbols, decides LONG/SHORT/NO_TRADE/CLOSE/REVERSE,
 * determines entry/exit prices, sizes positions within risk limits, and manages
 * TP/SL/trailing stops 24/7 while the user is offline.
 *
 * Risk controls sit ABOVE the AI with absolute veto authority (riskResult='VETOED').
 * Vetoed decisions are logged but never executed.
 *
 * Columns:
 *   direction        — AI's chosen action
 *   confidence       — AI certainty 0.0–1.0
 *   rationale        — one-line AI reasoning summary
 *   riskResult       — APPROVED | VETOED | MODIFIED (deterministic risk layer verdict)
 *   executionOutcome — FILLED | REJECTED | PENDING | CANCELLED | SIMULATED
 */
export const aiDecisionsTable = pgTable("ai_decisions", {
  id:               serial("id").primaryKey(),
  ts:               timestamp("ts").notNull().defaultNow(),
  symbol:           text("symbol").notNull(),
  direction:        text("direction").notNull(),        // 'LONG'|'SHORT'|'NO_TRADE'|'CLOSE'|'REVERSE'
  confidence:       real("confidence").notNull().default(0),   // 0.0–1.0
  rationale:        text("rationale").notNull().default(""),
  strategy:         text("strategy").notNull().default(""),
  entryPrice:       real("entry_price"),
  exitPrice:        real("exit_price"),
  size:             real("size"),
  riskResult:       text("risk_result").notNull().default("APPROVED"), // 'APPROVED'|'VETOED'|'MODIFIED'
  riskNote:         text("risk_note"),
  executionOutcome: text("execution_outcome").notNull().default("PENDING"), // 'FILLED'|'REJECTED'|'PENDING'|'CANCELLED'|'SIMULATED'
  pnl:              real("pnl"),
  durationMs:       integer("duration_ms"),
  /** Full AiEngineDecision serialised as JSON — null for older rows / VPS-originated decisions */
  fullJson:         text("full_json"),
  /** True when this decision was produced while LIVE TEST MODE was active */
  testMode:         boolean("test_mode").notNull().default(false),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
});

export const insertAiDecisionSchema = createInsertSchema(aiDecisionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAiDecision = z.infer<typeof insertAiDecisionSchema>;
export type DbAiDecision = typeof aiDecisionsTable.$inferSelect;
