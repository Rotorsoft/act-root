import { z } from "zod";
import * as adapter from "../src/adapter.js";
import { package_schema } from "../src/config.js";
import * as root from "../src/index.js";
import { resolveAutocloseConfig } from "../src/internal/config.js";
import { unscoped_ports } from "../src/ports.js";
import { sensitiveFields } from "../src/sensitive.js";
import * as types from "../src/types/index.js";
import { ValidationError } from "../src/types/index.js";

// Each name the root keeps for 2.x callers is the very function or value it
// points at, so a caller on the old name sees no difference until 3.0.
describe("deprecated root names (removed in 3.0)", () => {
  const exported = new Map(Object.entries(root));

  it.each([
    ["check_appends", adapter.checkAppends],
    ["throw_if_stale", adapter.checkVersion],
    ["concurrency_error", adapter.concurrencyError],
    ["seed_event", adapter.seedEvent],
    ["fair_slots", adapter.fairSlots],
    ["is_literal_source", adapter.isStreamName],
    ["notification_of", adapter.parseNotification],
    ["pii_fields", sensitiveFields],
    ["DEFAULT_QUERY_STREAMS_LIMIT", types.DEFAULT_QUERY_STREAMS_LIMIT],
    ["ActorSchema", types.ActorSchema],
    ["TargetSchema", types.TargetSchema],
    ["EventMetaSchema", types.EventMetaSchema],
    ["CausationEventSchema", types.CausationEventSchema],
    ["CommittedMetaSchema", types.CommittedMetaSchema],
    ["QuerySchema", types.QuerySchema],
    ["Environments", types.Environments],
    ["LogLevels", types.LogLevels],
    ["ExitCodes", types.ExitCodes],
    ["DEFAULT_LANE", types.DEFAULT_LANE],
    ["DEFAULT_MAX_SUBSCRIBED_STREAMS", types.DEFAULT_MAX_SUBSCRIBED_STREAMS],
    ["DEFAULT_SETTLE_DEBOUNCE_MS", types.DEFAULT_SETTLE_DEBOUNCE_MS],
    ["PackageSchema", package_schema],
    ["default_scope", unscoped_ports],
  ])("%s is its replacement", (name, replacement) => {
    expect(exported.get(name)).toBe(replacement);
  });

  it("pii_fields stays on /types too, beside sensitiveFields", () => {
    expect(types.pii_fields).toBe(types.sensitiveFields);
  });

  it("resolveAutocloseConfig still validates like act().build()", () => {
    const options = { autocloseWindow: { start: 1, end: 5 } };
    expect(root.resolveAutocloseConfig(options)).toEqual(
      resolveAutocloseConfig(options)
    );
    expect(() =>
      root.resolveAutocloseConfig({ autocloseWindow: { start: -1, end: 5 } })
    ).toThrow();
  });
});

const schema = z.object({ key: z.string() });

describe("extend (deprecated)", () => {
  it("should extend target with validated source", () => {
    const source = { key: "value" };
    const target = { otherKey: 123 };
    const extended = root.extend(source, schema, target);
    expect(extended).toEqual({ otherKey: 123, key: "value" });
  });

  it("should throw ValidationError on invalid source", () => {
    const source = { key: 123 };
    const target = { otherKey: 123 };
    // @ts-expect-error invalid source
    expect(() => root.extend(source, schema, target)).toThrow(ValidationError);
  });

  it("should extend with no target", () => {
    const schema = z.object({ key: z.string() });
    const source = { key: "value" };
    const extended = root.extend(source, schema);
    expect(extended).toEqual({ key: "value" });
  });

  it("should not mutate the target object across calls", () => {
    const defaults = { otherKey: 123 };
    const snapshot = { ...defaults };

    root.extend({ key: "first" }, schema, defaults);
    root.extend({ key: "second" }, schema, defaults);

    // defaults must remain pristine — extend returns a new object,
    // not a mutated target. Otherwise shared defaults leak across calls.
    expect(defaults).toEqual(snapshot);
    expect(defaults).not.toHaveProperty("key");
  });
});

describe("dateReviver (deprecated)", () => {
  it("returns a Date for a valid ISO-8601 string", () => {
    const iso = "2023-01-01T10:00:00.000Z";
    const result = root.dateReviver("key", iso);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe(iso);
  });

  it("rolls over invalid dates that still match the pattern", () => {
    // 2023-02-30 is well-formed but not a real date — Date rolls it to Mar 2.
    const result = root.dateReviver("key", "2023-02-30T10:00:00.000Z") as Date;
    expect(result).toBeInstanceOf(Date);
    expect(result.getUTCFullYear()).toBe(2023);
    expect(result.getUTCMonth()).toBe(2);
    expect(result.getUTCDate()).toBe(2);
  });

  it("passes non-string values through untouched", () => {
    const n = 12345;
    expect(root.dateReviver("key", n)).toBe(n);
  });

  it("passes non-date strings through untouched", () => {
    expect(root.dateReviver("key", "hello world")).toBe("hello world");
  });

  it("revives dates nested anywhere in a JSON.parse", () => {
    const parsed = JSON.parse(
      '{"at":"2024-03-01T10:20:30.000Z","nested":{"born":"2024-03-01T10:20:30.000Z"},"plain":"nope"}',
      root.dateReviver
    );
    expect(parsed.at).toBeInstanceOf(Date);
    expect(parsed.nested.born).toBeInstanceOf(Date);
    expect(parsed.plain).toBe("nope");
  });
});
