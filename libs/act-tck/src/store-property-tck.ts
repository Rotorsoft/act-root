import { fc, test } from "@fast-check/vitest";
import type { Store } from "@rotorsoft/act/types";
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { CounterEvents } from "./fixtures/events.js";
import { collect, inc, make_meta } from "./fixtures/helpers.js";

/**
 * Property-based contract for the store-level invariants the drain pipeline
 * depends on — commit version monotonicity, claim/lease no-leak, watermark
 * monotonicity, and block exclusion. These ran only against `InMemoryStore`
 * before ACT-982; running them against the durable adapters too is the only
 * way to catch a divergence the example-based TCK cases miss.
 *
 * Each predicate resets the store (`drop` + `seed`) so randomized runs are
 * isolated. Durable adapters should pass a reduced `numRuns` and their own
 * dedicated schema/file so a parallel test worker can't clobber the table.
 */
export type StorePropertyTckOptions = {
  /** Adapter name for the describe block. */
  name: string;
  /** Produces the store under test (created once, reset between runs). */
  factory: () => Store | Promise<Store>;
  /** fast-check runs per property. Default 100; lower for durable adapters. */
  numRuns?: number;
};

const streamArb = fc.constantFrom("s1", "s2", "s3");
const commitArb = fc.record({
  stream: streamArb,
  count: fc.integer({ min: 1, max: 3 }),
});

const claimStreamArb = fc.constantFrom("a", "b", "c");
const opArb = fc.oneof(
  fc.record({ kind: fc.constant("commit" as const), stream: claimStreamArb }),
  fc.record({ kind: fc.constant("claim" as const) }),
  fc.record({ kind: fc.constant("ack-all" as const) }),
  fc.record({ kind: fc.constant("block-all" as const) })
);

const events = (count: number) => Array.from({ length: count }, () => inc(1));

export const runStorePropertyTck = (options: StorePropertyTckOptions): void => {
  const numRuns = options.numRuns ?? 100;

  describe(`TCK / Store properties / ${options.name}`, () => {
    let store: Store;

    beforeAll(async () => {
      store = await options.factory();
      await store.seed();
    });
    afterAll(async () => {
      await store.dispose();
    });

    // Clean slate per randomized run. claim() spans every claimable stream
    // in the table, so namespacing alone can't isolate the claim properties;
    // a full reset is the only safe option.
    const reset = async () => {
      await store.drop();
      await store.seed();
    };

    describe("commit version invariants", () => {
      test.prop([fc.array(commitArb, { minLength: 0, maxLength: 30 })], {
        numRuns,
      })(
        "per-stream versions are 0..N-1 in commit order, regardless of interleaving",
        async (commits) => {
          await reset();
          const expected = new Map<string, number>();
          for (const { stream, count } of commits) {
            const before = expected.get(stream) ?? -1;
            const committed = await store.commit<CounterEvents>(
              stream,
              events(count),
              make_meta({ stream })
            );
            committed.forEach((e, i) => {
              expect(e.version).toBe(before + 1 + i);
            });
            expected.set(stream, before + count);
          }
          for (const stream of new Set(commits.map((c) => c.stream))) {
            const seen = await collect(store, { stream, stream_exact: true });
            seen.forEach((e, i) => {
              expect(e.version).toBe(i);
            });
          }
        }
      );

      test.prop([fc.array(commitArb, { minLength: 1, maxLength: 20 })], {
        numRuns,
      })(
        "bad expectedVersion throws and commits no events",
        async (commits) => {
          await reset();
          for (const { stream, count } of commits) {
            await store.commit<CounterEvents>(
              stream,
              events(count),
              make_meta({ stream })
            );
          }
          const stream = commits[0].stream;
          const before = await collect(store, { stream, stream_exact: true });
          // Actual head is before.length - 1, so before.length is wrong.
          await expect(
            store.commit<CounterEvents>(
              stream,
              [inc(1)],
              make_meta({ stream }),
              before.length
            )
          ).rejects.toThrow();
          const after = await collect(store, { stream, stream_exact: true });
          expect(after.length).toBe(before.length);
        }
      );
    });

    describe("claim/lease lifecycle invariants", () => {
      test.prop([fc.array(opArb, { minLength: 1, maxLength: 30 })], {
        numRuns,
      })(
        "no leaks: claims are always acked or blocked, never lost",
        async (ops) => {
          await reset();
          await store.subscribe([
            { stream: "a" },
            { stream: "b" },
            { stream: "c" },
          ]);
          let totalClaims = 0;
          let totalResolved = 0;
          let pending: Awaited<ReturnType<Store["claim"]>> = [];
          for (const op of ops) {
            if (op.kind === "commit") {
              await store.commit<CounterEvents>(
                op.stream,
                [inc(1)],
                make_meta({ stream: op.stream })
              );
            } else if (op.kind === "claim") {
              const claimed = await store.claim(5, 5, "worker", 60_000);
              totalClaims += claimed.length;
              pending = [...pending, ...claimed];
            } else if (op.kind === "ack-all") {
              const acked = await store.ack(pending);
              totalResolved += acked.length;
              pending = pending.filter(
                (p) => !acked.find((a) => a.stream === p.stream)
              );
            } else {
              const blocked = await store.block(
                pending.map((p) => ({ ...p, error: "test" }))
              );
              totalResolved += blocked.length;
              pending = pending.filter(
                (p) => !blocked.find((b) => b.stream === p.stream)
              );
            }
          }
          expect(totalResolved + pending.length).toBe(totalClaims);
        }
      );

      test.prop(
        [
          fc.array(claimStreamArb, { minLength: 1, maxLength: 5 }),
          fc.array(claimStreamArb, { minLength: 0, maxLength: 5 }),
        ],
        { numRuns }
      )(
        "ack advances the watermark monotonically per stream",
        async (commitsA, commitsB) => {
          await reset();
          const all = [...new Set([...commitsA, ...commitsB, "a", "b", "c"])];
          await store.subscribe(all.map((stream) => ({ stream })));
          for (const stream of commitsA) {
            await store.commit<CounterEvents>(
              stream,
              [inc(1)],
              make_meta({ stream })
            );
          }
          const acked1 = await store.ack(
            await store.claim(10, 10, "worker", 60_000)
          );
          // Seed every subscribed stream at -1 so the comparison below is
          // unconditional — streams not acked in batch 1 just compare
          // against -1, keeping the property branch-free for coverage.
          const watermark1 = new Map(all.map((stream) => [stream, -1]));
          for (const l of acked1) watermark1.set(l.stream, l.at);
          for (const stream of commitsB) {
            await store.commit<CounterEvents>(
              stream,
              [inc(1)],
              make_meta({ stream })
            );
          }
          const acked2 = await store.ack(
            await store.claim(10, 10, "worker", 60_000)
          );
          for (const lease of acked2) {
            expect(lease.at).toBeGreaterThanOrEqual(
              watermark1.get(lease.stream) as number
            );
          }
        }
      );

      test.prop([fc.array(claimStreamArb, { minLength: 1, maxLength: 5 })], {
        numRuns,
      })("blocked streams cannot be claimed again", async (commits) => {
        await reset();
        const streams = [...new Set(commits)];
        await store.subscribe(streams.map((stream) => ({ stream })));
        for (const stream of commits) {
          await store.commit<CounterEvents>(
            stream,
            [inc(1)],
            make_meta({ stream })
          );
        }
        const claimed = await store.claim(10, 10, "worker", 60_000);
        await store.block(claimed.map((l) => ({ ...l, error: "test" })));
        const blockedSet = new Set(claimed.map((l) => l.stream));
        // A control stream committed *after* the first claim is guaranteed
        // claimable, so the re-claim is non-empty and the exclusion check
        // below actually runs — while still proving no blocked stream
        // reappears.
        await store.subscribe([{ stream: "ctrl" }]);
        await store.commit<CounterEvents>(
          "ctrl",
          [inc(1)],
          make_meta({ stream: "ctrl" })
        );
        const reclaim = await store.claim(10, 10, "worker2", 60_000);
        for (const l of reclaim) expect(blockedSet.has(l.stream)).toBe(false);
      });
    });
  });
};
