import type { EventMeta } from "@rotorsoft/act";
import { ValidationError } from "@rotorsoft/act";
import { PostgresStore } from "../src/index.js";
import { schema } from "./schema.js";

/**
 * #1422 — a NUL byte is legal JSON and a legal JS string, so it passes Zod
 * and reaches the store. InMemory and SQLite (TEXT) round-trip it; only
 * Postgres refuses, and from two different places — the jsonb parser for
 * `data` / `meta` / `pii`, and the UTF-8 decoder for the text columns.
 *
 * The framework deliberately does not pre-screen payloads for this. Doing so
 * means walking every payload on the framework's hottest path to enforce one
 * adapter's storage limit on all three: measured against the Zod parse it
 * would ride along with, a recursive NUL walk costs ~2.7x the parse itself.
 * What is worth doing is making Postgres's refusal legible — the driver's own
 * message ("unsupported Unicode escape sequence") names neither the stream
 * nor the event, which is what made this expensive to diagnose.
 */
describe("NUL bytes are refused by Postgres, legibly (#1422)", () => {
  const NUL = String.fromCharCode(0);
  const store = new PostgresStore({
    port: 5431,
    schema: schema("nul_1422"),
    table: "events",
  });
  const meta: EventMeta = { correlation: "", causation: {} };

  beforeAll(async () => {
    await store.drop();
    await store.seed();
  });

  afterAll(async () => {
    await store.drop();
    await store.dispose();
  });

  it("translates the jsonb parser's refusal (22P05)", async () => {
    const err = await store
      .commit("nul-data", [{ name: "Noted", data: { note: `a${NUL}b` } }], meta)
      .catch((e) => e as Error);

    expect(err).toBeInstanceOf(ValidationError);
    const details = String((err as ValidationError).details);
    // Names the stream and the event — the whole point of translating.
    expect(details).toContain("nul-data");
    expect(details).toContain("Noted");
    // And keeps the driver's own words, so the SQLSTATE stays searchable.
    expect(details).toContain("unsupported Unicode escape sequence");
  });

  it("translates the text column's refusal too (22021)", async () => {
    // `name` is text, so this trips the UTF-8 decoder rather than the jsonb
    // parser — a different SQLSTATE for the same user mistake.
    const err = await store
      .commit("nul-name", [{ name: `No${NUL}ted`, data: {} }], meta)
      .catch((e) => e as Error);

    expect(err).toBeInstanceOf(ValidationError);
    expect(String((err as ValidationError).details)).toContain(
      "invalid byte sequence"
    );
  });

  it("control — the same payload without a NUL commits", async () => {
    const committed = await store.commit(
      "nul-control",
      [{ name: "Noted", data: { note: "ab" } }],
      meta
    );
    expect(committed.length).toBe(1);
    expect(committed[0].data).toEqual({ note: "ab" });
  });
});
