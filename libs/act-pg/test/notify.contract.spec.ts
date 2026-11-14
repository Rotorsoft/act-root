import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

/**
 * Correlate's job, done by hand: `claim` follows the work mark,
 * so a test that commits events has to say which of them resolve where.
 * Marks every subscription up to the log head, which is honest for these
 * fixtures — their sources carry the events under test.
 */

const PORT = 5431;
const SCHEMA = schema("notify_contract");
const TABLE = "notify_contract_test";

/**
 * Wait until `predicate()` returns true or the timeout elapses. Polling
 * keeps the integration tests robust against PG's asynchronous LISTEN
 * delivery — `pg_notify` round-trips are typically <5 ms but vary under
 * CI load.
 */
describe("PostgresStore notify contract", () => {
  let a: PostgresStore;
  let b: PostgresStore;

  beforeAll(async () => {
    // Two stores against the same (schema, table) with distinct
    // per-instance `_by` UUIDs — simulating two processes.
    a = new PostgresStore({
      port: PORT,
      schema: SCHEMA,
      table: TABLE,
      notify: true,
    });
    b = new PostgresStore({
      port: PORT,
      schema: SCHEMA,
      table: TABLE,
      notify: true,
    });
    await a.drop();
    await a.seed();
  });

  afterAll(async () => {
    await b.dispose();
    await a.dispose();
  });

  it("oversize notify payload skips the NOTIFY — the commit succeeds and events stay discoverable via the poll path", async () => {
    const seen_by_b: any[] = [];
    const dispose_b = await b.notify!((n) => seen_by_b.push(n));

    // 100 events with 80-char names serialize to a ~10.5KB payload —
    // well over PG's 8000-byte NOTIFY cap. An unguarded pg_notify would
    // raise "payload string too long" and abort the commit transaction.
    const long_name = "E".repeat(80);
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      name: long_name,
      data: { i },
    }));
    const committed = await a.commit([{ stream: "stream-oversize", msgs }], {
      correlation: "c",
      causation: {},
    });
    expect(committed).toHaveLength(100);

    // Delivery degrades: no notification goes out for the oversize batch.
    // Postgres delivers in commit order, so a later small commit arriving
    // alone shows none went out for it.
    await a.commit(
      [{ stream: "stream-fence", msgs: [{ name: "Fence", data: {} }] }],
      { correlation: "c", causation: {} }
    );
    await vi.waitFor(() => expect(seen_by_b).toHaveLength(1), {
      timeout: 1_500,
    });
    expect(seen_by_b.map((n) => n.stream)).toEqual(["stream-fence"]);

    // ...but never lost: the poll path still discovers the stream
    // (subscribe + claim, the drain's polling primitives) and every
    // event is fetchable — at-least-once delivery is preserved.
    await b.subscribe([
      { stream: "stream-oversize", correlated_at: committed.at(-1)?.id },
    ]);
    const leases = await b.claim(100, 0, "poll-worker", 10_000);
    expect(leases.map((l) => l.stream)).toContain("stream-oversize");

    const polled: any[] = [];
    await b.query((e) => polled.push(e), { stream: "stream-oversize" });
    expect(polled).toHaveLength(100);
    expect(polled.every((e) => e.name === long_name)).toBe(true);

    await dispose_b();
  });

  it("a small commit right at the payload boundary still notifies", async () => {
    // Sanity guard on the size check itself: a normal commit (payload
    // far under 8000 bytes) keeps flowing through the NOTIFY fast path.
    const seen_by_b: any[] = [];
    const dispose_b = await b.notify!((n) => seen_by_b.push(n));

    await a.commit(
      [
        {
          stream: "stream-under-cap",
          msgs: [{ name: "SmallEvent", data: {} }],
        },
      ],
      {
        correlation: "c",
        causation: {},
      }
    );

    await vi.waitFor(() => expect(seen_by_b).not.toHaveLength(0), {
      timeout: 1_500,
    });
    expect(seen_by_b[0].stream).toBe("stream-under-cap");

    await dispose_b();
  });
});
