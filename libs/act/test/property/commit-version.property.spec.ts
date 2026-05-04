import { fc, test } from "@fast-check/vitest";
import { InMemoryStore } from "../../src/adapters/in-memory-store.js";
import type { Committed, Schemas } from "../../src/types/index.js";

/**
 * Properties for commit version semantics:
 *
 *   1. Per-stream `version` is strictly monotonic and starts at 0.
 *   2. The version of the last committed event on a stream equals
 *      `(commits to that stream) - 1`.
 *   3. Interleaving commits across streams does not affect any stream's
 *      version sequence.
 *   4. `expectedVersion` enforcement throws when the actual version
 *      diverges; the rejected commit produces no events.
 */

const streamArb = fc.constantFrom("s1", "s2", "s3");
const eventNameArb = fc.constantFrom("E", "F", "G");
const commitArb = fc.record({
  stream: streamArb,
  events: fc.array(fc.record({ name: eventNameArb, data: fc.object() }), {
    minLength: 1,
    maxLength: 3,
  }),
});

async function readEvents(store: InMemoryStore, stream: string) {
  const out: Committed<Schemas, keyof Schemas>[] = [];
  await store.query((e) => out.push(e), { stream, stream_exact: true });
  return out;
}

describe("property: commit version invariants", () => {
  test.prop([fc.array(commitArb, { minLength: 0, maxLength: 30 })], {
    numRuns: 100,
  })(
    "per-stream versions are 0..N-1 in commit order, regardless of interleaving",
    async (commits) => {
      const store = new InMemoryStore();
      const expected = new Map<string, number>(); // stream → next expected version

      for (const { stream, events } of commits) {
        const before = expected.get(stream) ?? -1;
        const committed = await store.commit(stream, events, {
          correlation: "c",
          causation: {},
        });
        // Each emitted event's version equals before + 1 + index.
        committed.forEach((e, i) => {
          expect(e.version).toBe(before + 1 + i);
        });
        expected.set(stream, before + events.length);
      }

      // Independent observation: re-read each stream and confirm the
      // versions are 0, 1, 2, ... contiguous.
      for (const stream of new Set(commits.map((c) => c.stream))) {
        const events = await readEvents(store, stream);
        events.forEach((e, i) => expect(e.version).toBe(i));
      }
    }
  );

  test.prop([fc.array(commitArb, { minLength: 1, maxLength: 20 })], {
    numRuns: 100,
  })(
    "expectedVersion enforcement: bad expectedVersion throws and commits no events",
    async (commits) => {
      const store = new InMemoryStore();
      // Apply commits without expectedVersion to seed the store.
      for (const { stream, events } of commits) {
        await store.commit(stream, events, {
          correlation: "c",
          causation: {},
        });
      }
      // Pick the first stream that exists.
      const stream = commits[0].stream;
      const before = await readEvents(store, stream);
      const wrongExpected = before.length; // off by one — actual is before.length - 1
      await expect(
        store.commit(
          stream,
          [{ name: "E", data: {} }],
          { correlation: "c", causation: {} },
          wrongExpected
        )
      ).rejects.toThrow();
      // No event was added.
      const after = await readEvents(store, stream);
      expect(after.length).toBe(before.length);
    }
  );
});
