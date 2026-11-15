import type {
  Chapter,
  Check,
  Link,
  Node,
  TourSpec,
} from "../components/Tour/types";

/**
 * The framework tour: every capability of Act shown as what it does to the
 * event store. The storyboard, with a doc page and a test behind every claim,
 * is docs/flows/framework-tour.script.md; keep the two in step.
 */

const GH = "https://github.com/Rotorsoft/act-root/blob/master/";
const doc = (label: string, path: string): Link => ({
  label,
  href: `/docs/${path}`,
});
const test = (path: string, name: string): Link => ({
  label: `${path.split("/").pop()} → "${name}"`,
  href: GH + path,
});
const core = (file: string) => `libs/act/test/${file}`;
const TCK = "libs/act-tck/src/store-tck.ts";

const actor = (id: string, label: string, sub?: string): Node => ({
  id,
  kind: "actor",
  label,
  sub,
});
const action = (id: string, label = id, sub?: string): Node => ({
  id,
  kind: "action",
  label,
  sub,
});
const st = (id: string, label: string, sub?: string): Node => ({
  id,
  kind: "state",
  label,
  sub,
});
const reaction = (id: string, label = id, sub?: string): Node => ({
  id,
  kind: "reaction",
  label,
  sub,
});
const worker = (id: string, label: string, sub?: string): Node => ({
  id,
  kind: "worker",
  label,
  sub,
});
const outside = (id: string, label: string, sub?: string): Node => ({
  id,
  kind: "external",
  label,
  sub,
});
const projection = (id: string, label: string, sub?: string): Node => ({
  id,
  kind: "projection",
  label,
  sub,
});
const port = (id: string, label: string, sub?: string): Node => ({
  id,
  kind: "store",
  label,
  sub,
});

/** The checks an action walks, in order: `ok` before `at`, then `fail` or `todo`. */
const STEPS = [
  "payload schema",
  "load",
  "preconditions",
  "handler · event schemas",
  "fold · state schema",
  "commit",
];
const checks = (at: number, fail = false): Check[] =>
  STEPS.map((label, i) => ({
    label,
    state:
      i < at
        ? "ok"
        : i === at
          ? fail
            ? "fail"
            : "todo"
          : fail
            ? "skip"
            : "todo",
  }));
const passed = checks(STEPS.length);

const ticketState = `const Ticket = state({
  Ticket: z.object({ title: z.string(), status: z.string(), messages: z.number() }),
})
  .init(() => ({ title: "", status: "new", messages: 0 }))
  .emits({ TicketOpened, MessageAdded, TicketClosed })
  .patch({
    TicketOpened: ({ data }) => ({ title: data.title, status: "open" }),
    MessageAdded: (_, state) => ({ messages: state.messages + 1 }),
    TicketClosed: ({ data }) => ({ status: "closed", closedBy: data.closedBy }),
  })
  .on({ OpenTicket: z.object({ title: z.string() }) })
    .emit("TicketOpened")
  .on({ AddMessage: z.object({ body: z.string() }) })
    .emit("MessageAdded")
  .build();

const app = act().withState(Ticket).build();`;

const chapters: Chapter[] = [
  // ───────────────────────────────────────────────────────────── 1
  {
    id: "log",
    title: "One log, many streams",
    audience: "first app",
    blurb:
      "The event store is one ordered log. Everything else in Act reads from it or appends to it.",
    seed: [
      {
        stream: "ticket-4821",
        name: "TicketOpened",
        data: { title: "Printer jams" },
        ref: "t21-open",
      },
      {
        stream: "agent-ana",
        name: "AgentAdded",
        data: { name: "Ana" },
        ref: "ana-added",
      },
      {
        stream: "ticket-4822",
        name: "TicketOpened",
        data: { title: "VPN drops" },
        ref: "t22-open",
      },
      {
        stream: "ticket-4821",
        name: "MessageAdded",
        data: { body: "Since Monday" },
        ref: "t21-m1",
      },
    ],
    scenes: [
      {
        title: "The all stream",
        nodes: [
          actor("maya", "Maya", "customer"),
          actor("ana", "Ana", "agent"),
        ],
        api: ["app.query_array(query)", "Committed"],
        doc: doc(
          "Event sourcing § Event store",
          "concepts/event-sourcing#event-store"
        ),
        test: test(
          TCK,
          "lands every append, each from its own head, with ids in append order"
        ),
        code: `// every event, in commit order
const all = await app.query_array({});
// all[0] → { id: 0, stream: "ticket-4821", version: 0, name: "TicketOpened", … }`,
        steps: [
          {
            say: "This is a ticket desk's **event store**. It keeps every change as an event in **one ordered log**, the all stream. Each event gets a global `id` when it commits: #0, #1, #2, #3.",
            ops: [
              {
                op: "flag",
                on: "cell:t21-open",
                text: "id 0: first in the log",
              },
            ],
          },
          {
            say: "Each event also belongs to one **stream** and takes that stream's next **version**. Ticket 4821 holds v0 and v1; its events interleave with other streams in the log.",
            ops: [
              { op: "unflag" },
              { op: "flag", on: "cell:t21-open", text: "ticket-4821 v0" },
              { op: "flag", on: "cell:t21-m1", text: "ticket-4821 v1" },
            ],
            focus: ["cell:t21-open", "cell:t21-m1"],
          },
          {
            say: "Reading one stream is a query over the same log: `stream_exact` picks one stream's events, in version order. The stream table below folds the log the same way.",
            code: `const ticket = await app.query_array({ stream: "ticket-4821", stream_exact: true });
// [ v0 TicketOpened, v1 MessageAdded ]`,
            ops: [{ op: "unflag" }, { op: "dim", only: "ticket-4821" }],
          },
          {
            say: "Every event carries who caused it: `meta.causation` names the action and its actor, and `meta.correlation` is an id that a whole workflow shares. **Click any event** to see it.",
            ops: [
              { op: "dim" },
              { op: "flag", on: "cell:t21-m1", text: "click me" },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 2
  {
    id: "action",
    title: "A state and its first action",
    audience: "first app",
    blurb:
      "A state declares its schema, its events and its actions. An action decides; its events commit to the log.",
    scenes: [
      {
        title: "Declaring a state",
        nodes: [
          actor("maya", "Maya", "customer"),
          action("OpenTicket"),
          action("AddMessage"),
          st("ticket", "Ticket", "ticket-4830"),
        ],
        api: [
          "state(...)",
          ".init",
          ".emits",
          ".patch",
          ".on",
          ".emit",
          ".build",
          "act().withState(...).build()",
          "app.do",
          "app.load",
        ],
        doc: doc("Getting started", "guides/getting-started"),
        test: test(
          core("invariants.spec.ts"),
          "folds each event once, with the next version and a placeholder id"
        ),
        code: ticketState,
        steps: [
          {
            say: "A **state** is a Zod schema, an initial value, the events it emits, how each event **patches** it, and the **actions** that emit them. `act().withState(Ticket).build()` turns it into an app.",
            focus: ["ticket", "OpenTicket", "AddMessage"],
          },
          {
            say: 'Maya calls `app.do("OpenTicket", { stream: "ticket-4830", actor }, { title })`. First the payload is checked against the action\'s schema.',
            moves: [{ from: "maya", to: "OpenTicket", label: "{ title }" }],
            checks: checks(1),
            code: `await app.do(
  "OpenTicket",
  { stream: "ticket-4830", actor: { id: "maya", name: "Maya" } },
  { title: "Screen flickers" }
);`,
          },
          {
            say: "Then it **loads** the stream. Ticket 4830 has no events yet, so the state is its initial value at version −1.",
            moves: [{ from: "OpenTicket", to: "ticket", label: "load" }],
            ops: [
              {
                op: "state",
                node: "ticket",
                data: { title: "", status: "new", messages: 0 },
                version: -1,
              },
            ],
            checks: checks(2),
          },
          {
            say: "The handler decides the events: here `TicketOpened`, with the payload as its data. Each event folds into the state once, through its patch, **before** anything is stored. The final state is checked against the schema.",
            ops: [
              {
                op: "state",
                node: "ticket",
                data: { title: "Screen flickers", status: "open", messages: 0 },
                version: -1,
              },
            ],
            checks: checks(5),
          },
          {
            say: "The commit expects version −1 and lands: global id **#4**, stream version **0**. `app.do` returns one snapshot per event it committed.",
            moves: [
              {
                from: "ticket",
                to: "cell:t30-open",
                label: "expect −1",
                tone: "good",
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4830",
                    name: "TicketOpened",
                    data: { title: "Screen flickers" },
                    ref: "t30-open",
                  },
                ],
              },
              {
                op: "state",
                node: "ticket",
                data: { title: "Screen flickers", status: "open", messages: 0 },
                version: 0,
              },
            ],
            checks: passed,
          },
          {
            say: "The next action loads v0 and commits v1. The log grows by one: **#5**. Versions count per stream, ids count across the whole store.",
            moves: [
              { from: "maya", to: "AddMessage", label: "{ body }" },
              { from: "AddMessage", to: "ticket", label: "load v0" },
              {
                from: "ticket",
                to: "cell:t30-m1",
                label: "expect 0",
                tone: "good",
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4830",
                    name: "MessageAdded",
                    data: { body: "Since the update" },
                    ref: "t30-m1",
                  },
                ],
              },
              {
                op: "state",
                node: "ticket",
                data: { title: "Screen flickers", status: "open", messages: 1 },
                version: 1,
              },
            ],
            checks: passed,
          },
          {
            say: '`app.load(Ticket, "ticket-4830")` rebuilds the state from the stream\'s events: each folds through its patch, in version order.',
            moves: [
              { from: "cell:t30-open", to: "ticket", label: "fold v0" },
              { from: "cell:t30-m1", to: "ticket", label: "fold v1" },
            ],
            code: `const { state, version } = await app.load(Ticket, "ticket-4830");
// state → { title: "Screen flickers", status: "open", messages: 1 }, version → 1`,
            focus: ["ticket"],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 3
  {
    id: "rules",
    title: "Rules: preconditions and invariants",
    audience: "first app",
    blurb:
      "An action runs only when its rules hold, and the state it leaves must keep the schema. A refusal stores nothing.",
    scenes: [
      {
        title: "Six checks, in order",
        nodes: [
          actor("maya", "Maya", "customer"),
          actor("bo", "Bo", "agent"),
          action("CloseTicket"),
          st("ticket", "Ticket", "ticket-4830"),
        ],
        api: [
          ".requires([...])",
          "Precondition",
          "PreconditionError",
          "ValidationError",
        ],
        doc: doc(
          "State management § Preconditions",
          "concepts/state-management#preconditions"
        ),
        test: test(
          core("preconditions.spec.ts"),
          "refuses at the first precondition that doesn't hold, and commits nothing"
        ),
        code: `const mustBeOpen: Precondition<{ status: string }, unknown> = {
  description: "Ticket must be open",
  holds: (_, state) => state.status === "open",
};

.on({ CloseTicket: z.object({ reason: z.string() }) })
  .requires([mustBeOpen])
  .emit((_, __, { actor }) => ["TicketClosed", { closedBy: actor.id }])`,
        steps: [
          {
            say: "Every action walks the same checks, in this order, and refuses at the first that fails. Nothing is stored until the last one.",
            checks: checks(0),
          },
          {
            say: "A payload that breaks the action's schema (`reason: 42`) is a `ValidationError`. The action never loads.",
            moves: [
              {
                from: "maya",
                to: "CloseTicket",
                label: "{ reason: 42 }",
                tone: "bad",
              },
            ],
            ops: [
              {
                op: "refuse",
                stream: "ticket-4830",
                name: "TicketClosed",
                error: "ValidationError",
              },
            ],
            checks: checks(0, true),
          },
          {
            say: "Bo closes the ticket with a good reason. Every check passes, and `TicketClosed` commits as v2.",
            moves: [
              { from: "bo", to: "CloseTicket", label: "{ reason }" },
              { from: "CloseTicket", to: "ticket", label: "load v1" },
              {
                from: "ticket",
                to: "cell:t30-closed",
                label: "expect 1",
                tone: "good",
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4830",
                    name: "TicketClosed",
                    data: { closedBy: "bo" },
                    ref: "t30-closed",
                  },
                ],
              },
              {
                op: "state",
                node: "ticket",
                data: {
                  title: "Screen flickers",
                  status: "closed",
                  closedBy: "bo",
                },
                version: 2,
              },
            ],
            checks: passed,
          },
          {
            say: 'Maya tries to close it again. A **precondition** is a named rule the action needs right now: `.requires([mustBeOpen])` doesn\'t hold, so it throws `PreconditionError` with the message "CloseTicket failed precondition: Ticket must be open".',
            moves: [
              { from: "maya", to: "CloseTicket", label: "{ reason }" },
              { from: "CloseTicket", to: "ticket", label: "load v2" },
            ],
            ops: [
              {
                op: "refuse",
                stream: "ticket-4830",
                name: "TicketClosed",
                error: "PreconditionError",
              },
            ],
            checks: checks(2, true),
          },
          {
            say: "What must hold after **every** action is an **invariant**, and it lives in the state's schema. Suppose a buggy handler closes ticket 4822 without a closer: the fold leaves a state the schema rejects, so the action is refused with a `ValidationError` before the commit.",
            code: `const Ticket = z
  .object({ status: z.string(), closedBy: z.string().optional() /* … */ })
  .refine((t) => t.status !== "closed" || !!t.closedBy, "A closed ticket has a closer");`,
            moves: [{ from: "CloseTicket", to: "ticket", label: "fold" }],
            ops: [
              {
                op: "state",
                node: "ticket",
                data: { title: "VPN drops", status: "closed", closedBy: "—" },
              },
              {
                op: "refuse",
                stream: "ticket-4822",
                name: "TicketClosed",
                error: "ValidationError",
              },
            ],
            checks: checks(4, true),
          },
          {
            say: "Refusals never reach the log: no event, no version, no reaction wakes. The log still ends at #6.",
            ops: [
              {
                op: "state",
                node: "ticket",
                data: {
                  title: "Screen flickers",
                  status: "closed",
                  closedBy: "bo",
                },
                version: 2,
              },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 4
  {
    id: "concurrency",
    title: "Two writers, one stream",
    audience: "first app",
    blurb:
      "Every commit expects the version it loaded. When two writers race, one wins and the other learns at once.",
    scenes: [
      {
        title: "Optimistic concurrency",
        nodes: [
          actor("maya", "Maya", "customer"),
          actor("ana", "Ana", "agent"),
          action("AddMessage"),
          st("ticket", "Ticket", "ticket-4821"),
        ],
        api: [
          "ConcurrencyError",
          ".on(entry, { maxRetries, backoff })",
          "expectedVersion",
        ],
        doc: doc(
          "Error handling § ConcurrencyError",
          "concepts/error-handling#concurrencyerror"
        ),
        test: test(
          core("action-retry.spec.ts"),
          "succeeds on second attempt after one conflict"
        ),
        steps: [
          {
            say: "Maya and Ana add a message to ticket 4821 at the same moment. Both actions load the stream at **version 1**.",
            moves: [
              { from: "maya", to: "AddMessage", label: "Maya's" },
              { from: "ana", to: "AddMessage", label: "Ana's", par: true },
              { from: "AddMessage", to: "ticket", label: "load v1 ×2" },
            ],
            ops: [
              {
                op: "state",
                node: "ticket",
                data: { title: "Printer jams", status: "open", messages: 1 },
                version: 1,
              },
            ],
          },
          {
            say: "Maya's commit gets there first and lands as v2 (#7). Ana's commit expected 1 and found 2: `ConcurrencyError`, carrying `stream`, `expectedVersion` and `lastVersion`. Nothing of hers is stored.",
            moves: [
              {
                from: "ticket",
                to: "cell:t21-m2",
                label: "expect 1",
                tone: "good",
              },
              { from: "ticket", to: "log", label: "expect 1", tone: "bad" },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4821",
                    name: "MessageAdded",
                    data: { body: "Still jamming" },
                    ref: "t21-m2",
                  },
                ],
              },
              {
                op: "refuse",
                stream: "ticket-4821",
                name: "MessageAdded",
                error: "ConcurrencyError",
              },
              {
                op: "state",
                node: "ticket",
                data: { title: "Printer jams", status: "open", messages: 2 },
                version: 2,
              },
            ],
          },
          {
            say: "Give the action a retry budget and Act owns the loop: on `ConcurrencyError` it reloads, checks the rules again on the new state, and commits. Ana's message lands as v3 (#8). The caller never sees the conflict.",
            code: `.on({ AddMessage: z.object({ body: z.string() }) }, {
  maxRetries: 2,
  backoff: { strategy: "exponential", baseMs: 10, maxMs: 200, jitter: true },
})`,
            moves: [
              { from: "ticket", to: "AddMessage", label: "reload v2" },
              { from: "AddMessage", to: "ticket", label: "re-check" },
              {
                from: "ticket",
                to: "cell:t21-m3",
                label: "expect 2",
                tone: "good",
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4821",
                    name: "MessageAdded",
                    data: { body: "On my way" },
                    ref: "t21-m3",
                  },
                ],
              },
              {
                op: "state",
                node: "ticket",
                data: { title: "Printer jams", status: "open", messages: 3 },
                version: 3,
              },
            ],
            checks: passed,
          },
          {
            say: "A version the **caller** pins is a fixed conflict. With `expectedVersion: 1` the action fails at once with `ConcurrencyError`, and the budget doesn't retry it: reloading can't make v3 equal 1.",
            code: `await app.do("AddMessage", { stream: "ticket-4821", actor, expectedVersion: 1 }, { body });
// ConcurrencyError: thrown at once, never retried`,
            moves: [
              {
                from: "ana",
                to: "AddMessage",
                label: "expectedVersion: 1",
                tone: "bad",
              },
            ],
            ops: [
              {
                op: "refuse",
                stream: "ticket-4821",
                name: "MessageAdded",
                error: "ConcurrencyError",
              },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 5
  {
    id: "load",
    title: "Loading fast: cache, snapshots, time travel",
    audience: "production",
    blurb:
      "A load starts from a checkpoint and replays only what came after it. Snapshots are events in the log.",
    scenes: [
      {
        title: "Cache and snapshots",
        nodes: [
          actor("ana", "Ana", "agent"),
          action("AddMessage"),
          port("cache", "cache", "InMemoryCache"),
          st("ticket", "Ticket", "ticket-4821"),
        ],
        api: [
          ".snap(predicate)",
          "SNAP_EVENT",
          "cache()",
          "InMemoryCache",
          "Snapshot.patches",
        ],
        doc: doc("Cache and snapshots", "architecture/cache-and-snapshots"),
        test: test(
          core("event-sourcing.spec.ts"),
          "should persist snapshot event on snap success"
        ),
        code: `const Ticket = state({ Ticket: TicketSchema })
  // …
  .snap((snap) => snap.patches >= 5) // events since the last snapshot
  .build();`,
        steps: [
          {
            say: "A warm load starts from the **cache** (`InMemoryCache` by default) and replays only what came after its entry. Here the cache already holds ticket 4821 at v3, and nothing came after it, so there is nothing to fold.",
            moves: [
              {
                from: "cache",
                to: "ticket",
                label: "warm hit v3",
                tone: "good",
              },
            ],
            ops: [
              { op: "status", text: "cache: ticket-4821 @ v3", tone: "good" },
              {
                op: "state",
                node: "ticket",
                data: { title: "Printer jams", status: "open", messages: 3 },
                version: 3,
              },
            ],
          },
          {
            say: "With `.snap(...)` on the state, an action whose commit makes the predicate true also commits a **snapshot**. It is an event too, `__snapshot__`, on the stream's next version (v5, #10), holding the state.",
            moves: [
              { from: "ana", to: "AddMessage", label: "{ body }" },
              { from: "ticket", to: "cell:t21-m4", label: "v4", tone: "good" },
              { from: "ticket", to: "cell:t21-snap", label: "snapshot" },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4821",
                    name: "MessageAdded",
                    data: { body: "Fixed the tray" },
                    ref: "t21-m4",
                  },
                ],
              },
              {
                op: "snapshot",
                stream: "ticket-4821",
                data: { title: "Printer jams", status: "open", messages: 4 },
                ref: "t21-snap",
              },
              {
                op: "state",
                node: "ticket",
                data: { title: "Printer jams", status: "open", messages: 4 },
                version: 5,
              },
              { op: "status", text: "cache: ticket-4821 @ v5", tone: "good" },
            ],
          },
          {
            say: "After a restart the cache is empty. A **cold** load starts from the latest snapshot and folds only the events after it, instead of the whole stream.",
            moves: [
              { from: "cell:t21-snap", to: "ticket", label: "start here" },
            ],
            ops: [
              { op: "status", text: "cache: cold (restart)", tone: "warn" },
            ],
          },
          {
            say: "A **time-travel** load reads the past: `{ before: 8 }` replays the real events below id #8, skipping the cache and any snapshot outside the window. It is read-only.",
            code: `const past = await app.load(Ticket, "ticket-4821", undefined, { before: 8 });
// state → { messages: 2 }, version → 2
// also: { created_before }, { created_after }, { limit }`,
            moves: [
              { from: "cell:t21-open", to: "ticket", label: "v0" },
              { from: "cell:t21-m2", to: "ticket", label: "… v2" },
            ],
            ops: [
              { op: "dim", from: "t21-m3" },
              {
                op: "state",
                node: "ticket",
                data: { title: "Printer jams", status: "open", messages: 2 },
                version: 2,
              },
              { op: "status" },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 6
  {
    id: "reaction",
    title: "A reaction",
    audience: "first app",
    blurb:
      "A reaction runs when an event commits. Correlate finds where it runs; drain runs it; settle loops until nothing is left.",
    scenes: [
      {
        title: "Correlate, drain, ack",
        nodes: [
          actor("maya", "Maya", "customer"),
          action("OpenTicket"),
          reaction("assign", "assign", "on TicketOpened"),
          action("AssignTicket"),
          worker("drain", "drain", "this process"),
        ],
        api: [
          ".on(event)",
          ".do(handler)",
          ".to(resolver)",
          "app.correlate",
          "app.drain",
          "app.settle",
          "reactingTo",
        ],
        doc: doc("Correlation and drain", "architecture/correlation-and-drain"),
        test: test(
          core("correlate.spec.ts"),
          "marks the target with the id of the event that resolved to it"
        ),
        code: `act()
  .withState(Ticket)
  .on("TicketOpened")
    .do(async function assign(event, stream, app) {
      await app.do("AssignTicket", { stream: event.stream, actor: bot }, { agent: "bo" });
    })
    .to((event) => ({ target: \`assign:\${event.stream}\`, source: event.stream }))
  .build();`,
        steps: [
          {
            say: "Maya opens ticket 4831 (#11). Its event has a reaction, so the commit schedules `settle()` on its own: no wiring, no message queue. The log is the backbone.",
            ops: [
              { op: "dim" },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4831",
                    name: "TicketOpened",
                    data: { title: "No sound" },
                    ref: "t31-open",
                  },
                ],
              },
            ],
            moves: [
              { from: "maya", to: "OpenTicket", label: "{ title }" },
              {
                from: "OpenTicket",
                to: "cell:t31-open",
                label: "commit",
                tone: "good",
              },
            ],
          },
          {
            say: "**Correlate** reads the log past its checkpoint and asks each reaction's resolver where it runs. `assign` names the target stream `assign:ticket-4831`: it is subscribed, and its work is marked up to #11.",
            moves: [
              { from: "cell:t31-open", to: "assign", label: "resolve" },
              {
                from: "assign",
                to: "target:assign:ticket-4831",
                label: "subscribe",
              },
            ],
            ops: [
              { op: "checkpoint", at: "t31-open" },
              { op: "target", id: "assign:ticket-4831", source: "ticket-4831" },
              { op: "mark", target: "assign:ticket-4831", at: "t31-open" },
            ],
          },
          {
            say: "**Drain** claims targets that have work, each under a **lease**, and fetches the source's events past the target's watermark (−1 here).",
            moves: [
              {
                from: "drain",
                to: "target:assign:ticket-4831",
                label: "claim",
              },
              { from: "cell:t31-open", to: "assign", label: "fetch" },
            ],
            ops: [{ op: "lease", target: "assign:ticket-4831", by: "drain" }],
            focus: ["target:assign:ticket-4831"],
          },
          {
            say: "The handler calls `app.do`. That action **inherits** the event that woke it (`reactingTo` is injected): the same correlation, and `TicketOpened` as its cause. Click #12 to see it.",
            moves: [
              { from: "assign", to: "AssignTicket", label: "app.do" },
              {
                from: "AssignTicket",
                to: "cell:t31-asg",
                label: "commit",
                tone: "good",
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4831",
                    name: "TicketAssigned",
                    data: { agent: "bo" },
                    cause: "t31-open",
                    ref: "t31-asg",
                  },
                ],
              },
            ],
          },
          {
            say: "On success the drain **acks**: the target's watermark moves past #11 and the lease is released. A stream is never acked past an event a reaction hasn't handled.",
            ops: [{ op: "ack", target: "assign:ticket-4831", at: "t31-open" }],
            focus: ["target:assign:ticket-4831"],
          },
          {
            say: "**Settle** loops correlate and drain until a pass finds nothing. The next pass reads #12, which no reaction handles, so the app is settled and emits `settled`.",
            code: `app.on("settled", (drain) => {
  // notify clients, refresh caches, …
});`,
            ops: [
              { op: "checkpoint", at: "t31-asg" },
              { op: "status", text: "settled", tone: "good" },
            ],
          },
          {
            say: "Leave out `.to(...)` and the reaction runs on the event's own stream. In tests, build with `autoSettle: false` and walk the pipeline yourself.",
            code: `import { fixture } from "@rotorsoft/act/test";

const test = fixture(act().withState(Ticket) /* …reactions */, { autoSettle: false });

test("assigns a new ticket", async ({ app }) => {
  await app.do("OpenTicket", { stream: "ticket-1", actor }, { title: "No sound" });
  await app.correlate(); // mark the work
  await app.drain(); // run one cycle of it
});`,
            ops: [{ op: "status" }],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 7
  {
    id: "workers",
    title: "Many workers, lanes and priority",
    audience: "production",
    blurb:
      "Scale out by running more workers on one store. Leases keep each target to one worker at a time.",
    scenes: [
      {
        title: "Competing workers",
        nodes: [
          worker("a", "worker A", "process 1"),
          worker("b", "worker B", "process 2"),
          reaction("assign"),
        ],
        api: ["Store.claim", "leaseMillis", "Lease"],
        doc: doc("Concurrency model", "architecture/concurrency-model"),
        test: test(
          TCK,
          "hands an expired lease to exactly one competing claimer, with retry accounting shared across workers"
        ),
        steps: [
          {
            say: "Two tickets open (#13, #14) and correlate marks two targets. Two processes drain the same store, and they **compete**: each claims a different target, because an unexpired lease is invisible to other claimers.",
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4832",
                    name: "TicketOpened",
                    data: { title: "Laptop slow" },
                    ref: "t32-open",
                  },
                ],
              },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4833",
                    name: "TicketOpened",
                    data: { title: "Badge broken" },
                    ref: "t33-open",
                  },
                ],
              },
              { op: "checkpoint", at: "t33-open" },
              { op: "target", id: "assign:ticket-4832", source: "ticket-4832" },
              { op: "target", id: "assign:ticket-4833", source: "ticket-4833" },
              { op: "mark", target: "assign:ticket-4832", at: "t32-open" },
              { op: "mark", target: "assign:ticket-4833", at: "t33-open" },
              { op: "lease", target: "assign:ticket-4832", by: "worker A" },
              { op: "lease", target: "assign:ticket-4833", by: "worker B" },
            ],
            moves: [
              { from: "a", to: "target:assign:ticket-4832", label: "claim" },
              {
                from: "b",
                to: "target:assign:ticket-4833",
                label: "claim",
                par: true,
              },
            ],
          },
          {
            say: "Worker A dies mid-handler. Its lease runs out after `leaseMillis`, and **exactly one** other worker takes it over. B now runs both, and the attempt counts against the target's retry budget.",
            moves: [
              {
                from: "b",
                to: "target:assign:ticket-4832",
                label: "claim (expired)",
              },
            ],
            ops: [
              { op: "lease", target: "assign:ticket-4832", by: "worker B" },
              {
                op: "flag",
                on: "target:assign:ticket-4832",
                text: "A's lease expired",
              },
            ],
          },
          {
            say: "B's handlers assign both tickets (#15, #16), then ack both targets.",
            moves: [
              {
                from: "assign",
                to: "cell:t32-asg",
                label: "app.do",
                tone: "good",
              },
              {
                from: "assign",
                to: "cell:t33-asg",
                label: "app.do",
                tone: "good",
                par: true,
              },
            ],
            ops: [
              { op: "unflag" },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4832",
                    name: "TicketAssigned",
                    data: { agent: "ana" },
                    cause: "t32-open",
                    ref: "t32-asg",
                  },
                ],
              },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4833",
                    name: "TicketAssigned",
                    data: { agent: "bo" },
                    cause: "t33-open",
                    ref: "t33-asg",
                  },
                ],
              },
              { op: "ack", target: "assign:ticket-4832", at: "t32-open" },
              { op: "ack", target: "assign:ticket-4833", at: "t33-open" },
              { op: "checkpoint", at: "t33-asg" },
            ],
          },
        ],
      },
      {
        title: "Lanes and priority",
        nodes: [
          worker("default", "default lane", "leaseMillis 10 s"),
          worker("hooks", "webhooks lane", "leaseMillis 30 s"),
          reaction("webhook", "escalation webhook"),
        ],
        api: [
          ".withLane(config)",
          ".to({ target, lane })",
          ".to({ target, priority })",
          "app.prioritize",
          "onlyLanes",
        ],
        doc: doc("Configuration § Lanes", "concepts/configuration#lanes"),
        test: test(
          core("lanes.spec.ts"),
          "drains lanes in parallel — a stalled slow handler does not block the fast lane"
        ),
        code: `slice()
  .withState(Ticket)
  .withLane({ name: "webhooks", leaseMillis: 30_000, streamLimit: 5 })
  .on("TicketEscalated")
    .do(webhook({ url, body, timeoutMs: 2_000 }), { maxRetries: 3, backoff })
    .to({ target: "ticket-escalation-webhooks", lane: "webhooks" })
  .build();`,
        steps: [
          {
            say: "A **lane** is a separate drain controller with its own lease and claim budget. Webhook calls are slow, so they get their own lane with 30-second leases.",
            ops: [
              {
                op: "target",
                id: "ticket-escalation-webhooks",
                lane: "webhooks",
              },
            ],
            focus: ["hooks", "target:ticket-escalation-webhooks"],
          },
          {
            say: "Ticket 4832 escalates (#17). The webhooks lane claims its target while the default lane keeps draining: lanes run **in parallel**, so a slow lane never holds up the fast one.",
            moves: [
              {
                from: "hooks",
                to: "target:ticket-escalation-webhooks",
                label: "claim",
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4832",
                    name: "TicketEscalated",
                    data: { reason: "no reply" },
                    ref: "t32-esc",
                  },
                ],
              },
              { op: "checkpoint", at: "t32-esc" },
              {
                op: "mark",
                target: "ticket-escalation-webhooks",
                at: "t32-esc",
              },
              {
                op: "lease",
                target: "ticket-escalation-webhooks",
                by: "webhooks lane",
              },
            ],
          },
          {
            say: "Inside a lane, **priority** decides which targets that are behind get claimed first when the worker is saturated. It never reorders the events of a stream. `app.prioritize` changes it at run time.",
            code: `.to({ target: "notifications-out", priority: 10 })

await app.prioritize({ stream: "^proj-orders$" }, 10); // raise
await app.prioritize({ source: "^audit-" }, -5); // lower`,
            ops: [
              { op: "target", id: "ticket-escalation-webhooks", priority: 10 },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 8
  {
    id: "failures",
    title: "When a reaction fails",
    audience: "production",
    blurb:
      "Retries back off on a stored schedule, a stream blocks when its budget runs out, and an operator resumes it.",
    scenes: [
      {
        title: "Retries, backoff, blocked",
        nodes: [
          worker("hooks", "webhooks lane"),
          reaction("webhook", "escalation webhook"),
          outside("svc", "escalation service", "HTTP"),
          actor("ops", "operator"),
        ],
        api: [
          ".do(handler, { maxRetries, blockOnError, backoff })",
          'app.on("blocked")',
          "app.blocked_streams",
          "app.unblock",
          "NonRetryableError",
        ],
        doc: doc(
          "Error handling § Blocked streams",
          "concepts/error-handling#blocked-streams"
        ),
        test: test(
          core("backoff.spec.ts"),
          "spends the whole retry budget and blocks"
        ),
        code: `.do(webhook({ url, body, timeoutMs: 2_000 }), {
  maxRetries: 3,
  blockOnError: true, // the default
  backoff: { strategy: "exponential", baseMs: 200, maxMs: 10_000, jitter: true },
})`,
        steps: [
          {
            say: "The webhook POSTs #17 and the service answers 503. A failed attempt is retried after a **backoff**, and the schedule is stored on the target, so no worker retries before it is due.",
            moves: [
              { from: "webhook", to: "svc", label: "POST #17" },
              { from: "svc", to: "webhook", label: "503", tone: "bad" },
            ],
            ops: [
              {
                op: "retry",
                target: "ticket-escalation-webhooks",
                retry: 1,
                due: "~200 ms",
              },
            ],
          },
          {
            say: "Retries two and three fail too, each waiting longer: exponential, with jitter.",
            moves: [
              { from: "webhook", to: "svc", label: "retry" },
              { from: "svc", to: "webhook", label: "503", tone: "bad" },
            ],
            ops: [
              {
                op: "retry",
                target: "ticket-escalation-webhooks",
                retry: 3,
                due: "~800 ms",
              },
            ],
          },
          {
            say: "The fourth attempt fails. After `maxRetries + 1` attempts the target **blocks**: claim skips it, its watermark stays before #17, and the `blocked` event fires.",
            moves: [
              { from: "webhook", to: "svc", label: "attempt 4" },
              { from: "svc", to: "webhook", label: "503", tone: "bad" },
            ],
            code: `app.on("blocked", (blocked) => alert(blocked)); // [{ stream, error, retry, … }]
const stuck = await app.blocked_streams();`,
            ops: [
              {
                op: "block",
                target: "ticket-escalation-webhooks",
                error: "WebhookError 503",
              },
            ],
          },
          {
            say: "The service is back. `app.unblock` resumes **at the watermark**: #17 is delivered once more, and nothing before it runs again.",
            code: `await app.unblock(["ticket-escalation-webhooks"]);`,
            moves: [
              {
                from: "ops",
                to: "target:ticket-escalation-webhooks",
                label: "app.unblock",
              },
              { from: "webhook", to: "svc", label: "POST #17" },
              { from: "svc", to: "webhook", label: "200", tone: "good" },
            ],
            ops: [
              { op: "unblock", target: "ticket-escalation-webhooks" },
              {
                op: "ack",
                target: "ticket-escalation-webhooks",
                at: "t32-esc",
              },
            ],
          },
          {
            say: "Ticket 4833 escalates (#18) and the service answers **400**: a request that will never succeed. The webhook throws `NonRetryableError`, which blocks at the first attempt without spending the budget (unless `blockOnError` is false).",
            moves: [
              { from: "webhook", to: "svc", label: "POST #18" },
              { from: "svc", to: "webhook", label: "400", tone: "bad" },
            ],
            code: `// any handler can say a failure is permanent
throw new NonRetryableError("user deleted", { cause: error });`,
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4833",
                    name: "TicketEscalated",
                    data: { reason: "angry" },
                    ref: "t33-esc",
                  },
                ],
              },
              { op: "checkpoint", at: "t33-esc" },
              {
                op: "mark",
                target: "ticket-escalation-webhooks",
                at: "t33-esc",
              },
              {
                op: "block",
                target: "ticket-escalation-webhooks",
                error: "NonRetryable 400",
              },
            ],
          },
          {
            say: "Don't reach for `app.reset` here. Reset rewinds the watermark to −1 and replays **everything**: every webhook would be sent again. Reset rebuilds; unblock recovers.",
            ops: [
              {
                op: "flag",
                on: "target:ticket-escalation-webhooks",
                text: "reset → replays #0 on",
              },
            ],
          },
          {
            say: "When the **store itself** fails, the drain, settle and autoclose loops share a circuit breaker: after `failureThreshold` failures it opens, skips the store, and tries again after `cooldownMs`, so recovery needs no new commit. The `error` event fires on each failure.",
            code: `const app = act().withState(Ticket).build({
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000 },
});
app.on("error", ({ error, circuit }) => metrics.increment("store_error", { circuit }));`,
            ops: [
              { op: "unflag" },
              {
                op: "status",
                text: "StoreError · breaker open · retry after cooldown",
                tone: "bad",
              },
            ],
          },
          {
            say: "The store comes back and the breaker closes on the next pass. The bad request is fixed upstream, and the operator unblocks the target.",
            moves: [
              {
                from: "ops",
                to: "target:ticket-escalation-webhooks",
                label: "app.unblock",
              },
            ],
            ops: [
              { op: "status", text: "breaker closed", tone: "good" },
              { op: "unblock", target: "ticket-escalation-webhooks" },
              {
                op: "ack",
                target: "ticket-escalation-webhooks",
                at: "t33-esc",
              },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 9
  {
    id: "timers",
    title: "Timers: deferred reactions",
    audience: "first app",
    blurb:
      "A reaction can wait for a due time. The schedule is stored, so any worker runs it when it's due, even after a restart.",
    scenes: [
      {
        title: "Defer until due",
        nodes: [
          reaction("esc", "autoEscalate", "on TicketAssigned"),
          action("EscalateTicket"),
          st("ticket", "Ticket"),
          worker("drain", "drain"),
        ],
        api: [
          ".defer(when)",
          "{ after: { days, hours, minutes } }",
          "{ at: Date }",
          "DeferSignal",
        ],
        doc: doc(
          "State management § Deferred reactions",
          "concepts/state-management#deferred-reactions"
        ),
        test: test(
          core("defer.spec.ts"),
          "re-runs a sibling that shares the deferred reaction's target, but not an isolated one"
        ),
        code: `.on("TicketAssigned")
  .defer((event) => ({ at: event.data.escalateAfter }))
  .do(async function autoEscalate(event, _, app) {
    const { state } = await app.load("Ticket", event.stream);
    if (state.closedBy || state.escalated) return; // nothing to do any more
    await app.do("EscalateTicket", { stream: event.stream, actor: timers }, {});
  })
  .to((event) => ({ target: \`escalate:\${event.stream}\`, source: event.stream }))`,
        steps: [
          {
            say: "Ticket 4821 is assigned with `escalateAfter: 10:00` (#19). Correlate marks `escalate:ticket-4821`, and the drain finds the reaction **deferred**: the event stays pending and the target holds a due time.",
            ops: [
              { op: "status" },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4821",
                    name: "TicketAssigned",
                    data: { agent: "ana", escalateAfter: "10:00" },
                    ref: "t21-asg",
                  },
                ],
              },
              { op: "checkpoint", at: "t21-asg" },
              {
                op: "target",
                id: "escalate:ticket-4821",
                source: "ticket-4821",
              },
              { op: "mark", target: "escalate:ticket-4821", at: "t21-asg" },
              { op: "defer", target: "escalate:ticket-4821", due: "10:00" },
            ],
            moves: [
              {
                from: "cell:t21-asg",
                to: "target:escalate:ticket-4821",
                label: "defer",
              },
            ],
          },
          {
            say: "Claim skips the target until 10:00. The due time derives from the event, never from `Date.now()`, so a worker that claims it later lands on the same time. At 10:00 a worker runs it, and the ticket escalates (#20).",
            moves: [
              {
                from: "drain",
                to: "target:escalate:ticket-4821",
                label: "claim at 10:00",
              },
              { from: "esc", to: "EscalateTicket", label: "app.do" },
              {
                from: "EscalateTicket",
                to: "cell:t21-esc",
                label: "commit",
                tone: "good",
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4821",
                    name: "TicketEscalated",
                    data: { reason: "timer" },
                    cause: "t21-asg",
                    ref: "t21-esc",
                  },
                ],
              },
              { op: "ack", target: "escalate:ticket-4821", at: "t21-asg" },
              { op: "checkpoint", at: "t21-esc" },
            ],
          },
          {
            say: "Ticket 4822 is assigned with `escalateAfter: 11:00` (#21), then Bo closes it at 10:40 (#22).",
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4822",
                    name: "TicketAssigned",
                    data: { agent: "bo", escalateAfter: "11:00" },
                    ref: "t22-asg",
                  },
                ],
              },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4822",
                    name: "TicketClosed",
                    data: { closedBy: "bo" },
                    ref: "t22-closed",
                  },
                ],
              },
              { op: "checkpoint", at: "t22-closed" },
              {
                op: "target",
                id: "escalate:ticket-4822",
                source: "ticket-4822",
              },
              { op: "mark", target: "escalate:ticket-4822", at: "t22-asg" },
              { op: "defer", target: "escalate:ticket-4822", due: "11:00" },
            ],
          },
          {
            say: "At 11:00 the timer wakes, loads the ticket, finds it closed and returns. The drain acks; nothing is appended. A guard like this is how a deferred chain ends.",
            moves: [
              {
                from: "drain",
                to: "target:escalate:ticket-4822",
                label: "claim at 11:00",
              },
              { from: "ticket", to: "esc", label: "closed", tone: "muted" },
            ],
            ops: [
              {
                op: "state",
                node: "ticket",
                data: { status: "closed", closedBy: "bo" },
                version: 2,
              },
              { op: "ack", target: "escalate:ticket-4822", at: "t22-asg" },
            ],
          },
          {
            say: "When the wait depends on loaded state, a query or a branch, the handler throws `DeferSignal` instead. It holds the stream until due, then delivers the event again.",
            code: `.on("TicketOpened")
  .do(async function autoClose(event, _, app) {
    const { closeAfter } = event.data;
    if (!closeAfter) return;
    if (Date.now() < closeAfter.getTime()) throw new DeferSignal({ at: closeAfter });
    await app.do("CloseTicket", { stream: event.stream, actor: timers }, {});
  })`,
            ops: [{ op: "state", node: "ticket", data: null }],
          },
          {
            say: "Reactions that share a target are one group: when one defers, the event stays pending and the **whole group** runs again when due. Give a deferred reaction its own `.to(...)` and only it waits.",
            focus: [
              "target:escalate:ticket-4821",
              "target:escalate:ticket-4822",
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 10
  {
    id: "projections",
    title: "Projections, slices and rebuilds",
    audience: "first app",
    blurb:
      "A projection is a reaction that writes a read model. Because the log keeps everything, a read model can always be rebuilt.",
    scenes: [
      {
        title: "A read model",
        nodes: [
          projection("proj", "tickets", "projection"),
          worker("drain", "drain"),
          actor("ops", "operator"),
        ],
        api: [
          "projection(target)",
          ".on({ Event }).do(handler)",
          ".batch(handler)",
          ".of(...states).flush(handler)",
          "app.reset",
        ],
        doc: doc("Projections to a database", "guides/projections-to-database"),
        test: test(
          core("rebuild.spec.ts"),
          "should enable replay of projection after reset"
        ),
        code: `const Tickets = projection("tickets")
  .of(Ticket) // fold the state's own patches
  .flush(async (rows) => {
    for (const { stream, state } of rows) await db.upsert(tickets, { id: stream, ...state });
  })
  .build();

act().withState(Ticket).withProjection(Tickets).build();`,
        steps: [
          {
            say: "A **state projection** folds a state's own patches and flushes one row per stream. Its target is `tickets`; a new one starts at watermark −1.",
            ops: [
              { op: "table", name: "tickets", title: "tickets table" },
              { op: "target", id: "tickets" },
              { op: "mark", target: "tickets", at: "t22-closed" },
            ],
            focus: ["proj", "target:tickets"],
          },
          {
            say: "It drains like any reaction: it catches up on the whole log, then flushes the rows, then acks. A failed flush holds the watermark.",
            moves: [
              { from: "drain", to: "target:tickets", label: "claim" },
              { from: "target:tickets", to: "table:tickets", label: "flush" },
            ],
            ops: [
              {
                op: "row",
                table: "tickets",
                key: "ticket-4821",
                values: { status: "escalated", messages: 4 },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4822",
                values: { status: "closed", by: "bo" },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4830",
                values: { status: "closed", by: "bo" },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4831",
                values: { status: "open", agent: "bo" },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4832",
                values: { status: "escalated", agent: "ana" },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4833",
                values: { status: "escalated", agent: "bo" },
              },
              { op: "ack", target: "tickets", at: "t22-closed" },
            ],
          },
          {
            say: "Maya adds a message to ticket 4831 (#23). The projection's next drain updates one row.",
            moves: [
              {
                from: "cell:t31-m1",
                to: "table:tickets",
                label: "fold + flush",
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4831",
                    name: "MessageAdded",
                    data: { body: "Still no sound" },
                    ref: "t31-m1",
                  },
                ],
              },
              { op: "checkpoint", at: "t31-m1" },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4831",
                values: { status: "open", agent: "bo", messages: 1 },
              },
              { op: "ack", target: "tickets", at: "t31-m1" },
            ],
          },
          {
            say: "A **slice** groups partial states, projections and reactions into one feature. Partial states with the same name merge into one state, so features grow without touching each other.",
            code: `export const TicketSlice = slice()
  .withState(TicketCreation)   // partial "Ticket"
  .withState(TicketOperations) // partial "Ticket", merged
  .withProjection(Tickets)
  .on("TicketOpened").do(assign).to(byTicket)
  .build();

const app = act().withSlice(TicketSlice).withSlice(AgentSlice).build();`,
          },
          {
            say: 'To rebuild the table after a code change, empty it and call `app.reset(["tickets"])`. The watermark goes back to −1 and the reset schedules the replay on its own.',
            code: `await db.delete(tickets); // the read model is yours to empty
await app.reset(["tickets"]); // or a filter: app.reset({ stream: "^proj-" })`,
            moves: [{ from: "ops", to: "target:tickets", label: "app.reset" }],
            ops: [
              { op: "table", name: "tickets", clear: true },
              { op: "reset", target: "tickets" },
            ],
          },
          {
            say: "The replay walks the log from #0 and the rows come back. Nothing in the log changed: a projection is derived data.",
            moves: [
              { from: "cell:t21-open", to: "table:tickets", label: "replay" },
              { from: "cell:t31-m1", to: "table:tickets", label: "… #23" },
            ],
            ops: [
              {
                op: "row",
                table: "tickets",
                key: "ticket-4821",
                values: { status: "escalated", messages: 4 },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4822",
                values: { status: "closed", by: "bo" },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4830",
                values: { status: "closed", by: "bo" },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4831",
                values: { status: "open", agent: "bo", messages: 1 },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4832",
                values: { status: "escalated", agent: "ana" },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4833",
                values: { status: "escalated", agent: "bo" },
              },
              { op: "ack", target: "tickets", at: "t31-m1" },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 11
  {
    id: "loads",
    title: "Rules across streams: .loads",
    audience: "production",
    blurb:
      "One action can decide on several streams and append to all of them in one commit, each guarded by its version.",
    seed: [
      { stream: "agent-ana", name: "AgentAdded", data: { name: "Ana" } },
      { stream: "agent-bo", name: "AgentAdded", data: { name: "Bo" } },
      { stream: "agent-bo", name: "TicketTaken" },
      { stream: "agent-bo", name: "TicketTaken" },
      { stream: "agent-bo", name: "TicketTaken" },
      { stream: "agent-bo", name: "TicketTaken" },
      { stream: "agent-bo", name: "TicketTaken" },
      {
        stream: "ticket-5200",
        name: "TicketOpened",
        data: { title: "Monitor dead" },
        ref: "t5200-open",
      },
      {
        stream: "ticket-5201",
        name: "TicketOpened",
        data: { title: "Mouse lag" },
        ref: "t5201-open",
      },
    ],
    scenes: [
      {
        title: "One commit, several streams",
        nodes: [
          actor("lead", "Lee", "team lead"),
          action("AssignTicket"),
          st("ticket", "Ticket", "own stream"),
          st("current", "Agent · current", "load"),
          st("next", "Agent · next", "load"),
        ],
        api: [
          ".loads(State, target, events, name?)",
          "loaded",
          "ConcurrencyError.stream",
        ],
        doc: doc("Rules across streams", "guides/rules-across-streams"),
        test: test(
          core("loads.spec.ts"),
          "commits to both streams at once and returns its own snapshots"
        ),
        code: `// an agent holds at most five open tickets: the Agent schema says so
const Agent = state({ Agent: z.object({ name: z.string(), open: z.number().min(0).max(5) }) })
  // …TicketTaken: open + 1, TicketDropped: open − 1

.on({ AssignTicket }, { maxRetries: 4 })
  .loads(Agent, (_, s) => s.agentId && \`agent-\${s.agentId}\`, ["TicketDropped"], "current")
  .loads(Agent, (data) => \`agent-\${data.agentId}\`, ["TicketTaken"], "next")
  .requires([mustBeOpen])
  .emit((data) => [["TicketAssigned", data], ["TicketDropped", {}], ["TicketTaken", {}]])`,
        steps: [
          {
            say: "A fresh store: two agents, Bo already holding five tickets, two open tickets. Lee assigns ticket 5200 to Ana. `.loads` loads every state the decision needs, at once. The ticket has no agent yet, so the `current` target returns `undefined` and that load is skipped.",
            moves: [
              { from: "lead", to: "AssignTicket", label: "{ agentId: ana }" },
              { from: "AssignTicket", to: "ticket", label: "load ticket-5200" },
              {
                from: "AssignTicket",
                to: "next",
                label: "load agent-ana",
                par: true,
              },
            ],
            ops: [
              {
                op: "state",
                node: "ticket",
                data: { title: "Monitor dead", status: "open" },
                version: 0,
              },
              {
                op: "state",
                node: "current",
                data: { skipped: "no agent yet" },
              },
              {
                op: "state",
                node: "next",
                data: { name: "Ana", open: 0 },
                version: 0,
              },
            ],
            checks: checks(3),
          },
          {
            say: "Each event goes to the stream whose load lists it: `TicketAssigned` to the ticket, `TicketTaken` to `agent-ana` (`TicketDropped` is dropped with the skipped load). Both land in **one commit**, each stream guarded by the version it had at load. All or nothing.",
            moves: [
              {
                from: "ticket",
                to: "cell:t5200-asg",
                label: "expect 0",
                tone: "good",
              },
              {
                from: "next",
                to: "cell:ana-took1",
                label: "expect 0",
                tone: "good",
                par: true,
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-5200",
                    name: "TicketAssigned",
                    data: { agentId: "ana" },
                    ref: "t5200-asg",
                  },
                  {
                    stream: "agent-ana",
                    name: "TicketTaken",
                    ref: "ana-took1",
                  },
                ],
              },
              {
                op: "state",
                node: "ticket",
                data: { title: "Monitor dead", status: "open", agentId: "ana" },
                version: 1,
              },
              {
                op: "state",
                node: "next",
                data: { name: "Ana", open: 1 },
                version: 1,
              },
            ],
            checks: passed,
          },
          {
            say: "Lee assigns ticket 5201 to Bo. The fold makes Bo's `open` 6, which his state's schema refuses: `ValidationError`, and nothing lands on **any** stream. The loaded state's schema guards its fold, whichever action emits into it.",
            moves: [
              { from: "lead", to: "AssignTicket", label: "{ agentId: bo }" },
              { from: "AssignTicket", to: "next", label: "load agent-bo" },
            ],
            ops: [
              {
                op: "state",
                node: "ticket",
                data: { title: "Mouse lag", status: "open" },
                version: 0,
              },
              {
                op: "state",
                node: "current",
                data: { skipped: "no agent yet" },
              },
              {
                op: "state",
                node: "next",
                data: { name: "Bo", open: "5 → 6" },
                version: 5,
              },
              {
                op: "refuse",
                stream: "agent-bo",
                name: "TicketTaken",
                error: "ValidationError",
              },
            ],
            checks: checks(4, true),
          },
          {
            say: "Lee assigns 5201 to Ana instead, loading `agent-ana` at v1. Meanwhile ticket 5200 closes, and `CloseTicket` (which loads the agent too) drops Ana's slot in its own commit: `agent-ana` moves to v2.",
            moves: [
              { from: "AssignTicket", to: "next", label: "load agent-ana v1" },
            ],
            ops: [
              {
                op: "state",
                node: "next",
                data: { name: "Ana", open: 1 },
                version: 1,
              },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-5200",
                    name: "TicketClosed",
                    data: { closedBy: "ana" },
                    ref: "t5200-closed",
                  },
                  {
                    stream: "agent-ana",
                    name: "TicketDropped",
                    ref: "ana-dropped",
                  },
                ],
              },
            ],
          },
          {
            say: "Lee's commit expected `agent-ana` at v1 and found v2: the **whole** commit fails with `ConcurrencyError` naming `agent-ana`. The action's `maxRetries` reloads every stream and decides again.",
            moves: [
              { from: "next", to: "log", label: "expect 1", tone: "bad" },
            ],
            ops: [
              {
                op: "refuse",
                stream: "agent-ana",
                name: "TicketTaken",
                error: "ConcurrencyError",
              },
            ],
          },
          {
            say: "The retry sees Ana at `open: 0` and commits both events. A load that lists no events is only a read: nothing is appended to it, so it isn't guarded.",
            moves: [
              {
                from: "ticket",
                to: "cell:t5201-asg",
                label: "expect 0",
                tone: "good",
              },
              {
                from: "next",
                to: "cell:ana-took2",
                label: "expect 2",
                tone: "good",
                par: true,
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-5201",
                    name: "TicketAssigned",
                    data: { agentId: "ana" },
                    ref: "t5201-asg",
                  },
                  {
                    stream: "agent-ana",
                    name: "TicketTaken",
                    ref: "ana-took2",
                  },
                ],
              },
              {
                op: "state",
                node: "ticket",
                data: { title: "Mouse lag", status: "open", agentId: "ana" },
                version: 1,
              },
              {
                op: "state",
                node: "next",
                data: { name: "Ana", open: 1 },
                version: 3,
              },
            ],
            checks: passed,
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 12
  {
    id: "sensitive",
    title: "Sensitive data",
    audience: "production",
    blurb:
      "Sensitive fields live in their own column of the event row, are gated on read, and can be wiped without rewriting the log.",
    seed: [
      {
        stream: "ticket-6001",
        name: "TicketOpened",
        data: { title: "Password reset" },
      },
    ],
    scenes: [
      {
        title: "Split, gate, forget",
        nodes: [
          actor("lee", "Lee", "user-42"),
          actor("ops", "operator"),
          action("register"),
          st("user", "User", "user-42"),
        ],
        api: [
          "sensitive(schema)",
          ".discloses(predicate)",
          "app.load(State, { stream, actor })",
          "app.forget",
          "REDACTED",
          "SHREDDED",
          'app.on("forgotten")',
        ],
        doc: doc("Handling sensitive data", "guides/sensitive-data"),
        test: test(
          core("forget.spec.ts"),
          "happy path — wipes pii, returns the row count, emits forgotten once"
        ),
        code: `const UserRegistered = z.object({
  email: sensitive(z.string().email()),
  plan: z.enum(["free", "pro"]),
});

const User = state({ User: UserSchema })
  // …
  .discloses((event, actor) => actor.id === event.stream)
  .build();`,
        steps: [
          {
            say: "Lee registers. `email` is marked `sensitive(...)`, so the commit never puts it in the event's data: it goes to a separate **pii** column of the same row, in the same transaction.",
            moves: [
              { from: "lee", to: "register", label: "{ email, plan }" },
              {
                from: "register",
                to: "cell:u42-reg",
                label: "data + pii",
                tone: "good",
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "user-42",
                    name: "UserRegistered",
                    data: { plan: "pro" },
                    pii: { email: "lee@example.com" },
                    ref: "u42-reg",
                  },
                ],
              },
              {
                op: "flag",
                on: "cell:u42-reg",
                text: "data { plan } · pii { email }",
              },
            ],
          },
          {
            say: "A read with no actor (a background worker, a script) gets `[REDACTED]` in place of every sensitive field. Reactions and projections never see them either.",
            moves: [
              { from: "cell:u42-reg", to: "user", label: "load, no actor" },
            ],
            ops: [
              { op: "unflag" },
              {
                op: "state",
                node: "user",
                data: { "event.email": "[REDACTED]", plan: "pro" },
                version: 0,
              },
            ],
          },
          {
            say: "`.discloses` decides who may read the plaintext. Lee loads his own stream with his actor, the predicate holds, and he reads his email.",
            code: `const snap = await app.load(User, { stream: "user-42", actor: lee });
// snap.event.data.email → "lee@example.com"`,
            moves: [
              {
                from: "cell:u42-reg",
                to: "user",
                label: "load as Lee",
                tone: "good",
              },
            ],
            ops: [
              {
                op: "state",
                node: "user",
                data: { "event.email": "lee@example.com", plan: "pro" },
                version: 0,
              },
            ],
          },
          {
            say: 'Lee asks to be forgotten. `app.forget("user-42")` wipes the pii column of every event on the stream, in place. Every later read gets `[SHREDDED]`, even an authorized one. Everything else in the log stays.',
            code: `const { eventCount } = await app.forget("user-42"); // 1
app.on("forgotten", ({ stream, at, eventCount }) => audit.write({ stream, at, eventCount }));`,
            moves: [
              {
                from: "ops",
                to: "cell:u42-reg",
                label: "app.forget",
                tone: "bad",
              },
            ],
            ops: [
              { op: "forget", stream: "user-42" },
              {
                op: "state",
                node: "user",
                data: { "event.email": "[SHREDDED]", plan: "pro" },
                version: 0,
              },
              {
                op: "flag",
                on: "cell:u42-reg",
                text: "forgotten { eventCount: 1 }",
                tone: "bad",
              },
            ],
          },
          {
            say: "A snapshot would copy derived state where forget can't reach it, so a state whose events declare sensitive fields can't `.snap()`: the build throws. For the same reason a restart close skips such a stream.",
            ops: [{ op: "unflag" }],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 13
  {
    id: "close",
    title: "Closing the books",
    audience: "operator",
    blurb:
      "Archive a stream, then delete its events and leave one seed: a tombstone to retire it, or a snapshot to keep going.",
    seed: [
      {
        stream: "ticket-4822",
        name: "TicketOpened",
        data: { title: "VPN drops" },
        ref: "c-open",
      },
      {
        stream: "agent-ana",
        name: "AgentAdded",
        data: { name: "Ana" },
        ref: "c-ana",
      },
      {
        stream: "ticket-4822",
        name: "TicketAssigned",
        data: { agentId: "ana" },
        ref: "c-asg",
      },
      { stream: "agent-ana", name: "TicketTaken", ref: "c-took" },
      {
        stream: "ticket-4823",
        name: "TicketOpened",
        data: { title: "Wi-Fi" },
        ref: "c-4823",
      },
      {
        stream: "ticket-4822",
        name: "TicketClosed",
        data: { closedBy: "ana" },
        ref: "c-closed",
      },
      { stream: "agent-ana", name: "TicketDropped", ref: "c-dropped" },
    ],
    scenes: [
      {
        title: "Tombstone or restart",
        nodes: [
          actor("ops", "operator"),
          action("close", "app.close"),
          outside("s3", "archive", "S3 bucket"),
          projection("proj", "tickets"),
        ],
        api: [
          "app.close(targets)",
          "CloseTarget { stream, archive?, restart? }",
          "CloseResult",
          "TOMBSTONE_EVENT",
          "StreamClosedError",
          'app.on("closed")',
        ],
        doc: doc("Close cycle", "architecture/close-cycle"),
        test: test(
          core("close.spec.ts"),
          "should restart streams with snapshot at version 0"
        ),
        code: `const { truncated, skipped } = await app.close([
  { stream: "ticket-4822", archive: () => s3.put("ticket-4822", events) },
  { stream: "agent-ana", restart: true },
]);`,
        steps: [
          {
            say: "Ticket 4822 is done. Close first checks that no reaction still has work on it. The `tickets` projection has handled up to #4 only, so the stream is **skipped** this time: a close never drops events a reaction hasn't seen.",
            moves: [
              { from: "ops", to: "close", label: "close ticket-4822" },
              {
                from: "close",
                to: "target:tickets",
                label: "caught up?",
                tone: "bad",
              },
            ],
            ops: [
              { op: "target", id: "tickets" },
              { op: "ack", target: "tickets", at: "c-4823" },
              { op: "flag", on: "target:tickets", text: "behind: skipped" },
            ],
          },
          {
            say: "The projection catches up. Close tries again and commits a `__tombstone__` **guard** at the stream's version (#7, v3). From here, no writer can land on the stream.",
            moves: [{ from: "close", to: "cell:c-guard", label: "guard" }],
            ops: [
              { op: "unflag" },
              { op: "ack", target: "tickets", at: "c-dropped" },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4822",
                    name: "__tombstone__",
                    ref: "c-guard",
                  },
                ],
              },
            ],
          },
          {
            say: "The archive callback runs while the stream is guarded. If it throws, the stream stays guarded and nothing is deleted, so the close can simply run again.",
            moves: [
              { from: "cell:c-guard", to: "s3", label: "archive" },
              { from: "s3", to: "close", label: "ok", tone: "good" },
            ],
          },
          {
            say: "Then the stream's events are deleted in one transaction, and one seed is left: a `__tombstone__` at **version 0** (#8). The cache is updated and `closed` fires.",
            moves: [
              { from: "close", to: "cell:c-seed", label: "truncate + seed" },
            ],
            ops: [
              {
                op: "truncate",
                stream: "ticket-4822",
                seed: "tombstone",
                ref: "c-seed",
              },
            ],
          },
          {
            say: "An action on a closed stream throws `StreamClosedError`. The tombstone is its head forever.",
            moves: [
              { from: "ops", to: "log", label: "AddMessage", tone: "bad" },
            ],
            ops: [
              {
                op: "refuse",
                stream: "ticket-4822",
                name: "MessageAdded",
                error: "StreamClosedError",
              },
            ],
          },
          {
            say: "A **restart** keeps the stream alive: Ana's stream is guarded, deleted, and seeded with a `__snapshot__` of its final state at v0 (#10).",
            moves: [{ from: "close", to: "cell:c-ana-seed", label: "restart" }],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "agent-ana",
                    name: "__tombstone__",
                    ref: "c-ana-guard",
                  },
                ],
              },
              {
                op: "truncate",
                stream: "agent-ana",
                seed: "snapshot",
                data: { name: "Ana", open: 0 },
                ref: "c-ana-seed",
              },
            ],
          },
          {
            say: "Her next action lands on v1 (#11), folding from the seed. Closing the books shrinks the log; the state carries on.",
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "agent-ana",
                    name: "TicketTaken",
                    ref: "c-ana-took",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 14
  {
    id: "policies",
    title: "Close policies and rolling windows",
    audience: "operator",
    blurb:
      "A state can declare when its streams close, or how much history they keep. The framework turns it into a reaction.",
    seed: [
      {
        stream: "ticket-7001",
        name: "TicketOpened",
        data: { title: "Desk phone" },
        ref: "p-open",
      },
      {
        stream: "ledger-9",
        name: "Posted",
        data: { amount: 100, on: "Jan 02" },
        ref: "l-1",
      },
      {
        stream: "ledger-9",
        name: "Posted",
        data: { amount: -40, on: "Feb 10" },
        ref: "l-2",
      },
      {
        stream: "ticket-7001",
        name: "TicketClosed",
        data: { closedBy: "bo", on: "Feb 20" },
        ref: "p-closed",
      },
      {
        stream: "ledger-9",
        name: "Posted",
        data: { amount: 25, on: "Mar 01" },
        ref: "l-3",
      },
      {
        stream: "ledger-9",
        name: "__snapshot__",
        data: { balance: 85, on: "Mar 01" },
        ref: "l-snap1",
      },
      {
        stream: "ledger-9",
        name: "Posted",
        data: { amount: 10, on: "Jul 15" },
        ref: "l-4",
      },
      {
        stream: "ledger-9",
        name: "Posted",
        data: { amount: -5, on: "Aug 02" },
        ref: "l-5",
      },
      {
        stream: "ledger-9",
        name: "Posted",
        data: { amount: 30, on: "Sep 09" },
        ref: "l-6",
      },
      {
        stream: "ledger-9",
        name: "__snapshot__",
        data: { balance: 120, on: "Sep 09" },
        ref: "l-snap2",
      },
    ],
    scenes: [
      {
        title: "Autoclose after a cooldown",
        nodes: [
          st("ticket", "Ticket", ".autocloses"),
          reaction("auto", "autoclose", "synthesized"),
          outside("s3", "archive", ".archives(fn)"),
        ],
        api: [
          ".autocloses({ is, after, reaches, or, keep })",
          ".archives(fn)",
          "autocloseWindow",
        ],
        doc: doc("Online close-the-books policies", "guides/close-policies"),
        test: test(
          core("autoclose-reaction.spec.ts"),
          "evaluates the live head — a reopened stream is not closed"
        ),
        code: `const Ticket = state({ Ticket: TicketSchema })
  // …
  .autocloses({ is: ["TicketClosed", "TicketResolved"], after: { days: 90 } })
  .archives(async (stream) => archiveToS3(stream))
  .build();

act().withState(Ticket).build({
  autocloseWindow: { start: 22, end: 6, timeZone: "America/New_York" }, // off-hours only
});`,
        steps: [
          {
            say: "`.autocloses` compiles to a reaction on the state's events, on a per-stream target. Ticket 7001 closed on Feb 20, so the reaction defers to **90 days later**: a stored schedule, no sweep.",
            moves: [
              {
                from: "cell:p-closed",
                to: "target:__autoclose__:ticket-7001",
                label: "defer",
              },
            ],
            ops: [
              {
                op: "target",
                id: "__autoclose__:ticket-7001",
                source: "ticket-7001",
              },
              {
                op: "mark",
                target: "__autoclose__:ticket-7001",
                at: "p-closed",
              },
              {
                op: "defer",
                target: "__autoclose__:ticket-7001",
                due: "May 21 (+90 days)",
              },
            ],
          },
          {
            say: "When it is due (inside the off-hours window), it checks the **live head**: still `TicketClosed`, so it runs the same close cycle as `app.close`, with `.archives` as the archive. A reopened ticket would not close.",
            moves: [
              { from: "auto", to: "s3", label: "archive" },
              { from: "auto", to: "cell:p-seed", label: "truncate + seed" },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-7001",
                    name: "__tombstone__",
                    ref: "p-guard",
                  },
                ],
              },
              {
                op: "truncate",
                stream: "ticket-7001",
                seed: "tombstone",
                ref: "p-seed",
              },
              { op: "untarget", id: "__autoclose__:ticket-7001" },
            ],
          },
        ],
      },
      {
        title: "Keep a rolling window",
        nodes: [
          st("ledger", "Ledger", ".snap + keep"),
          reaction("auto", "autoclose", "keep: 180 days"),
          actor("ops", "operator"),
        ],
        api: [
          ".autocloses({ keep: { days } })",
          "app.close([{ stream, before }])",
        ],
        doc: doc(
          "Close policies § keep",
          "guides/close-policies#keep--days---the-rolling-window"
        ),
        test: test(
          TCK,
          "deletes the prefix below the closest safe snapshot and keeps the snapshot + tail"
        ),
        code: `const Ledger = state({ Ledger: z.object({ balance: z.number() }) })
  // …
  .snap((s) => s.patches >= 3) // keep requires snapshots
  .autocloses({ keep: { days: 180 } }) // days, never minutes
  .archives(async (stream, _head, before) => {
    if (before) await archiveToS3(stream, before);
  })
  .build();`,
        steps: [
          {
            say: "Some streams never end. `keep: { days: 180 }` prunes history older than the window. Today is Oct 1, so the cutoff is Apr 4. The closest snapshot older than the cutoff is the one from Mar 01 (#5).",
            ops: [
              { op: "flag", on: "cell:l-snap1", text: "closest safe snapshot" },
            ],
            focus: ["cell:l-snap1"],
          },
          {
            say: "A **windowed** close deletes only the events **below** that snapshot. No tombstone, no seed: the snapshot holds the balance, and the stream stays live and keeps taking actions.",
            moves: [{ from: "auto", to: "cell:l-snap1", label: "prune below" }],
            ops: [
              { op: "unflag" },
              { op: "prune", stream: "ledger-9", below: "l-snap1" },
            ],
          },
          {
            say: "The window advances on the stream's commits. A stream that went quiet is pruned with an explicit windowed close: `app.close([{ stream, before }])`, which archives only through its own `archive`.",
            code: `const cutoff = new Date(Date.now() - 180 * 86_400_000);
await app.close([{ stream: "ledger-9", before: cutoff, archive: () => archiveLedger(cutoff) }]);`,
            moves: [
              { from: "ops", to: "cell:l-snap1", label: "before: cutoff" },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 15
  {
    id: "restore",
    title: "Restore, migrate and audit",
    audience: "operator",
    blurb:
      "Rebuild a store from another in one transaction: compact it, migrate it, move it between adapters.",
    scenes: [
      {
        title: "Rebuild a store",
        nodes: [
          actor("ops", "operator"),
          action("restore", "app.restore"),
          port("csv", "source", "PostgresStore"),
        ],
        api: [
          "app.restore(source, options?, sink?)",
          "CsvFile",
          "ScanOptions",
          "EventMigration",
          "drop_snapshots",
          "drop_closed_streams",
        ],
        doc: doc(
          "Event sourcing § Restoring a store",
          "concepts/event-sourcing#restoring-a-store"
        ),
        test: test(
          core("restore.spec.ts"),
          "carries a __snapshot__ through a store-to-store restore"
        ),
        code: `const pg = new PostgresStore({ /* … */ });
const sqlite = new SqliteStore({ url: "file:./desk.db" });
const result = await app.restore(pg, {}, sqlite); // source → sink, one transaction`,
        steps: [
          {
            say: "The store after the last chapter has gaps: closed and pruned streams left holes in the ids. Restore copies a source into a sink in **one transaction**. Ids renumber densely, `created` is kept, and causation is rewritten to the new ids.",
            moves: [{ from: "restore", to: "log:sink", label: "scan → sink" }],
            ops: [
              { op: "unflag" },
              { op: "store", name: "main", label: "PostgresStore (source)" },
              { op: "store", name: "sink", label: "SqliteStore (new)" },
              { op: "restore", from: "main", store: "sink" },
            ],
          },
          {
            say: "It can compact on the way: `drop_snapshots` drops every snapshot that has history before it, but keeps a stream's **first** one, which a pruned or restarted stream starts from.",
            code: `await app.restore(pg, { drop_snapshots: true }, sqlite);`,
            ops: [
              {
                op: "restore",
                from: "main",
                store: "sink",
                dropSnapshots: true,
              },
            ],
          },
          {
            say: "It can migrate events too. On the live store an event never changes: a new name like `Posted_v2` deprecates the old one. A restore can physically rewrite old events as they pass, validated on both sides.",
            code: `await app.restore(pg, {
  drop_snapshots: true,
  event_migrations: {
    Posted: {
      to: "Posted_v2",
      from_schema: z.object({ amount: z.number(), on: z.string() }),
      to_schema: z.object({ cents: z.number(), on: z.string() }),
      migrate: ({ amount, on }) => ({ cents: amount * 100, on }),
    },
  },
}, sqlite);`,
            ops: [
              {
                op: "restore",
                from: "main",
                store: "sink",
                dropSnapshots: true,
                rename: { Posted: "Posted_v2" },
              },
            ],
          },
          {
            say: "Restore doesn't touch the cache or your read models: after a destructive restore, clear the cache and rebuild projections with `app.reset`.",
            code: `await cache().clear();
await app.reset({ stream: "^proj-" });`,
          },
          {
            say: "`app.audit()` walks a store and yields findings an operator can act on: schema drift, close and restart candidates, blocked or stuck reactions, snapshot drift, correlation gaps.",
            code: `for await (const f of app.audit(["close-candidate", "reaction-health"], {
  thresholds: { idle_days: 14 },
})) console.log(f);`,
            ops: [
              {
                op: "flag",
                on: "cell:l-6",
                text: "close-candidate: idle",
                tone: "warn",
              },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 16
  {
    id: "scale",
    title: "Scaling out: processes, wakeups, scoped Acts",
    audience: "operator",
    blurb:
      "Many processes share one store; a store that notifies wakes them at once. Several Acts in one process keep their stores apart.",
    seed: [
      {
        stream: "ticket-8001",
        name: "TicketOpened",
        data: { title: "Scanner" },
        ref: "s-open",
      },
    ],
    scenes: [
      {
        title: "Cross-process wakeups",
        nodes: [
          worker("pa", "process A", "API server"),
          worker("pb", "process B", "worker"),
          port("pg", "Postgres", "LISTEN / NOTIFY"),
        ],
        api: [
          "store(adapter)",
          "PostgresStore({ notify: true })",
          "Store.notify",
          'app.on("notified")',
          "withBroker",
          "app.start_correlations",
        ],
        doc: doc(
          "Cross-process reactions",
          "architecture/cross-process-reactions"
        ),
        test: test(
          TCK,
          "does not deliver an instance's own commits (self-filtering)"
        ),
        code: `store(new PostgresStore({ /* … */ notify: true })); // before act()...build()
const app = act().withSlice(TicketSlice).build();`,
        steps: [
          {
            say: "Two processes run the same app over one Postgres store. Without notify, process B sees A's commit only when it polls (`start_correlations`, every 10 s by default).",
            ops: [
              { op: "store", name: "main", label: "PostgresStore" },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-8002",
                    name: "TicketOpened",
                    data: { title: "Keyboard" },
                    ref: "s-2",
                  },
                ],
              },
              { op: "status", text: "B: next poll in 10 s", tone: "warn" },
            ],
            moves: [{ from: "pa", to: "cell:s-2", label: "commit" }],
          },
          {
            say: "With a store that notifies, A's commit wakes B at once: B gets `notified` and settles. An instance never hears its own commits; its own commit already settles locally. Inject the store before `build()`, or nothing is wired.",
            moves: [
              { from: "pa", to: "cell:s-3", label: "commit" },
              { from: "pg", to: "pb", label: "NOTIFY", tone: "good" },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-8003",
                    name: "TicketOpened",
                    data: { title: "Headset" },
                    ref: "s-3",
                  },
                ],
              },
              { op: "status", text: "B: notified, settling", tone: "good" },
            ],
          },
          {
            say: "Notify is a hint, not a guarantee: correctness always comes from claim and drain over the store. That's why the channel can be swapped, for example to Redis with `withBroker`.",
            code: `store(withBroker(new PostgresStore({ notify: false }), new RedisBroker({ publisher, subscriber })));`,
          },
        ],
      },
      {
        title: "Scoped Acts",
        nodes: [worker("ta", "tenant A app"), worker("tb", "tenant B app")],
        api: ["ActOptions.scoped { store, cache }", "app.shutdown"],
        doc: doc(
          "Extension points § Scoped ports",
          "architecture/extension-points#scoped-ports-per-act"
        ),
        test: test(
          core("scope.spec.ts"),
          "two Acts with their own scoped ports — no cross-talk"
        ),
        code: `const build = (schema: string) =>
  act().withSlice(TicketSlice).build({
    scoped: { store: new PostgresStore({ schema }), cache: new InMemoryCache() },
  });
const tenantA = build("tenant_a");
const tenantB = build("tenant_b");`,
        steps: [
          {
            say: "Several Acts in one process can each get their **own store and cache**, passed together. Two tenants, two logs, no cross-talk. One store always belongs to one application.",
            moves: [
              { from: "ta", to: "cell:s-a", label: "commit" },
              { from: "tb", to: "cell:s-b", label: "commit", par: true },
            ],
            ops: [
              { op: "status" },
              { op: "store", name: "main", label: "PostgresStore (tenant_a)" },
              {
                op: "store",
                name: "tenant-b",
                label: "PostgresStore (tenant_b)",
              },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-8004",
                    name: "TicketOpened",
                    data: { title: "Dock" },
                    ref: "s-a",
                  },
                ],
              },
              {
                op: "commit",
                store: "tenant-b",
                events: [
                  {
                    stream: "ticket-1",
                    name: "TicketOpened",
                    data: { title: "Login" },
                    ref: "s-b",
                  },
                ],
              },
            ],
          },
          {
            say: "`app.shutdown()` waits for in-flight drains up to a grace budget, hands back the correlation lease, and starts nothing after it resolves.",
            code: `await tenantA.shutdown();
await tenantB.shutdown();`,
            ops: [
              {
                op: "status",
                store: "tenant-b",
                text: "shut down",
                tone: "muted",
              },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 17
  {
    id: "edge",
    title: "At the edge: generated APIs and live updates",
    audience: "production",
    blurb:
      "Routes, types and live updates come from the app's registry. Outside calls are reactions.",
    scenes: [
      {
        title: "HTTP in, patches out",
        nodes: [
          outside("browser", "browser", "typed client"),
          action("route", "POST /api/actions/OpenTicket", "hono(app)"),
          st("ticket", "Ticket"),
          worker("sse", "BroadcastChannel", "SSE"),
        ],
        api: [
          "trpc(app, options)",
          "hono(app, options)",
          "openapi(app, options)",
          "BroadcastChannel",
          "webhook(config)",
        ],
        doc: doc("Auto-generated API surfaces", "guides/auto-generated-api"),
        test: test(
          "libs/act-http/test/api/errors.spec.ts",
          "maps PreconditionError to 409 + PRECONDITION"
        ),
        code: `import { hono } from "@rotorsoft/act-http/hono";
import { BroadcastChannel } from "@rotorsoft/act-http/sse";
import { trpc } from "@rotorsoft/act-http/trpc";

const sse = { channel: new BroadcastChannel() };
export const api = hono(app, { actor, stream, sse }); // POST /api/actions/<action>, GET /api/sse/<state>
export const router = trpc(app, { actor, stream, sse });`,
        steps: [
          {
            say: "`@rotorsoft/act-http` walks the registry and generates a route per action: the action's payload in, its snapshots out, typed end to end on the client.",
            moves: [
              { from: "browser", to: "route", label: "{ title }" },
              { from: "route", to: "ticket", label: "app.do" },
              {
                from: "ticket",
                to: "cell:e-open",
                label: "commit",
                tone: "good",
              },
              {
                from: "route",
                to: "browser",
                label: "200 [snapshot]",
                tone: "good",
              },
            ],
            ops: [
              { op: "store", name: "tenant-b", label: "", remove: true },
              { op: "store", name: "main", label: "PostgresStore" },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-8100",
                    name: "TicketOpened",
                    data: { title: "Docking" },
                    ref: "e-open",
                  },
                ],
              },
            ],
          },
          {
            say: "Errors map to status codes in one table: a refused precondition answers **409** `PRECONDITION`.",
            moves: [
              { from: "browser", to: "route", label: "close twice" },
              {
                from: "route",
                to: "browser",
                label: "409 PRECONDITION",
                tone: "bad",
              },
            ],
            ops: [
              {
                op: "refuse",
                stream: "ticket-8100",
                name: "TicketClosed",
                error: "PreconditionError",
              },
            ],
          },
          {
            say: "With `sse`, each committed change reaches the clients subscribed to that state as a small patch, versioned, so a client that falls behind knows to refetch.",
            moves: [
              { from: "cell:e-open", to: "sse", label: "committed" },
              { from: "sse", to: "browser", label: "patch v0", tone: "good" },
            ],
          },
          {
            say: "Calls out of the process are reactions too: `webhook(...)` from `@rotorsoft/act-http/webhook` is a handler with a timeout, an idempotency key from the event id, and typed errors that drive retries and blocking.",
            code: `.on("TicketOpened")
  .do(webhook({ url, body: (e) => ({ ticket: e.stream }), timeoutMs: 2_000 }), { maxRetries: 5, backoff })
  .to("ticket-webhooks")`,
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 18
  {
    id: "adapters",
    title: "Adapters and the TCK",
    audience: "adapter author",
    blurb:
      "The store is a port. Every adapter proves the same contract with the same tests.",
    scenes: [
      {
        title: "One contract, three stores",
        nodes: [
          port("port", "store()", "the port"),
          outside("tck", "runStoreTck", "@rotorsoft/act-tck"),
        ],
        api: [
          "store(adapter)",
          "InMemoryStore",
          "PostgresStore",
          "SqliteStore",
          "runStoreTck",
          "@rotorsoft/act/adapter",
        ],
        doc: doc("Writing a store", "guides/writing-a-store"),
        test: test(
          TCK,
          "leaves nothing of the commit that lost a race, on any of its streams"
        ),
        code: `import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { SqliteStore } from "@rotorsoft/act-sqlite";

store(new PostgresStore({ host, database, schema: "desk" })); // production
// store(new SqliteStore({ url: "file:./desk.db" }));          // embedded, single node
// InMemoryStore is the default: dev and tests`,
        steps: [
          {
            say: "Everything in this tour ran against the store **port**. InMemory is the default; Postgres and SQLite run the same log in production. Inject one before building the app.",
            ops: [{ op: "store", name: "main", label: "InMemoryStore" }],
            focus: ["port"],
          },
          {
            say: "Swap the adapter and nothing above the log changes: same ids, same versions, same leases.",
            ops: [{ op: "store", name: "main", label: "SqliteStore" }],
          },
          {
            say: "A new adapter proves the contract with the **TCK**: the same suite the in-tree stores run. A commit across streams is all or nothing, an unexpired lease goes to no one else, a truncate seeds, notify never echoes.",
            code: `import { runStoreTck } from "@rotorsoft/act-tck";

runStoreTck({
  name: "MysqlStore",
  factory: () => new MysqlStore({ host: "localhost", database: "act_tck" }),
  capabilities: { notify: false, restore: false, pii_isolation: false, source_matches: false },
});`,
            moves: [{ from: "tck", to: "store:main", label: "run" }],
            ops: [
              { op: "store", name: "main", label: "MysqlStore (yours)" },
              {
                op: "status",
                text: "TCK ✓ commit · claim · truncate · notify",
                tone: "good",
              },
            ],
          },
          {
            say: "The rules a store must apply are exported from `@rotorsoft/act/adapter`, so every store refuses the same bad appends and builds the same seeds. That's the whole tour: every capability is something the log does.",
            code: `import { checkAppends, checkVersion, seedEvent } from "@rotorsoft/act/adapter";`,
          },
        ],
      },
    ],
  },
];

const tour: TourSpec = {
  title: "The Act framework tour",
  stores: [{ name: "main", label: "InMemoryStore" }],
  chapters,
};
export default tour;
