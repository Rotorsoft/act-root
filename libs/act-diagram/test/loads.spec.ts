import { describe, expect, it } from "vitest";
import { build_contract_index } from "../src/cli/contract-index.js";
import {
  format_action,
  format_event,
  format_state,
} from "../src/cli/format.js";
import { format_json_schema } from "../src/cli/json-schema.js";
import { format_markdown } from "../src/cli/markdown.js";
import { extract_model } from "../src/client/lib/evaluate.js";
import { compute_layout } from "../src/client/lib/layout.js";
import {
  appending_loads,
  commit_summary,
  load_of,
  read_loads,
} from "../src/client/lib/loads.js";
import type { DomainModel } from "../src/client/types/index.js";

const source = `
import { act, slice, state } from "@rotorsoft/act";
import { z } from "zod";
const SeatTaken = z.object({ student: z.string() });
export const Seats = state({ Seats: z.object({ taken: z.number() }) })
  .init(() => ({ taken: 0 }))
  .emits({ SeatTaken })
  .patch({ SeatTaken: (_, s) => ({ taken: s.taken + 1 }) })
  .on({ TakeSeat: SeatTaken })
  .emit("SeatTaken")
  .build();
const Enroll = z.object({ course: z.string(), student: z.string() });
export const Enrollment = state({ Enrollment: Enroll })
  .init(() => ({ course: "", student: "" }))
  .emits({ Enrolled: Enroll, Audited: Enroll })
  .patch({ Enrolled: ({ data }) => data, Audited: ({ data }) => data })
  .on({ Enroll })
  .loads(Seats, (d) => d.course, ["SeatTaken"])
  .emit((d) => [["Enrolled", d], ["SeatTaken", { student: d.student }]])
  .on({ Audit: Enroll })
  .loads(Seats, (d) => d.course)
  .emit("Audited")
  .build();
const Amount = z.object({ amount: z.number() });
export const Account = state({ Account: z.object({ balance: z.number() }) })
  .init(() => ({ balance: 0 }))
  .emits({ Debited: Amount, Credited: Amount })
  .patch({ Debited: (_, s) => s, Credited: (_, s) => s })
  .build();
const Move = z.object({ from: z.string(), to: z.string(), amount: z.number() });
export const Transfer = state({ Transfer: Move })
  .init(() => ({ from: "", to: "", amount: 0 }))
  .emits({ Transferred: Move })
  .patch({ Transferred: ({ data }) => data })
  .on({ Transfer: Move })
  .loads(Account, (d) => d.from, ["Debited"], "from")
  .loads(Account, (d) => d.to, ["Credited"], "to")
  .emit((d) => [["Transferred", d], ["Debited", d], ["Credited", d]])
  .build();
export const Bank = slice().withState(Account).withState(Transfer).build();
export const app = act().withSlice(Bank).withState(Seats).withState(Enrollment).build();
`;

const { model } = extract_model([{ path: "rules.ts", content: source }]);
const idx = build_contract_index(model);
const plain = (s: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors
  s.replace(/\u001b\[[0-9;]*m/g, "");
const entry = (kind: string, name: string) =>
  idx.entries.find((e) => e.kind === kind && e.name === name)!;

describe("the model", () => {
  it("records each load with its state, name and events", () => {
    const actions = model.states.flatMap((s) => s.actions);
    expect(actions.find((a) => a.name === "Transfer")?.loads).toEqual([
      { state: "Account", name: "from", events: ["Debited"] },
      { state: "Account", name: "to", events: ["Credited"] },
    ]);
    expect(actions.find((a) => a.name === "Audit")?.loads).toEqual([
      { state: "Seats", name: "Seats", events: [] },
    ]);
    expect(actions.find((a) => a.name === "TakeSeat")?.loads).toBeUndefined();
  });

  it("drops a load whose state didn't resolve", () => {
    const { model: broken } = extract_model([
      {
        path: "broken.ts",
        content: `
          import { act, state } from "@rotorsoft/act";
          import { z } from "zod";
          export const S = state({ S: z.object({}) })
            .init(() => ({}))
            .emits({ Done: z.object({}) })
            .on({ go: z.object({}) })
            .loads(undefined, () => "x")
            .emit("Done")
            .build();
          export const app = act().withState(S).build();`,
      },
    ]);
    expect(broken.states[0].actions[0].loads).toBeUndefined();
  });
});

describe("a state with sensitive fields", () => {
  it("is read like any other, along with what follows it in the file", () => {
    const { model: read } = extract_model([
      {
        path: "user.ts",
        content: `
          import { act, sensitive, state } from "@rotorsoft/act";
          import { z } from "zod";
          const Registered = z.object({ email: sensitive(z.string()) });
          export const User = state({ User: z.object({}) })
            .init(() => ({}))
            .emits({ Registered })
            .on({ Register: z.object({ email: z.string() }) })
            .emit("Registered")
            .build();
          export const Later = state({ Later: z.object({}) })
            .init(() => ({}))
            .emits({ Done: z.object({}) })
            .build();
          export const app = act().withState(User).withState(Later).build();`,
      },
    ]);
    expect(read.states.map((s) => s.name)).toEqual(["User", "Later"]);
    expect(read.states[0].actions[0].name).toBe("Register");
  });
});

describe("an action without loads", () => {
  const action = { name: "a", emits: ["E"] };

  it("has nothing to append, read or commit across streams", () => {
    expect(appending_loads(action)).toEqual([]);
    expect(read_loads(action)).toEqual([]);
    expect(load_of(action, "E")).toBeUndefined();
    expect(commit_summary(action, "S")).toBeUndefined();
  });
});

describe("the CLI", () => {
  it("shows an action's loads, where each event goes, and its commit", () => {
    const out = plain(format_action(idx, entry("action", "Enroll")));
    expect(out).toContain("loads:\n    - Seats: appends SeatTaken");
    expect(out).toContain("- Enrolled\n    - SeatTaken to the Seats stream");
    expect(out).toContain(
      "commit:  one commit across 2 streams (Enrollment, Seats), each guarded by its version at load: all land or none do"
    );
  });

  it("names each load of a state loaded twice", () => {
    const out = plain(format_action(idx, entry("action", "Transfer")));
    expect(out).toContain('- Account as "from": appends Debited');
    expect(out).toContain(
      'one commit across 3 streams (Transfer, Account as "from", Account as "to")'
    );
  });

  it("says a read isn't guarded and that it adds no commit across streams", () => {
    const out = plain(format_action(idx, entry("action", "Audit")));
    expect(out).toContain("- Seats: read, not guarded");
    expect(out).not.toContain("commit:");
  });

  it("shows no loads or commit on an action without them", () => {
    const out = plain(format_action(idx, entry("action", "TakeSeat")));
    expect(out).not.toContain("loads:");
    expect(out).not.toContain("commit:");
  });

  it("lists who loads a state and who else emits its events", () => {
    const out = plain(format_state(idx, entry("state", "Seats")));
    expect(out).toContain("also emitted by Enrollment.Enroll");
    expect(out).toContain("loaded by:");
    expect(out).toContain("- Enroll (on Enrollment): appends SeatTaken");
    expect(out).toContain("- Audit (on Enrollment): read, not guarded");
  });

  it("shows the loads on a state's action lines, and no loaded-by when nothing loads it", () => {
    const out = plain(format_state(idx, entry("state", "Enrollment")));
    expect(out).toContain("Enroll → Enrolled, SeatTaken  loads Seats");
    expect(out).not.toContain("loaded by:");
  });

  it("names the stream on an event's producers", () => {
    const out = plain(format_event(idx, entry("event", "SeatTaken")));
    expect(out).toContain("TakeSeat  (on Seats)");
    expect(out).toContain("Enroll  (on Enrollment, to the Seats stream)");
  });

  it("carries the loaded state into the JSON report", () => {
    const { events } = JSON.parse(format_json_schema(idx));
    const by_action = Object.fromEntries(
      events.Debited.producers.map((p: any) => [p.action, p.appends_to])
    );
    expect(by_action).toEqual({ Transfer: 'Account as "from"' });
    expect(events.Enrolled.producers[0].appends_to).toBeUndefined();
  });

  it("carries loads and the commit into the Markdown registry", () => {
    const out = format_markdown(idx);
    expect(out).toContain("- **loads:**\n  - `Seats`: appends `SeatTaken`");
    expect(out).toContain("  - `Seats`: read, not guarded");
    expect(out).toContain("`SeatTaken` to the `Seats` stream");
    expect(out).toContain(
      "- **commit:** one commit across 2 streams (Enrollment, Seats), all or none"
    );
  });
});

describe("the diagram", () => {
  const layout = compute_layout(model);
  const node = (type: string, label: string) =>
    layout.ns.find((n) => n.type === type && n.label === label)!;

  it("draws one box around the events of each commit across streams", () => {
    expect(layout.commits).toHaveLength(2);
    const rows = (labels: string[], box: (typeof layout.commits)[0]) =>
      labels.every((l) =>
        layout.ns.some(
          (n) =>
            n.type === "event" &&
            n.label === l &&
            n.pos.y >= box.y &&
            n.pos.y <= box.y + box.h &&
            n.pos.x >= box.x
        )
      );
    expect(
      layout.commits.some((b) =>
        rows(["Transferred", "Debited", "Credited"], b)
      )
    ).toBe(true);
    expect(layout.commits.some((b) => rows(["Enrolled", "SeatTaken"], b))).toBe(
      true
    );
  });

  it("notes the stream on each routed event and the loads on each action", () => {
    expect(
      layout.ns.find((n) => n.key.startsWith("e:SeatTaken") && n.note)?.note
    ).toBe("→ Seats");
    expect(node("action", "Enroll").note).toBe("loads Seats");
    expect(node("action", "Audit").note).toBe("reads Seats");
    expect(node("action", "Transfer").note).toBe("loads from, to");
    expect(node("action", "TakeSeat").note).toBeUndefined();
  });

  it("fills the tooltips on actions, loaded states and their events", () => {
    expect(node("action", "Transfer").loads).toEqual([
      'Account as "from" → Debited',
      'Account as "to" → Credited',
    ]);
    expect(node("action", "Transfer").commit).toBe(
      'one commit across 3 streams (Transfer, Account as "from", Account as "to")'
    );
    expect(node("action", "Audit").loads).toEqual([
      "Seats (read, not guarded)",
    ]);
    expect(node("action", "Audit").commit).toBeUndefined();
    expect(node("state", "Seats").loaded_by).toEqual([
      "Enrollment.Enroll",
      "Enrollment.Audit",
    ]);
    expect(node("state", "Account").loaded_by).toEqual(["Transfer.Transfer"]);
    expect(node("event", "SeatTaken").outside).toEqual(["Enrollment.Enroll"]);
  });

  it("draws one edge per loaded state: yellow when appending, gray when reading", () => {
    const into = (label: string) => {
      const a = node("action", label);
      return layout.es.filter(
        (e) => e.dash && e.to.x === a.pos.x + 100 && e.to.y === a.pos.y + 18
      );
    };
    expect(into("Transfer")).toHaveLength(1);
    expect(into("Enroll")[0].color).toBe("#eab308");
    expect(into("Audit")[0].color).toBe("#a1a1aa");
    expect(into("TakeSeat")).toHaveLength(0);
  });

  it("points an action's edge at its own row of an event two actions emit", () => {
    const both: DomainModel = {
      entries: [],
      slices: [],
      projections: [],
      reactions: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          events: [{ name: "E", hasCustomPatch: true }],
          actions: [
            { name: "a", emits: ["E"] },
            { name: "b", emits: ["E"] },
          ],
        },
      ],
    };
    const { es, ns } = compute_layout(both);
    const rows = ns.filter((n) => n.type === "event").map((n) => n.pos.y);
    expect(es.map((e) => e.to.y - 18)).toEqual(rows);
  });

  it("notes the stream and boxes the commit on a state outside any slice", () => {
    const standalone: DomainModel = {
      entries: [],
      slices: [],
      projections: [],
      reactions: [],
      states: [
        {
          name: "Seats",
          varName: "Seats:0",
          events: [{ name: "Taken", hasCustomPatch: true }],
          actions: [],
        },
        {
          name: "Enrollment",
          varName: "Enrollment:0",
          events: [{ name: "Enrolled", hasCustomPatch: true }],
          actions: [
            {
              name: "Enroll",
              emits: ["Enrolled", "Taken"],
              loads: [{ state: "Seats", name: "Seats", events: ["Taken"] }],
            },
          ],
        },
      ],
    };
    const { ns, commits } = compute_layout(standalone);
    const routed = ns.find((n) => n.type === "event" && n.note);
    expect(routed?.label).toBe("Taken");
    expect(routed?.note).toBe("→ Seats");
    expect(commits).toHaveLength(1);
    expect(routed?.pos.y).toBeGreaterThanOrEqual(commits[0].y);
    expect(routed?.pos.y).toBeLessThan(commits[0].y + commits[0].h);
  });

  it("skips a load of a state outside the view, and a commit it can't see two rows of", () => {
    const partial: DomainModel = {
      entries: [],
      slices: [],
      projections: [],
      reactions: [],
      states: [
        {
          name: "S",
          varName: "S:0",
          events: [{ name: "E", hasCustomPatch: true }],
          actions: [
            {
              name: "a",
              emits: ["E"],
              loads: [{ state: "Elsewhere", name: "Elsewhere", events: ["X"] }],
            },
          ],
        },
      ],
    };
    const { es, commits, ns } = compute_layout(partial);
    expect(es.filter((e) => e.dash)).toHaveLength(0);
    expect(commits).toHaveLength(0);
    expect(ns.find((n) => n.type === "action")?.note).toBe("loads Elsewhere");
  });
});
