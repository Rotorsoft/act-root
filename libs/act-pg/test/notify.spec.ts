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

  it("disposer stops further deliveries", async () => {
    const received: any[] = [];
    const dispose = await listener.notify!((n) => received.push(n));
    await dispose();

    await writer.commit(
      [
        {
          stream: "stream-after-dispose",
          msgs: [{ name: "PostDispose", data: {} }],
        },
      ],
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

    await writer.commit(
      [{ stream: "stream-rewire", msgs: [{ name: "Rewired", data: {} }] }],
      {
        correlation: "c",
        causation: {},
      }
    );

    await vi.waitFor(() => expect(secondSeen).not.toHaveLength(0), {
      timeout: 1_500,
    });
    expect(secondSeen).toHaveLength(1);
    expect(firstSeen).toHaveLength(0);

    // The first disposer is now stale but must remain safe to call.
    await firstDispose();
    await secondDispose();
  });

  it("skips malformed payloads and keeps delivering", async () => {
    const received: any[] = [];
    const dispose = await listener.notify!((n) => received.push(n));

    // Raw NOTIFYs on the writer/listener channel: no payload, not JSON, and
    // JSON that isn't a notification. Postgres delivers one channel in order,
    // so if the commit sent after them is the first thing received, every
    // bad payload was skipped and the listener is still connected.
    const channel = (writer as any)._channel as string;
    const raw = await (writer as any)._pool.connect();
    try {
      await raw.query(`NOTIFY ${channel}`);
      await raw.query(`SELECT pg_notify($1, 'not-json')`, [channel]);
      for (const bad of [
        { stream: 42, events: [], by: "other" },
        { stream: "ok", events: "nope", by: "other" },
        {
          stream: "ok",
          events: [{ id: "not-a-number", name: "X" }],
          by: "other",
        },
      ])
        await raw.query(`SELECT pg_notify($1, $2)`, [
          channel,
          JSON.stringify(bad),
        ]);
    } finally {
      raw.release();
    }
    await writer.commit(
      [{ stream: "stream-after-bad", msgs: [{ name: "AfterBad", data: {} }] }],
      { correlation: "c", causation: {} }
    );
    await vi.waitFor(() => expect(received).not.toHaveLength(0), {
      timeout: 1_500,
    });
    expect(received[0].stream).toBe("stream-after-bad");

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
        [{ stream: "stream-no-notify", msgs: [{ name: "Quiet", data: {} }] }],
        { correlation: "c", causation: {} }
      );
      // Postgres delivers in commit order, so once a later notifying commit
      // arrives, a notification for the quiet one would have arrived first.
      await writer.commit(
        [{ stream: "stream-fence", msgs: [{ name: "Fence", data: {} }] }],
        { correlation: "c", causation: {} }
      );
      await vi.waitFor(() => expect(received).toHaveLength(1), {
        timeout: 1_500,
      });
      expect(received.map((n) => n.stream)).toEqual(["stream-fence"]);
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
    await writer.commit(
      [{ stream: "stream-throw", msgs: [{ name: "ThrowOnce", data: {} }] }],
      {
        correlation: "c",
        causation: {},
      }
    );
    // Second commit should still be delivered to the recovered handler.
    await writer.commit(
      [
        {
          stream: "stream-after-throw",
          msgs: [{ name: "AfterThrow", data: {} }],
        },
      ],
      { correlation: "c", causation: {} }
    );
    await vi.waitFor(() => expect(received).not.toHaveLength(0), {
      timeout: 1_500,
    });
    expect(received[0].stream).toBe("stream-after-throw");

    await dispose();
  });
});

/**
 * The user-visible half of handing back an in-flight open: `dispose()`
 * has to resolve. The unit test over a fake pool proves the in-flight open
 * hands its client back; only a real pool shows why that matters, because
 * `pool.end()` waits for every checked-out client and a stranded one keeps
 * a graceful shutdown pending forever.
 */
describe("PostgresStore.dispose racing an in-flight re-LISTEN", () => {
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
    await vi.waitFor(() => expect(parked_once).toBe(true), { timeout: 3_000 });

    const started = Date.now();
    const disposing = store.dispose();
    release();
    await disposing;

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(inner._listen_client).toBeUndefined();
  }, 30_000);
});

describe("PostgresStore.notify channel names", () => {
  it("delivers on an uppercase table name", async () => {
    const config = {
      port: PORT,
      schema: schema("schema_notify_upper"),
      table: "OrderEvents",
      notify: true,
    };
    const writer = new PostgresStore(config);
    const listener = new PostgresStore(config);
    try {
      await writer.drop();
      await writer.seed();
      const received: unknown[] = [];
      const dispose = await listener.notify!((n) => received.push(n));
      await writer.commit(
        [{ stream: "upper-1", msgs: [{ name: "Placed", data: {} }] }],
        { correlation: "c", causation: {} }
      );
      await vi.waitFor(() => expect(received).toHaveLength(1), {
        timeout: 1_500,
      });
      await dispose();
    } finally {
      await writer.drop();
      await listener.dispose();
      await writer.dispose();
    }
  });

  it("refuses a channel over Postgres's 63-byte name limit", () => {
    const table = "t".repeat(60);
    expect(
      () => new PostgresStore({ port: PORT, table, notify: true })
    ).toThrow(/over 63 bytes/);
    expect(() => new PostgresStore({ port: PORT, table })).not.toThrow();
  });
});
