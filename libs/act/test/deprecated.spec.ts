import * as adapter from "../src/adapter.js";
import { PackageSchema } from "../src/config.js";
import * as root from "../src/index.js";
import { resolveAutocloseConfig } from "../src/internal/config.js";
import { default_scope } from "../src/ports.js";
import { sensitiveFields } from "../src/sensitive.js";
import * as types from "../src/types/index.js";
import { extend } from "../src/utils.js";

// Each name the root keeps for 2.x callers is the very function or value it
// points at, so a caller on the old name sees no difference until 3.0.
describe("deprecated root names (removed in 3.0)", () => {
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
    ["PackageSchema", PackageSchema],
    ["default_scope", default_scope],
    ["extend", extend],
  ])("%s is its replacement", (name, replacement) => {
    expect(root[name as keyof typeof root]).toBe(replacement);
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
