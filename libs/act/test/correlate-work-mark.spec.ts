/**
 * #1487 — correlate is the universal producer of the work mark.
 *
 * It walks both resolver kinds now (statics used to be subscribed at init and
 * never looked at again), and every target an event resolves to is subscribed
 * with `correlated_at` = that event's id. `claim` reads eligibility off that
 * mark, so a target correlate never marks is a target that never drains.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { act, state, ZodEmpty } from "../src/index.js";
import { sandbox } from "../src/test/index.js";
import type { Store, StreamPosition } from "../src/types/index.js";

const Ticker = state({ Ticker: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Ticked: ZodEmpty, Ended: ZodEmpty })
  .patch({
    Ticked: (_, s) => ({ n: s.n + 1 }),
    Ended: (_, s) => ({ n: s.n }),
  })
  .on({ tick: ZodEmpty })
  .emit(() => ["Ticked", {}])
  .on({ end: ZodEmpty })
  .emit(() => ["Ended", {}])
  .build();

const actor = { id: "a", name: "a" };

/** Subscription rows by target — `correlated_at` included since #1487. */
const positions = async (store: Store) => {
  const rows = new Map<string, StreamPosition>();
  await store.query_streams((p) => rows.set(p.stream, p));
  return rows;
};

const disposers: Array<() => Promise<void>> = [];
const open = async <T>(builder: { build: (o?: any) => T }) => {
  const ctx = await sandbox(builder);
  disposers.push(ctx.dispose);
  return ctx;
};

afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
});

describe("static targets are marked", () => {
  const builder = () =>
    act()
      .withState(Ticker)
      .on("Ticked")
      .do(async function noop() {})
      .to({ target: "out" });

  it("marks the target with the id of the event that resolved to it", async () => {
    const { app, store } = await open(builder());

    await app.do("tick", { stream: "s1", actor }, {});
    const scan = await app.correlate();

    expect((await positions(store)).get("out")?.correlated_at).toBe(
      scan.last_id
    );
  });

  it("raises the mark as later events arrive", async () => {
    const { app, store } = await open(builder());

    await app.do("tick", { stream: "s1", actor }, {});
    await app.correlate();
    const first = (await positions(store)).get("out")?.correlated_at;

    await app.do("tick", { stream: "s1", actor }, {});
    const second = await app.correlate();

    expect((await positions(store)).get("out")?.correlated_at).toBe(
      second.last_id
    );
    expect(second.last_id).toBeGreaterThan(first as number);
  });
});

describe("a mark is only claimed for events the target would fetch", () => {
  it("skips an event outside a pattern source, and marks one inside it", async () => {
    const { app, store } = await open(
      act()
        .withState(Ticker)
        .on("Ticked")
        .do(async function noop() {})
        .to({ target: "out", source: "^(a|b)$" })
    );

    // Two events from a stream the source excludes — the second also proves
    // the compiled pattern is reused rather than recompiled per event.
    await app.do("tick", { stream: "c", actor }, {});
    await app.do("tick", { stream: "c", actor }, {});
    await app.correlate();
    expect((await positions(store)).get("out")?.correlated_at).toBeUndefined();

    await app.do("tick", { stream: "b", actor }, {});
    const scan = await app.correlate();
    expect((await positions(store)).get("out")?.correlated_at).toBe(
      scan.last_id
    );
  });

  it("marks nothing for an event its resolver declines", async () => {
    const { app, store } = await open(
      act()
        .withState(Ticker)
        .on("Ticked")
        .do(async function noop() {})
        // A resolver that routes only some events — the declined ones resolve
        // to no target, so they raise no mark anywhere.
        .to((e) => (e.stream === "keep" ? { target: "out" } : undefined))
    );

    await app.do("tick", { stream: "drop", actor }, {});
    await app.correlate();
    expect((await positions(store)).size).toBe(0);

    await app.do("tick", { stream: "keep", actor }, {});
    const scan = await app.correlate();
    expect((await positions(store)).get("out")?.correlated_at).toBe(
      scan.last_id
    );
  });

  it("skips an event outside a literal source", async () => {
    const { app, store } = await open(
      act()
        .withState(Ticker)
        .on("Ticked")
        .do(async function noop() {})
        .to({ target: "out", source: "a" })
    );

    await app.do("tick", { stream: "c", actor }, {});
    await app.correlate();

    expect((await positions(store)).get("out")?.correlated_at).toBeUndefined();
  });
});

describe("a mark rides an upsert that changes nothing else", () => {
  const tiered = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: z.object({ premium: z.boolean() }) })
    .patch({ ticked: (_e, s) => ({ count: s.count + 1 }) })
    .on({ tick: z.object({ premium: z.boolean() }) })
    .emit((a) => ["ticked", { premium: a.premium }])
    .build();

  it("a later lower-priority scan neither lowers the priority nor re-lanes", async () => {
    const { app, store } = await open(
      act()
        .withState(tiered)
        .withLane({ name: "fast" })
        .withLane({ name: "slow" })
        .on("ticked")
        .do(async function react() {})
        .to((e) => ({
          target: "shared",
          source: e.stream,
          priority: (e.data as { premium: boolean }).premium ? 5 : 0,
          lane: (e.data as { premium: boolean }).premium ? "slow" : "fast",
        }))
    );

    await app.do("tick", { stream: "prem", actor }, { premium: true });
    await app.correlate();
    expect(await positions(store).then((p) => p.get("shared"))).toMatchObject({
      priority: 5,
      lane: "slow",
    });

    // The free-tier scan does not beat the recorded floor, so it re-sends the
    // row's own priority and lane — `subscribe` writes lane unconditionally,
    // and the mark has to travel on that same upsert.
    await app.do("tick", { stream: "free", actor }, { premium: false });
    const scan = await app.correlate();
    expect(await positions(store).then((p) => p.get("shared"))).toMatchObject({
      priority: 5,
      lane: "slow",
      correlated_at: scan.last_id,
    });
  });

  it("a dynamic resolution never re-opens a static target's priority", async () => {
    const { app, store } = await open(
      act()
        .withState(Ticker)
        .on("Ticked")
        .do(async function statically() {})
        .to({ target: "out", priority: 3 })
        .on("Ticked")
        .do(async function dynamically() {})
        .to(() => ({ target: "out", priority: 9 }))
    );

    await app.do("tick", { stream: "s1", actor }, {});
    const scan = await app.correlate();

    // Build-time priority owns the row; the scan only raises the mark.
    expect(await positions(store).then((p) => p.get("out"))).toMatchObject({
      priority: 3,
      correlated_at: scan.last_id,
    });
  });
});

describe("close sees pending work, not watermark lag", () => {
  it("closes a stream whose head has no reaction to consume it", async () => {
    const { app, store } = await open(
      act()
        .withState(Ticker)
        // Only `Ticked` has a reaction: after `Ended` commits, the target's
        // watermark sits below the head forever, because nothing resolves
        // there. The close guard must read that as "no pending work".
        .on("Ticked")
        .do(async function noop() {})
        .to((e) => ({ target: `out-${e.stream}`, source: e.stream }))
    );

    await app.do("tick", { stream: "s1", actor }, {});
    await app.correlate();
    await app.drain();
    await app.do("end", { stream: "s1", actor }, {});

    const result = await app.close([{ stream: "s1" }]);

    expect(result.skipped).toEqual([]);
    expect(result.truncated.has("s1")).toBe(true);
    // Caught up in the only sense that matters: everything marked for it is
    // consumed, even though the stream's head sits above its watermark.
    const target = (await positions(store)).get("out-s1");
    expect(target?.at).toBe(target?.correlated_at);
  });
});
