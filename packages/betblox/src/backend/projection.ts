import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../act/schema.drizzle";
import { BetBloxEvent } from "../act/schemas";

// Set up Postgres connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
const db = drizzle(pool, { schema });

export async function projectEvent(event: BetBloxEvent) {
  switch (event.type) {
    case "PollCreated":
      await db.insert(schema.polls).values({
        id: event.pollId,
        creator: event.creator,
        question: event.question,
        options: JSON.stringify(event.options),
        closeTime: event.closeTime,
        resolutionCriteria: event.resolutionCriteria,
        createdAt: event.createdAt,
      });
      break;
    case "VoteCast":
      await db.insert(schema.votes).values({
        pollId: event.pollId,
        voter: event.voter,
        option: event.option,
        amount: event.amount,
        txHash: event.txHash,
        castAt: event.castAt,
      });
      break;
    case "PollClosed":
      await db
        .insert(schema.pollOutcomes)
        .values({
          pollId: event.pollId,
          outcome: event.outcome,
          closedAt: event.closedAt,
          resolver: event.resolver,
        })
        .onConflictDoUpdate({
          target: schema.pollOutcomes.pollId,
          set: {
            outcome: event.outcome,
            closedAt: event.closedAt,
            resolver: event.resolver,
          },
        });
      break;
    case "WinningsClaimed":
      await db.insert(schema.winnings).values({
        pollId: event.pollId,
        voter: event.voter,
        amount: event.amount,
        claimedAt: event.claimedAt,
        txHash: event.txHash,
      });
      break;
    default:
      // Optionally log or throw for unknown event
      break;
  }
}
