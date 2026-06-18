/**
 * SSE subscription wiring on the auto-generated tRPC router (#846).
 * Verifies the per-state subscription is grouped under
 * `router.subscribe.<stateName>`, the yield order (cached `state`
 * first, then `patch` per publication), cap enforcement
 * (TOO_MANY_REQUESTS), and clean teardown on abort.
 */
import { act, state, ZodEmpty } from "@rotorsoft/act";
import { fixture } from "@rotorsoft/act/test";
import { initTRPC, TRPCError } from "@trpc/server";
import { describe, expect } from "vitest";
import { z } from "zod";
import { BroadcastChannel } from "../../src/sse/index.js";
import { type TrpcOptions, trpc } from "../../src/trpc/index.js";

const Calculator = state({
  Calculator: z.object({ display: z.string() }),
})
  .init(() => ({ display: "" }))
  .emits({
    KeyPressed: z.object({ key: z.string() }),
    Cleared: ZodEmpty,
  })
  .patch({
    KeyPressed: ({ data }, s) => ({ display: s.display + data.key }),
    Cleared: () => ({ display: "" }),
  })
  .on({ PressKey: z.object({ key: z.string().min(1) }) })
  .emit((a) => ["KeyPressed", { key: a.key }])
  .on({ Clear: ZodEmpty })
  .emit(() => ["Cleared", {}])
  .build();

const Ticket = state({
  Ticket: z.object({ title: z.string() }),
})
  .init(() => ({ title: "" }))
  .emits({ TicketOpened: z.object({ title: z.string() }) })
  .patch({ TicketOpened: ({ data }) => ({ title: data.title }) })
  .on({ OpenTicket: z.object({ title: z.string() }) })
  .emit((a) => ["TicketOpened", { title: a.title }])
  .build();

const builder = act().withState(Calculator).withState(Ticket);
const test = fixture(builder);

type Ctx = { actorId: string };

const default_options = (
  // `any`: tests intentionally use a wide channel shape so the helper composes with empty and typed states alike
  channel: BroadcastChannel<any>,
  sse_overrides: Record<string, number> = {}
): TrpcOptions<Ctx> => ({
  actor: (ctx) => ({ id: (ctx as Ctx).actorId, name: (ctx as Ctx).actorId }),
  stream: () => "calc-1",
  sse: { channel, ...sse_overrides },
});

type SubscriptionFrame =
  | { kind: "state"; data: unknown }
  | { kind: "patch"; data: unknown };

/**
 * Drain the first `n` frames from an async-iterable subscription.
 * Resolves whatever frames arrive before the abort signal fires.
 */
async function take_frames(
  iter: AsyncIterable<SubscriptionFrame>,
  n: number,
  abort?: AbortController
): Promise<SubscriptionFrame[]> {
  const frames: SubscriptionFrame[] = [];
  for await (const frame of iter) {
    frames.push(frame);
    if (frames.length >= n) {
      abort?.abort();
      break;
    }
  }
  return frames;
}

describe("trpc(app, { sse }) — generated subscriptions", () => {
  test("groups one subscription per unique state under router.subscribe", ({
    app,
  }) => {
    const channel = new BroadcastChannel();
    const router = trpc<Ctx>(app as never, default_options(channel));
    const def = (router as { _def: { procedures: Record<string, unknown> } })
      ._def.procedures;
    // Nested routers flatten into `_def.procedures` with dot notation.
    const sub_keys = Object.keys(def)
      .filter((k) => k.startsWith("subscribe."))
      .sort();
    expect(sub_keys).toEqual(["subscribe.Calculator", "subscribe.Ticket"]);
  });

  test("no router.subscribe when sse option is absent", ({ app }) => {
    const router = trpc<Ctx>(app as never, {
      actor: () => ({ id: "u-1", name: "alice" }),
      stream: () => "calc-1",
    });
    const def = (router as { _def: { procedures: Record<string, unknown> } })
      ._def.procedures;
    const sub_keys = Object.keys(def).filter((k) => k.startsWith("subscribe."));
    expect(sub_keys).toEqual([]);
  });

  test("yields cached state first, then patches as they publish", async ({
    app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    channel.publish("calc-1", { _v: 1, display: "1" }, [{ display: "1" }]);

    const router = trpc<Ctx>(app as never, default_options(channel));
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)({ actorId: "u-1" });

    const sub = (
      caller as unknown as {
        subscribe: {
          Calculator: (input: {
            stream: string;
          }) => Promise<AsyncIterable<SubscriptionFrame>>;
        };
      }
    ).subscribe.Calculator({ stream: "calc-1" });
    const iter = await sub;

    setTimeout(() => {
      channel.publish("calc-1", { _v: 2, display: "12" }, [{ display: "12" }]);
    }, 10);

    const abort = new AbortController();
    const frames = await take_frames(iter, 2, abort);
    expect(frames[0]).toMatchObject({ kind: "state" });
    expect(frames[1]).toMatchObject({ kind: "patch" });
  });

  test("skips the cached-state yield when no state has been published", async ({
    app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    const router = trpc<Ctx>(app as never, default_options(channel));
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)({ actorId: "u-1" });

    const iter = await (
      caller as unknown as {
        subscribe: {
          Calculator: (input: {
            stream: string;
          }) => Promise<AsyncIterable<SubscriptionFrame>>;
        };
      }
    ).subscribe.Calculator({ stream: "calc-1" });

    setTimeout(() => {
      channel.publish("calc-1", { _v: 1, display: "1" }, [{ display: "1" }]);
    }, 10);

    const abort = new AbortController();
    const frames = await take_frames(iter, 1, abort);
    expect(frames[0]).toMatchObject({ kind: "patch" });
  });

  test("connection cap throws TOO_MANY_REQUESTS when full", async ({ app }) => {
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    // Seed state so the first subscription's generator body actually
    // runs to its first yield — that's when `acquire()` lands.
    channel.publish("calc-1", { _v: 1, display: "1" }, [{ display: "1" }]);

    const router = trpc<Ctx>(
      app as never,
      default_options(channel, { maxConnections: 1 })
    );
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)({ actorId: "u-1" });

    const sub_proc = (
      caller as unknown as {
        subscribe: {
          Calculator: (input: {
            stream: string;
          }) => Promise<AsyncIterable<SubscriptionFrame>>;
        };
      }
    ).subscribe.Calculator;

    const iter1 = await sub_proc({ stream: "calc-1" });
    const reader1 = iter1[Symbol.asyncIterator]();
    // Draining one frame guarantees `acquire()` has run — the slot
    // is held while the generator awaits the next publish.
    const first = await reader1.next();
    expect(first.value).toMatchObject({ kind: "state" });

    await expect(async () => {
      const iter2 = await sub_proc({ stream: "calc-2" });
      const reader2 = iter2[Symbol.asyncIterator]();
      await reader2.next();
    }).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    await reader1.return?.(undefined);
  });

  test("cap counter releases on abort so a follow-up open succeeds", async ({
    app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    channel.publish("calc-1", { _v: 1, display: "1" }, [{ display: "1" }]);

    const router = trpc<Ctx>(
      app as never,
      default_options(channel, { maxConnections: 1 })
    );
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)({ actorId: "u-1" });

    const sub_proc = (
      caller as unknown as {
        subscribe: {
          Calculator: (input: {
            stream: string;
          }) => Promise<AsyncIterable<SubscriptionFrame>>;
        };
      }
    ).subscribe.Calculator;

    const iter1 = await sub_proc({ stream: "calc-1" });
    const reader1 = iter1[Symbol.asyncIterator]();
    // Land in the loop so the slot is acquired.
    await reader1.next();
    // Tear down — runs the generator's `finally` block, releasing.
    await reader1.return?.(undefined);

    // Slot is free; the second open's generator should run cleanly.
    const iter2 = await sub_proc({ stream: "calc-1" });
    const reader2 = iter2[Symbol.asyncIterator]();
    const re_open = await reader2.next();
    expect(re_open.value).toMatchObject({ kind: "state" });
    await reader2.return?.(undefined);
  });

  test("aborting the signal during the wait drains the generator", async ({
    app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    channel.publish("calc-1", { _v: 1, display: "1" }, [{ display: "1" }]);
    const router = trpc<Ctx>(app as never, default_options(channel));
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)({ actorId: "u-1" });

    const sub_proc = (
      caller as unknown as {
        subscribe: {
          Calculator: (input: {
            stream: string;
          }) => Promise<AsyncIterable<SubscriptionFrame>>;
        };
      }
    ).subscribe.Calculator;

    const iter = await sub_proc({ stream: "calc-1" });
    const reader = iter[Symbol.asyncIterator]();
    // First yield = cached state.
    await reader.next();
    // Tell the generator to stop — triggers the `finally` cleanup
    // and exercises the `on_abort` listener path.
    const closed = reader.return?.(undefined);
    await closed;
  });

  test("validates the input shape (stream is required, non-empty)", async ({
    app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    const router = trpc<Ctx>(app as never, default_options(channel));
    const t = initTRPC.context<Ctx>().create();
    const caller = t.createCallerFactory(router)({ actorId: "u-1" });

    await expect(
      (
        caller as unknown as {
          subscribe: {
            Calculator: (input: { stream: string }) => Promise<unknown>;
          };
        }
      ).subscribe.Calculator({ stream: "" })
    ).rejects.toBeInstanceOf(TRPCError);
  });
});
