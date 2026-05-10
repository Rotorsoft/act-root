/**
 * Auto-wiring tests for `Act` ↔ `Store.notify`.
 *
 * Each test gets a fresh module graph via `vi.resetModules()` so the
 * `store()` / `dispose()` singletons start clean. A handful of tests
 * exercise the success path; the rest cover the no-op / error branches
 * the orchestrator must tolerate.
 */
import { z } from "zod";

vi.mock("../src/config.js", () => ({
  config: vi.fn().mockReturnValue({
    env: "test",
    logLevel: "fatal",
    logSingleLine: true,
  }),
}));

type AnyHandler = (n: {
  stream: string;
  events: ReadonlyArray<{ id: number; name: string }>;
}) => void;

/**
 * Builds an Act instance with a single reaction on `Pressed`, after
 * injecting a `notify`-capable fake store. Returns the app, the captured
 * notify handler, and bookkeeping spies for subscribe/dispose.
 */
async function buildAppWithNotifyStore(
  opts: {
    hasNotify?: boolean;
    notifyThrows?: Error;
    registerReaction?: boolean;
  } = {}
) {
  const { hasNotify = true, notifyThrows, registerReaction = true } = opts;
  vi.resetModules();
  const { InMemoryStore } = await import("../src/adapters/in-memory-store.js");
  const { store, dispose } = await import("../src/ports.js");
  const { act, state } = await import("../src/index.js");

  let captured: AnyHandler | undefined;
  const notifyDispose = vi.fn().mockResolvedValue(undefined);
  const subscribe = vi.fn(async (h: AnyHandler) => {
    if (notifyThrows) throw notifyThrows;
    captured = h;
    return notifyDispose;
  });

  class FakeStore extends InMemoryStore {}
  const fake = new FakeStore() as InstanceType<typeof FakeStore> & {
    notify?: typeof subscribe;
  };
  if (hasNotify) fake.notify = subscribe;
  store(fake);

  const Counter = state({ Counter: z.object({ count: z.number() }) })
    .init(() => ({ count: 0 }))
    .emits({ Pressed: z.object({ digit: z.string() }) })
    .on({ press: z.object({ digit: z.string() }) })
    .emit("Pressed")
    .build();

  let builder = act().withState(Counter);
  if (registerReaction) {
    builder = builder
      .on("Pressed")
      .do(async function noopReaction() {})
      .to("counter-projection");
  }
  // The fake store above has a `notify` method assigned, so the
  // orchestrator auto-wires unconditionally. Real adapters control
  // overhead at the store-config level (e.g., `PostgresStore({ notify:
  // true })` enables LISTEN/NOTIFY; `false` leaves the method
  // undefined).
  const app = builder.build();

  // Wiring is kicked off in the constructor but the subscription
  // itself is async — yield once so the wire promise resolves before
  // tests inspect captured state.
  await new Promise((r) => setImmediate(r));

  return {
    app,
    dispose,
    subscribe,
    notifyDispose,
    capturedHandler: () => captured,
  };
}

describe("Act ↔ Store.notify auto-wiring", () => {
  afterEach(async () => {
    const { dispose } = await import("../src/ports.js");
    await dispose()("EXIT").catch(() => {});
  });

  it("subscribes when store has notify and reactions exist", async () => {
    const { subscribe, capturedHandler } = await buildAppWithNotifyStore();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(capturedHandler()).toBeTypeOf("function");
  });

  it("does not subscribe when there are no reactive events", async () => {
    const { subscribe } = await buildAppWithNotifyStore({
      registerReaction: false,
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not subscribe when store lacks notify", async () => {
    const { subscribe } = await buildAppWithNotifyStore({ hasNotify: false });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("emits 'notified' lifecycle event on incoming notifications", async () => {
    const { app, capturedHandler } = await buildAppWithNotifyStore();
    const seen: any[] = [];
    app.on("notified", (n) => seen.push(n));
    const handler = capturedHandler()!;
    handler({
      stream: "remote-stream",
      events: [{ id: 42, name: "Pressed" }],
    });
    expect(seen).toEqual([
      { stream: "remote-stream", events: [{ id: 42, name: "Pressed" }] },
    ]);
  });

  it("wakes settle when notification carries a reactive event", async () => {
    const { app, capturedHandler } = await buildAppWithNotifyStore();
    const settled = vi.fn();
    app.on("settled", settled);
    capturedHandler()!({
      stream: "remote-stream",
      events: [{ id: 1, name: "Pressed" }],
    });
    // settle() runs on a 0ms debounce; yield twice to let the loop run.
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toHaveBeenCalled();
  });

  it("contains errors thrown by user 'notified' listeners", async () => {
    // The orchestrator wraps `emit` + drain wakeup in a try/catch so a
    // bad user listener can't tear down the wiring. The drain wakeup
    // for *this* notification is also lost (the throw shortcuts the
    // settle schedule call), but the listener stays alive for future
    // notifications.
    const { app, capturedHandler } = await buildAppWithNotifyStore();
    app.on("notified", () => {
      throw new Error("user listener boom");
    });
    expect(() =>
      capturedHandler()!({
        stream: "remote-stream",
        events: [{ id: 1, name: "Pressed" }],
      })
    ).not.toThrow();
  });

  it("does not wake when no event in the batch is reactive", async () => {
    const { app, capturedHandler } = await buildAppWithNotifyStore();
    const settled = vi.fn();
    app.on("settled", settled);
    capturedHandler()!({
      stream: "remote-stream",
      events: [{ id: 1, name: "UnknownEvent" }],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).not.toHaveBeenCalled();
  });

  it("disposer runs on app dispose", async () => {
    const { dispose, notifyDispose } = await buildAppWithNotifyStore();
    await dispose()("EXIT").catch(() => {});
    expect(notifyDispose).toHaveBeenCalledTimes(1);
  });

  it("swallows subscription errors and falls back to debounce/poll", async () => {
    const result = await buildAppWithNotifyStore({
      notifyThrows: new Error("boom"),
    });
    // App built without throwing; the notified handler is undefined.
    expect(result.capturedHandler()).toBeUndefined();
  });
});
