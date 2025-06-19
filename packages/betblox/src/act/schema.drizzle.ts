import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// Polls table
export const polls = pgTable("polls", {
  id: varchar("id", { length: 64 }).primaryKey(),
  creator: varchar("creator", { length: 64 }),
  question: text("question"),
  options: text("options"), // JSON stringified array
  closeTime: timestamp("close_time", { mode: "string" }),
  resolutionCriteria: text("resolution_criteria"),
  createdAt: timestamp("created_at", { mode: "string" }),
});

// Votes table
export const votes = pgTable(
  "votes",
  {
    pollId: varchar("poll_id", { length: 64 }),
    voter: varchar("voter", { length: 64 }),
    option: varchar("option", { length: 64 }),
    amount: varchar("amount", { length: 64 }),
    txHash: varchar("tx_hash", { length: 128 }),
    castAt: timestamp("cast_at", { mode: "string" }),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.voter] })]
);

// Poll outcomes table
export const pollOutcomes = pgTable("poll_outcomes", {
  pollId: varchar("poll_id", { length: 64 }).primaryKey(),
  outcome: varchar("outcome", { length: 64 }),
  closedAt: timestamp("closed_at", { mode: "string" }),
  resolver: varchar("resolver", { length: 64 }),
});

// Winnings table
export const winnings = pgTable(
  "winnings",
  {
    pollId: varchar("poll_id", { length: 64 }),
    voter: varchar("voter", { length: 64 }),
    amount: varchar("amount", { length: 64 }),
    claimedAt: timestamp("claimed_at", { mode: "string" }),
    txHash: varchar("tx_hash", { length: 128 }),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.voter] })]
);
