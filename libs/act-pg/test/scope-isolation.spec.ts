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

import { afterAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/index.js";

const make = (table: string) =>
  new PostgresStore({ port: 5431, schema: "public", table });

const stores = [make("scope_iso_alpha"), make("scope_iso_beta")];
const [alpha, beta] = stores;

const peek = async (s: PostgresStore) => (await s.subscribe([])).correlated_at;

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
    expect(await peek(alpha)).toBe(-1);
    await alpha.subscribe([], 100);
    expect(await peek(beta)).toBe(-1);
    await beta.subscribe([], 7);

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

  it("advancing one scope's checkpoint leaves the other alone", async () => {
    await alpha.seed();
    await beta.seed();
    await alpha.subscribe([], 5_000);
    expect(await peek(alpha)).toBe(5_000);
    expect(await peek(beta)).toBeLessThan(5_000);
  });
});
