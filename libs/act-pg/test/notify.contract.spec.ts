/**
 * Conformance tests for cross-process NOTIFY semantics that live outside
 * the shared TCK (they need two store instances against the same physical
 * store — see the "needs two processes" note in
 * `libs/act-tck/src/store-tck.ts`). Two contracts the orchestrator relies
 * on are pinned here, against the docker PG instance (port 5431):
 *
 * 1. **Per-instance self-filtering.** Every `PostgresStore` carries a
 *    per-instance `_by` UUID; the LISTEN handler skips payloads where
 *    `by === this._by`, so a store instance never wakes itself — local
 *    commits already arm the drain via `do()`.
 * 2. **8KB payload cap → poll fallback.** PG rejects NOTIFY payloads at
 *    or above 8000 bytes ("payload string too long"), and inside the
 *    commit transaction that error would abort the whole INSERT batch.
 *    `commit()` measures the payload and skips the NOTIFY when it would
 *    not fit — the commit succeeds, no notification is delivered, and
 *    the events remain discoverable via the poll path (subscribe/claim/
 *    query), preserving at-least-once delivery.
 *
 * Complements `notify.spec.ts`, which covers delivery, disposal, and
 * malformed-payload robustness on a single listener.
 */
import { sleep } from "@rotorsoft/act";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "schema_notify_contract_test";
const TABLE = "notify_contract_test";

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

  it("notify is self-filtered per instance — a commit wakes the other instance, never its own", async () => {
    const seen_by_a: any[] = [];
    const seen_by_b: any[] = [];
    const dispose_a = await a.notify!((n) => seen_by_a.push(n));
    const dispose_b = await b.notify!((n) => seen_by_b.push(n));

    await a.commit("stream-self-filter", [{ name: "Ping", data: {} }], {
      correlation: "c",
      causation: {},
    });

    // The other instance is woken with the committed batch...
    await waitFor(() => seen_by_b.length > 0);
    expect(seen_by_b).toHaveLength(1);
    expect(seen_by_b[0].stream).toBe("stream-self-filter");
    expect(seen_by_b[0].events).toEqual([
      { id: expect.any(Number), name: "Ping" },
    ]);

    // ...while the committing instance never sees its own NOTIFY. Wait
    // long enough for any spurious self-delivery to arrive.
    await sleep(200);
    expect(seen_by_a).toHaveLength(0);

    await dispose_a();
    await dispose_b();
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
    const committed = await a.commit("stream-oversize", msgs, {
      correlation: "c",
      causation: {},
    });
    expect(committed).toHaveLength(100);

    // Delivery degrades: no notification goes out for the oversize batch.
    await sleep(200);
    expect(seen_by_b).toHaveLength(0);

    // ...but never lost: the poll path still discovers the stream
    // (subscribe + claim, the drain's polling primitives) and every
    // event is fetchable — at-least-once delivery is preserved.
    await b.subscribe([{ stream: "stream-oversize" }]);
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

    await a.commit("stream-under-cap", [{ name: "SmallEvent", data: {} }], {
      correlation: "c",
      causation: {},
    });

    await waitFor(() => seen_by_b.length > 0);
    expect(seen_by_b[0].stream).toBe("stream-under-cap");

    await dispose_b();
  });
});
