/**
 * #855: runtime cost of the sensitive-data foundation on regular workloads.
 *
 * Three axes:
 *
 * 1. **Commit-path overhead** — `action()` splits sensitive fields off `data`
 *    into `pii` before calling `Store.commit`. Non-sensitive events
 *    short-circuit on `sensitive_fields(name).length === 0`. We compare:
 *      - baseline: action() committing a non-sensitive event
 *      - sensitive: action() committing an event with 2 sensitive fields
 *
 * 2. **Load-path gate overhead** — `load()` builds the reducer view + the
 *    external view per event. Non-sensitive events short-circuit on the
 *    same field-list check. We compare:
 *      - baseline: load() over a stream of 100 non-sensitive events
 *      - sensitive: load() over a stream of 100 sensitive events with
 *        `.discloses(() => true)` (predicate fires per event)
 *
 * 3. **Handler-strip overhead** — `buildHandle` strips sensitive keys before
 *    invoking the user handler. Non-sensitive events short-circuit. We
 *    compare:
 *      - baseline: handler invocation on a non-sensitive event
 *      - sensitive: handler invocation on a sensitive event with 2 stripped
 *        keys
 *
 * Per CLAUDE.md: InMemory is a baseline reference, never the primary
 * production number. These benches measure orchestrator-level cost only —
 * `act-pg` adapter-level numbers belong in `libs/act-pg/bench/`.
 *
 * Results land in `libs/act/PERFORMANCE.md`.
 */

/* eslint-disable @typescript-eslint/no-unsafe-argument -- bench helpers use any to avoid State name branding */
import { afterAll, bench, describe } from "vitest";
import { z } from "zod";
import { state } from "../src/builders/state-builder.js";
import { action, load } from "../src/internal/event-sourcing.js";
import { pii_fields, strip_for_handler } from "../src/internal/sensitive.js";
import { dispose, store } from "../src/ports.js";
import type { Actor, Committed } from "../src/types/index.js";
import { sensitive } from "../src/types/schemas.js";

const actor: Actor = { id: "u-1", name: "Bench" };

// -- 1. Commit-path overhead -------------------------------------------------

const NonPIIEvent = z.object({ by: z.number() });
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: NonPIIEvent })
  .patch({ Incremented: (event, s) => ({ count: s.count + event.data.by }) })
  .on({ increment: NonPIIEvent })
  .emit((a) => ["Incremented", a])
  .build();

const SensitiveEvent = z.object({
  email: sensitive(z.string()),
  name: sensitive(z.string()),
  plan: z.enum(["free", "pro"]),
});
const SensitiveState = state({ Sensitive: z.object({}) })
  .init(() => ({}))
  .emits({ Registered: SensitiveEvent })
  .patch({ Registered: () => ({}) })
  .on({ register: SensitiveEvent })
  .emit((p) => ["Registered", p])
  .discloses(() => true)
  .build();

// pii_fields lookups: registry-cached versions
const counter_lookup = (): readonly string[] => [];
const sensitive_lookup = (name: string): readonly string[] =>
  name === "Registered" ? ["email", "name"] : [];

describe("commit-path: sensitive split overhead", () => {
  let counter_stream = 0;
  let sensitive_stream = 0;

  bench(
    "baseline — non-sensitive event commit",
    async () => {
      await action(
        Counter,
        "increment",
        { stream: `c-${counter_stream++}`, actor },
        { by: 1 },
        undefined,
        true,
        undefined,
        counter_lookup
      );
    },
    {
      setup: async () => {
        await dispose()();
        counter_stream = 0;
      },
    }
  );

  bench(
    "sensitive — 2-field split + clean partition",
    async () => {
      await action(
        SensitiveState,
        "register",
        { stream: `s-${sensitive_stream++}`, actor },
        { email: "u@example.com", name: "Ursula", plan: "free" },
        undefined,
        true,
        undefined,
        sensitive_lookup
      );
    },
    {
      setup: async () => {
        await dispose()();
        sensitive_stream = 0;
      },
    }
  );
});

// -- 2. Load-path gate overhead ----------------------------------------------

const EVENTS_PER_STREAM = 100;

describe("load-path: gate overhead over 100-event stream", () => {
  bench(
    "baseline — 100 non-sensitive events",
    async () => {
      await load(Counter, "load-baseline");
    },
    {
      setup: async () => {
        await dispose()();
        for (let i = 0; i < EVENTS_PER_STREAM; i++) {
          await action(
            Counter,
            "increment",
            { stream: "load-baseline", actor },
            { by: 1 },
            undefined,
            true,
            undefined,
            counter_lookup
          );
        }
      },
    }
  );

  bench(
    "sensitive — 100 sensitive events, discloses() => true (per-event predicate + merge)",
    async () => {
      await load(
        SensitiveState,
        "load-sensitive",
        undefined,
        undefined,
        actor,
        sensitive_lookup
      );
    },
    {
      setup: async () => {
        await dispose()();
        for (let i = 0; i < EVENTS_PER_STREAM; i++) {
          await action(
            SensitiveState,
            "register",
            { stream: "load-sensitive", actor },
            { email: `u${i}@example.com`, name: `User${i}`, plan: "free" },
            undefined,
            true,
            undefined,
            sensitive_lookup
          );
        }
      },
    }
  );
});

// -- 3. Handler-strip overhead -----------------------------------------------

describe("handler dispatch: strip overhead", () => {
  // Build representative events directly so the bench measures only strip cost
  // (not commit + queue). The Committed shape matches what the drain pipeline
  // passes to handlers.
  const counter_event: Committed<
    { Incremented: { by: number } },
    "Incremented"
  > = {
    id: 0,
    stream: "c-1",
    version: 0,
    created: new Date(),
    name: "Incremented",
    data: { by: 1 },
    meta: { correlation: "x", causation: {} },
  };

  const sensitive_event: Committed<
    { Registered: { email: string; name: string; plan: "free" | "pro" } },
    "Registered"
  > = {
    id: 0,
    stream: "s-1",
    version: 0,
    created: new Date(),
    name: "Registered",
    data: { email: "u@example.com", name: "Ursula", plan: "free" },
    pii: { email: "u@example.com", name: "Ursula" },
    meta: { correlation: "x", causation: {} },
  };

  bench("baseline — non-sensitive event (short-circuit)", () => {
    strip_for_handler(counter_event, []);
  });

  bench("sensitive — strip 2 keys + drop pii field", () => {
    strip_for_handler(sensitive_event, ["email", "name"]);
  });
});

// -- 4. Walker overhead at build time ----------------------------------------

// Pre-build the large schema OUTSIDE the bench loop so we measure walker
// cost, not Zod object construction.
const LargeSchema = z.object({
  a: z.string(),
  b: z.number(),
  c: sensitive(z.string()),
  d: z.boolean(),
  e: sensitive(z.string()),
  f: z.string(),
  g: z.number(),
  h: sensitive(z.string()),
  i: z.string(),
  j: z.number(),
  k: sensitive(z.string()),
  l: z.string(),
});

describe("build time: pii_fields walker per event schema", () => {
  bench("non-sensitive schema (1 field, none marked)", () => {
    pii_fields(NonPIIEvent);
  });

  bench("sensitive schema (3 fields, 2 marked)", () => {
    pii_fields(SensitiveEvent);
  });

  bench("large schema (12 fields, 4 marked)", () => {
    pii_fields(LargeSchema);
  });
});

// Cleanup at module teardown — Vitest invokes setup once per iteration
// group, so a single dispose at the end keeps process state clean for the
// next bench module.
afterAll(async () => {
  await dispose()();
  store();
});
