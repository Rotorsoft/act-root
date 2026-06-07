/**
 * #855: orchestrator overhead on non-sensitive workloads.
 *
 * The sensitive-data foundation adds work to every event through the
 * orchestrator — `pii_fields(name)` registry lookup, `fields.length === 0`
 * early-exit branches in `pii_merge`/`pii_gate`/`pii_strip`,
 * and the gating path in `action()`'s post-commit snapshot builder.
 *
 * For events with no `sensitive(...)` markers, every one of those checks
 * should short-circuit immediately. This bench measures **whether the
 * regular-event hot path actually pays nothing**. The workload uses a plain
 * Counter — no sensitive markers anywhere, no `.discloses`, no `actor` arg on
 * load.
 *
 * Run this bench on master to get the **before** numbers, then on this
 * branch (with the full PII machinery wired in) to get the **after**
 * numbers. The delta tells you the orchestrator's added cost on real
 * workloads that don't use the feature.
 *
 * Per CLAUDE.md: InMemory is a baseline reference, never the primary
 * production number. These benches measure orchestrator-level cost only;
 * adapter-level numbers belong in `libs/act-pg/bench/`.
 */

/* eslint-disable @typescript-eslint/no-unsafe-argument -- bench helpers use any to avoid State name branding */
import { afterAll, bench, describe } from "vitest";
import { z } from "zod";
import { act } from "../src/builders/act-builder.js";
import { state } from "../src/builders/state-builder.js";
import { dispose } from "../src/ports.js";
import type { Actor } from "../src/types/index.js";

const actor: Actor = { id: "u-1", name: "Bench" };

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: (event, s) => ({ count: s.count + event.data.by }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((a) => ["Incremented", { by: a.by }])
  .build();

describe("orchestrator — non-sensitive workload (master vs PR baseline)", () => {
  let streamId = 0;
  // biome-ignore lint/suspicious/noExplicitAny: bench-only, narrow generic preserved at runtime
  let app: any;

  bench(
    "app.do() — commit one Incremented per call",
    async () => {
      await app.do(
        "increment",
        { stream: `c-${streamId++}`, actor },
        { by: 1 }
      );
    },
    {
      setup: async () => {
        await dispose()();
        app = act().withState(Counter).build();
        streamId = 0;
      },
    }
  );

  bench(
    "app.load() — replay a 100-event stream",
    async () => {
      await app.load(Counter as any, "load-bench");
    },
    {
      setup: async () => {
        await dispose()();
        app = act().withState(Counter).build();
        for (let i = 0; i < 100; i++) {
          await app.do("increment", { stream: "load-bench", actor }, { by: 1 });
        }
      },
    }
  );

  bench(
    "app.do() then app.load() — round-trip per call",
    async () => {
      const stream = `rt-${streamId++}`;
      await app.do("increment", { stream, actor }, { by: 1 });
      await app.load(Counter as any, stream);
    },
    {
      setup: async () => {
        await dispose()();
        app = act().withState(Counter).build();
        streamId = 0;
      },
    }
  );
});

afterAll(async () => {
  await dispose()();
});
