import { describe, expect, it } from "vitest";
import { buildContractIndex } from "../src/cli/contract-index.js";
import { formatMarkdown } from "../src/cli/markdown.js";
import type { DomainModel } from "../src/client/types/index.js";

function richModel(): DomainModel {
  return {
    entries: [],
    states: [
      {
        name: "Order",
        varName: "Order:0",
        file: "src/order.ts",
        line: 1,
        events: [
          {
            name: "OrderPlaced",
            hasCustomPatch: true,
            line: 12,
            schema: "z.object({ id: z.string() })",
          },
          {
            name: "OrderPlaced_v2",
            hasCustomPatch: false,
            line: 14,
            schema: "z.object({ id: z.string(), total: z.number() })",
          },
        ],
        actions: [
          {
            name: "placeOrder",
            emits: ["OrderPlaced", "OrderPlaced_v2"],
            invariants: ["fresh-cart", "non-empty"],
            line: 30,
          },
          { name: "noop", emits: [], invariants: [] },
        ],
      },
    ],
    slices: [
      {
        name: "Fulfillment",
        states: ["Order:0"],
        stateVars: ["Order:0"],
        projections: ["OrdersByCustomer"],
        file: "src/fulfillment.ts",
        line: 5,
        reactions: [
          {
            event: "OrderPlaced_v2",
            handlerName: "reserveStock",
            dispatches: ["reserve"],
            line: 18,
          },
          { event: "OrderShipped", handlerName: "noTriggers", dispatches: [] },
        ],
      },
      {
        name: "Broken",
        states: [],
        stateVars: [],
        projections: [],
        reactions: [],
        error: "could not parse",
      },
    ],
    projections: [
      {
        name: "OrdersByCustomer",
        varName: "OrdersByCustomer",
        handles: ["OrderPlaced_v2"],
        file: "src/projections.ts",
      },
      { name: "Empty", varName: "Empty", handles: [] },
    ],
    reactions: [
      {
        event: "OrderPlaced",
        handlerName: "auditOldEvent",
        dispatches: ["audit"],
        file: "src/audit.ts",
      },
    ],
  };
}

describe("formatMarkdown", () => {
  const idx = buildContractIndex(richModel());
  const md = formatMarkdown(idx);

  it("opens with a generated-by header and counts", () => {
    expect(md).toMatch(/^# Act Contracts Registry/);
    expect(md).toContain("1 states");
    expect(md).toContain("2 slices");
    expect(md).toContain("2 projections");
    expect(md).toContain("3 events");
  });

  it("renders an Events section with schema, status, producers, consumers", () => {
    expect(md).toContain("## Events");
    expect(md).toContain("### `OrderPlaced`");
    expect(md).toContain("**schema:** `z.object({ id: z.string() })`");
    expect(md).toContain(
      "**status:** deprecated — superseded by **OrderPlaced_v2**"
    );
    expect(md).toContain("- `placeOrder` (state `Order`)");
    expect(md).toContain("reaction `auditOldEvent`");
    // The v2 event lists Fulfillment::reserveStock as a consumer.
    expect(md).toContain("reaction `Fulfillment`::`reserveStock`");
    expect(md).toContain("projection `OrdersByCustomer`");
  });

  it("renders an Actions section with invariants and emits", () => {
    expect(md).toContain("## Actions");
    expect(md).toContain("### `placeOrder`");
    expect(md).toContain("**invariants:**");
    expect(md).toContain("- fresh-cart");
    expect(md).toContain("- non-empty");
    expect(md).toContain("- `OrderPlaced`");
    expect(md).toContain("- `OrderPlaced_v2`");
    // noop has no emits; the placeholder shows up.
    expect(md).toContain("### `noop`");
    expect(md).toMatch(/### `noop`[\s\S]*\*\*emits:\*\* _\(none\)_/);
  });

  it("renders a States section with action and event lists", () => {
    expect(md).toContain("## States");
    expect(md).toContain("### `Order`");
    expect(md).toContain("**actions:** `placeOrder`, `noop`");
    expect(md).toContain("**events:** `OrderPlaced`, `OrderPlaced_v2`");
  });

  it("renders a Slices section including errors and reactions without triggers", () => {
    expect(md).toContain("## Slices");
    expect(md).toContain("### `Fulfillment`");
    expect(md).toContain("**states:** `Order:0`");
    expect(md).toContain("**projections:** `OrdersByCustomer`");
    expect(md).toContain("- `OrderPlaced_v2` → `reserveStock` → `reserve`");
    expect(md).toContain("- `OrderShipped` → `noTriggers`");
    expect(md).toContain("### `Broken`");
    expect(md).toContain("**error:** could not parse");
  });

  it("renders a Projections section with empty-projection handling", () => {
    expect(md).toContain("## Projections");
    expect(md).toContain("### `OrdersByCustomer`");
    expect(md).toContain("**handles:** `OrderPlaced_v2`");
    expect(md).toContain("### `Empty`");
  });

  it("renders a Reactions section with slice and triggers", () => {
    expect(md).toContain("## Reactions");
    expect(md).toContain("### `reserveStock`");
    expect(md).toContain("**in slice:** `Fulfillment`");
    expect(md).toContain("**on event:** `OrderPlaced_v2`");
    expect(md).toContain("**triggers:** `reserve`");
  });

  it("renders multi-line schemas as fenced code blocks", () => {
    const model: DomainModel = {
      entries: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          file: "src/s.ts",
          events: [
            {
              name: "MultiLine",
              hasCustomPatch: false,
              schema: 'z\n  .object({ id: z.string() })\n  .describe("hi")',
            },
          ],
          actions: [],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const i = buildContractIndex(model);
    const out = formatMarkdown(i);
    expect(out).toMatch(/```ts\n[\s\S]*z\n[\s\S]*```/);
    // Body lines get indented so they stay inside the bullet's scope.
    expect(out).toContain("  .object({ id: z.string() })");
  });

  it("emits no ANSI escapes — output is plain Markdown", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: validating absence of ANSI escapes
    expect(md).not.toMatch(/\x1b\[/);
  });
});

describe("formatMarkdown — event with no producer and no consumer", () => {
  it("emits the (none) placeholders", () => {
    const model: DomainModel = {
      entries: [],
      states: [
        {
          name: "Orphan",
          varName: "Orphan:0",
          file: "src/orphan.ts",
          events: [{ name: "Lonesome", hasCustomPatch: false }],
          // No actions → no producers for Lonesome
          actions: [],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    };
    const idx = buildContractIndex(model);
    const md = formatMarkdown(idx);
    expect(md).toContain("### `Lonesome`");
    expect(md).toContain("**producers:** _(none)_");
    expect(md).toContain("**consumers:** _(none)_");
  });
});

describe("formatMarkdown — empty model", () => {
  it("emits placeholder sections when the project is empty", () => {
    const idx = buildContractIndex({
      entries: [],
      states: [],
      slices: [],
      projections: [],
      reactions: [],
    });
    const md = formatMarkdown(idx);
    expect(md).toContain("## Events");
    expect(md).toContain("## Actions");
    expect(md).toContain("## States");
    expect(md).toContain("## Slices");
    expect(md).toContain("## Projections");
    expect(md).toContain("## Reactions");
    expect(md.match(/_\(none\)_/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

describe("formatMarkdown — defensive paths", () => {
  it("handles slice/projection entries whose names don't match any model item", () => {
    const idx = buildContractIndex({
      entries: [],
      states: [],
      slices: [],
      projections: [],
      reactions: [],
    });
    // Inject fabricated entries that don't have backing model objects.
    idx.entries.push({ kind: "slice", name: "Ghost" });
    idx.entries.push({ kind: "projection", name: "Phantom" });
    idx.entries.push({ kind: "state", name: "Lost" });
    const md = formatMarkdown(idx);
    expect(md).toContain("### `Ghost`");
    expect(md).toContain("### `Phantom`");
    expect(md).toContain("### `Lost`");
  });

  it("handles a reaction entry without a qualifier or file", () => {
    const idx = buildContractIndex({
      entries: [],
      states: [],
      slices: [],
      projections: [],
      reactions: [],
    });
    idx.entries.push({ kind: "reaction", name: "Bare" });
    const md = formatMarkdown(idx);
    expect(md).toContain("### `Bare`");
    expect(md).not.toContain("**in slice:** `Bare`");
    expect(md).not.toContain("**on event:**");
  });

  it("handles an action entry whose qualifier doesn't match any state", () => {
    const idx = buildContractIndex({
      entries: [],
      states: [
        {
          name: "Real",
          varName: "Real:0",
          file: "src/r.ts",
          events: [],
          actions: [{ name: "doThing", emits: [], invariants: [] }],
        },
      ],
      slices: [],
      projections: [],
      reactions: [],
    });
    // Push an entry pointing at a state name that doesn't match.
    idx.entries.push({
      kind: "action",
      name: "doThing",
      qualifier: "Wrong",
    });
    const md = formatMarkdown(idx);
    expect(md).toMatch(/### `doThing`/);
  });
});
