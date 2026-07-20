/**
 * Adapter-layer envelope encryption for the `events.pii` column (#921),
 * SQLite side. Mirrors the PG suite: round-trip + on-disk ciphertext,
 * forget semantics, wrong-key / tampered-payload fault injection,
 * mixed-data rollout, restore-path symmetry.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { type Client, createClient } from "@libsql/client";
import { DecryptionError } from "@rotorsoft/act-crypto";
import { Chance } from "chance";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/index.js";

const chance = new Chance();

async function freshStore(
  key?: Buffer | (() => Buffer | Promise<Buffer>)
): Promise<{ store: SqliteStore; raw: Client; url: string; path: string }> {
  // libSQL's `file::memory:` doesn't share state across client
  // instances, so we use a scratch file per test (matches the
  // priority.spec.ts pattern) — that way the raw client below can
  // read the same rows the SqliteStore committed.
  const path = `/tmp/act-pii-enc-${randomUUID()}.db`;
  const url = `file:${path}`;
  const store = new SqliteStore({
    url,
    pii_encryption: key
      ? {
          keyProvider: typeof key === "function" ? key : () => key,
          algorithm: "aes-256-gcm",
        }
      : undefined,
  });
  await store.seed();
  const raw = createClient({ url });
  return { store, raw, url, path };
}

describe("SqliteStore pii_encryption", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length) {
      await cleanup.pop()!();
    }
  });

  function track(s: SqliteStore, r: Client, path: string) {
    cleanup.push(async () => {
      await s.dispose();
      r.close();
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
    });
  }

  it("round-trips an event's pii through commit and query (encrypted at rest)", async () => {
    const key = randomBytes(32);
    const { store, raw, path } = await freshStore(key);
    track(store, raw, path);
    const stream = `roundtrip-${chance.guid()}`;

    const committed = await store.commit(
      stream,
      [
        {
          name: "UserRegistered",
          data: { plan: "gold" },
          pii: { email: "alice@example.com", name: "Alice" },
        },
      ],
      { correlation: "c1", causation: {} }
    );
    expect(committed[0]?.pii).toEqual({
      email: "alice@example.com",
      name: "Alice",
    });

    const seen: Array<{ pii: unknown; name: string }> = [];
    await store.query(
      (e) => void seen.push({ pii: e.pii, name: e.name as string }),
      { stream, stream_exact: true }
    );
    expect(seen[0]?.pii).toEqual({
      email: "alice@example.com",
      name: "Alice",
    });

    // On-disk: the pii column is a JSON-stringified base64 string,
    // not the cleartext object.
    const raw_row = await raw.execute({
      sql: "SELECT pii FROM events WHERE stream = ?",
      args: [stream],
    });
    const raw_pii = raw_row.rows[0]!.pii as string;
    expect(typeof raw_pii).toBe("string");
    // JSON-stringified base64 starts with `"` and the inner string
    // doesn't contain plaintext email.
    expect(raw_pii.startsWith('"')).toBe(true);
    expect(raw_pii).not.toContain("alice@example.com");
  });

  it("forget_pii nulls the column regardless of ciphertext", async () => {
    const key = randomBytes(32);
    const { store, raw, path } = await freshStore(key);
    track(store, raw, path);
    const stream = `forget-${chance.guid()}`;

    await store.commit(
      stream,
      [
        {
          name: "UserRegistered",
          data: {},
          pii: { email: "bob@example.com" },
        },
        {
          name: "UserUpdated",
          data: {},
          pii: { email: "bob+new@example.com" },
        },
      ],
      { correlation: "c2", causation: {} }
    );

    expect(await store.forget_pii(stream)).toBe(2);

    const seen: Array<{ pii: unknown }> = [];
    await store.query((e) => void seen.push({ pii: e.pii }), {
      stream,
      stream_exact: true,
    });
    expect(seen).toHaveLength(2);
    expect(seen.every((e) => e.pii == null)).toBe(true);

    // Idempotent on a second call.
    expect(await store.forget_pii(stream)).toBe(0);
  });

  it("passes through events with no pii (encryption only wraps non-null payloads)", async () => {
    const key = randomBytes(32);
    const { store, raw, path } = await freshStore(key);
    track(store, raw, path);
    const stream = `none-${chance.guid()}`;

    await store.commit(stream, [{ name: "Ping", data: { n: 1 } }], {
      correlation: "c3",
      causation: {},
    });

    const raw_row = await raw.execute({
      sql: "SELECT pii FROM events WHERE stream = ?",
      args: [stream],
    });
    expect(raw_row.rows[0]!.pii).toBeNull();

    const seen: Array<{ pii: unknown }> = [];
    await store.query((e) => void seen.push({ pii: e.pii }), {
      stream,
      stream_exact: true,
    });
    expect(seen[0]!.pii).toBeNull();
  });

  it("throws DecryptionError when the read key disagrees with the write key", async () => {
    const writeKey = randomBytes(32);
    const readKey = randomBytes(32);
    const writer = await freshStore(writeKey);
    track(writer.store, writer.raw, writer.path);
    const stream = `wrongkey-${chance.guid()}`;

    await writer.store.commit(
      stream,
      [
        {
          name: "UserRegistered",
          data: {},
          pii: { email: "x@example.com" },
        },
      ],
      { correlation: "c4", causation: {} }
    );

    // A second store on the same shared-memory URL but a different
    // key reads the ciphertext and trips the auth-tag check.
    const reader = new SqliteStore({
      url: writer.url,
      pii_encryption: {
        keyProvider: () => readKey,
        algorithm: "aes-256-gcm",
      },
    });
    cleanup.push(async () => {
      await reader.dispose();
    });

    await expect(
      reader.query(() => {}, { stream, stream_exact: true })
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("throws DecryptionError on tampered ciphertext", async () => {
    const key = randomBytes(32);
    const { store, raw, path } = await freshStore(key);
    track(store, raw, path);
    const stream = `tamper-${chance.guid()}`;

    await store.commit(
      stream,
      [
        {
          name: "UserRegistered",
          data: {},
          pii: { email: "y@example.com" },
        },
      ],
      { correlation: "c5", causation: {} }
    );

    // Overwrite the pii column with a base64-shaped but unrelated payload.
    const junk = JSON.stringify(randomBytes(64).toString("base64"));
    await raw.execute({
      sql: "UPDATE events SET pii = ? WHERE stream = ?",
      args: [junk, stream],
    });

    await expect(
      store.query(() => {}, { stream, stream_exact: true })
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("reads pre-encryption (plaintext object) rows transparently", async () => {
    // Operator wrote some events before enabling encryption, then
    // restarted with pii_encryption configured. New writes are
    // encrypted; old rows stay readable because the type discriminator
    // (string after JSON.parse → ciphertext, object → plaintext)
    // lets both kinds pass through one read path.
    const path = `/tmp/act-pii-mixed-${randomUUID()}.db`;
    const url = `file:${path}`;
    const plain = new SqliteStore({ url });
    await plain.seed();
    const stream = `mixed-${chance.guid()}`;
    await plain.commit(
      stream,
      [
        {
          name: "UserRegistered",
          data: {},
          pii: { email: "legacy@example.com" },
        },
      ],
      { correlation: "c6a", causation: {} }
    );
    await plain.dispose();

    const enc = new SqliteStore({
      url,
      pii_encryption: {
        keyProvider: () => randomBytes(32),
        algorithm: "aes-256-gcm",
      },
    });
    cleanup.push(async () => {
      await enc.dispose();
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
    });
    await enc.commit(
      stream,
      [
        {
          name: "UserUpdated",
          data: {},
          pii: { email: "current@example.com" },
        },
      ],
      { correlation: "c6b", causation: {} }
    );

    const seen: Array<{ pii: unknown }> = [];
    await enc.query((e) => void seen.push({ pii: e.pii }), {
      stream,
      stream_exact: true,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.pii).toEqual({ email: "legacy@example.com" });
    expect(seen[1]!.pii).toEqual({ email: "current@example.com" });
  });

  it("encrypts via the restore driver (rebuild path is symmetric)", async () => {
    const key = randomBytes(32);
    const { store, raw, path } = await freshStore(key);
    track(store, raw, path);
    const stream = `restore-${chance.guid()}`;

    await store.restore(async (insert) => {
      await insert({
        id: 0,
        stream,
        version: 0,
        name: "UserRegistered",
        data: {},
        pii: { email: "restored@example.com" },
        created: new Date("2025-01-01T00:00:00Z"),
        meta: { correlation: "c7", causation: {} },
      });
      await insert({
        id: 1,
        stream,
        version: 1,
        name: "Ping",
        data: { n: 1 },
        created: new Date("2025-01-01T00:01:00Z"),
        meta: { correlation: "c7", causation: {} },
      });
    });

    const raw_rows = await raw.execute({
      sql: "SELECT version, pii FROM events WHERE stream = ? ORDER BY version",
      args: [stream],
    });
    expect(typeof raw_rows.rows[0]!.pii).toBe("string");
    expect(raw_rows.rows[1]!.pii).toBeNull();

    const seen: Array<{ version: number; pii: unknown }> = [];
    await store.query(
      (e) => void seen.push({ version: e.version, pii: e.pii }),
      { stream, stream_exact: true }
    );
    expect(seen[0]!.pii).toEqual({ email: "restored@example.com" });
    expect(seen[1]!.pii).toBeNull();
  });

  it("never carries pii on query_stats head/tail — the operator-introspection surface is pii-safe (#1294)", async () => {
    const key = randomBytes(32);
    const { store, raw, path } = await freshStore(key);
    track(store, raw, path);
    const stream = `stats-${chance.guid()}`;

    await store.commit(
      stream,
      [
        {
          name: "UserRegistered",
          data: {},
          pii: { email: "head@example.com" },
        },
        {
          name: "UserUpdated",
          data: {},
          pii: { email: "tail@example.com" },
        },
      ],
      { correlation: "c8", causation: {} }
    );

    // `query_stats` has no actor context and no disclosure gate, so it must
    // not leak the plaintext pii the way `query`/`load` (gated) can. Matches
    // PostgresStore and InMemoryStore, which omit the pii column entirely.
    const stats = await store.query_stats([stream], { tail: true });
    const entry = stats.get(stream);
    expect(entry?.head?.pii).toBeUndefined();
    expect(entry?.tail?.pii).toBeUndefined();

    // Same on the full-scan code path (count + names → exercises the second
    // `to_committed` closure, including its tail branch).
    const full = await store.query_stats([stream], {
      tail: true,
      count: true,
      names: true,
    });
    const full_entry = full.get(stream);
    expect(full_entry?.head?.pii).toBeUndefined();
    expect(full_entry?.tail?.pii).toBeUndefined();
    expect(full_entry?.count).toBe(2);

    // The pii is still durably stored (ciphertext on disk) — this surface
    // just doesn't surface it. `query` (gated) still round-trips it.
    const raw_rows = await raw.execute({
      sql: "SELECT pii FROM events WHERE stream = ? ORDER BY version",
      args: [stream],
    });
    expect(typeof raw_rows.rows[0]!.pii).toBe("string");
  });
});
