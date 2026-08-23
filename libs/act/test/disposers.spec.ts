/**
 * #1441 — the dispose registry was push-only, so every Act ever built stayed
 * reachable for the process lifetime through the closure it registered.
 *
 * Real garbage collection is not schedulable, so the mechanism is pinned with
 * a stub `RefLike` that reports its target as collected on demand. The
 * end-to-end collection check lives at the bottom and runs only when the
 * process was started with `--expose-gc`.
 */
import { act, state } from "@rotorsoft/act";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type RefLike,
  register_disposer,
  register_weak_disposer,
  run_disposers,
} from "../src/disposers.js";

/** A `WeakRef` whose target can be released on command. */
const fake_ref = <T extends object>(target: T) => {
  let held: T | undefined = target;
  return {
    ref: { deref: () => held } satisfies RefLike<T>,
    collect: () => {
      held = undefined;
    },
  };
};

describe("dispose registry", () => {
  it("runs a plain disposer in reverse registration order", async () => {
    const order: string[] = [];
    register_disposer(async () => void order.push("first"));
    register_disposer(async () => void order.push("second"));
    await run_disposers();
    expect(order).toEqual(["second", "first"]);
  });

  it("runs a weak disposer while its target is reachable, handing it back", async () => {
    const target = { name: "act" };
    const { ref } = fake_ref(target);
    const run = vi.fn(async () => {});
    register_weak_disposer(ref, run);
    await run_disposers();
    expect(run).toHaveBeenCalledWith(target);
  });

  it("skips a weak disposer whose target is gone", async () => {
    const { ref, collect } = fake_ref({ name: "act" });
    const run = vi.fn(async () => {});
    register_weak_disposer(ref, run);
    collect();
    await run_disposers();
    expect(run).not.toHaveBeenCalled();
  });

  it("re-runs registrations on a second teardown, as before", async () => {
    const run = vi.fn(async () => {});
    register_disposer(run);
    await run_disposers();
    await run_disposers();
    expect(run).toHaveBeenCalledTimes(2);
  });

  // The registry is module-level, so without pruning it grows for the whole
  // process — the secondary half of #1441, which made teardown O(all Acts
  // ever built).
  it("prunes dead weak entries when anything else registers", async () => {
    const live = vi.fn(async () => {});
    const dead = vi.fn(async () => {});
    const kept = fake_ref({ name: "kept" });
    const gone = fake_ref({ name: "gone" });
    register_weak_disposer(kept.ref, live);
    register_weak_disposer(gone.ref, dead);
    gone.collect();

    // The registration itself is what compacts the array.
    const after = vi.fn(async () => {});
    register_disposer(after);

    await run_disposers();
    expect(live).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    expect(dead).not.toHaveBeenCalled();
  });
});

describe("Act registers itself weakly", () => {
  const build = () => {
    const Counter = state({ Counter: z.object({ n: z.number() }) })
      .init(() => ({ n: 0 }))
      .emits({ Bumped: z.object({}) })
      .patch({ Bumped: (_, s) => ({ n: s.n + 1 }) })
      .on({ bump: z.object({}) })
      .emit(() => ["Bumped", {}])
      .build();
    return act().withState(Counter).build();
  };

  it("does not keep a shut-down Act reachable through the registry", async () => {
    const app = build();
    const spy = vi.spyOn(app, "shutdown");
    // While the caller still holds it, process-wide teardown still reaches it.
    await run_disposers();
    expect(spy).toHaveBeenCalled();
  });

  it.runIf(typeof globalThis.gc === "function")(
    "releases an Act once nothing else references it (needs --expose-gc)",
    async () => {
      const refs: WeakRef<object>[] = [];
      // Build inside a helper, not in the test body: a `const` in the test's
      // own frame stays reachable from that frame until the test returns, and
      // would report the last Act as retained no matter what the registry
      // does. Before the fix this reports 5 of 5 retained.
      const build_and_shutdown = async () => {
        const app = build();
        refs.push(new WeakRef(app));
        await app.shutdown();
      };
      for (let i = 0; i < 5; i++) await build_and_shutdown();
      for (let i = 0; i < 8; i++) {
        globalThis.gc?.();
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(refs.filter((r) => r.deref()).length).toBe(0);
    }
  );
});
