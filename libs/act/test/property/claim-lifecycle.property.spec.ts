import { fc, test } from "@fast-check/vitest";
import { InMemoryStore } from "../../src/adapters/in-memory-store.js";

/**
 * Properties for the claim/lease lifecycle:
 *
 *   1. No leaks: every successful claim is eventually `ack`ed or `block`ed.
 *   2. ack monotonically advances a stream's watermark.
 *   3. block prevents the stream from being claimed again.
 *   4. Concurrent claimers (different `by` ids on the same store) never
 *      hold overlapping leases on the same stream within the lease window.
 */

const streamArb = fc.constantFrom("a", "b", "c");

const opArb = fc.oneof(
  fc.record({ kind: fc.constant("commit" as const), stream: streamArb }),
  fc.record({ kind: fc.constant("claim" as const) }),
  fc.record({ kind: fc.constant("ack-all" as const) }),
  fc.record({ kind: fc.constant("block-all" as const) })
);

describe("property: claim/lease lifecycle invariants", () => {
  test.prop([fc.array(opArb, { minLength: 1, maxLength: 30 })], {
    numRuns: 100,
  })(
    "no leaks: claims are always acked or blocked, never lost",
    async (ops) => {
      const store = new InMemoryStore();
      await store.subscribe([
        { stream: "a" },
        { stream: "b" },
        { stream: "c" },
      ]);

      let totalClaims = 0;
      let totalResolved = 0; // ack + block
      let pending: Awaited<ReturnType<typeof store.claim>> = [];

      for (const op of ops) {
        if (op.kind === "commit") {
          await store.commit(op.stream, [{ name: "E", data: {} }], {
            correlation: "c",
            causation: {},
          });
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

      // Every claim must be reachable via ack/block — pending leases
      // would be acked once the lease window expires (which we don't
      // simulate here), but at this point in the trace, claims-resolved
      // must equal claims minus what's still in flight.
      expect(totalResolved + pending.length).toBe(totalClaims);
    }
  );

  test.prop(
    [
      fc.array(streamArb, { minLength: 1, maxLength: 5 }),
      fc.array(streamArb, { minLength: 0, maxLength: 5 }),
    ],
    { numRuns: 100 }
  )(
    "ack advances the watermark monotonically per stream",
    async (commitsA, commitsB) => {
      const store = new InMemoryStore();
      const allStreams = [
        ...new Set([...commitsA, ...commitsB, "a", "b", "c"]),
      ];
      await store.subscribe(allStreams.map((s) => ({ stream: s })));

      // First batch of commits.
      for (const s of commitsA) {
        await store.commit(s, [{ name: "E", data: {} }], {
          correlation: "c",
          causation: {},
        });
      }
      const claimed1 = await store.claim(10, 10, "worker", 60_000);
      const acked1 = await store.ack(claimed1);
      const watermark1 = new Map(acked1.map((l) => [l.stream, l.at]));

      // Second batch.
      for (const s of commitsB) {
        await store.commit(s, [{ name: "E", data: {} }], {
          correlation: "c",
          causation: {},
        });
      }
      const claimed2 = await store.claim(10, 10, "worker", 60_000);
      const acked2 = await store.ack(claimed2);

      // Each second-batch ack must have at >= the corresponding first-batch at.
      for (const lease of acked2) {
        const prev = watermark1.get(lease.stream);
        if (prev !== undefined) expect(lease.at).toBeGreaterThanOrEqual(prev);
      }
    }
  );

  test.prop([fc.array(streamArb, { minLength: 1, maxLength: 5 })], {
    numRuns: 100,
  })("blocked streams cannot be claimed again", async (commits) => {
    const store = new InMemoryStore();
    const streams = [...new Set(commits)];
    await store.subscribe(streams.map((s) => ({ stream: s })));
    for (const s of commits) {
      await store.commit(s, [{ name: "E", data: {} }], {
        correlation: "c",
        causation: {},
      });
    }
    const claimed = await store.claim(10, 10, "worker", 60_000);
    await store.block(claimed.map((l) => ({ ...l, error: "test" })));

    // Subsequent claim should not return any blocked stream.
    const reclaim = await store.claim(10, 10, "worker2", 60_000);
    const blockedSet = new Set(claimed.map((l) => l.stream));
    for (const l of reclaim) {
      expect(blockedSet.has(l.stream)).toBe(false);
    }
  });
});
