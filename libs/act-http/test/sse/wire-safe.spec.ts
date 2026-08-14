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
  nested?: { keep?: string; drop?: string };
  tags?: string[];
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
