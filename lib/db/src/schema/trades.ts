import { pgTable, text, numeric, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Persistent trade log for paper-trading sessions.
 * Both OPEN and CLOSE actions are stored so activity history survives
 * browser/app storage clears.
 */
export const tradesTable = pgTable("trades", {
  id:        text("id").primaryKey(),
  symbol:    text("symbol").notNull(),
  side:      text("side").notNull(),    // 'LONG' | 'SHORT'
  action:    text("action").notNull(),  // 'OPEN' | 'CLOSE'
  size:      numeric("size",  { precision: 18, scale: 8 }).notNull(),
  price:     numeric("price", { precision: 18, scale: 8 }).notNull(),
  pnl:       numeric("pnl",   { precision: 18, scale: 8 }).notNull().default("0"),
  strategy:  text("strategy").notNull().default("Manual"),
  timestamp: timestamp("timestamp").notNull(),
  closeTime: bigint("close_time", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ createdAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type DbTrade = typeof tradesTable.$inferSelect;
