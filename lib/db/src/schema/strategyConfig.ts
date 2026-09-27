import { pgTable, serial, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Persists the user's strategy indicator and risk-limit config.
 * Single-row table (id=1) — always upserted, never multi-row.
 */
export const strategyConfigTable = pgTable("strategy_config", {
  id:         serial("id").primaryKey(),
  indicators: jsonb("indicators").notNull().default({}),
  limits:     jsonb("limits").notNull().default({}),
  updatedAt:  timestamp("updated_at").defaultNow().notNull(),
});

export const insertStrategyConfigSchema = createInsertSchema(strategyConfigTable).omit({ id: true, updatedAt: true });
export type InsertStrategyConfig = z.infer<typeof insertStrategyConfigSchema>;
export type DbStrategyConfig = typeof strategyConfigTable.$inferSelect;
