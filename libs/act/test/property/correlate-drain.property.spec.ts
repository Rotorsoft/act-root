import { fc, test } from "@fast-check/vitest";
import { z } from "zod";
import { InMemoryCache } from "../../src/adapters/in-memory-cache.js";
import { InMemoryStore } from "../../src/adapters/in-memory-store.js";
import { act } from "../../src/builders/act-builder.js";
import { state } from "../../src/builders/state-builder.js";
import { cache, dispose, store } from "../../src/ports.js";
import { ZodEmpty } from "../../src/types/schemas.js";

/**
 * Properties for correlate→drain delivery semantics:
 *
 *   1. Every committed reactive event is delivered to exactly one
 *      handler invocation (no losses, no duplicates) under a sufficient
 *      number of correlate→drain passes.
 *   2. Drain is idempotent — repeated drains after a settled stream
 *      produce no additional handler invocations.
 *   3. Acks advance the watermark such that the same lease cannot be
 *      claimed again with the same `at`.
 */

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Inc: ZodEmpty })
  .patch({ Inc: (_, s) => ({ count: s.count + 1 }) })
  .on({ inc: ZodEmpty })
  .emit("Inc")
  .build();

const target = (stream: string) => ({
  stream,
  actor: { id: "u", name: "u" },
});

const streamArb = fc.constantFrom("a", "b", "c");

describe("property: correlate→drain delivery invariants", () => {
  beforeEach(() => {
    store(new InMemoryStore());
    cache(new InMemoryCache());
  });
  afterEach(async () => {
    await dispose()();
  });

  test.prop([fc.array(streamArb, { minLength: 1, maxLength: 20 })], {
    numRuns: 50,
  })(
    "every committed reactive event is delivered exactly once after enough drains",
    async (commits) => {
      const calls: string[] = [];
      const app = act()
        .withState(Counter)
        .on("Inc")
        .do(function recordInc(event) {
          calls.push(`${event.stream}:${event.id}`);
          return Promise.resolve();
        })
        .to((event) => ({ target: `proj-${event.stream}` }))
        .build();

      for (const s of commits) {
        await app.do("inc", target(s), {});
      }

      // Drain to completion.
      let safety = 50;
      while (safety-- > 0) {
        await app.correlate({ limit: 1000 });
        const d = await app.drain({ streamLimit: 100, eventLimit: 100 });
        if (d.acked.length === 0 && d.blocked.length === 0) break;
      }

      // Each commit produces exactly one handler invocation, identified
      // by its (stream, eventId) tuple.
      expect(calls.length).toBe(commits.length);
      expect(new Set(calls).size).toBe(calls.length); // no duplicates
    }
  );

  test.prop([fc.array(streamArb, { minLength: 0, maxLength: 10 })], {
    numRuns: 50,
  })(
    "drain is idempotent once settled — extra drains produce no work",
    async (commits) => {
      const calls: string[] = [];
      const app = act()
        .withState(Counter)
        .on("Inc")
        .do(function recordInc(event) {
          calls.push(`${event.stream}:${event.id}`);
          return Promise.resolve();
        })
        .to((event) => ({ target: `proj-${event.stream}` }))
        .build();

      for (const s of commits) {
        await app.do("inc", target(s), {});
      }
      // First, drive to completion.
      let safety = 50;
      while (safety-- > 0) {
        await app.correlate({ limit: 1000 });
        const d = await app.drain({ streamLimit: 100, eventLimit: 100 });
        if (d.acked.length === 0 && d.blocked.length === 0) break;
      }
      const before = calls.length;

      // Now do many extra drains — handler must NOT be re-invoked.
      for (let i = 0; i < 5; i++) {
        await app.correlate();
        await app.drain();
      }
      expect(calls.length).toBe(before);
    }
  );
});
