/**
 * Two stores in one schema own three tables each — events, correlated,
 * subscriptions — and nothing between them.
 *
 * Postgres is the only adapter where this is reachable: a store is identified
 * by (schema, table), so a multi-tenant deployment can put many stores in one
 * schema (`ActOptions.scoped`, the split-stores recipe). SQLite gives each
 * store its own database file.
 *
 * Run against `public` deliberately. `drop()` on a NON-public schema is
 * schema-wide (`DROP SCHEMA ... CASCADE`) and takes every sibling store with
 * it — a documented test/cleanup helper, not a per-store operation. In
 * `public` it drops only the calling store's three tables, which is where the
 * per-scope isolation of #1484's checkpoint is observable.
 */

import { CORRELATE_LANE, CORRELATE_STREAM } from "@rotorsoft/act";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/index.js";

const make = (table: string) =>
  new PostgresStore({ port: 5431, schema: "public", table });

const stores = [make("scope_iso_alpha"), make("scope_iso_beta")];

const lease = (s: PostgresStore, by: string, millis = 5_000) =>
  s.claim(1, 0, by, millis, CORRELATE_LANE);
const release = (s: PostgresStore, by: string, at: number) =>
  s.ack([
    {
      stream: CORRELATE_STREAM,
      source: undefined,
      at,
      retry: -1,
      by,
      lagging: true,
    },
  ]);
const peek = async (s: PostgresStore) => {
  const [l] = await lease(s, `peek-${Math.random()}`);
  await release(s, l.by, l.at);
  return l.at;
};
const [alpha, beta] = stores;

afterAll(async () => {
  for (const s of stores) {
    await s.drop().catch(() => {});
    await s.dispose();
  }
});

describe("two stores in one schema", () => {
  it("keep separate checkpoints, and one drop does not disturb the other", async () => {
    await alpha.seed();
    await beta.seed();

    // Advance each to a different position.
    const [la] = await lease(alpha, "corr-a");
    expect(la.at).toBe(-1);
    await release(alpha, "corr-a", 100);

    const [lb] = await lease(beta, "corr-b");
    expect(lb.at).toBe(-1);
    await release(beta, "corr-b", 7);

    // Neither sees the other's value.
    expect(await peek(alpha)).toBe(100);
    expect(await peek(beta)).toBe(7);

    // Dropping one leaves the other's checkpoint intact — the property a
    // shared checkpoint table could not offer.
    await beta.drop();
    expect(await peek(alpha)).toBe(100);

    // And a re-seeded store starts clean rather than inheriting anything.
    await beta.seed();
    expect(await peek(beta)).toBe(-1);
  });

  it("leases are independent — holding one does not block the other", async () => {
    await alpha.seed();
    await beta.seed();
    expect(await lease(alpha, "holder", 30_000)).toHaveLength(1);
    // Same holder id, different scope: must not collide.
    expect(await lease(beta, "holder", 30_000)).toHaveLength(1);
    await release(alpha, "holder", 1);
    await release(beta, "holder", 1);
  });
});
