/**
 * Adapter-layer envelope encryption for the `events.pii` column (#921).
 *
 * The framework's `pii_isolation` capability is covered by the shared
 * store TCK; that suite asserts the round-trip of `pii` payloads in the
 * clear. This spec is orthogonal — it exercises the optional encryption
 * shell that wraps the column when an operator opts in via
 * `pii_encryption`. Round-trip, on-disk ciphertext, forget semantics
 * post-encryption, wrong-key / tampered-payload fault injection, and
 * mixed-data rollout from a pre-encryption baseline.
 */
import { randomBytes } from "node:crypto";
import { DecryptionError } from "@rotorsoft/act-crypto";
import { Chance } from "chance";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/index.js";
import { schema } from "./schema.js";

const chance = new Chance();
const PORT = 5431;
const SCHEMA = schema("schema_pii_enc");
const TABLE = "pii_enc_events";

function buildStore(key: Buffer | (() => Buffer | Promise<Buffer>)) {
  return new PostgresStore({
    port: PORT,
    schema: SCHEMA,
    table: TABLE,
    pii_encryption: {
      keyProvider: typeof key === "function" ? key : () => key,
      algorithm: "aes-256-gcm",
    },
  });
}

function buildPlainStore() {
  return new PostgresStore({
    port: PORT,
    schema: SCHEMA,
    table: TABLE,
  });
}

const rawPool = new Pool({
  port: PORT,
  user: "postgres",
  password: "postgres",
  database: "postgres",
});

describe("PostgresStore pii_encryption", () => {
  beforeAll(async () => {
    const setup = buildPlainStore();
    await setup.drop();
    await setup.seed();
    await setup.dispose();
  });

  afterAll(async () => {
    await rawPool.end();
  });

  it("round-trips an event's pii through commit and query (encrypted at rest)", async () => {
    const key = randomBytes(32);
    const store = buildStore(key);
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

    const seen: Array<{
      pii: Record<string, unknown> | null;
      name: string;
    }> = [];
    await store.query(
      (e) =>
        void seen.push({
          pii: e.pii as Record<string, unknown> | null,
          name: e.name as string,
        }),
      { stream, stream_exact: true }
    );
    expect(seen[0]?.pii).toEqual({
      email: "alice@example.com",
      name: "Alice",
    });

    // Confirm the on-disk shape is a JSONB string, not a JSONB object.
    const { rows } = await rawPool.query(
      `SELECT pii FROM "${SCHEMA}"."${TABLE}" WHERE stream = $1`,
      [stream]
    );
    expect(typeof rows[0]!.pii).toBe("string");
    expect((rows[0]!.pii as string).length).toBeGreaterThan(0);
    // Plaintext fields must never appear in the on-disk value.
    expect(rows[0]!.pii as string).not.toContain("alice@example.com");

    await store.dispose();
  });

  it("forget_pii nulls the column regardless of ciphertext (semantics unchanged)", async () => {
    const key = randomBytes(32);
    const store = buildStore(key);
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

    const wiped = await store.forget_pii(stream);
    expect(wiped).toBe(2);

    const seen: Array<{ pii: unknown }> = [];
    await store.query((e) => void seen.push({ pii: e.pii }), {
      stream,
      stream_exact: true,
    });
    expect(seen).toHaveLength(2);
    expect(seen.every((e) => e.pii == null)).toBe(true);

    // A second call returns 0 — idempotent.
    expect(await store.forget_pii(stream)).toBe(0);

    await store.dispose();
  });

  it("passes through events with no pii (encryption only wraps non-null payloads)", async () => {
    const key = randomBytes(32);
    const store = buildStore(key);
    const stream = `none-${chance.guid()}`;

    await store.commit(stream, [{ name: "Ping", data: { n: 1 } }], {
      correlation: "c3",
      causation: {},
    });

    const { rows } = await rawPool.query(
      `SELECT pii FROM "${SCHEMA}"."${TABLE}" WHERE stream = $1`,
      [stream]
    );
    expect(rows[0]!.pii).toBeNull();

    const seen: Array<{ pii: unknown }> = [];
    await store.query((e) => void seen.push({ pii: e.pii }), {
      stream,
      stream_exact: true,
    });
    expect(seen[0]!.pii).toBeNull();

    await store.dispose();
  });

  it("throws DecryptionError when the read key disagrees with the write key", async () => {
    const writeKey = randomBytes(32);
    const readKey = randomBytes(32);

    const writer = buildStore(writeKey);
    const reader = buildStore(readKey);
    const stream = `wrongkey-${chance.guid()}`;

    await writer.commit(
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

    await expect(
      reader.query(() => {}, { stream, stream_exact: true })
    ).rejects.toBeInstanceOf(DecryptionError);

    await writer.dispose();
    await reader.dispose();
  });

  it("throws DecryptionError on tampered ciphertext", async () => {
    const key = randomBytes(32);
    const store = buildStore(key);
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

    // Replace the ciphertext with something base64-shaped but unrelated.
    const junk = randomBytes(64).toString("base64");
    await rawPool.query(
      `UPDATE "${SCHEMA}"."${TABLE}" SET pii = $1::jsonb WHERE stream = $2`,
      [JSON.stringify(junk), stream]
    );

    await expect(
      store.query(() => {}, { stream, stream_exact: true })
    ).rejects.toBeInstanceOf(DecryptionError);

    await store.dispose();
  });

  it("names the stream and event id on an unreadable row (#1675)", async () => {
    // The generic message is deliberate — it must not say WHICH failure mode
    // was hit. The stream and id are not secret, and without them the read
    // that trips aborts the whole scan without naming the row to repair.
    const key = randomBytes(32);
    const store = buildStore(key);
    const stream = `locate-${chance.guid()}`;

    await store.commit(
      stream,
      [{ name: "UserRegistered", data: {}, pii: { email: "z@example.com" } }],
      { correlation: "c-locate", causation: {} }
    );

    const rows = await rawPool.query<{ id: string }>(
      `SELECT id FROM "${SCHEMA}"."${TABLE}" WHERE stream = $1`,
      [stream]
    );
    const id = Number(rows.rows[0]!.id);

    const junk = randomBytes(64).toString("base64");
    await rawPool.query(
      `UPDATE "${SCHEMA}"."${TABLE}" SET pii = $1::jsonb WHERE stream = $2`,
      [JSON.stringify(junk), stream]
    );

    const error = await store
      .query(() => {}, { stream, stream_exact: true })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    // Still the framework signal callers catch.
    expect(error).toBeInstanceOf(DecryptionError);
    // Machine-readable, so a caller acts without parsing the message.
    expect(error).toMatchObject({ stream, event_id: id });
    expect((error as Error).message).toContain(stream);
    expect((error as Error).message).toContain(String(id));
    // The original failure is preserved rather than replaced.
    expect((error as Error).cause).toBeInstanceOf(DecryptionError);

    await store.dispose();
  });

  it("passes a non-decryption failure through untouched", async () => {
    // A key provider that returns the wrong shape fails inside the resolver,
    // not the cipher — a plain Error, not a DecryptionError. Locating it as a
    // poison row would be a lie, so it travels as-is.
    const key = randomBytes(32);
    const writer = buildStore(key);
    const stream = `badkey-${chance.guid()}`;

    await writer.commit(
      stream,
      [{ name: "UserRegistered", data: {}, pii: { email: "q@example.com" } }],
      { correlation: "c-badkey", causation: {} }
    );

    const reader = buildStore(() => Buffer.alloc(8));
    const error = await reader
      .query(() => {}, { stream, stream_exact: true })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DecryptionError);
    expect(error).not.toHaveProperty("event_id");

    await writer.dispose();
    await reader.dispose();
  });

  it("locates a decrypt failure in the commit echo too", async () => {
    // The echo decrypts the rows it just wrote, so it cannot fail against a
    // stable key. Swap the resolver between the encrypt and the decrypt —
    // private-state fault injection, the only way to reach this branch.
    const key = randomBytes(32);
    const other = randomBytes(32);
    const store = buildStore(key);
    const stream = `echo-${chance.guid()}`;

    let calls = 0;
    (store as unknown as { _resolve_pii_key: () => Buffer })._resolve_pii_key =
      () => (++calls === 1 ? key : other);

    const error = await store
      .commit(
        stream,
        [{ name: "UserRegistered", data: {}, pii: { email: "e@example.com" } }],
        { correlation: "c-echo", causation: {} }
      )
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(error).toBeInstanceOf(DecryptionError);
    expect(error).toMatchObject({ stream });
    expect((error as { event_id: number }).event_id).toBeTypeOf("number");

    await store.dispose();
  });

  it("reads pre-encryption (plaintext object) rows transparently", async () => {
    // Operator wrote some events before enabling encryption, then
    // restarted with pii_encryption configured. New writes are
    // encrypted; old rows stay readable because the store
    // discriminates by typeof (string → decrypt, object → passthrough).
    const plain = buildPlainStore();
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

    const enc = buildStore(randomBytes(32));
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

    const seen: Array<{ pii: Record<string, unknown> | null }> = [];
    await enc.query(
      (e) => void seen.push({ pii: e.pii as Record<string, unknown> | null }),
      { stream, stream_exact: true }
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]!.pii).toEqual({ email: "legacy@example.com" });
    expect(seen[1]!.pii).toEqual({ email: "current@example.com" });

    await enc.dispose();
  });

  it("encrypts via the restore driver (rebuild path is symmetric)", async () => {
    const key = randomBytes(32);
    const store = buildStore(key);

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
      // A second event with no pii — exercises the null branch on the
      // restore path.
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

    // The on-disk pii is encrypted for the first event, null for the
    // second.
    const { rows } = await rawPool.query(
      `SELECT version, pii FROM "${SCHEMA}"."${TABLE}" WHERE stream = $1 ORDER BY version`,
      [stream]
    );
    expect(typeof rows[0]!.pii).toBe("string");
    expect(rows[1]!.pii).toBeNull();

    const seen: Array<{ version: number; pii: unknown }> = [];
    await store.query(
      (e) =>
        void seen.push({
          version: e.version,
          pii: e.pii,
        }),
      { stream, stream_exact: true }
    );
    expect(seen[0]!.pii).toEqual({ email: "restored@example.com" });
    expect(seen[1]!.pii).toBeNull();

    await store.dispose();
  });

  it("round-trips a Date in pii losslessly under encryption (#1370/#1556)", async () => {
    // Encryption is an at-rest concern: a Date must survive it as a Date,
    // exactly as it does on the plaintext path. `data.at` is the in-row
    // control — it never travels through the envelope.
    const key = randomBytes(32);
    const store = buildStore(key);
    const stream = `date-enc-${chance.guid()}`;
    const when = new Date("2024-03-01T10:20:30.000Z");

    await store.commit(
      stream,
      [
        {
          name: "Probed",
          data: { at: when },
          pii: { born: when },
        },
      ] as never,
      { correlation: chance.guid(), causation: {} }
    );

    const rows: Array<{ data: unknown; pii: unknown }> = [];
    await store.query((e) => rows.push(e as never), { stream });

    expect(rows).toHaveLength(1);
    // The store returns what it stored, identically in both columns —
    // encryption is an at-rest concern, not a payload-type change. Typing
    // these back to `Date` is the framework's job, from the declared
    // `z.date()` (#1556).
    expect(typeof (rows[0].data as { at: unknown }).at).toBe("string");
    expect(typeof (rows[0].pii as { born: unknown }).born).toBe("string");
    expect((rows[0].pii as { born: string }).born).toBe(when.toISOString());

    await store.dispose();
  });
});
