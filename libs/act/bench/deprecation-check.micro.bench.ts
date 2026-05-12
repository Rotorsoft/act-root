/**
 * ACT-403: runtime cost of the deprecation check on the action() hot path.
 *
 * The check runs on every `app.do()` call. Two configurations exist:
 *
 * 1. **No deprecation** — the state's events are all single-version. The
 *    check is one property read + a falsy branch, then it bails out.
 *    Expected: indistinguishable from a state without the check at all.
 *
 * 2. **With deprecation** — the state's events include a `_v<n>` pair, so
 *    `me._deprecated` is a non-empty Set. The check loops over emitted
 *    tuples (typically one), does 2 Set lookups. After the first warning
 *    fires, the second lookup short-circuits and subsequent calls take
 *    the cheap fast path.
 *
 * Run: pnpm bench:micro libs/act/bench/deprecation-check.micro.bench.ts
 */
import { bench, describe } from "vitest";
import { z } from "zod";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { act } from "../src/builders/act-builder.js";
import { state } from "../src/builders/state-builder.js";
import { dispose, store } from "../src/ports.js";

const Plain = state({ Plain: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Tick: z.object({}) })
  .patch({ Tick: (_, s) => s })
  .on({ doTick: z.object({}) })
  .emit((_a) => ["Tick", {}])
  .build();

const Deprecated = state({ Deprecated: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({
    Tick: z.object({}),
    Tick_v2: z.object({}),
  })
  .patch({
    Tick: (_, s) => s,
    Tick_v2: (_, s) => s,
  })
  .on({ doTick: z.object({}) })
  // Dynamic form targeting the CURRENT version — the deprecation
  // check still runs on every commit, but no warning fires.
  .emit((_a) => ["Tick_v2", {}])
  .build();

const actor = { id: "bench", name: "bench" };

store(new InMemoryStore());

const plainApp = act().withState(Plain).build();
const deprecatedApp = act().withState(Deprecated).build();

let i = 0;
const nextStream = () => `bench-${++i}`;

describe("action() deprecation check overhead", () => {
  // Pre-seed each app's stream so load() finds something — we want to
  // isolate the action() path, not the cold-start cost.
  bench(
    "no deprecation in registry",
    async () => {
      await plainApp.do("doTick", { stream: nextStream(), actor }, {});
    },
    { iterations: 1_000 }
  );

  bench(
    "with deprecation in registry (targets current version)",
    async () => {
      await deprecatedApp.do("doTick", { stream: nextStream(), actor }, {});
    },
    { iterations: 1_000 }
  );
});

// Best-effort cleanup; vitest bench mode doesn't expose afterAll on
// describe(), so we register a process exit handler.
process.on("exit", () => {
  void dispose()();
});
