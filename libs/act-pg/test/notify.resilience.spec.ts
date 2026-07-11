/**
 * #1189: the dedicated LISTEN client loses node-postgres's idle-error
 * guard on checkout, so a checked-out client that emits `error` (backend
 * restart, failover, network drop) with no listener is an uncaught
 * exception — a process crash. Even surviving that, nothing re-LISTENs,
 * so cross-process wakeups silently stop while the client looks healthy.
 *
 * These are unit tests over a mocked pg pool — a real backend restart is
 * impractical to stage against the shared docker instance, and the
 * contract we care about is entirely on the store's side: an error
 * listener exists, driving a teardown + self-healing re-LISTEN with
 * capped backoff, and a pending reconnect is cancelled cleanly on
 * disposal.
 */
import { EventEmitter } from "node:events";
import { PostgresStore } from "../src/postgres-store.js";

// A fake pg PoolClient that is an EventEmitter, so tests can emit
// `error` the way node-postgres would surface a connection loss.
class FakeClient extends EventEmitter {
  released = false;
  query = vi.fn().mockResolvedValue({ rows: [] });
  release = vi.fn().mockImplementation(() => {
    this.released = true;
  });
}

// A fake Pool that hands out FakeClients and records every checkout so
// tests can assert a *new* client was checked out on reconnect.
class FakePool {
  clients: FakeClient[] = [];
  connect = vi.fn().mockImplementation(async () => {
    const c = new FakeClient();
    this.clients.push(c);
    return c;
  });
  end = vi.fn().mockResolvedValue(undefined);
  query = vi.fn().mockResolvedValue({ rows: [] });
}

vi.mock("pg", () => {
  const Pool = vi.fn();
  return {
    default: {
      Pool,
      types: { setTypeParser: vi.fn(), builtins: { JSONB: 0 } },
    },
    Pool,
    types: { setTypeParser: vi.fn(), builtins: { JSONB: 0 } },
  };
});

const makeStore = () => {
  const store = new PostgresStore({ notify: true, schema: "x", table: "y" });
  const pool = new FakePool();
  // Swap in the fake pool — the constructor built a mocked (empty) Pool.
  (store as unknown as { _pool: FakePool })._pool = pool;
  return { store, pool };
};

describe("PostgresStore LISTEN client resilience (#1189)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("attaches an error listener to the LISTEN client so a connection blip cannot crash the process", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});
    const client = pool.clients[0];
    // A real checked-out client with no `error` listener would throw an
    // uncaught exception here (EventEmitter re-raises unhandled `error`).
    expect(client.listenerCount("error")).toBeGreaterThan(0);
    // Proof it doesn't throw: emitting is a no-op for the assertion.
    expect(() =>
      client.emit("error", new Error("connection reset"))
    ).not.toThrow();
  });

  it("self-heals: on client error it tears down the dead client and re-LISTENs on a fresh one", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});
    const first = pool.clients[0];
    expect(pool.connect).toHaveBeenCalledTimes(1);

    // Simulate a connection loss.
    first.emit("error", new Error("backend restart"));

    // The dead client is released, and a reconnect is scheduled (not
    // fired synchronously — it rides capped backoff).
    expect(first.released).toBe(true);
    expect(pool.connect).toHaveBeenCalledTimes(1);

    // Advance past the backoff window and let the async re-LISTEN settle.
    await vi.advanceTimersByTimeAsync(1000);

    // A fresh client was checked out and issued LISTEN.
    expect(pool.connect).toHaveBeenCalledTimes(2);
    const second = pool.clients[1];
    expect(second.listenerCount("error")).toBeGreaterThan(0);
    expect(second.query).toHaveBeenCalledWith(
      expect.stringContaining("LISTEN")
    );

    await store.dispose();
  });

  it("grows the backoff on repeated failures and resets it after a healthy reconnect", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});

    // First blip → base delay (~250ms). A shorter advance must NOT
    // reconnect yet.
    pool.clients[0].emit("error", new Error("blip 1"));
    await vi.advanceTimersByTimeAsync(100);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(pool.connect).toHaveBeenCalledTimes(2);

    // Healthy reconnect resets the counter, so the next blip is base
    // delay again (not doubled).
    pool.clients[1].emit("error", new Error("blip 2"));
    await vi.advanceTimersByTimeAsync(300);
    expect(pool.connect).toHaveBeenCalledTimes(3);

    await store.dispose();
  });

  it("reschedules with backoff when the re-LISTEN itself fails", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});

    // Make the next two checkouts fail, then succeed.
    pool.connect
      .mockRejectedValueOnce(new Error("still down"))
      .mockRejectedValueOnce(new Error("still down"));

    pool.clients[0].emit("error", new Error("down"));
    // First reconnect attempt fails to check out a client...
    await vi.advanceTimersByTimeAsync(300);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    // ...reschedules, second attempt also fails...
    await vi.advanceTimersByTimeAsync(1000);
    expect(pool.connect).toHaveBeenCalledTimes(3);
    // ...third succeeds.
    await vi.advanceTimersByTimeAsync(2000);
    expect(pool.connect).toHaveBeenCalledTimes(4);

    await store.dispose();
  });

  it("dispose during a pending reconnect cancels it — no client is checked out after teardown", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});

    pool.clients[0].emit("error", new Error("down"));
    expect(pool.connect).toHaveBeenCalledTimes(1);

    // Dispose while the reconnect timer is still pending.
    await store.dispose();

    // Advancing time must NOT trigger a reconnect after teardown.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it("a client error after the handler was already cleared is a no-op reconnect", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});
    const client = pool.clients[0];
    // Clear the handler out from under the subscription (as disposal does)
    // without cancelling anything, then fire the error: `_reconnect` must
    // bail on the missing handler and never check out a fresh client.
    (store as unknown as { _notify_handler: undefined })._notify_handler =
      undefined;
    client.emit("error", new Error("late error"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    await store.dispose();
  });

  it("the reconnect timer callback bails if the handler was cleared after scheduling", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});
    // Schedule a reconnect, then clear the handler *without* cancelling the
    // timer (simulating disposal racing the already-fired timer). The
    // timer callback must re-check and bail — no fresh checkout.
    pool.clients[0].emit("error", new Error("down"));
    (store as unknown as { _notify_handler: undefined })._notify_handler =
      undefined;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    await store.dispose();
  });

  it("disposer is a no-op after a re-subscribe replaced the handler", async () => {
    const { store, pool } = makeStore();
    const firstDispose = await store.notify!(() => {});
    await store.notify!(() => {});
    // The first disposer is stale — calling it must not tear down the
    // live second subscription.
    await firstDispose();
    // The live subscription's client is still checked out and unreleased.
    expect(pool.clients[1].released).toBe(false);
    await store.dispose();
  });

  // #1231: a node-postgres socket routinely emits `error` more than once on
  // teardown (in-flight LISTEN rejection + socket ECONNRESET/end). The
  // reconnect must never leave the dead client without an `error` listener
  // during the backoff window, or the second emission re-raises as an
  // uncaught exception — the exact process crash #1189 fixed.
  it("a SECOND error on the dead client during the backoff window does not crash the process", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});
    const first = pool.clients[0];

    // First error: schedules the reconnect and detaches the original
    // handler. The dead client must still carry *some* `error` listener.
    first.emit("error", new Error("in-flight LISTEN rejection"));
    expect(first.released).toBe(true);
    expect(first.listenerCount("error")).toBeGreaterThan(0);

    // Second error during the backoff window — sockets emit this on the
    // ECONNRESET/end that follows. It must NOT re-raise as uncaught.
    expect(() =>
      first.emit("error", new Error("socket ECONNRESET"))
    ).not.toThrow();

    // The second error must not have triggered a second reconnect schedule.
    await vi.advanceTimersByTimeAsync(1000);
    expect(pool.connect).toHaveBeenCalledTimes(2);

    await store.dispose();
  });

  it("repeated reconnect cycles return the checked-out and listener counts to baseline (no leak, no double-subscribe)", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});

    // Drive several full reconnect cycles.
    for (let cycle = 0; cycle < 4; cycle++) {
      const live = pool.clients[pool.clients.length - 1];
      live.emit("error", new Error(`blip ${cycle}`));
      // Healthy reconnect resets backoff, so each cycle is the base delay.
      await vi.advanceTimersByTimeAsync(500);
    }

    // One fresh client per cycle plus the original = 5 checkouts.
    expect(pool.connect).toHaveBeenCalledTimes(5);

    // Every dead client is released; exactly one live client remains.
    const live = pool.clients[pool.clients.length - 1];
    const released = pool.clients.filter((c) => c.released);
    expect(released).toHaveLength(pool.clients.length - 1);
    expect(live.released).toBe(false);

    // The live client carries exactly one `error` and one `notification`
    // listener — no accumulation across cycles (no double-subscribe).
    expect(live.listenerCount("error")).toBe(1);
    expect(live.listenerCount("notification")).toBe(1);

    // No timer left pending after the cycles settle.
    expect(
      (store as unknown as { _reconnect_timer: unknown })._reconnect_timer
    ).toBeUndefined();

    await store.dispose();
  });

  it("a re-entrant reconnect cancels the pending timer instead of leaking a second one (no double-LISTEN)", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});

    // First error schedules a reconnect timer. `_listen_client` is now
    // undefined, so a second socket error routes to the swallow listener and
    // cannot re-enter `_reconnect`. The re-entrant guard exists for the
    // hardened case where `_reconnect` runs again while a timer is still live
    // — drive it directly and capture the timer identity before and after.
    pool.clients[0].emit("error", new Error("down"));
    const internals = store as unknown as {
      _reconnect: () => void;
      _reconnect_timer: ReturnType<typeof setTimeout>;
    };
    const firstTimer = internals._reconnect_timer;
    expect(firstTimer).toBeDefined();

    internals._reconnect();
    const secondTimer = internals._reconnect_timer;
    // A fresh timer replaced the old one — the guard cleared the first so two
    // do not race to re-LISTEN.
    expect(secondTimer).not.toBe(firstTimer);

    // Exactly one reconnect fires despite two schedules.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.connect).toHaveBeenCalledTimes(2);

    await store.dispose();
  });

  it("dispose during a pending reconnect fires no reconnect and leaves no client checked out", async () => {
    const { store, pool } = makeStore();
    await store.notify!(() => {});
    const first = pool.clients[0];

    first.emit("error", new Error("down"));
    expect(pool.connect).toHaveBeenCalledTimes(1);

    // Dispose while the reconnect timer is pending.
    await store.dispose();

    // No reconnect fires after teardown.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pool.connect).toHaveBeenCalledTimes(1);

    // The dead client is released; no new client was checked out.
    expect(first.released).toBe(true);
    expect(pool.clients).toHaveLength(1);
    expect(
      (store as unknown as { _reconnect_timer: unknown })._reconnect_timer
    ).toBeUndefined();
  });
});
