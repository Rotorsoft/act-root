import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  act,
  type CloseResult,
  dispose,
  state,
  ZodEmpty,
} from "../src/index.js";
import { CloseSignal } from "../src/internal/close-signal.js";

/**
 * Part 1 of #1090's autoclose port: the close mechanic. A reaction handler
 * throws {@link CloseSignal}; `build_handle` acks the triggering event (so the
 * requesting reaction isn't seen as an in-flight consumer by the close-cycle
 * guard) and yields a `HandleResult.close`; `run_drain_cycle` collects it; the
 * `DrainController` hands it to the orchestrator's `on_close`, which runs
 * `run_close_cycle` and emits `"closed"`.
 */
describe("close outcome (integration)", () => {
  const counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ ticked: ZodEmpty })
    .patch({ ticked: () => ({}) })
    .on({ tick: ZodEmpty })
    .emit(() => ["ticked", {}])
    .build();

  const actor = { id: "a", name: "a" };

  afterEach(async () => {
    await dispose()();
  });

  it("a reaction throwing CloseSignal retires its stream and emits closed", async () => {
    const closed: CloseResult[] = [];
    const closing = async () => {
      throw new CloseSignal();
    };

    const app = act().withState(counter).on("ticked").do(closing).build();
    app.on("closed", (r) => closed.push(r));

    await app.do("tick", { stream: "c1", actor }, {});
    await app.correlate();
    await app.drain();

    expect(closed).toHaveLength(1);
    expect(closed[0].truncated.has("c1")).toBe(true);

    // The stream is tombstoned: a fresh query sees only the tombstone seed.
    const events = await app.query_array({ stream: "c1", stream_exact: true });
    expect(events.every((e) => (e.name as string) === "__tombstone__")).toBe(
      true
    );
  });

  it("runs the archiver carried by the signal before truncating", async () => {
    const archived: string[] = [];
    const closing = async (_e: unknown, stream: string) => {
      throw new CloseSignal({
        archive: async () => {
          archived.push(stream);
        },
      });
    };

    const app = act().withState(counter).on("ticked").do(closing).build();

    await app.do("tick", { stream: "c2", actor }, {});
    await app.correlate();
    await app.drain();

    expect(archived).toEqual(["c2"]);
  });
});
