import { initTRPC } from "@trpc/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import * as schema from "../act/schema.drizzle";

const t = initTRPC.create();

const config = {
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
};
const pool = new Pool(config);
console.log(config);
const db = drizzle(pool, { schema });

const paginationInput = z.object({
  limit: z.number().min(1).max(100).default(20),
  offset: z.number().min(0).default(0),
});

export const appRouter = t.router({
  health: t.procedure.query(() => ({ status: "ok" })),

  getPolls: t.procedure
    .input(paginationInput.default({}))
    .query(async ({ input }) => {
      const { limit, offset } = input;
      return await db.select().from(schema.polls).limit(limit).offset(offset);
    }),

  getPollById: t.procedure
    .input(z.object({ pollId: z.string() }))
    .query(async ({ input }) => {
      return await db
        .select()
        .from(schema.polls)
        .where(eq(schema.polls.id, input.pollId));
    }),

  getVotesForPoll: t.procedure
    .input(
      z.object({
        pollId: z.string(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const { pollId, limit, offset } = input;
      return await db
        .select()
        .from(schema.votes)
        .where(eq(schema.votes.pollId, pollId))
        .limit(limit)
        .offset(offset);
    }),

  getPollOutcome: t.procedure
    .input(z.object({ pollId: z.string() }))
    .query(async ({ input }) => {
      return await db
        .select()
        .from(schema.pollOutcomes)
        .where(eq(schema.pollOutcomes.pollId, input.pollId));
    }),

  getWinningsForUser: t.procedure
    .input(
      z.object({
        voter: z.string(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const { voter, limit, offset } = input;
      return await db
        .select()
        .from(schema.winnings)
        .where(eq(schema.winnings.voter, voter))
        .limit(limit)
        .offset(offset);
    }),

  createPoll: t.procedure
    .input(
      z.object({
        question: z.string().min(1).max(200),
        options: z.array(z.string().min(1).max(100)).min(2).max(10),
      })
    )
    .mutation(async ({ input }) => {
      const pollId = uuidv4();
      const now = new Date().toISOString();
      await db.insert(schema.polls).values({
        id: pollId,
        creator: "dev",
        question: input.question,
        options: JSON.stringify(input.options),
        closeTime: "",
        resolutionCriteria: "",
        createdAt: now,
      });
      return {
        id: pollId,
        creator: "dev",
        question: input.question,
        options: JSON.stringify(input.options),
        closeTime: "",
        resolutionCriteria: "",
        createdAt: now,
      };
    }),

  castVote: t.procedure
    .input(
      z.object({
        pollId: z.string(),
        voter: z.string(),
        option: z.string(),
        amount: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const txHash = uuidv4();
      const castAt = new Date().toISOString();
      await db.insert(schema.votes).values({
        pollId: input.pollId,
        voter: input.voter,
        option: input.option,
        amount: input.amount,
        txHash,
        castAt,
      });
      return {
        pollId: input.pollId,
        voter: input.voter,
        option: input.option,
        amount: input.amount,
        txHash,
        castAt,
      };
    }),

  claimWinnings: t.procedure
    .input(
      z.object({
        pollId: z.string(),
        voter: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const txHash = uuidv4();
      const claimedAt = new Date().toISOString();
      // For demo, set amount to '100'. In real app, calculate based on poll outcome and bet.
      const amount = "100";
      await db.insert(schema.winnings).values({
        pollId: input.pollId,
        voter: input.voter,
        amount,
        claimedAt,
        txHash,
      });
      return {
        pollId: input.pollId,
        voter: input.voter,
        amount,
        claimedAt,
        txHash,
      };
    }),
});

export type AppRouter = typeof appRouter;
