/**
 * Integration tests for `PostgresStore.notify` against the docker PG
 * instance (port 5431, see docker-compose.yml at the repo root). Uses an
 * isolated schema per file to avoid interfering with the wider PG suite.
 */
import { sleep } from "@rotorsoft/act";
import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

const PORT = 5431;
const SCHEMA = schema("schema_notify_test");
const TABLE = "notify_test";

/**
 * Wait until `predicate()` returns true or the timeout elapses. Polling
 * keeps the integration tests robust against PG's asynchronous LISTEN
 * delivery — `pg_notify` round-trips are typically <5 ms but vary under
 * CI load.
 */
async function waitFor(
  predicate: () => boolean,
  { timeout = 1500, interval = 10 } = {}
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await sleep(interval);
  }
}

describe("PostgresStore.notify", () => {
  let writer: PostgresStore;
  let listener: PostgresStore;

  beforeAll(async () => {
    // One writer creates the schema/table; both stores point at the same
    // backing physical store but use different per-instance `_by` UUIDs,
    // simulating two processes.
    // Enable cross-process notifications on both stores — the default
    // is opt-out (no `pg_notify` per commit, no `notify` method).
    writer = new PostgresStore({
      port: PORT,
      schema: SCHEMA,
      table: TABLE,
      notify: true,
    });
    listener = new PostgresStore({
      port: PORT,
      schema: SCHEMA,
      table: TABLE,
      notify: true,
    });
    await writer.drop();
    await writer.seed();
  });

  afterAll(async () => {
    await listener.dispose();
    await writer.dispose();
  });

  it("delivers a notification when a different store commits", async () => {
    const received: any[] = [];
    const dispose = await listener.notify!((n) => received.push(n));

    await writer.commit("stream-A", [{ name: "EventX", data: { v: 1 } }], {
      correlation: "c",
      causation: {},
    });

    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
    expect(received[0].stream).toBe("stream-A");
    expect(received[0].events).toEqual([
      { id: expect.any(Number), name: "EventX" },
    ]);

    await dispose();
  });

  it("self-filters: own commits don't fire the listener's handler", async () => {
    // Use the listener as both writer and listener: it should NOT see
    // its own NOTIFY because the LISTEN handler skips payloads where
    // by === this._by.
    const received: any[] = [];
    const dispose = await listener.notify!((n) => received.push(n));

    await listener.commit("stream-self", [{ name: "SelfEvent", data: {} }], {
      correlation: "c",
      causation: {},
    });

    // Wait long enough for any spurious notification to arrive.
    await sleep(200);
    expect(received).toHaveLength(0);

    await dispose();
  });

  it("delivers the full event batch in a single notification", async () => {
    const received: any[] = [];
    const dispose = await listener.notify!((n) => received.push(n));

    await writer.commit(
      "stream-batch",
      [
        { name: "BatchA", data: {} },
        { name: "BatchB", data: {} },
        { name: "BatchC", data: {} },
      ],
      { correlation: "c", causation: {} }
    );

    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
    expect(received[0].stream).toBe("stream-batch");
    expect(received[0].events.map((e: any) => e.name)).toEqual([
      "BatchA",
      "BatchB",
      "BatchC",
    ]);

    await dispose();
  });

  it("disposer stops further deliveries", async () => {
    const received: any[] = [];
    const dispose = await listener.notify!((n) => received.push(n));
    await dispose();

    await writer.commit(
      "stream-after-dispose",
      [{ name: "PostDispose", data: {} }],
      { correlation: "c", causation: {} }
    );

    await sleep(200);
    expect(received).toHaveLength(0);
  });

  it("re-subscribing replaces the prior listen client", async () => {
    const firstSeen: any[] = [];
    const secondSeen: any[] = [];

    const firstDispose = await listener.notify!((n) => firstSeen.push(n));
    // Re-subscribe — should release the prior LISTEN client and start fresh.
    const secondDispose = await listener.notify!((n) => secondSeen.push(n));

    await writer.commit("stream-rewire", [{ name: "Rewired", data: {} }], {
      correlation: "c",
      causation: {},
    });

    await waitFor(() => secondSeen.length > 0);
    expect(secondSeen).toHaveLength(1);
    expect(firstSeen).toHaveLength(0);

    // The first disposer is now stale but must remain safe to call.
    await firstDispose();
    await secondDispose();
  });

  it("survives malformed payloads on the channel without tearing down", async () => {
    const received: any[] = [];
    const dispose = await listener.notify!((n) => received.push(n));

    // Inject a raw NOTIFY with a non-JSON payload via the writer's pool.
    // Use the same namespaced channel the writer/listener pair uses.
    const channel = (writer as any)._channel as string;
    const rawClient = await (writer as any)._pool.connect();
    try {
      await rawClient.query(`SELECT pg_notify($1, 'not-json')`, [channel]);
    } finally {
      rawClient.release();
    }
    // Then send a valid commit and ensure the listener is still alive.
    await sleep(50);
    await writer.commit("stream-after-bad", [{ name: "AfterBad", data: {} }], {
      correlation: "c",
      causation: {},
    });
    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
    expect(received[0].stream).toBe("stream-after-bad");

    await dispose();
  });

  it("ignores NOTIFYs with no payload", async () => {
    const received: any[] = [];
    const dispose = await listener.notify!((n) => received.push(n));

    const channel = (writer as any)._channel as string;
    const rawClient = await (writer as any)._pool.connect();
    try {
      // `NOTIFY chan` (no payload) — pg delivers msg.payload as ''.
      await rawClient.query(`NOTIFY ${channel}`);
    } finally {
      rawClient.release();
    }
    await sleep(100);
    expect(received).toHaveLength(0);

    // Listener still alive — a real commit is delivered.
    await writer.commit(
      "stream-after-empty",
      [{ name: "AfterEmpty", data: {} }],
      { correlation: "c", causation: {} }
    );
    await waitFor(() => received.length > 0);
    expect(received[0].stream).toBe("stream-after-empty");

    await dispose();
  });

  it("skips JSON payloads missing required fields", async () => {
    const received: any[] = [];
    const dispose = await listener.notify!((n) => received.push(n));

    const channel = (writer as any)._channel as string;
    const rawClient = await (writer as any)._pool.connect();
    try {
      // Valid JSON but missing `stream` (number instead of string).
      await rawClient.query(`SELECT pg_notify($1, $2)`, [
        channel,
        JSON.stringify({ stream: 42, events: [], by: "other" }),
      ]);
      // Valid JSON but `events` not an array.
      await rawClient.query(`SELECT pg_notify($1, $2)`, [
        channel,
        JSON.stringify({ stream: "ok", events: "nope", by: "other" }),
      ]);
      // Valid envelope but events array contains malformed entries
      // (drop those, deliver no event when nothing valid remains).
      await rawClient.query(`SELECT pg_notify($1, $2)`, [
        channel,
        JSON.stringify({
          stream: "ok",
          events: [{ id: "not-a-number", name: "X" }],
          by: "other",
        }),
      ]);
    } finally {
      rawClient.release();
    }
    await sleep(100);
    expect(received).toHaveLength(0);

    // Listener still alive — a real commit is delivered.
    await writer.commit(
      "stream-after-bad-fields",
      [{ name: "AfterBadFields", data: {} }],
      { correlation: "c", causation: {} }
    );
    await waitFor(() => received.length > 0);
    expect(received[0].stream).toBe("stream-after-bad-fields");

    await dispose();
  });

  it("propagates LISTEN failures from notify()", async () => {
    // Fresh store with a closed pool — LISTEN throws because no
    // connection can be obtained. Confirms the error bubbles up
    // (caught by the orchestrator's wireNotify and logged) rather
    // than silently leaving the store in a half-set state.
    const broken = new PostgresStore({
      port: PORT,
      schema: SCHEMA,
      table: "notify_listen_fail",
      notify: true,
    });
    await broken.dispose();
    await expect(broken.notify!(() => {})).rejects.toBeDefined();
  });

  it("notify is undefined when config.notify is false (the default)", async () => {
    // Default opt-out keeps the LISTEN path entirely off — the
    // orchestrator's `if (store.notify)` short-circuits and no
    // dedicated client is allocated.
    const optedOut = new PostgresStore({
      port: PORT,
      schema: SCHEMA,
      table: "notify_optout_test",
    });
    try {
      expect(optedOut.notify).toBeUndefined();
    } finally {
      await optedOut.dispose();
    }
  });

  it("commit() skips pg_notify when config.notify is false", async () => {
    // Spin up a writer without notify and a listener with notify on the
    // same channel — confirm nothing is delivered. This is the proof
    // that opt-out actually saves the per-write `pg_notify`.
    const optOutWriter = new PostgresStore({
      port: PORT,
      schema: SCHEMA,
      table: TABLE,
      // notify omitted → defaults false
    });
    const received: any[] = [];
    const dispose = await listener.notify!((n) => received.push(n));
    try {
      await optOutWriter.commit(
        "stream-no-notify",
        [{ name: "Quiet", data: {} }],
        { correlation: "c", causation: {} }
      );
      await sleep(200);
      expect(received).toHaveLength(0);
    } finally {
      await dispose();
      await optOutWriter.dispose();
    }
  });

  it("survives a handler that throws — listener stays connected", async () => {
    const received: any[] = [];
    let throwOnce = true;
    const dispose = await listener.notify!((n) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("handler boom");
      }
      received.push(n);
    });

    // First commit triggers the throwing path.
    await writer.commit("stream-throw", [{ name: "ThrowOnce", data: {} }], {
      correlation: "c",
      causation: {},
    });
    await sleep(100);
    // Second commit should still be delivered to the recovered handler.
    await writer.commit(
      "stream-after-throw",
      [{ name: "AfterThrow", data: {} }],
      { correlation: "c", causation: {} }
    );
    await waitFor(() => received.length > 0);
    expect(received[0].stream).toBe("stream-after-throw");

    await dispose();
  });
});

/**
 * The user-visible half of #1616: `dispose()` has to resolve. The unit
 * test over a fake pool proves the in-flight open hands its client back;
 * only a real pool shows why that matters, because `pool.end()` waits for
 * every checked-out client and a stranded one keeps a graceful shutdown
 * pending forever.
 */
describe("PostgresStore.dispose racing an in-flight re-LISTEN (#1616)", () => {
  const DISPOSE_SCHEMA = schema("schema_dispose_race");

  const mk = () =>
    new PostgresStore({
      port: PORT,
      schema: DISPOSE_SCHEMA,
      table: "dispose_race",
      notify: true,
    });

  it("CONTROL — with no reconnect in flight, dispose resolves promptly", async () => {
    const store = mk();
    await store.drop();
    await store.seed();
    await store.notify!(() => {});

    const started = Date.now();
    await store.dispose();

    expect(Date.now() - started).toBeLessThan(2_000);
  }, 30_000);

  it("resolves while a reconnect sits in the pool checkout", async () => {
    const store = mk();
    await store.drop();
    await store.seed();
    await store.notify!(() => {});

    const inner = store as unknown as {
      _pool: { connect: () => Promise<unknown> };
      _listen_client: { emit: (e: string, x: Error) => void } | undefined;
    };
    // Park the reconnect's checkout — a stand-in for the slow or hung
    // connect a struggling database produces, which is exactly when a
    // reconnect and a shutdown overlap.
    const real_connect = inner._pool.connect.bind(inner._pool);
    let release!: () => void;
    const parked = new Promise<void>((r) => {
      release = r;
    });
    let parked_once = false;
    inner._pool.connect = async () => {
      const client = await real_connect();
      if (!parked_once) {
        parked_once = true;
        await parked;
      }
      return client;
    };

    // Force the reconnect the way a real blip would.
    inner._listen_client!.emit("error", new Error("simulated blip"));
    await waitFor(() => parked_once, { timeout: 3_000 });

    const started = Date.now();
    const disposing = store.dispose();
    release();
    await disposing;

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(inner._listen_client).toBeUndefined();
  }, 30_000);
});
