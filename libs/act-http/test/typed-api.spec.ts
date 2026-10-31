/**
 * The generated APIs keep the app's types. These checks run in the
 * type-checker (`pnpm typecheck`): a generator whose inputs or outputs
 * widen to `any` or `unknown` fails to compile here.
 */
import { act, state } from "@rotorsoft/act";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { testClient } from "hono/testing";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { ApiError } from "../src/api/index.js";
import { hono } from "../src/hono/index.js";
import { BroadcastChannel } from "../src/sse/index.js";
import { trpc } from "../src/trpc/index.js";

const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Added: z.object({ by: z.number() }) })
  .patch({ Added: ({ data }, s) => ({ n: s.n + data.by }) })
  .on({ add: z.object({ by: z.number() }) })
  .emit((a) => ["Added", a])
  .build();

const Note = state({ Note: z.object({ text: z.string() }) })
  .init(() => ({ text: "" }))
  .emits({ Written: z.object({ text: z.string() }) })
  .patch({ Written: ({ data }) => ({ text: data.text }) })
  .on({ write: z.object({ text: z.string() }) })
  .emit((a) => ["Written", a])
  .build();

const app = act().withState(Counter).withState(Note).build();
const stream = () => "s-1";
type Ctx = { user: string };

describe("trpc(app) types", () => {
  const router = trpc(app, {
    actor: (ctx: Ctx) => ({ id: ctx.user, name: ctx.user }),
    stream,
  });
  type In = inferRouterInputs<typeof router>;
  type Out = inferRouterOutputs<typeof router>;

  it("takes each action's payload", () => {
    expectTypeOf<In["add"]>().toEqualTypeOf<{ by: number }>();
    expectTypeOf<In["write"]>().toEqualTypeOf<{ text: string }>();
    expectTypeOf<keyof In>().toEqualTypeOf<"add" | "write">();
  });

  it("returns the snapshots app.do returns, as JSON", () => {
    expectTypeOf<Out["add"][number]["state"]>().toEqualTypeOf<{ n: number }>();
    expectTypeOf<Out["write"][number]["state"]>().toEqualTypeOf<{
      text: string;
    }>();
    expectTypeOf<
      NonNullable<Out["add"][number]["event"]>["created"]
    >().toEqualTypeOf<string>();
  });

  it("narrows a resolver's payload by the action name", () => {
    trpc(app, {
      actor: (ctx: Ctx) => ({ id: ctx.user, name: ctx.user }),
      stream: (action, input, ctx) =>
        action === "add"
          ? `${ctx.user}-${input.by.toFixed()}`
          : `${ctx.user}-${input.text.trim()}`,
      // TypeScript narrows by the name when all three parameters are declared.
      expectedVersion: (action, input, _ctx) =>
        action === "add" ? input.by : input.text.length,
    });
  });

  it("subscribes per state, with that state's frames", () => {
    const sse_router = trpc(app, {
      actor: () => ({ id: "a", name: "a" }),
      stream,
      sse: { channel: new BroadcastChannel() },
    });
    type Frames = inferRouterOutputs<typeof sse_router>["subscribe"];
    type Frame<N extends keyof Frames> =
      Frames[N] extends AsyncIterable<infer F> ? F : never;
    expectTypeOf<keyof Frames>().toEqualTypeOf<"Counter" | "Note">();
    expectTypeOf<
      Extract<Frame<"Counter">, { kind: "state" }>["data"]
    >().toEqualTypeOf<{ n: number } & { _v: number }>();
    expectTypeOf<
      Extract<Frame<"Note">, { kind: "state" }>["data"]
    >().toEqualTypeOf<{ text: string } & { _v: number }>();
  });
});

describe("hono(app) types", () => {
  const api = hono(app, { actor: () => ({ id: "a", name: "a" }), stream });
  const client = testClient(api);

  it("takes each action's payload as the JSON body", () => {
    expectTypeOf(client.api.actions.add.$post)
      .parameter(0)
      .toEqualTypeOf<{ json: { by: number } }>();
    // @ts-expect-error an action the app doesn't have
    client.api.actions.nope;
  });

  it("returns the snapshots on 200 and ApiError otherwise", async () => {
    type Res = Awaited<ReturnType<typeof client.api.actions.add.$post>>;
    type Ok = Awaited<ReturnType<Extract<Res, { status: 200 }>["json"]>>;
    type Err = Awaited<ReturnType<Exclude<Res, { status: 200 }>["json"]>>;
    expectTypeOf<Ok[number]["state"]>().toEqualTypeOf<{ n: number }>();
    expectTypeOf<Err>().toEqualTypeOf<ApiError>();
  });

  it("narrows a resolver's payload by the action name", () => {
    hono(app, {
      actor: (c) => ({ id: c.req.header("x-user") ?? "", name: "" }),
      stream: (action, input, c) =>
        action === "add"
          ? `${c.req.path}-${input.by.toFixed()}`
          : `${c.req.path}-${input.text.trim()}`,
    });
  });

  it("mounts under the basePath it's given", () => {
    const v1 = testClient(
      hono(app, {
        actor: () => ({ id: "a", name: "a" }),
        stream,
        basePath: "/v1",
      })
    );
    expectTypeOf(v1.v1.actions.write.$post)
      .parameter(0)
      .toEqualTypeOf<{ json: { text: string } }>();
  });

  it("types the SSE routes when sse is set", () => {
    const sse = testClient(
      hono(app, {
        actor: () => ({ id: "a", name: "a" }),
        stream,
        sse: { channel: new BroadcastChannel() },
      })
    );
    expectTypeOf(sse.api.sse.Note.$get)
      .parameter(0)
      .toEqualTypeOf<{ query: { stream: string } }>();
    // @ts-expect-error no SSE routes without sse
    client.api.sse;
  });
});
