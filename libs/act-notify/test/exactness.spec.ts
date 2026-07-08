import { act, dispose, InMemoryStore, state } from "@rotorsoft/act";
import { sandbox } from "@rotorsoft/act/test";
import { z } from "zod";
import type { Broker, BrokerMessage } from "../src/index.js";
import { withBroker } from "../src/index.js";

/**
 * The exactness property from the audit: the broker is a hint, never
 * truth. A broker that drops, duplicates, and reorders every message
 * must not change what correlate→drain processes — the wrapped store
 * delivers exactly what the bare store delivers.
 */
describe("correlate→drain exactness under broker chaos", () => {
  const Counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ Incremented: z.object({ by: z.number() }) })
    .patch({ Incremented: (e, s) => ({ count: s.count + e.data.by }) })
    .on({ increment: z.object({ by: z.number() }) })
    .emit((a) => ["Incremented", a])
    .build();

  const actor = { id: "a", name: "a" };

  /** Deterministically hostile: drops every 2nd, duplicates every 3rd,
   * delays every 5th message it doesn't drop. */
  class ChaosBroker implements Broker {
    private readonly _subs = new Set<(m: BrokerMessage) => void>();
    private _n = 0;

    publish(message: BrokerMessage): void {
      this._n++;
      if (this._n % 2 === 0) return; // dropped
      const deliver = () => {
        for (const s of this._subs) s(message);
      };
      if (this._n % 3 === 0) deliver(); // duplicated
      if (this._n % 5 === 0)
        setTimeout(deliver, 5); // reordered
      else deliver();
    }

    subscribe(handler: (m: BrokerMessage) => void) {
      this._subs.add(handler);
      return () => {
        this._subs.delete(handler);
      };
    }
  }

  async function run(
    store_factory: () => InMemoryStore | ReturnType<typeof withBroker>
  ) {
    const handled: string[] = [];
    const builder = act()
      .withState(Counter)
      .on("Incremented")
      .do(async function reactor(event) {
        handled.push(`${event.stream}@${event.version}`);
      })
      .to((e) => ({ target: `r:${e.stream}`, source: e.stream }));
    const ctx = await sandbox(builder, { store: store_factory });
    try {
      const app = ctx.app as unknown as {
        do: (a: string, t: object, p: object) => Promise<unknown>;
        correlate: () => Promise<unknown>;
        drain: (o?: object) => Promise<{ acked: unknown[] }>;
      };
      for (let i = 0; i < 30; i++)
        await app.do(
          "increment",
          { stream: `c-${i % 5}`, actor },
          { by: i + 1 }
        );
      await app.correlate();
      for (;;) {
        const d = await app.drain({ leaseMillis: 10_000, eventLimit: 1_000 });
        if (d.acked.length === 0) break;
      }
      return handled.sort();
    } finally {
      await ctx.dispose();
    }
  }

  it("processes exactly what the bare store processes", async () => {
    const bare = await run(() => new InMemoryStore());
    await dispose()();
    const chaotic = await run(() =>
      withBroker(new InMemoryStore(), new ChaosBroker())
    );
    expect(chaotic).toEqual(bare);
    expect(chaotic).toHaveLength(30);
  });
});
