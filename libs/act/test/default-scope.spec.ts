/**
 * An Act's ports are its own, scoped or not (#1597).
 *
 * A scoped Act resolves `store()`/`cache()` from an ambient frame. An Act
 * built without `ActOptions.scoped` used to run in whatever frame it was
 * called from, so dispatching into a shared Act from inside a tenant's
 * handler wrote the shared Act's events into the tenant's store. Every Act
 * now enters its own frame; the one without a bag carries the singleton
 * adapters.
 */
import {
  act,
  dispose,
  InMemoryCache,
  InMemoryStore,
  state,
  store,
} from "@rotorsoft/act";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const ZodEmpty = z.object({});

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Bumped: ZodEmpty })
  .patch({ Bumped: (_, s) => ({ n: s.n + 1 }) })
  .on({ bump: ZodEmpty })
  .emit(() => ["Bumped", {}])
  .build();

const Logged = state({ Logged: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Logged: ZodEmpty })
  .patch({ Logged: (_, s) => ({ n: s.n + 1 }) })
  .on({ log: ZodEmpty })
  .emit(() => ["Logged", {}])
  .build();

const actor = { id: "t", name: "t" };
const names = async (s: InMemoryStore) => {
  const out: string[] = [];
  await s.query((e) => out.push(String(e.name)), {});
  return out;
};

afterEach(async () => {
  await dispose()().catch(() => {});
});

describe("an Act's ports are its own (#1597)", () => {
  it("a shared Act called from inside a tenant's handler writes to the shared store", async () => {
    const global_store = new InMemoryStore();
    store(global_store);
    const shared = act().withState(Logged).build();

    const tenant_store = new InMemoryStore();
    const tenant = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function forward() {
        // dispatched from inside the tenant's frame
        await shared.do("log", { stream: "audit", actor }, {});
      })
      .to(() => ({ target: "t" }))
      .build({ scoped: { store: tenant_store, cache: new InMemoryCache() } });

    await tenant.do("bump", { stream: "c1", actor }, {});
    await tenant.correlate();
    await tenant.drain();

    expect(await names(global_store)).toEqual(["Logged"]);
    expect(await names(tenant_store)).toEqual(["Bumped"]);
  });

  it("a tenant Act called from inside a shared handler writes to the tenant store", async () => {
    const global_store = new InMemoryStore();
    store(global_store);
    const tenant_store = new InMemoryStore();
    const tenant = act()
      .withState(Logged)
      .build({ scoped: { store: tenant_store, cache: new InMemoryCache() } });

    const shared = act()
      .withState(Counter)
      .on("Bumped")
      .do(async function forward() {
        await tenant.do("log", { stream: "audit", actor }, {});
      })
      .to(() => ({ target: "t" }))
      .build();

    await shared.do("bump", { stream: "c1", actor }, {});
    await shared.correlate();
    await shared.drain();

    expect(await names(global_store)).toEqual(["Bumped"]);
    expect(await names(tenant_store)).toEqual(["Logged"]);
  });

  it("leaves a call made outside any Act on the singleton adapters", () => {
    // Every Act runs in a frame now, but application setup calling `store()`
    // before building anything is outside all of them, and must still see the
    // process-wide adapter it just injected.
    const injected = new InMemoryStore();
    store(injected);
    expect(store()).toBe(injected);
  });

  it("uses the singleton adapter injected before the Act was built", async () => {
    // The documented order: inject, then build. `notify` is wired at
    // construction, so an adapter injected afterwards is ignored — that is a
    // standing contract, not something the ports frame changes.
    const early = new InMemoryStore();
    store(early);
    const app = act().withState(Counter).build();
    await app.do("bump", { stream: "c1", actor }, {});
    expect(await names(early)).toEqual(["Bumped"]);
  });
});
