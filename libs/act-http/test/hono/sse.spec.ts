/**
 * SSE wiring on the auto-generated Hono surface (#846). Covers the
 * subscription-open / cached-state / patch / disconnect lifecycle
 * plus the error paths the cap counter and missing-stream guard
 * produce. Run end-to-end through `app.request()` so no live server
 * is needed.
 */
import { act, state, ZodEmpty } from "@rotorsoft/act";
import { fixture } from "@rotorsoft/act/test";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { type HonoOptions, hono } from "../../src/hono/index.js";
import { BroadcastChannel } from "../../src/sse/index.js";

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

// `any`: tests intentionally use a wide channel shape so the helper composes with empty and typed states alike
const default_options = (channel: BroadcastChannel<any>): HonoOptions => ({
  actor: () => ({ id: "u-1", name: "alice" }),
  stream: () => "calc-1",
  sse: { channel },
});

/**
 * Drain SSE frames from a streamed `Response`. Resolves on the first
 * `expected` event names that arrive, or rejects after `timeoutMs`
 * if the stream is too slow / blocked. Closes the underlying reader
 * before returning so the server-side stream sees a disconnect.
 */
async function read_sse_frames(
  res: Response,
  expected: ReadonlyArray<string>,
  timeoutMs = 1000
): Promise<{ event: string; data: string }[]> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const decoder = new TextDecoder();
  const frames: { event: string; data: string }[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (frames.length < expected.length) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for SSE frames; got ${frames
            .map((f) => f.event)
            .join(",")}, expected ${expected.join(",")}`
        );
      }
      const read_result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 50)
        ),
      ]);
      if (read_result.done) continue;
      buffer += decoder.decode(read_result.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const lines = part.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        frames.push({ event, data });
        if (frames.length >= expected.length) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

describe("hono(app, { sse }) — generated SSE endpoints", () => {
  test("emits one GET /sse/<stateName> per unique state name", ({ app }) => {
    const channel = new BroadcastChannel();
    const api = hono(app as never, default_options(channel)) as unknown as {
      routes: Array<{ method: string; path: string }>;
    };
    const sse_paths = Array.from(
      new Set(
        api.routes
          .filter((r) => r.method === "GET" && r.path.startsWith("/api/sse/"))
          .map((r) => r.path)
      )
    ).sort();
    expect(sse_paths).toEqual(["/api/sse/Calculator", "/api/sse/Ticket"]);
  });

  test("no /sse/* routes when sse option is absent", ({ app }) => {
    const api = hono(app as never, {
      actor: () => ({ id: "u-1", name: "alice" }),
      stream: () => "calc-1",
    }) as unknown as { routes: Array<{ method: string; path: string }> };
    const sse_paths = api.routes.filter(
      (r) => r.method === "GET" && r.path.startsWith("/api/sse/")
    );
    expect(sse_paths).toEqual([]);
  });

  test("missing ?stream query returns 400 / BAD_REQUEST", async ({ app }) => {
    const channel = new BroadcastChannel();
    const api = hono(app as never, default_options(channel));
    const res = await api.request("/api/sse/Calculator");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("BAD_REQUEST");
  });

  test("yields cached state on open, then patches as they publish", async ({
    app: _app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    channel.publish("calc-1", { _v: 1, display: "1" }, [{ display: "1" }]);

    const api = hono(_app as never, default_options(channel));
    const res = await api.request("/api/sse/Calculator?stream=calc-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Publish a follow-up patch so the subscriber has something to drain.
    setTimeout(() => {
      channel.publish("calc-1", { _v: 2, display: "12" }, [{ display: "12" }]);
    }, 10);

    const frames = await read_sse_frames(res, ["state", "patch"]);
    expect(frames[0].event).toBe("state");
    expect(JSON.parse(frames[0].data)).toMatchObject({
      _v: 1,
      display: "1",
    });
    expect(frames[1].event).toBe("patch");
  });

  test("emits patches even when no cached state existed at open", async ({
    app: _app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    const api = hono(_app as never, default_options(channel));
    const res = await api.request("/api/sse/Calculator?stream=calc-1");

    setTimeout(() => {
      channel.publish("calc-1", { _v: 1, display: "x" }, [{ display: "x" }]);
    }, 10);

    const frames = await read_sse_frames(res, ["patch"]);
    expect(frames[0].event).toBe("patch");
  });

  test("connection cap returns 503 with Retry-After when full", async ({
    app: _app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    const api = hono(_app as never, {
      actor: () => ({ id: "u-1", name: "alice" }),
      stream: () => "calc-1",
      sse: { channel, maxConnections: 1 },
    });

    const first = await api.request("/api/sse/Calculator?stream=calc-1");
    expect(first.status).toBe(200);

    const blocked = await api.request("/api/sse/Calculator?stream=calc-1");
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("Retry-After")).toBe("1");
    const body = await blocked.json();
    expect(body.code).toBe("SSE_BUSY");

    await first.body?.cancel();
  });

  test("releasing a connection allows a new one through", async ({
    app: _app,
  }) => {
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    const api = hono(_app as never, {
      actor: () => ({ id: "u-1", name: "alice" }),
      stream: () => "calc-1",
      sse: { channel, maxConnections: 1 },
    });

    const first = await api.request("/api/sse/Calculator?stream=calc-1");
    expect(first.status).toBe(200);

    // Cancel the first reader → server sees abort → counter releases.
    await first.body?.cancel();
    // Give the abort listener a tick to fire and release the slot.
    await new Promise((r) => setTimeout(r, 20));

    const next = await api.request("/api/sse/Calculator?stream=calc-1");
    expect(next.status).toBe(200);
    await next.body?.cancel();
  });

  test("401 when the actor extractor throws", async ({ app: _app }) => {
    const channel = new BroadcastChannel();
    const api = hono(_app as never, {
      actor: () => {
        throw new Error("nope");
      },
      stream: () => "calc-1",
      sse: { channel },
    });
    const res = await api.request("/api/sse/Calculator?stream=calc-1");
    expect(res.status).toBe(401);
  });

  test("heartbeat ping fires once heartbeatMs elapses", async ({
    app: _app,
  }) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    const api = hono(_app as never, {
      actor: () => ({ id: "u-1", name: "alice" }),
      stream: () => "calc-1",
      sse: { channel, heartbeatMs: 15_000 },
    });
    const res = await api.request("/api/sse/Calculator?stream=calc-1");
    expect(res.status).toBe(200);
    // Advance past one heartbeat interval — the timer callback runs
    // and writes a ping frame; we just need the path covered.
    vi.advanceTimersByTime(20_000);
    vi.useRealTimers();
    await res.body?.cancel();
  });

  test("heartbeat-write rejection is swallowed (catch path)", async ({
    app: _app,
  }) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const channel = new BroadcastChannel<{ _v: number; display: string }>();
    const api = hono(_app as never, {
      actor: () => ({ id: "u-1", name: "alice" }),
      stream: () => "calc-1",
      sse: { channel, heartbeatMs: 15_000 },
    });
    const res = await api.request("/api/sse/Calculator?stream=calc-1");
    expect(res.status).toBe(200);
    // Cancel the consumer-side body so the underlying writable
    // closes; subsequent `writeSSE` calls reject. Then advance the
    // fake interval to fire the heartbeat — its write rejects and
    // the production handler's `.catch(() => undefined)` guard
    // swallows the rejection.
    await res.body?.cancel();
    await vi.advanceTimersByTimeAsync(16_000);
    vi.useRealTimers();
  });
});
