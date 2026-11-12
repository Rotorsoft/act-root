import * as adapter from "../src/adapter.js";
import { parseNotification } from "../src/adapter.js";

// The other rules run through every store in the TCK; these pin what the
// subpath publishes and the one rule a broker reads on its own.
describe("@rotorsoft/act/adapter", () => {
  it("publishes exactly the seven rules a store calls", () => {
    expect(Object.keys(adapter).sort()).toEqual([
      "checkAppends",
      "checkVersion",
      "concurrencyError",
      "fairSlots",
      "isStreamName",
      "parseNotification",
      "seedEvent",
    ]);
  });
});

describe("parseNotification", () => {
  it("reads a well-formed notification, keeping only id and name", () => {
    expect(
      parseNotification({
        stream: "s",
        by: "other",
        events: [{ id: 7, name: "Incremented", extra: true }],
      })
    ).toEqual({ stream: "s", events: [{ id: 7, name: "Incremented" }] });
  });

  it("drops malformed events and keeps the rest", () => {
    expect(
      parseNotification({
        stream: "s",
        events: [{ name: "no-id" }, null, { id: 1, name: "A" }],
      })
    ).toEqual({ stream: "s", events: [{ id: 1, name: "A" }] });
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["a string", "s"],
    ["a non-string stream", { stream: 42, events: [{ id: 1, name: "A" }] }],
    ["no events", { stream: "s" }],
    ["events that aren't a list", { stream: "s", events: "nope" }],
    ["an empty list", { stream: "s", events: [] }],
    [
      "only malformed events",
      { stream: "s", events: [{ id: "1", name: "X" }, null] },
    ],
  ])("finds no notification in %s", (_, raw) => {
    expect(parseNotification(raw)).toBeUndefined();
  });
});
