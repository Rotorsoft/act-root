/**
 * #1468 — `shutdown()` waits for an in-flight settle cycle, not just
 * in-flight drain cycles.
 *
 * `SettleLoop.stop()` cancels *scheduling*: it clears the debounce timer and
 * the pending re-arm. A cycle already inside its correlate → drain loop keeps
 * running, so before this fix a settle parked in `correlate` resumed after
 * teardown resolved and took a fresh lease on a stream — and under
 * `disposeAndExit`, issued it against a disposed store.
 */
import { act, dispose, InMemoryStore, state, store } from "@rotorsoft/act";
import type { Store } from "@rotorsoft/act/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const ZodEmpty = z.object({});

const Ticker = state({ Ticker: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Ticked: ZodEmpty })
  .patch({ Ticked: (_, s) => ({ count: s.count + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Ticked", {}])
  .build();

const actor = { id: "a", name: "a" };

const until = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise<void>((r) => setTimeout(r, 5));
};

/** A store that can park one method and record what runs after teardown. */
const harness = (park_on: string) => {
  const raw = new InMemoryStore();
  const after_shutdown: string[] = [];
  const flags = { shut: false, parking: false, entered: false };
  let release!: () => void;
  const parked = new Promise<void>((r) => {
    release = r;
  });
  const wrapped = new Proxy(raw, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        const name = String(p);
        if (flags.shut) after_shutdown.push(name);
        if (flags.parking && name === park_on && !flags.entered) {
          flags.entered = true;
          await parked;
        }
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  }) as unknown as Store;
  return { wrapped, after_shutdown, flags, release: () => release() };
};

/** A dynamic resolver is what makes correlate actually scan the log. */
const build = () =>
  act()
    .withState(Ticker)
    .on("Ticked")
    .do(async function noop() {})
    .to((e) => ({ target: `dyn-${e.stream}` }))
    .build();

afterEach(async () => {
  await dispose()("EXIT").catch(() => {});
});

describe("shutdown waits for an in-flight settle cycle (#1468)", () => {
  it("issues no store operations after teardown resolves", async () => {
    const h = harness("query");
    store(h.wrapped);
    const app = build();
    await app.do("tick", { stream: "src", actor }, {});

    h.flags.parking = true;
    app.settle({ debounceMs: 0 });
    await until(() => h.flags.entered);

    const shutting = app.shutdown({ graceMs: 5_000 }).then(() => {
      // Anything the settle does from here on is post-teardown.
      h.flags.shut = true;
    });
    // Teardown must still be waiting: the settle is parked mid-correlate.
    await new Promise<void>((r) => setTimeout(r, 50));
    h.release();
    await shutting;

    // Give any escaped continuation a chance to run before asserting.
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(h.after_shutdown).toEqual([]);
  });

  it("does not return while a settle is parked mid-correlate", async () => {
    const h = harness("query");
    store(h.wrapped);
    const app = build();
    await app.do("tick", { stream: "src", actor }, {});

    h.flags.parking = true;
    app.settle({ debounceMs: 0 });
    await until(() => h.flags.entered);

    let settled = false;
    const shutting = app.shutdown({ graceMs: 5_000 }).then(() => {
      settled = true;
    });
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    h.release();
    await shutting;
    expect(settled).toBe(true);
  });

  it("proceeds when the grace budget expires on a stuck settle", async () => {
    const h = harness("query");
    store(h.wrapped);
    const app = build();
    await app.do("tick", { stream: "src", actor }, {});

    h.flags.parking = true;
    app.settle({ debounceMs: 0 });
    await until(() => h.flags.entered);

    // Never released — one stuck cycle must not hang the deploy.
    const started = Date.now();
    await app.shutdown({ graceMs: 40 });
    expect(Date.now() - started).toBeLessThan(2_000);

    h.release();
  });

  it("graceMs: 0 keeps the pre-#1442 immediate return", async () => {
    const h = harness("query");
    store(h.wrapped);
    const app = build();
    await app.do("tick", { stream: "src", actor }, {});

    h.flags.parking = true;
    app.settle({ debounceMs: 0 });
    await until(() => h.flags.entered);

    const started = Date.now();
    await app.shutdown({ graceMs: 0 });
    expect(Date.now() - started).toBeLessThan(50);

    h.release();
  });

  it("returns promptly when nothing is settling", async () => {
    store(new InMemoryStore());
    const app = build();
    const started = Date.now();
    await app.shutdown();
    expect(Date.now() - started).toBeLessThan(50);
  });
});
