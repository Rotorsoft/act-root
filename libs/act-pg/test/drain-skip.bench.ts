/**
 * Benchmark: drain skip optimization for non-reactive events (PostgreSQL).
 *
 * Simulates a realistic workload: an entity with 18 event types where only 7
 * have registered reactions (lifecycle events). The remaining 11 are
 * high-frequency operational events that should skip drain entirely.
 *
 * Run: pnpm vitest bench libs/act-pg/test/drain-skip.bench.ts --run
 */
import { act, dispose, state, store, ZodEmpty } from "@rotorsoft/act";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { z } from "zod";
import { PostgresStore } from "../src/PostgresStore.js";

// Simulate an entity with lifecycle + operational events
const Entity = state({
  Entity: z.object({
    status: z.string(),
    members: z.number(),
    score: z.number(),
  }),
})
  .init(() => ({ status: "active", members: 0, score: 0 }))
  .emits({
    // Lifecycle events (7) — have reactions
    Created: ZodEmpty,
    MemberAdded: ZodEmpty,
    Started: ZodEmpty,
    MemberRemoved: ZodEmpty,
    Completed: ZodEmpty,
    Archived: ZodEmpty,
    Deleted: ZodEmpty,
    // Operational events (11) — no reactions
    Updated: ZodEmpty,
    ScoreChanged: ZodEmpty,
    ItemMoved: ZodEmpty,
    EntryLogged: ZodEmpty,
    FieldChanged: ZodEmpty,
    StepAdvanced: ZodEmpty,
    PhaseChanged: ZodEmpty,
    CounterIncremented: ZodEmpty,
    StatusToggled: ZodEmpty,
    NoteAdded: ZodEmpty,
    TagApplied: ZodEmpty,
  })
  .patch({
    Created: () => ({ status: "created" }),
    MemberAdded: (_, s) => ({ members: s.members + 1 }),
    Started: () => ({ status: "started" }),
    MemberRemoved: (_, s) => ({ members: s.members - 1 }),
    Completed: () => ({ status: "completed" }),
    Archived: () => ({ status: "archived" }),
    Deleted: () => ({ status: "deleted" }),
    Updated: () => ({}),
    ScoreChanged: (_, s) => ({ score: s.score + 1 }),
    ItemMoved: () => ({}),
    EntryLogged: () => ({}),
    FieldChanged: () => ({}),
    StepAdvanced: () => ({}),
    PhaseChanged: () => ({}),
    CounterIncremented: () => ({}),
    StatusToggled: () => ({}),
    NoteAdded: () => ({}),
    TagApplied: () => ({}),
  })
  // Actions for both tiers
  .on({ create: ZodEmpty })
  .emit(() => ["Created", {}])
  .on({ addMember: ZodEmpty })
  .emit(() => ["MemberAdded", {}])
  .on({ start: ZodEmpty })
  .emit(() => ["Started", {}])
  .on({ update: ZodEmpty })
  .emit(() => ["Updated", {}])
  .on({ changeScore: ZodEmpty })
  .emit(() => ["ScoreChanged", {}])
  .on({ moveItem: ZodEmpty })
  .emit(() => ["ItemMoved", {}])
  .on({ logEntry: ZodEmpty })
  .emit(() => ["EntryLogged", {}])
  .build();

// Reactions only for lifecycle events — operational events have none
const app = act()
  .withState(Entity)
  .on("Created")
  .do(async () => {})
  .on("MemberAdded")
  .do(async () => {})
  .on("Started")
  .do(async () => {})
  .on("MemberRemoved")
  .do(async () => {})
  .on("Completed")
  .do(async () => {})
  .on("Archived")
  .do(async () => {})
  .on("Deleted")
  .do(async () => {})
  .build();

const actor = { id: "bench", name: "bench" };

store(
  new PostgresStore({
    port: 5431,
    schema: "drain_skip_bench",
    table: "events",
  })
);

beforeAll(async () => {
  await store().drop();
  await store().seed();
  await app.correlate();
});

afterAll(async () => {
  await store().drop();
  await dispose()();
});

describe("drain skip — 18 event types, 7 reactive (PostgreSQL)", () => {
  bench("operational event (drain skipped — 0 DB trips)", async () => {
    await app.do("update", { stream: "bench-op", actor }, {});
    await app.drain();
  });

  bench("lifecycle event (full drain — 3 DB trips)", async () => {
    await app.do("addMember", { stream: "bench-lc", actor }, {});
    await app.correlate();
    await app.drain();
  });

  bench("mixed burst: 3 operational + 1 lifecycle", async () => {
    await app.do("update", { stream: "bench-mix", actor }, {});
    await app.do("changeScore", { stream: "bench-mix", actor }, {});
    await app.do("logEntry", { stream: "bench-mix", actor }, {});
    await app.do("addMember", { stream: "bench-mix", actor }, {});
    await app.correlate();
    await app.drain();
  });
});
