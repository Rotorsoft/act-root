/**
 * `PostgresStore` priority: the boot path that restores declared
 * priorities. The seed migration that adds the column is pinned by
 * `seed-upgrade.spec.ts`, and the portable priority contract (max on
 * subscribe, prioritize filters, claim order) lives in the store TCK.
 */

import { act, dispose, state, store, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";
import { schema } from "./schema.js";

const PORT = 5431;
const _SCHEMA = schema("act_priority_test");
const TABLE = "events";

/**
 * The app-level path into the duplicate-batch merge. Two static
 * reactions to one target from different sources are a supported shape
 * (`lanes.spec.ts` "accepts same-target reactions on the SAME lane across
 * sources"), `classify_registry` keys them separately, and correlate's init
 * passes the whole list to one `subscribe` call.
 */
describe("static-target batch after a lower stored priority", () => {
  const Counter = state({ Counter: z.object({ n: z.number() }) })
    .init(() => ({ n: 0 }))
    .emits({ Incremented: ZodEmpty })
    .patch({ Incremented: (_e, s) => ({ n: s.n + 1 }) })
    .on({ Increment: ZodEmpty })
    .emit(() => ["Incremented", {}])
    .build();

  beforeEach(async () => {
    store(
      new PostgresStore({
        port: PORT,
        schema: schema("act_dup_batch_test"),
        table: TABLE,
      })
    );
    await store().drop();
    await store().seed();
  });

  afterEach(async () => {
    await dispose()("EXIT").catch(() => {});
  });

  it("restores the declared maximum priority on boot", async () => {
    // What a deploy that raises declared priorities, or a `prioritize()`
    // override, leaves behind: a stored value below BOTH declared entries.
    await store().subscribe([{ stream: "shared", priority: 0 }]);

    const app = act()
      .withState(Counter)
      .on("Incremented")
      .do(function reactA() {
        return Promise.resolve();
      })
      .to({ target: "shared", source: "sA", priority: 1 })
      .on("Incremented")
      .do(function reactB() {
        return Promise.resolve();
      })
      .to({ target: "shared", source: "sB", priority: 7 })
      .build();
    // Forces correlate's init, which subscribes the static batch.
    await app.correlate();

    const seen: { priority: number }[] = [];
    await store().query_streams((p) => seen.push(p as never), {
      stream: "shared",
      stream_exact: true,
    });
    expect(seen[0].priority).toBe(7);
    await app.shutdown();
  });
});
