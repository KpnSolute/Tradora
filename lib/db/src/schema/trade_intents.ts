import { pgTable, text, serial, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { tradesTable } from "./trades";

/**
 * Human-in-the-loop trade proposals produced by the strategy engine analyst.
 *
 * Nothing in this table was executed by an agent: a row is a written thesis plus
 * risk levels that the user approves (which simulates a paper fill in `trades`)
 * or rejects.
 */
export const tradeIntentsTable = pgTable("trade_intents", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(), // buy | sell
  quantity: numeric("quantity", { precision: 20, scale: 8 }).notNull(),
  orderType: text("order_type").notNull().default("market"),
  referencePrice: numeric("reference_price", { precision: 20, scale: 8 }).notNull(),
  stopLoss: numeric("stop_loss", { precision: 20, scale: 8 }).notNull(),
  takeProfit: numeric("take_profit", { precision: 20, scale: 8 }).notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
  thesis: text("thesis").notNull(),
  strategyName: text("strategy_name").notNull(),
  timeframe: text("timeframe").notNull().default("1h"), // bar interval the thesis used
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  mode: text("mode").notNull().default("paper"), // paper only
  decisionNote: text("decision_note"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  tradeId: integer("trade_id").references(() => tradesTable.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TradeIntentRecord = typeof tradeIntentsTable.$inferSelect;
