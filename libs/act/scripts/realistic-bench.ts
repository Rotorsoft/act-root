/**
 * Realistic-workload bench — measures end-to-end throughput for shapes
 * that resemble production apps. Distinct from `perf-bench.ts` (the CI
 * regression guard, which targets framework primitives in isolation).
 *
 * Each scenario exercises the full pipeline a real app pays for:
 * payload validation, invariant checking, multi-event commits, reaction
 * dispatch + drain, and projection updates. Numbers are typically lower
 * than the synthetic perf-bench numbers; the gap is what real apps
 * actually pay.
 *
 * Runs on-demand (not in CI). Document results in PERFORMANCE.md under
 * "Realistic workloads" so users can compare against their planning
 * assumptions.
 *
 * Usage:
 *   pnpm -F @rotorsoft/act bench:realistic
 */

import { performance } from "node:perf_hooks";
import { z } from "zod";
import { InMemoryCache } from "../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act } from "../src/builders/act-builder.js";
import { state } from "../src/builders/state-builder.js";
import { cache, dispose, store } from "../src/ports.js";

// ---------------------------------------------------------------------------
// Bench runner (same shape as perf-bench)
// ---------------------------------------------------------------------------

interface Scenario {
  readonly name: string;
  readonly setup: () => Promise<void>;
  readonly run: () => Promise<void>;
  /** Underlying ops per timed run — drives effective_per_sec. */
  readonly batchSize: number;
}

interface Result {
  readonly name: string;
  readonly samples: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly mean_ms: number;
  readonly ops_per_sec: number;
  readonly effective_per_sec: number;
}

async function measure(s: Scenario, iters: number): Promise<Result> {
  await s.setup();
  for (let i = 0; i < 5; i++) await s.run(); // warmup

  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    await s.run();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const opsPerSec = round(1000 / mean, 0);
  return {
    name: s.name,
    samples: samples.length,
    p50_ms: round(p50),
    p95_ms: round(p95),
    mean_ms: round(mean),
    ops_per_sec: opsPerSec,
    effective_per_sec: opsPerSec * s.batchSize,
  };
}

const round = (n: number, d = 4) => Number(n.toFixed(d));

const resetPorts = async () => {
  await dispose()();
  store(new InMemoryStore());
  cache(new InMemoryCache());
};

// ---------------------------------------------------------------------------
// Scenario 1 — Ticket workflow (open → assign → close, invariants + reaction)
// ---------------------------------------------------------------------------

const Ticket = state({
  Ticket: z.object({
    status: z.enum(["new", "assigned", "closed"]),
    assignee: z.string().optional(),
  }),
})
  .init(() => ({ status: "new" as const, assignee: undefined }))
  .emits({
    TicketOpened: z.object({ title: z.string() }),
    TicketAssigned: z.object({ assignee: z.string() }),
    TicketClosed: z.object({ resolution: z.string() }),
  })
  .patch({
    TicketOpened: () => ({ status: "new" as const }),
    TicketAssigned: ({ data }) => ({
      status: "assigned" as const,
      assignee: data.assignee,
    }),
    TicketClosed: () => ({ status: "closed" as const }),
  })
  .on({ open: z.object({ title: z.string() }) })
  .emit("TicketOpened")
  .on({ assign: z.object({ assignee: z.string() }) })
  .given([
    {
      description: "must be new",
      valid: (s) => s.status === "new",
    },
  ])
  .emit("TicketAssigned")
  .on({ close: z.object({ resolution: z.string() }) })
  .given([
    {
      description: "must be assigned",
      valid: (s) => s.status === "assigned",
    },
  ])
  .emit("TicketClosed")
  .build();

let ticketApp: ReturnType<
  ReturnType<typeof act<any, any, any, any, any>>["build"]
>;
let ticketCounter = 0;

// ---------------------------------------------------------------------------
// Scenario 2 — Calculator session with digit-board projection
// ---------------------------------------------------------------------------

const Calc = state({ Calc: z.object({ value: z.number() }) })
  .init(() => ({ value: 0 }))
  .emits({ DigitPressed: z.object({ digit: z.number() }) })
  .patch({
    DigitPressed: ({ data }, s) => ({ value: s.value * 10 + data.digit }),
  })
  .on({ press: z.object({ digit: z.number() }) })
  .emit("DigitPressed")
  .build();

let calcApp: ReturnType<
  ReturnType<typeof act<any, any, any, any, any>>["build"]
>;
let calcCounter = 0;

// ---------------------------------------------------------------------------
// Scenario 3 — Shared inventory (10 contending reservations with invariants)
// ---------------------------------------------------------------------------

const Inventory = state({ Inventory: z.object({ stock: z.number() }) })
  .init(() => ({ stock: 1000 }))
  .emits({ Reserved: z.object({ qty: z.number() }) })
  .patch({
    Reserved: ({ data }, s) => ({ stock: s.stock - data.qty }),
  })
  .on({ reserve: z.object({ qty: z.number() }) })
  .given([
    {
      description: "stock must be positive",
      valid: (s) => s.stock > 0,
    },
  ])
  .emit("Reserved")
  .build();

let invApp: ReturnType<
  ReturnType<typeof act<any, any, any, any, any>>["build"]
>;
let invCounter = 0;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const actor = { id: "u", name: "u" };

const scenarios: Scenario[] = [
  {
    name: "ticket workflow: open → assign → close (3 actions, 3 events, 2 invariants)",
    batchSize: 3,
    async setup() {
      await resetPorts();
      ticketApp = act().withState(Ticket).build();
      ticketCounter = 0;
    },
    async run() {
      const stream = `tk-${ticketCounter++}`;
      await ticketApp.do("open", { stream, actor }, { title: "perf" });
      await ticketApp.do("assign", { stream, actor }, { assignee: "alice" });
      await ticketApp.do("close", { stream, actor }, { resolution: "fixed" });
    },
  },
  {
    name: "calculator session: 10 key presses + projection updating",
    batchSize: 10,
    async setup() {
      await resetPorts();
      calcApp = act()
        .withState(Calc)
        .on("DigitPressed")
        .do(function projectDigit() {
          return Promise.resolve(); // projection no-op (timed: dispatch overhead)
        })
        .to((event) => ({ target: `digits-${event.stream}` }))
        .build();
      calcCounter = 0;
    },
    async run() {
      const stream = `calc-${calcCounter++}`;
      for (let i = 0; i < 10; i++) {
        await calcApp.do("press", { stream, actor }, { digit: i % 10 });
      }
      // Drive the reactions through the pipeline.
      await calcApp.correlate();
      await calcApp.drain({ streamLimit: 100, eventLimit: 100 });
    },
  },
  {
    name: "shared inventory: 10 contending reservations (same stream, invariant + retries)",
    batchSize: 10,
    async setup() {
      await resetPorts();
      invApp = act().withState(Inventory).build();
      invCounter = 0;
    },
    async run() {
      const stream = `inv-${invCounter++}`;
      // Seed: open the stream with 1000 units (init covers it).
      const tasks = Array.from({ length: 10 }, async () => {
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            await invApp.do("reserve", { stream, actor }, { qty: 1 });
            return;
          } catch (err) {
            if (!(err instanceof Error) || !err.message.includes("Concurrency"))
              throw err;
          }
        }
      });
      await Promise.all(tasks);
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Tuned to keep total time < 60s.
  const counts: Record<string, number> = {
    "ticket workflow: open → assign → close (3 actions, 3 events, 2 invariants)": 100,
    "calculator session: 10 key presses + projection updating": 50,
    "shared inventory: 10 contending reservations (same stream, invariant + retries)": 50,
  };

  const results: Result[] = [];
  for (const s of scenarios) {
    const iters = counts[s.name] ?? 50;
    process.stderr.write(`Running ${s.name} (${iters} iters)...\n`);
    results.push(await measure(s, iters));
  }
  await dispose()();
  process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
}

void main();
