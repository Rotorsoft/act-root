/**
 * #1471 — a delete must survive the wire.
 *
 * `@rotorsoft/act-patch` treats `undefined` and `null` as the same delete
 * signal, but `JSON.stringify` drops `undefined`-valued keys and every SSE
 * transport serializes frames as JSON. A reducer clearing a field the
 * idiomatic way produced a frame with no mention of the field, so a live
 * client kept the stale value while stamping the new version — believing
 * itself caught up, and never refetching.
 */
import { describe, expect, it } from "vitest";
import { applyPatchMessage } from "../../src/sse/apply-patch.js";
import { BroadcastChannel } from "../../src/sse/broadcast.js";

type Calc = {
  _v: number;
  result?: number;
  left?: string;
  operator?: string;
  nested?: { keep?: string; drop?: string; tags?: string[] };
  tags?: string[];
  onlineUsers?: string[];
  meta?: Record<string, unknown>;
};

/** Exactly what a transport does to a frame. */
const over_the_wire = <T>(frame: T): T => JSON.parse(JSON.stringify(frame));

/** Apply a frame to a client the way a browser subscriber would. */
const client_after = (frame: unknown, cached: Partial<Calc>) => {
  const res = applyPatchMessage(frame as never, cached as never);
  return res.ok ? (res.state as Partial<Calc>) : cached;
};

describe("broadcast frames are wire-safe", () => {
  it("delivers an undefined-valued delete to a live client", () => {
    const ch = new BroadcastChannel<Calc>();
    const frames: unknown[] = [];
    ch.subscribe("calc", (f) => frames.push(f));

    ch.publish("calc", { _v: 0, left: "7" } as Calc);
    const cached: Partial<Calc> = { _v: 0, left: "7" };

    // The shape a reducer produces when it clears fields.
    ch.publish("calc", { _v: 1, result: 0 } as Calc, [
      { result: 0, left: undefined, operator: undefined } as Partial<Calc>,
    ]);

    const live = client_after(over_the_wire(frames.at(-1)), cached);
    expect(live.left).toBeUndefined();
    expect(live.result).toBe(0);
    expect(live._v).toBe(1);
  });

  it("treats a null-valued delete identically", () => {
    const ch = new BroadcastChannel<Calc>();
    const frames: unknown[] = [];
    ch.subscribe("calc", (f) => frames.push(f));
    ch.publish("calc", { _v: 0, left: "7" } as Calc);
    ch.publish("calc", { _v: 1, result: 0 } as Calc, [
      { result: 0, left: null } as unknown as Partial<Calc>,
    ]);
    const live = client_after(over_the_wire(frames.at(-1)), {
      _v: 0,
      left: "7",
    });
    expect(live.left).toBeUndefined();
  });

  it("clears a nested field without disturbing its siblings", () => {
    const ch = new BroadcastChannel<Calc>();
    const frames: unknown[] = [];
    ch.subscribe("s", (f) => frames.push(f));
    ch.publish("s", { _v: 0, nested: { keep: "a", drop: "b" } } as Calc);
    ch.publish("s", { _v: 1, nested: { keep: "a" } } as Calc, [
      { nested: { drop: undefined } } as unknown as Partial<Calc>,
    ]);

    const live = client_after(over_the_wire(frames.at(-1)), {
      _v: 0,
      nested: { keep: "a", drop: "b" },
    });
    expect(live.nested).toEqual({ keep: "a" });
  });

  it("delivers an undefined-valued delete through overlay() too", () => {
    const ch = new BroadcastChannel<Calc>();
    ch.publish("s", { _v: 5, operator: "+" } as Calc);
    const frames: unknown[] = [];
    ch.subscribe("s", (f) => frames.push(f));

    ch.overlay("s", { operator: undefined } as Partial<Calc>);

    const live = client_after(over_the_wire(frames.at(-1)), {
      _v: 5,
      operator: "+",
    });
    expect(live.operator).toBeUndefined();
  });

  it("leaves ordinary values, arrays and absent keys alone", () => {
    const ch = new BroadcastChannel<Calc>();
    const frames: unknown[] = [];
    ch.subscribe("s", (f) => frames.push(f));
    ch.publish("s", { _v: 0 } as Calc);
    ch.publish("s", { _v: 1, result: 3, tags: ["a", "b"] } as Calc, [
      { result: 3, tags: ["a", "b"] } as Partial<Calc>,
    ]);

    const sent = over_the_wire(frames.at(-1)) as Record<string, unknown>;
    expect(sent["1"]).toEqual({ result: 3, tags: ["a", "b"] });
    const live = client_after(sent, { _v: 0 });
    expect(live).toMatchObject({ result: 3, tags: ["a", "b"] });
  });

  it("does not rewrite the internals of a non-plain object", () => {
    const ch = new BroadcastChannel<Calc & { at?: Date }>();
    const frames: unknown[] = [];
    ch.subscribe("s", (f) => frames.push(f));
    const at = new Date("2020-01-02T03:04:05.000Z");
    ch.publish("s", { _v: 0 } as never);
    ch.publish("s", { _v: 1, at } as never, [{ at } as never]);

    const sent = over_the_wire(frames.at(-1)) as Record<
      string,
      Record<string, unknown>
    >;
    expect(sent["1"].at).toBe("2020-01-02T03:04:05.000Z");
  });

  it("keeps the server-side cached state untouched by normalization", () => {
    const ch = new BroadcastChannel<Calc>();
    ch.publish("s", { _v: 0, left: "7" } as Calc);
    ch.overlay("s", { left: undefined } as Partial<Calc>);
    // `apply_patch` handles `undefined` natively — the reseed a reconnecting
    // client gets must have the key gone, not set to null.
    expect(ch.state("s")).not.toHaveProperty("left");
  });
});

describe("presence sets survive the wire (#1472)", () => {
  it("delivers a Set-valued overlay as an array to a live client", () => {
    const ch = new BroadcastChannel<Calc>();
    ch.publish("g1", { _v: 5, result: 1 } as Calc);
    const frames: unknown[] = [];
    ch.subscribe("g1", (f) => frames.push(f));

    // The shape `PresenceTracker.online()` returns, fed to overlay() the way
    // the real-time guide's presence recipe does.
    ch.overlay("g1", {
      onlineUsers: new Set(["alice", "bob"]),
    } as unknown as Partial<Calc>);

    const live = client_after(over_the_wire(frames.at(-1)), {
      _v: 5,
      result: 1,
    });
    expect(live.onlineUsers).toEqual(["alice", "bob"]);
  });

  it("gives a reconnecting client the same value as a live one", () => {
    const ch = new BroadcastChannel<Calc>();
    ch.publish("g1", { _v: 5, result: 1 } as Calc);
    const frames: unknown[] = [];
    ch.subscribe("g1", (f) => frames.push(f));
    ch.overlay("g1", {
      onlineUsers: new Set(["alice"]),
    } as unknown as Partial<Calc>);

    const live = client_after(over_the_wire(frames.at(-1)), {
      _v: 5,
      result: 1,
    });
    const reseed = over_the_wire(ch.state("g1")) as Partial<Calc>;
    expect(reseed.onlineUsers).toEqual(["alice"]);
    expect(reseed.onlineUsers).toEqual(live.onlineUsers);
  });

  it("normalizes a Set nested inside a patch", () => {
    const ch = new BroadcastChannel<Calc>();
    const frames: unknown[] = [];
    ch.subscribe("s", (f) => frames.push(f));
    ch.publish("s", { _v: 0 } as Calc);
    ch.publish("s", { _v: 1 } as Calc, [
      { nested: { tags: new Set(["x"]) } } as unknown as Partial<Calc>,
    ]);
    const sent = over_the_wire(frames.at(-1)) as Record<
      string,
      Record<string, unknown>
    >;
    expect(sent["1"]).toEqual({ nested: { tags: ["x"] } });
  });

  it("leaves a Map alone — its JSON encoding is ambiguous, not wrong", () => {
    const ch = new BroadcastChannel<Calc>();
    const frames: unknown[] = [];
    ch.subscribe("s", (f) => frames.push(f));
    ch.publish("s", { _v: 0 } as Calc);
    ch.publish("s", { _v: 1 } as Calc, [
      { meta: new Map([["k", "v"]]) } as unknown as Partial<Calc>,
    ]);
    const sent = over_the_wire(frames.at(-1)) as Record<
      string,
      Record<string, unknown>
    >;
    expect(sent["1"]).toEqual({ meta: {} });
  });
});

describe("overlay state survives a commit (#1473)", () => {
  it("gives a reconnecting client what a live one holds after a publish", () => {
    const ch = new BroadcastChannel<Calc>();
    const frames: unknown[] = [];
    ch.publish("g1", { _v: 5, result: 1 } as Calc);
    ch.subscribe("g1", (f) => frames.push(f));

    let live: Partial<Calc> = { _v: 5, result: 1 };
    ch.overlay("g1", { onlineUsers: ["alice"] } as Partial<Calc>);
    live = client_after(over_the_wire(frames.at(-1)), live);

    // A domain commit lands; the host derives state from the store, which
    // knows nothing about presence.
    ch.publish("g1", { _v: 6, result: 2 } as Calc, [
      { result: 2 } as Partial<Calc>,
    ]);
    live = client_after(over_the_wire(frames.at(-1)), live);

    const reseed = over_the_wire(ch.state("g1")) as Partial<Calc>;
    expect(live).toMatchObject({ _v: 6, result: 2, onlineUsers: ["alice"] });
    expect(reseed.onlineUsers).toEqual(live.onlineUsers);
    expect(reseed.result).toBe(2);
  });

  it("lets a later domain state overwrite an overlay key", () => {
    const ch = new BroadcastChannel<Calc>();
    ch.publish("g1", { _v: 1 } as Calc);
    ch.overlay("g1", { result: 99 } as Partial<Calc>);
    ch.publish("g1", { _v: 2, result: 7 } as Calc, [
      { result: 7 } as Partial<Calc>,
    ]);
    expect(ch.state("g1")?.result).toBe(7);
  });

  it("keeps overlay keys across several commits", () => {
    const ch = new BroadcastChannel<Calc>();
    ch.publish("g1", { _v: 1 } as Calc);
    ch.overlay("g1", { onlineUsers: ["alice"] } as Partial<Calc>);
    ch.publish("g1", { _v: 2, result: 1 } as Calc, [{ result: 1 } as never]);
    ch.publish("g1", { _v: 3, result: 2 } as Calc, [{ result: 2 } as never]);
    expect(ch.state("g1")).toMatchObject({
      _v: 3,
      result: 2,
      onlineUsers: ["alice"],
    });
  });

  it("does not resurrect an overlay key the overlay itself cleared", () => {
    const ch = new BroadcastChannel<Calc>();
    ch.publish("g1", { _v: 1 } as Calc);
    ch.overlay("g1", { onlineUsers: ["alice"] } as Partial<Calc>);
    ch.overlay("g1", { onlineUsers: undefined } as Partial<Calc>);
    ch.publish("g1", { _v: 2, result: 1 } as Calc, [{ result: 1 } as never]);
    expect(ch.state("g1")).not.toHaveProperty("onlineUsers");
  });

  it("carries nothing when no overlay ever ran", () => {
    const ch = new BroadcastChannel<Calc>();
    ch.publish("g1", { _v: 1, left: "7" } as Calc);
    // A publisher dropping a domain key must still drop it.
    ch.publish("g1", { _v: 2, result: 1 } as Calc, [{ result: 1 } as never]);
    expect(ch.state("g1")).not.toHaveProperty("left");
  });

  it("keeps the marker off the wire", () => {
    const ch = new BroadcastChannel<Calc>();
    ch.publish("g1", { _v: 1 } as Calc);
    ch.overlay("g1", { onlineUsers: ["alice"] } as Partial<Calc>);
    const reseed = ch.state("g1") as object;
    expect(Object.keys(reseed)).toEqual(["_v", "onlineUsers"]);
    expect(JSON.parse(JSON.stringify(reseed))).toEqual({
      _v: 1,
      onlineUsers: ["alice"],
    });
  });
});
