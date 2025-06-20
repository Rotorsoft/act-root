import { initTRPC } from "@trpc/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod/v4";
import * as schema from "../act/schema.drizzle";
import { mockedBlockchainRouter } from "./trpc-mocked-blockchain";

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
    .input(paginationInput.default({ limit: 20, offset: 0 }))
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

  blockchain: mockedBlockchainRouter,
});

export type AppRouter = typeof appRouter;
export { t };
