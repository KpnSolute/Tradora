import {
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const strategiesTable = pgTable("strategies", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  version: text("version").notNull().default("1.0.0"),
  status: text("status").notNull().default("disabled"),
  config: jsonb("config")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const backtestJobsTable = pgTable("backtest_jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  strategyId: integer("strategy_id").references(() => strategiesTable.id, {
    onDelete: "set null",
  }),
  symbol: text("symbol").notNull(),
  status: text("status").notNull().default("queued"),
  parameters: jsonb("parameters")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const signalsTable = pgTable("signals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, {
    onDelete: "cascade",
  }),
  strategyId: integer("strategy_id").references(() => strategiesTable.id, {
    onDelete: "set null",
  }),
  symbol: text("symbol").notNull(),
  assetClass: text("asset_class").notNull(),
  direction: text("direction").notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
  mode: text("mode").notNull(),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  generatedAt: timestamp("generated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const riskEventsTable = pgTable("risk_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, {
    onDelete: "cascade",
  }),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull(),
  symbol: text("symbol"),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type StrategyRecord = typeof strategiesTable.$inferSelect;
export type BacktestJob = typeof backtestJobsTable.$inferSelect;
export type SignalRecord = typeof signalsTable.$inferSelect;
export type RiskEvent = typeof riskEventsTable.$inferSelect;
