import type {
  AppSpec,
  Chapter,
  Link,
  Node,
  StreamKind,
  TourSpec,
} from "../components/Tour/types";

/**
 * The framework tour: every capability of Act shown as what it does to the
 * event store. The design notes (the screen, the narration, what was left out)
 * are in docs/flows/framework-tour.script.md; every spoken line lives here.
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

// ── the running app, chapter by chapter: what its registry holds ──────────

const PORTS = [
  "store: InMemoryStore",
  "cache: InMemoryCache",
  "logger: ConsoleLogger",
];

/** The code behind the app's elements, shown behind their `</>` icons. */
const CODE: Record<string, string> = {
  Ticket: `const Ticket = state({ Ticket: TicketSchema })
  .init(() => ({ title: "", status: "new", messages: 0 }))
  .emits({ TicketOpened, MessageAdded, TicketClosed })
  .patch({ /* one reducer per event */ })`,
  OpenTicket: `.on({ OpenTicket: z.object({ title: z.string() }) })
  .emit("TicketOpened")`,
  AddMessage: `.on({ AddMessage: z.object({ body: z.string() }) }, { maxRetries: 2 })
  .emit("MessageAdded")`,
  CloseTicket: `.on({ CloseTicket: z.object({ reason: z.string() }) })
  .requires([mustBeOpen])
  .emit((_, __, { actor }) => ["TicketClosed", { closedBy: actor.id }])`,
  AssignTicket: `.on({ AssignTicket }, { maxRetries: 4 })
  .loads(Agent, (_, s) => s.agentId && \`agent-\${s.agentId}\`, ["TicketDropped"], "current")
  .loads(Agent, (data) => \`agent-\${data.agentId}\`, ["TicketTaken"], "next")
  .requires([mustBeOpen])
  .emit((data) => [["TicketAssigned", data], ["TicketDropped", {}], ["TicketTaken", {}]])`,
  EscalateTicket: `.on({ EscalateTicket }, { maxRetries: 4 })
  .requires([mustBeOpen, mustNotBeEscalated])
  .emit((data) => ["TicketEscalated", data])`,
  Agent: `const Agent = state({
  Agent: z.object({ name: z.string(), open: z.number().min(0).max(5) }),
})
  .init(() => ({ name: "", open: 0 }))
  .emits({ AgentAdded, TicketTaken, TicketDropped })
  .patch({ TicketTaken: (_, s) => ({ open: s.open + 1 }), TicketDropped: (_, s) => ({ open: s.open - 1 }) })`,
  AddAgent: `.on({ AddAgent }).requires([notOnTheDesk]).emit((data) => ["AgentAdded", data])`,
  assign: `.on("TicketOpened")
  .do(async function assign(event, stream, app) {
    await app.do("AssignTicket", { stream: event.stream, actor: bot }, { agentId: "bo" });
  })
  .to((event) => ({ target: \`assign:\${event.stream}\`, source: event.stream }))`,
  "escalation webhook": `.on("TicketEscalated")
  .do(webhook({ url, body, timeoutMs: 2_000 }), {
    maxRetries: 3,
    backoff: { strategy: "exponential", baseMs: 200, maxMs: 10_000, jitter: true },
  })
  .to({ target: "ticket-escalation-webhooks", lane: "webhooks" })`,
  "lane:webhooks": `.withLane({ name: "webhooks", leaseMillis: 30_000, streamLimit: 5 })`,
  autoEscalate: `.on("TicketAssigned")
  .defer((event) => ({ at: event.data.escalateAfter }))
  .do(async function autoEscalate(event, _, app) { /* … */ })
  .to((event) => ({ target: \`escalate:\${event.stream}\`, source: event.stream }))`,
  tickets: `projection("tickets")
  .of(Ticket) // folds the state's own patches
  .flush(async (rows) => { /* one upsert per stream */ })
  .build()`,
  "slice:Tickets": `export const TicketSlice = slice()
  .withState(Ticket)
  .withProjection(Tickets)
  .on("TicketOpened").do(assign).to(byTicket)
  .build();`,
  "slice:Agents": `export const AgentSlice = slice().withState(Agent).build();`,
  User: `const User = state({ User: UserSchema })
  .emits({ UserRegistered: z.object({ email: sensitive(z.string().email()), plan: Plan }) })
  .discloses((event, actor) => actor.id === event.stream)`,
  register: `.on({ register: RegisterSchema }).emit((data) => ["UserRegistered", data])`,
  Ledger: `const Ledger = state({ Ledger: z.object({ balance: z.number() }) })
  .snap((s) => s.patches >= 3)
  .autocloses({ keep: { days: 180 } })`,
  post: `.on({ post: z.object({ amount: z.number() }) }).emit((a) => ["Posted", a])`,
  autoclose: `// synthesized at build from the state's .autocloses(...)
.autocloses({ is: ["TicketClosed", "TicketResolved"], after: { days: 90 } })
.archives(async (stream) => archiveToS3(stream))`,
  "app.close": `const { truncated, skipped } = await app.close([
  { stream: "ticket-4822", archive: () => s3.put("ticket-4822", events) },
  { stream: "agent-ana", restart: true },
]);`,
  "app.reset": `await app.reset(["tickets"]); // or a filter: { stream: "^proj-" }`,
  "app.unblock": `await app.unblock(["ticket-escalation-webhooks"]);`,
  "app.forget": `const { eventCount } = await app.forget("user-42");`,
  "app.restore": `await app.restore(pg, { drop_snapshots: true, event_migrations }, sqlite);`,
  "app.audit": `for await (const f of app.audit(["close-candidate", "reaction-health"])) console.log(f);`,
};

const LISTENS: Record<string, string> = {
  assign: "TicketOpened",
  "escalation webhook": "TicketEscalated",
  autoEscalate: "TicketAssigned",
  autoclose: "TicketClosed",
};

const TICKET_EVENTS = ["TicketOpened", "MessageAdded", "TicketClosed"];
const tickets = (
  actions: string[],
  events: string[],
  extra: Partial<AppSpec["slices"][number]> = {}
) => ({
  name: "Tickets",
  states: [
    {
      name: "Ticket",
      actions,
      events,
      fields: ["title", "status", "messages"],
    },
  ],
  ...extra,
});
const agents = {
  name: "Agents",
  states: [
    {
      name: "Agent",
      fields: ["name", "open (at most 5)"],
      actions: ["AddAgent"],
      events: ["AgentAdded", "TicketTaken", "TicketDropped"],
    },
  ],
};

const APP_DESK: AppSpec = {
  title: "act().withSlice(TicketSlice).withSlice(AgentSlice).build()",
  slices: [
    tickets(["OpenTicket", "AddMessage", "CloseTicket"], TICKET_EVENTS),
    agents,
  ],
  ports: PORTS,
  code: CODE,
  listens: LISTENS,
};
const APP_ONE: AppSpec = {
  title: "act().withState(Ticket).build()",
  slices: [
    tickets(["OpenTicket", "AddMessage"], ["TicketOpened", "MessageAdded"]),
  ],
  ports: PORTS,
  code: CODE,
  listens: LISTENS,
};
const APP_RULES: AppSpec = {
  ...APP_ONE,
  slices: [tickets(["OpenTicket", "AddMessage", "CloseTicket"], TICKET_EVENTS)],
};
const APP_REACT: AppSpec = {
  title: 'act().withState(Ticket).on("TicketOpened").do(assign).build()',
  slices: [
    tickets(
      ["OpenTicket", "AddMessage", "CloseTicket", "AssignTicket"],
      [...TICKET_EVENTS, "TicketAssigned"],
      { reactions: ["assign"] }
    ),
  ],
  ports: PORTS,
  code: CODE,
  listens: LISTENS,
};
const APP_LANES: AppSpec = {
  ...APP_REACT,
  title: 'act()…withLane({ name: "webhooks" }).build()',
  slices: [
    tickets(
      ["OpenTicket", "AddMessage", "AssignTicket", "EscalateTicket"],
      ["TicketOpened", "TicketAssigned", "TicketEscalated"],
      {
        reactions: ["assign", "escalation webhook"],
      }
    ),
  ],
  lanes: [{ name: "webhooks", budget: "leaseMillis 30 s · streamLimit 5" }],
};
const APP_TIMERS: AppSpec = {
  ...APP_LANES,
  slices: [
    tickets(
      ["AssignTicket", "EscalateTicket", "CloseTicket"],
      ["TicketAssigned", "TicketEscalated", "TicketClosed"],
      {
        reactions: ["assign", "autoEscalate", "escalation webhook"],
      }
    ),
  ],
};
const APP_PROJ: AppSpec = {
  title: "act().withSlice(TicketSlice).withSlice(AgentSlice).build()",
  slices: [
    tickets(
      ["OpenTicket", "AddMessage", "AssignTicket"],
      ["TicketOpened", "MessageAdded", "TicketAssigned"],
      {
        reactions: ["assign"],
        projections: [{ name: "tickets", target: "tickets", of: "Ticket" }],
      }
    ),
    agents,
  ],
  ports: PORTS,
  ops: ["app.reset"],
  code: CODE,
  listens: LISTENS,
};
const APP_LOADS: AppSpec = {
  title: "act().withSlice(TicketSlice).withSlice(AgentSlice).build()",
  slices: [
    tickets(
      ["AssignTicket", "CloseTicket"],
      ["TicketOpened", "TicketAssigned", "TicketClosed"]
    ),
    agents,
  ],
  ports: PORTS,
  code: CODE,
  listens: LISTENS,
};
const APP_USERS: AppSpec = {
  title: "act().withState(User).build()",
  slices: [
    {
      name: "Users",
      states: [
        {
          name: "User",
          fields: ["plan", "email (sensitive)"],
          actions: ["register"],
          events: ["UserRegistered", "PlanChanged"],
        },
      ],
    },
  ],
  ports: PORTS,
  ops: ["app.forget"],
  code: CODE,
  listens: LISTENS,
};
const APP_CLOSE: AppSpec = {
  ...APP_DESK,
  slices: [
    tickets(["OpenTicket", "AddMessage", "CloseTicket"], TICKET_EVENTS, {
      projections: [{ name: "tickets", target: "tickets", of: "Ticket" }],
    }),
    agents,
  ],
  ops: ["app.close"],
};
const APP_POLICIES: AppSpec = {
  title: "act().withState(Ticket).withState(Ledger).build({ autocloseWindow })",
  slices: [
    tickets(["OpenTicket", "CloseTicket"], ["TicketOpened", "TicketClosed"], {
      reactions: ["autoclose"],
    }),
    {
      name: "Ledgers",
      states: [
        {
          name: "Ledger",
          actions: ["post"],
          events: ["Posted"],
          fields: ["balance"],
        },
      ],
      reactions: ["autoclose"],
    },
  ],
  ports: PORTS,
  ops: ["app.close"],
  code: CODE,
  listens: LISTENS,
};
const APP_OPS: AppSpec = {
  ...APP_POLICIES,
  ops: ["app.restore", "app.reset", "app.audit"],
};
const APP_SCALE: AppSpec = {
  ...APP_DESK,
  title: "act().withSlice(TicketSlice).build({ scoped: { store, cache } })",
  slices: [
    tickets(
      ["OpenTicket", "AssignTicket"],
      ["TicketOpened", "TicketAssigned"],
      { reactions: ["assign"] }
    ),
  ],
  ports: [
    "store: PostgresStore (notify)",
    "cache: InMemoryCache",
    "logger: ConsoleLogger",
  ],
};
const APP_EDGE: AppSpec = {
  ...APP_SCALE,
  title: "hono(app, { actor, stream, sse })",
  ports: ["store: PostgresStore", "cache: InMemoryCache"],
};

// ── the history the macro chapters start from: seeded, so it's the same every time ──
const DESK_KINDS: StreamKind[] = [
  {
    prefix: "ticket",
    count: 420,
    weight: 7,
    events: [
      "TicketOpened",
      "MessageAdded",
      "TicketAssigned",
      "MessageAdded",
      "MessageAdded",
      "TicketClosed",
    ],
  },
  {
    prefix: "agent",
    count: 28,
    weight: 2,
    events: ["AgentAdded", "TicketTaken", "TicketDropped"],
    snapEvery: 12,
  },
  {
    prefix: "user",
    count: 160,
    weight: 1.2,
    events: ["UserRegistered", "PlanChanged"],
    pii: true,
  },
];
const LEDGER_KINDS: StreamKind[] = [
  {
    prefix: "ledger",
    count: 60,
    weight: 4,
    events: ["Opened", "Posted"],
    snapEvery: 8,
  },
  {
    prefix: "ticket",
    count: 260,
    weight: 4,
    events: ["TicketOpened", "MessageAdded", "TicketClosed"],
  },
];

const chapters: Chapter[] = [
  // ───────────────────────────────────────────────────────────── 0
  {
    id: "intro",
    app: APP_PROJ,
    view: "micro",
    title: "How to read this tour",
    audience: "everyone",
    blurb: "A short walk around the screen before the first chapter.",
    history: [{ seed: 7, events: 1800, days: 300, kinds: DESK_KINDS }],
    seed: [
      {
        stream: "ticket-101",
        name: "TicketOpened",
        data: { title: "No sound" },
        ref: "i-open",
      },
      {
        stream: "agent-ana",
        name: "AgentAdded",
        data: { name: "Ana" },
        ref: "i-ana",
      },
      {
        stream: "ticket-101",
        name: "MessageAdded",
        data: { body: "Since today" },
        ref: "i-m1",
      },
    ],
    scenes: [
      {
        title: "The screen, part by part",
        nodes: [
          actor("maya", "Maya", "customer"),
          worker("drain", "drain", "this process"),
          st("ticket", "Ticket"),
          action("OpenTicket"),
          reaction("assign", "assign", "on TicketOpened"),
          projection("proj", "tickets", "projection"),
        ],
        api: ["act().withSlice(...).build()", "app.do"],
        doc: doc("Getting started", "guides/getting-started"),
        code: `const app = act()
  .withSlice(TicketSlice) // states, reactions, projections
  .withSlice(AgentSlice)
  .build();`,
        steps: [
          {
            now: "A ticket that says closed, and nobody knows why",
            say: "Monday, nine sharp. Maya calls the help desk, a little upset. Her ticket says closed, and nobody remembers closing it.",
            focus: ["store:"],
          },
          {
            now: "Keep every change, and the ticket can explain itself",
            say: "If the desk kept only the ticket's latest row, that's where the story would end. Every update to that row was a small act of forgetting. Act keeps the whole story instead, as events in one log. Let's watch it remember.",
            focus: ["store:"],
          },
          {
            now: "Actors at the edge: the people who call the app",
            say: "At the left edge are the actors: the people outside the app who call it, like Maya.",
            focus: ["maya"],
          },
          {
            now: "The running Act app and its action layer",
            say: "In the middle runs the Act app. Every request knocks on one door, `app.do`, then walks the action layer.",
            focus: ["layer:"],
          },
          {
            now: "Slices: states, reactions and projections",
            say: "Below it live the slices: states with their actions and events, and the reactions and projections that answer them. Under those runs the drain, Act's own worker inside the app, picking up new events and handing them to reactions.",
            focus: ["ticket", "assign", "proj", "drain"],
          },
          {
            now: "The event store: one log, a dot per event",
            say: "On the right is the event store. One log, one dot per event, in the order things happened.",
            focus: ["store:"],
          },
          {
            now: "A highlighted stream",
            say: "The stream a scene is about lights up. Hover any dot, and its whole stream lights up with it.",
            focus: ["cell:i-open", "cell:i-m1"],
          },
          {
            now: "Data flows along the link",
            pipe: { name: "action", at: 7 },
            say: "Data travels along the link: Maya opens a ticket, and its event lands at the end of the log.",
            moves: [
              {
                from: "maya",
                to: "cell:i-new",
                label: "OpenTicket",
                tone: "good",
              },
            ],
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-102",
                    name: "TicketOpened",
                    data: { title: "Login fails" },
                    ref: "i-new",
                  },
                ],
              },
            ],
          },
          {
            now: "The code icon",
            say: "Curious how something is built? Its little code icon shows you, with links to read more.",
            ui: ["tip"],
          },
          {
            now: "Captions and speed",
            say: "The captions follow the voice, and the speed control next to Play sets the pace.",
            ui: ["speed"],
          },
          {
            now: "Step, play, and pick a chapter",
            say: "Play runs a chapter, the arrows step, and the menu jumps anywhere. Ready? Let's go.",
            ui: ["play", "menu"],
          },
        ],
      },
    ],
  },
  // ───────────────────────────────────────────────────────────── 1
  {
    id: "log",
    app: APP_DESK,
    view: "macro",
    history: [{ seed: 7, events: 1800, days: 300, kinds: DESK_KINDS }],
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
// all[0] is the oldest event, all.at(-1) the newest; each has its global id`,
        steps: [
          {
            now: "The store holds {events} events on {streams} streams, in one global log",
            say: "Lee, the team lead, wants to know why one ticket took a whole week to close. A table of current rows just shrugs. A log can answer. This is the desk's **event store**: every dot is one event, in the order it happened, wrapping like lines of text. A ring is a snapshot, a square is a tombstone, and a hollow dot holds something sensitive. The history grows from a fixed seed, so it's the same every time you watch.",
            focus: ["field:main"],
          },
          {
            now: "Traffic: {burst} new events commit at the tail; the store now holds {events}",
            say: "Work keeps rolling in. Each commit takes the next global `id`, so new events always land at the end. Nothing already written ever changes.",
            ops: [
              {
                op: "burst",
                count: 80,
                seed: 101,
                kinds: DESK_KINDS,
                day: 300,
              },
            ],
          },
          {
            now: "ticket-4821 holds v0 ({#t21-open}) and v1 ({#t21-m1}); other streams sit between them",
            say: "Each event also belongs to one **stream**, and takes that stream's next **version**. The dashed lens marks this scene's events, and the cells below zoom in. Ticket 4821 holds v0 and v1, with other tickets chatting in between.",
            ops: [
              { op: "unflag" },
              { op: "flag", on: "cell:t21-open", text: "ticket-4821 v0" },
              { op: "flag", on: "cell:t21-m1", text: "ticket-4821 v1" },
            ],
            focus: ["cell:t21-open", "cell:t21-m1"],
          },
          {
            now: '`app.query_array({ stream: "ticket-4821", stream_exact: true })` reads one stream',
            say: "Reading one ticket's story is just a question asked of the same log. Ask for the exact stream, and you get its events alone, in order.",
            code: `const ticket = await app.query_array({ stream: "ticket-4821", stream_exact: true });
// [ v0 TicketOpened, v1 MessageAdded ]`,
            ops: [{ op: "unflag" }, { op: "dim", only: "ticket-4821" }],
          },
          {
            now: "Every event carries `meta.correlation` and `meta.causation`",
            say: "Every event also remembers why it happened. Its causation names the action and who did it. Its correlation is a thread that ties a whole workflow together.",
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
    app: APP_ONE,
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
            now: "Declare `state({ Ticket })` and build the app with `act().withState(Ticket)`",
            say: "Maya's screen keeps flickering, and she'd like someone to care. First the desk needs a ticket that knows what it is. In Act that's a **state**: a Zod schema, a starting value, the events it emits, how each event **patches** it, and the **actions** that emit them. Hand it to `act()`, build, and you have an app.",
            focus: ["ticket", "OpenTicket", "AddMessage"],
          },
          {
            now: "Maya runs `OpenTicket` on ticket-4830: the payload passes its schema",
            pipe: { name: "action", at: 1 },
            say: "Maya opens ticket 4830 with a title. The first thing Act does is check her payload against the action's schema.",
            moves: [{ from: "maya", to: "OpenTicket", label: "{ title }" }],
            code: `await app.do(
  "OpenTicket",
  { stream: "ticket-4830", actor: { id: "maya", name: "Maya" } },
  { title: "Screen flickers" }
);`,
          },
          {
            now: "`OpenTicket` loads ticket-4830: a new stream, the initial state at v−1",
            pipe: { name: "action", at: 3 },
            say: "Then the action **loads** the stream. Ticket 4830 is brand new, so it starts from its initial value, at version −1.",
            moves: [{ from: "OpenTicket", to: "ticket", label: "load" }],
            ops: [
              {
                op: "state",
                node: "ticket",
                data: { title: "", status: "new", messages: 0 },
                version: -1,
              },
            ],
          },
          {
            now: "The handler emits `TicketOpened`; it folds, and the state passes its schema",
            pipe: { name: "action", at: 6 },
            say: "The handler decides what happened: a `TicketOpened`, carrying her title. The event folds into the state **before** anything is saved, and the result is checked against the schema.",
            ops: [
              {
                op: "state",
                node: "ticket",
                data: { title: "Screen flickers", status: "open", messages: 0 },
                version: -1,
              },
            ],
          },
          {
            now: "Commit: {#t30-open} `TicketOpened` · ticket-4830 v0",
            pipe: { name: "action", at: 7 },
            say: "The commit expects version −1, finds it, and lands as global id **{#t30-open}**, stream version **0**. Maya gets back a snapshot for every event that landed.",
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
          },
          {
            now: "Maya runs `AddMessage`: {#t30-m1} `MessageAdded` · ticket-4830 v1",
            pipe: { name: "action", at: 7 },
            say: "She adds a message. It loads v0 and commits v1, and the log grows by one, to **{#t30-m1}**. Versions count within a stream; ids count across the whole store.",
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
          },
          {
            now: '`app.load(Ticket, "ticket-4830")` folds v0 and v1',
            say: "Later, loading the ticket replays those events in order. The ticket was never saved as a row. It's remembered.",
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
    app: APP_RULES,
    title: "Rules: preconditions and invariants",
    audience: "first app",
    blurb:
      "An action runs only when its rules hold, and the state it leaves must keep the schema. A refusal stores nothing.",
    scenes: [
      {
        title: "Seven stages, in order",
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
            now: "An action walks seven stages, in order",
            pipe: { name: "action", at: 0 },
            say: "Every desk has rules, and rules love to wander. One hides in a controller, another in a service, and soon they disagree. In Act every action walks the same checks, in the same order, and stops at the first one that fails. Nothing is saved until the last one passes.",
          },
          {
            now: "Maya runs `CloseTicket` with `{ reason: 42 }`: refused in the action layer at the payload (`ValidationError`); nothing sent to the store",
            pipe: { name: "action", at: 0, fail: true },
            say: "Maya tries to close her ticket with a reason of 42. A number, where words belong. The schema says no with a `ValidationError`, and the action never even loads.",
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
                op: "reject",
                stream: "ticket-4830",
                name: "TicketClosed",
                error: "ValidationError",
                stage: "payload",
              },
            ],
          },
          {
            now: "Bo runs `CloseTicket`: {#t30-closed} `TicketClosed` · ticket-4830 v2",
            pipe: { name: "action", at: 7 },
            say: "Bo closes it properly, with a real reason. Every check passes, and `TicketClosed` lands as v2.",
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
          },
          {
            now: "Maya runs `CloseTicket` again: refused in the action layer at preconditions (`PreconditionError`); nothing sent to the store",
            pipe: { name: "action", at: 2, fail: true },
            say: "Maya, still cross, tries to close it again. A **precondition** is a named rule the action needs right now, and this ticket is no longer open. The action politely refuses with a `PreconditionError`.",
            moves: [
              { from: "maya", to: "CloseTicket", label: "{ reason }" },
              { from: "CloseTicket", to: "ticket", label: "load v2" },
            ],
            ops: [
              {
                op: "reject",
                stream: "ticket-4830",
                name: "TicketClosed",
                error: "PreconditionError",
                stage: "preconditions",
              },
            ],
          },
          {
            now: "A buggy `CloseTicket` on ticket-4822: refused in the action layer at the state check (`ValidationError`)",
            pipe: { name: "action", at: 5, fail: true },
            say: "Some promises must hold after **every** action. Those are **invariants**, and they live in the state's schema. Say a buggy handler closes ticket 4822 without saying who closed it. The schema spots the gap, and the action is refused with a `ValidationError` before anything is saved.",
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
                op: "reject",
                stream: "ticket-4822",
                name: "TicketClosed",
                error: "ValidationError",
                stage: "state check",
              },
            ],
          },
          {
            now: "Nothing was stored: the log still ends at {#t30-closed}",
            say: "None of these refusals reached the log. No event, no version, and no reaction woke up. The log still ends at {#t30-closed}.",
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
    app: APP_RULES,
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
            now: "Maya and Ana both run `AddMessage` on ticket-4821; both load v1",
            pipe: { name: "action", at: 2 },
            say: "Two agents, one ticket, the very same instant. Maya and Ana both add a message to ticket 4821, and both actions load it at **version 1**.",
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
            now: "Maya's commit lands as {#t21-m2} v2; Ana's bounces at the store: `ConcurrencyError`, expected v1, head v2",
            pipe: { name: "action", at: 6, fail: true },
            say: "Maya is a hair faster, and her message lands as v2 ({#t21-m2}). Ana's commit expected 1 and found 2, so the store hands it back with a `ConcurrencyError`. It names the stream, the version she expected, and the one she found. Nothing of hers was saved.",
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
                expected: 1,
                actual: 2,
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
            now: "Ana's action retries: reloads v2, checks again, commits {#t21-m3} · ticket-4821 v3",
            pipe: { name: "action", at: 7 },
            say: "Give the action a retry budget, and Act handles the awkward part. It reloads, checks the rules again on the fresh state, and commits. Ana's message lands as v3 ({#t21-m3}), and she never even knows there was a race.",
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
          },
          {
            now: "Ana runs `AddMessage` with `expectedVersion: 1`: bounced at the store (head v3), no retry",
            pipe: { name: "action", at: 6, fail: true },
            say: "When the **caller** pins a version, though, the conflict is final. With an expected version of 1 the action fails at once. No retry can make v3 equal 1.",
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
                expected: 1,
                actual: 3,
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
    app: APP_RULES,
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
            now: '`app.load(Ticket, "ticket-4821")` hits the cache at v3',
            say: "Ticket 4821 keeps growing, and replaying its whole life on every click would get slow. A warm load starts from the **cache**, in memory by default, and replays only what came after. Here the cache already holds the ticket at v3, and nothing came after, so there's nothing to do.",
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
            now: "Ana runs `AddMessage`: {#t21-m4} · ticket-4821 v4, then {#t21-snap} `__snapshot__` v5",
            pipe: { name: "action", at: 7 },
            say: "With a snap rule on the state, an action that makes the rule true also saves a **snapshot**. It's an event too, on the stream's next version (v5, {#t21-snap}), holding the state at that moment.",
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
            now: "After a restart, a cold load starts from the snapshot {#t21-snap}",
            say: "Then the server restarts, and the cache is empty. A **cold** load starts from the latest snapshot and folds only what came after, not the whole stream.",
            moves: [
              { from: "cell:t21-snap", to: "ticket", label: "start here" },
            ],
            ops: [
              { op: "status", text: "cache: cold (restart)", tone: "warn" },
            ],
          },
          {
            now: '`app.load(Ticket, "ticket-4821", undefined, { before: {@t21-m3} })` folds {#t21-open}, {#t21-m1}, {#t21-m2}: v2',
            say: "Sometimes the question is about the past. A **time-travel** load reads only the events below {#t21-m3}, skipping the cache and any later snapshot, and it never writes a thing.",
            code: `const past = await app.load(Ticket, "ticket-4821", undefined, { before: {@t21-m3} });
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
    app: APP_REACT,
    view: "macro",
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
      await app.do("AssignTicket", { stream: event.stream, actor: bot }, { agentId: "bo" });
    })
    .to((event) => ({ target: \`assign:\${event.stream}\`, source: event.stream }))
  .build();`,
        steps: [
          {
            now: "The app starts: correlate reads all {events} events the store already holds",
            pipe: { name: "reaction", at: 0 },
            say: "New tickets shouldn't sit around waiting to be noticed. The desk wants each one assigned the moment it opens, without anyone wiring up a queue. When an app with reactions starts, **correlate** reads the log from its bookmark and notes the work for every reaction. Here it sweeps the whole store once. After that, it only reads what's new.",
            ops: [{ op: "scan", from: "checkpoint" }],
          },
          {
            now: "Maya runs `OpenTicket`: {#t31-open} `TicketOpened` · ticket-4831 v0, and settle is scheduled",
            pipe: { name: "action", at: 7 },
            say: "Maya opens ticket 4831 ({#t31-open}). Its event has a reaction, so the commit schedules a settle all by itself. No wiring, no message broker: the log is the backbone.",
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
            now: "Correlate reads {#t31-open} and subscribes `assign:ticket-4831`",
            pipe: { name: "reaction", at: 0 },
            say: "**Correlate** reads past its bookmark and asks each reaction where it should run. The assign reaction names its own target stream for this ticket, which is subscribed, with work marked up to {#t31-open}.",
            moves: [
              { from: "cell:t31-open", to: "assign", label: "resolve" },
              {
                from: "assign",
                to: "target:assign:ticket-4831",
                label: "subscribe",
              },
            ],
            ops: [
              { op: "scan", from: "checkpoint" },
              { op: "checkpoint", at: "t31-open" },
              {
                op: "target",
                id: "assign:ticket-4831",
                source: "ticket-4831",
                reaction: "assign",
              },
              { op: "mark", target: "assign:ticket-4831", at: "t31-open" },
            ],
          },
          {
            now: "Drain leases `assign:ticket-4831` and fetches {#t31-open}",
            pipe: { name: "reaction", at: 2 },
            say: "The **drain**, Act's own worker inside the app, claims targets that have work, each under a **lease**. It fetches the events past the target's watermark, which is −1 here.",
            moves: [
              {
                from: "drain",
                to: "target:assign:ticket-4831",
                label: "claim",
              },
              { from: "cell:t31-open", to: "assign", label: "fetch" },
            ],
            ops: [
              { op: "lease", target: "assign:ticket-4831", by: "drain" },
              { op: "glow", worker: "drain", streams: ["ticket-4831"] },
            ],
            focus: ["target:assign:ticket-4831"],
          },
          {
            now: "`assign` runs `AssignTicket`: {#t31-asg} `TicketAssigned` · ticket-4831 v1",
            pipe: { name: "reaction", at: 3 },
            say: "The handler calls `app.do` to assign the ticket. That new action **inherits** the event that woke it: same correlation, with `TicketOpened` as its cause.",
            moves: [
              { from: "assign", to: "gate", label: "app.do" },
              {
                from: "gate",
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
                    data: { agentId: "bo" },
                    cause: "t31-open",
                    ref: "t31-asg",
                  },
                ],
              },
            ],
            focus: ["AssignTicket"],
          },
          {
            now: "Drain acks `assign:ticket-4831` at {#t31-open} and releases the lease",
            pipe: { name: "reaction", at: 4 },
            say: "On success the drain **acks**. The watermark moves past {#t31-open}, and the lease is released. A stream is never acked past an event its reaction hasn't handled.",
            ops: [{ op: "ack", target: "assign:ticket-4831", at: "t31-open" }],
            focus: ["target:assign:ticket-4831"],
          },
          {
            now: "Settle's next pass reads {#t31-asg}, finds no reaction, and emits `settled`",
            pipe: { name: "reaction", at: 5 },
            say: "**Settle** keeps looping correlate and drain until a pass finds nothing. The next pass reads {#t31-asg}, which no reaction wants, so the app is settled and says so.",
            code: `app.on("settled", (drain) => {
  // notify clients, refresh caches, …
});`,
            ops: [
              { op: "checkpoint", at: "t31-asg" },
              { op: "scan", from: "checkpoint" },
              { op: "glow" },
              { op: "status", text: "settled", tone: "good" },
            ],
          },
          {
            now: "In a test: `app.correlate()`, then `app.drain()`",
            say: "Leave out the target, and a reaction runs on the event's own stream. In tests, switch off auto-settle and walk the pipeline yourself, one step at a time.",
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
    app: APP_LANES,
    view: "macro",
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
            now: "Worker A leases `assign:ticket-4832`; worker B leases `assign:ticket-4833`; their streams glow in the field",
            pipe: { name: "reaction", at: 1 },
            say: "Monday morning, and one worker can't keep up. Two tickets open ({#t32-open}, {#t33-open}), and correlate marks two targets. Two processes drain the same store and **compete** for the work. Each claims a different target, because a lease someone holds is invisible to everyone else.",
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
              {
                op: "target",
                id: "assign:ticket-4832",
                source: "ticket-4832",
                reaction: "assign",
              },
              {
                op: "target",
                id: "assign:ticket-4833",
                source: "ticket-4833",
                reaction: "assign",
              },
              { op: "mark", target: "assign:ticket-4832", at: "t32-open" },
              { op: "mark", target: "assign:ticket-4833", at: "t33-open" },
              { op: "lease", target: "assign:ticket-4832", by: "worker A" },
              { op: "lease", target: "assign:ticket-4833", by: "worker B" },
              { op: "glow", worker: "worker A", streams: ["ticket-4832"] },
              { op: "glow", worker: "worker B", streams: ["ticket-4833"] },
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
            now: "A's lease expires; B leases `assign:ticket-4832`",
            pipe: { name: "reaction", at: 1 },
            say: "Then worker A trips over a cable mid-handler. Its lease runs out, and **exactly one** other worker takes over. B now runs both, and the failed try counts against the target's retry budget.",
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
            now: "B commits {#t32-asg} and {#t33-asg}, then acks both targets",
            pipe: { name: "reaction", at: 4 },
            say: "B's handlers assign both tickets ({#t32-asg}, {#t33-asg}), then ack both targets. Nobody noticed a thing.",
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
                    data: { agentId: "ana" },
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
                    data: { agentId: "bo" },
                    cause: "t33-open",
                    ref: "t33-asg",
                  },
                ],
              },
              { op: "ack", target: "assign:ticket-4832", at: "t32-open" },
              { op: "ack", target: "assign:ticket-4833", at: "t33-open" },
              { op: "glow" },
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
            now: "Declare lane `webhooks` for target `ticket-escalation-webhooks`",
            say: "Some work is just slow, like calling another company's webhook. It shouldn't hold up everything else. A **lane** is a separate drain with its own lease and claim budget, so webhooks get a lane of their own, with 30-second leases.",
            ops: [
              {
                op: "target",
                reaction: "escalation webhook",
                id: "ticket-escalation-webhooks",
                lane: "webhooks",
              },
            ],
            focus: ["hooks", "target:ticket-escalation-webhooks"],
          },
          {
            now: "{#t32-esc} `TicketEscalated` · ticket-4832; the webhooks lane leases its target",
            pipe: { name: "reaction", at: 1 },
            say: "Ticket 4832 escalates ({#t32-esc}). The webhooks lane claims its target while the default lane keeps humming along. Lanes run **side by side**, so the slow one never blocks the fast one.",
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
            now: "Set priority 10 on `ticket-escalation-webhooks`",
            say: "Inside a lane, **priority** decides who gets picked first when work piles up. It never reorders a stream's events, and it can change while the app runs.",
            code: `.to({ target: "notifications-out", priority: 10 })

await app.prioritize({ stream: "^proj-orders$" }, 10); // raise
await app.prioritize({ source: "^audit-" }, -5); // lower`,
            ops: [
              {
                op: "target",
                reaction: "escalation webhook",
                id: "ticket-escalation-webhooks",
                priority: 10,
              },
            ],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 8
  {
    id: "failures",
    app: APP_LANES,
    view: "macro",
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
            now: "The webhook POSTs {#t32-esc}: 503, retry 1 due in 200 ms × jitter",
            pipe: { name: "reaction", at: 3, fail: true },
            say: "Two in the morning, and the escalation service is down. The webhook posts {#t32-esc} and gets a 503 back. A failed try waits out its **backoff**: 200 milliseconds for the first retry, times a jitter between 0.5 and 1.5. The schedule lives on the target, so no worker jumps the gun.",
            moves: [
              { from: "webhook", to: "svc", label: "POST {#t32-esc}" },
              { from: "svc", to: "webhook", label: "503", tone: "bad" },
            ],
            ops: [
              {
                op: "retry",
                target: "ticket-escalation-webhooks",
                retry: 1,
                due: "200 ms × jitter",
              },
            ],
          },
          {
            now: "Retries 2 and 3 fail: the next is due in 800 ms × jitter",
            pipe: { name: "reaction", at: 3, fail: true },
            say: "Retries two and three fail too. The wait doubles each time, to 400 milliseconds and then 800, up to a cap, each with its own jitter.",
            moves: [
              { from: "webhook", to: "svc", label: "retry" },
              { from: "svc", to: "webhook", label: "503", tone: "bad" },
            ],
            ops: [
              {
                op: "retry",
                target: "ticket-escalation-webhooks",
                retry: 3,
                due: "800 ms × jitter",
              },
            ],
          },
          {
            now: "Attempt 4 fails: `ticket-escalation-webhooks` blocks",
            pipe: { name: "reaction", at: 3, fail: true },
            say: "The fourth try fails, and the budget is spent, so the target **blocks**. Claim skips it, its watermark waits just before {#t32-esc}, and a blocked event fires so a human can take a look.",
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
            now: "The operator runs `app.unblock`: {#t32-esc} is delivered and acked",
            pipe: { name: "reaction", at: 4 },
            say: "By breakfast the service is back. Unblocking picks up **at the watermark**: {#t32-esc} goes out once more, and nothing before it runs again.",
            code: `await app.unblock(["ticket-escalation-webhooks"]);`,
            moves: [
              {
                from: "ops",
                to: "target:ticket-escalation-webhooks",
                label: "app.unblock",
              },
              { from: "webhook", to: "svc", label: "POST {#t32-esc}" },
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
            now: "{#t33-esc} is POSTed: 400, and `NonRetryableError` blocks at once",
            pipe: { name: "reaction", at: 3, fail: true },
            say: "Ticket 4833 escalates ({#t33-esc}), and the service answers **400**: a request that will never work, no matter how often you send it. The webhook throws a `NonRetryableError`, which blocks on the spot without spending the budget, unless blocking on errors is switched off.",
            moves: [
              { from: "webhook", to: "svc", label: "POST {#t33-esc}" },
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
            now: "`app.reset` would replay every webhook from {#t21-open}: don't",
            say: "Tempting as it is, this is not the moment for a reset. Reset rewinds the watermark to −1 and replays **everything**, so every webhook would go out again. Reset rebuilds; unblock recovers.",
            ops: [
              {
                op: "flag",
                on: "target:ticket-escalation-webhooks",
                text: "reset → replays {#t21-open} on",
              },
            ],
          },
          {
            now: "The store fails: `error` fires and the breaker opens",
            say: "Sometimes it's the **store itself** that stumbles. The drain, settle and autoclose loops share a circuit breaker: after enough failures it opens, leaves the store alone, and tries again after a cooldown. An error event fires each time.",
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
            now: "The breaker closes; the operator unblocks; {#t33-esc} is acked",
            pipe: { name: "reaction", at: 4 },
            say: "The store comes back, and the breaker closes on the next pass. The bad request gets fixed upstream, and the operator unblocks the target.",
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
    app: APP_TIMERS,
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
            now: "{#t21-asg} `TicketAssigned`: `escalate:ticket-4821` is deferred until 10:00",
            pipe: { name: "reaction", at: 3 },
            say: "A ticket nobody touches should escalate on its own, without a cron job sweeping the table at midnight. Ticket 4821 is assigned to escalate after 10:00 ({#t21-asg}). Correlate marks its escalate target, and the drain finds the reaction **deferred**: the event waits, and the target holds a due time.",
            ops: [
              { op: "status" },
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4821",
                    name: "TicketAssigned",
                    data: { agentId: "ana", escalateAfter: "10:00" },
                    ref: "t21-asg",
                  },
                ],
              },
              { op: "checkpoint", at: "t21-asg" },
              {
                op: "target",
                reaction: "autoEscalate",
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
            now: "At 10:00 `autoEscalate` runs `EscalateTicket`: {#t21-esc} `TicketEscalated`, then ack",
            pipe: { name: "reaction", at: 4 },
            say: "Claim skips the target until 10:00. The due time comes from the event, never from the clock on the wall, so a late worker lands on the same time. At 10:00 it runs, and the ticket escalates ({#t21-esc}).",
            moves: [
              {
                from: "drain",
                to: "target:escalate:ticket-4821",
                label: "claim at 10:00",
              },
              { from: "esc", to: "gate", label: "app.do" },
              {
                from: "gate",
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
            focus: ["EscalateTicket"],
          },
          {
            now: "{#t22-asg} `TicketAssigned` (escalate at 11:00), then {#t22-closed} `TicketClosed` by Bo",
            say: "Ticket 4822 is set to escalate after 11:00 ({#t22-asg}), but Bo closes it at 10:40 ({#t22-closed}). Nicely done, Bo.",
            ops: [
              {
                op: "commit",
                events: [
                  {
                    stream: "ticket-4822",
                    name: "TicketAssigned",
                    data: { agentId: "bo", escalateAfter: "11:00" },
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
                reaction: "autoEscalate",
                id: "escalate:ticket-4822",
                source: "ticket-4822",
              },
              { op: "mark", target: "escalate:ticket-4822", at: "t22-asg" },
              { op: "defer", target: "escalate:ticket-4822", due: "11:00" },
            ],
          },
          {
            now: "At 11:00 `autoEscalate` finds ticket-4822 closed and returns; ack, nothing appended",
            pipe: { name: "reaction", at: 4 },
            say: "At 11:00 the timer wakes up, loads the ticket, sees it's closed, and quietly goes back to sleep. The drain acks, and nothing is added. A guard like this is how a deferred chain ends.",
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
            now: "A handler can `throw new DeferSignal({ at })` instead",
            say: "When the wait depends on something the handler must look up first, it throws a `DeferSignal` instead. That holds the stream until it's due, then delivers the event again.",
            code: `.on("TicketOpened")
  .do(async function autoClose(event, _, app) {
    const { closeAfter } = event.data;
    if (!closeAfter) return;
    if (Date.now() < closeAfter.getTime()) throw new DeferSignal({ at: closeAfter });
    await app.do("CloseTicket", { stream: event.stream, actor: timers }, { reason: "timed out" });
  })`,
            ops: [{ op: "state", node: "ticket", data: null }],
          },
          {
            now: "A defer redelivers every reaction on its target",
            say: "Reactions that share a target travel as a group. When one defers, the **whole group** waits and runs again when due. A reaction that should wait alone gets a target of its own.",
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
    app: APP_PROJ,
    view: "macro",
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
            now: "Correlate subscribes the projection's target `tickets` at −1",
            pipe: { name: "projection", at: 0 },
            say: "The support screen needs a list of tickets, fast. Nobody wants to replay the log for every page view. A **state projection** folds a state's own patches and writes one row per stream into a read model. Its target is called tickets, and a new one starts at watermark −1.",
            ops: [
              { op: "table", name: "tickets", title: "tickets table" },
              { op: "target", id: "tickets", reaction: "tickets" },
              { op: "mark", target: "tickets", at: "t22-closed" },
            ],
            focus: ["proj", "target:tickets"],
          },
          {
            now: "Drain runs the projection over the whole log: {replayed} events → {rows} rows, acked at {#t22-closed}",
            pipe: { name: "projection", at: 4 },
            say: "It drains like any reaction: it catches up on the whole log, writes the rows, then acks. If a write fails, the watermark stays put and nothing is lost.",
            moves: [
              { from: "drain", to: "target:tickets", label: "claim" },
              { from: "field:main", to: "proj", label: "events" },
              { from: "proj", to: "table:tickets", label: "rows" },
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
                values: { status: "open", agentId: "bo" },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4832",
                values: { status: "escalated", agentId: "ana" },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4833",
                values: { status: "escalated", agentId: "bo" },
              },
              { op: "scan", from: "start" },
              { op: "project", table: "tickets", prefix: "ticket" },
              { op: "ack", target: "tickets", at: "t22-closed" },
            ],
          },
          {
            now: "Maya adds {#t31-m1} · ticket-4831 v2; the projection updates one row",
            pipe: { name: "projection", at: 4 },
            say: "Maya adds a message to ticket 4831 ({#t31-m1}), and the projection's next drain updates a single row.",
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
                values: { status: "open", agentId: "bo", messages: 1 },
              },

              { op: "ack", target: "tickets", at: "t31-m1" },
            ],
          },
          {
            now: "Group states, projections and reactions with `slice()`",
            say: "A **slice** bundles partial states, projections and reactions into one feature. Partial states with the same name merge into one, so features grow without stepping on each other's toes.",
            code: `export const TicketSlice = slice()
  .withState(TicketCreation)   // partial "Ticket"
  .withState(TicketOperations) // partial "Ticket", merged
  .withProjection(Tickets)
  .on("TicketOpened").do(assign).to(byTicket)
  .build();

const app = act().withSlice(TicketSlice).withSlice(AgentSlice).build();`,
          },
          {
            now: 'The operator empties the table and runs `app.reset(["tickets"])`: the watermark goes to −1',
            say: "Then the screen gets a redesign, and the table needs a new shape. Empty it and reset the projection. The watermark goes back to −1, and the replay schedules itself.",
            code: `await db.delete(tickets); // the read model is yours to empty
await app.reset(["tickets"]); // or a filter: app.reset({ stream: "^proj-" })`,
            moves: [{ from: "ops", to: "target:tickets", label: "app.reset" }],
            ops: [
              { op: "table", name: "tickets", clear: true },
              { op: "reset", target: "tickets" },
            ],
          },
          {
            now: "The replay walks the whole log again, {#t31-m1} included: {replayed} events → {rows} rows",
            pipe: { name: "projection", at: 4 },
            say: "The replay walks the log again from {#t21-open}, and the rows come back, good as new. Nothing in the log changed. A projection is only a view of it.",
            moves: [
              { from: "field:main", to: "proj", label: "replay" },
              { from: "proj", to: "table:tickets", label: "rows" },
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
                values: { status: "open", agentId: "bo", messages: 1 },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4832",
                values: { status: "escalated", agentId: "ana" },
              },
              {
                op: "row",
                table: "tickets",
                key: "ticket-4833",
                values: { status: "escalated", agentId: "bo" },
              },
              { op: "scan", from: "start" },
              { op: "project", table: "tickets", prefix: "ticket" },
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
    app: APP_LOADS,
    title: "Rules across streams: .loads",
    audience: "production",
    blurb:
      "One action can decide on several streams and append to all of them in one commit, each guarded by its version.",
    history: [{ seed: 7, events: 1800, days: 300, kinds: DESK_KINDS }],
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
            now: "Lee runs `AssignTicket` ticket-5200 → Ana: loads ticket-5200 and agent-ana",
            pipe: { name: "action", at: 3 },
            say: "An agent can juggle five open tickets at most, and that rule belongs to the agent, not the ticket. So assigning one touches both. Ana and Bo are on shift today, and Bo is already at five. Lee assigns ticket 5200 to Ana. The action loads every state the decision needs, all at once. The ticket has no agent yet, so that load is skipped.",
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
          },
          {
            now: "One commit: {#t5200-asg} · ticket-5200 v1 and {#ana-took1} · agent-ana v1",
            pipe: { name: "action", at: 7 },
            say: "Each event goes to the stream that asked for it: the assignment to the ticket, and the taken slot to Ana. The dropped one goes away with the skipped load. Both land in **one commit**, each stream guarded by the version it had at load. All or nothing.",
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
          },
          {
            now: "Lee runs `AssignTicket` ticket-5201 → Bo: refused in the action layer at the state check (`open` 6 > 5)",
            pipe: { name: "action", at: 5, fail: true },
            say: "Next, Lee tries to give ticket 5201 to Bo. That would make 6 open tickets for Bo, and his state's schema says no. It's a `ValidationError`, and nothing lands on **any** stream.",
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
                op: "reject",
                stream: "agent-bo",
                name: "TicketTaken",
                error: "ValidationError",
                stage: "state check",
              },
            ],
          },
          {
            now: "Meanwhile `CloseTicket` commits {#t5200-closed} · ticket-5200 and {#ana-dropped} · agent-ana v2",
            say: "So Lee gives 5201 to Ana instead, loading her stream at v1. Meanwhile ticket 5200 closes, and closing frees Ana's slot in its own commit. Her stream moves to v2.",
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
            now: "Lee's commit bounces at the store: `ConcurrencyError` on agent-ana, expected v1, head v2",
            pipe: { name: "action", at: 6, fail: true },
            say: "Lee's commit expected Ana at v1 and found v2, so the **whole** commit bounces with a `ConcurrencyError` that names her stream. The retry budget reloads every stream and decides again.",
            moves: [
              { from: "next", to: "log", label: "expect 1", tone: "bad" },
            ],
            ops: [
              {
                op: "refuse",
                stream: "agent-ana",
                name: "TicketTaken",
                error: "ConcurrencyError",
                expected: 1,
                actual: 2,
              },
            ],
          },
          {
            now: "The retry commits {#t5201-asg} · ticket-5201 v1 and {#ana-took2} · agent-ana v3",
            pipe: { name: "action", at: 7 },
            say: "The retry sees Ana with 0 open tickets and commits both events. A load that lists no events is just a read: nothing is added to it, so it isn't guarded.",
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
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 12
  {
    id: "sensitive",
    app: APP_USERS,
    title: "Sensitive data",
    audience: "production",
    blurb:
      "Sensitive fields live in their own column of the event row, are gated on read, and can be wiped without rewriting the log.",
    history: [{ seed: 7, events: 1800, days: 300, kinds: DESK_KINDS }],
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
            now: "Lee runs `register`: {#u42-reg} `UserRegistered` · user-42, with the email in pii",
            pipe: { name: "action", at: 7 },
            say: "A customer writes in: please forget me. In a log that never forgets, that sounds impossible, unless the personal bits were kept apart from the start. Lee registers, and his email is marked sensitive, so it never goes into the event's data. It goes into a separate **pii** column of the same row, in the same transaction.",
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
            now: '`app.load(User, "user-42")` with no actor reads `[REDACTED]`',
            say: "A read with no actor, like a background job or a script, sees REDACTED where every sensitive field would be. Reactions and projections never see them either.",
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
            now: "Lee loads with his own actor: `.discloses` lets him read the email",
            say: "The state's disclose rule decides who may read the real thing. Lee loads his own stream as himself, the rule agrees, and he sees his email.",
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
            now: 'The operator runs `app.forget("user-42")`: pii wiped, reads get `[SHREDDED]`',
            say: "Then Lee asks to be forgotten. Forgetting user 42 wipes the pii column of every event on the stream, right where it sits. Every later read gets SHREDDED, even for the boss. Everything else in the log stays.",
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
            now: "`.snap()` on this state would throw at build",
            say: "A snapshot would copy that data somewhere forget can't reach, so a state with sensitive fields can't snap, and the build says so. For the same reason, a restart close skips such a stream.",
            ops: [{ op: "unflag" }],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 13
  {
    id: "close",
    app: APP_CLOSE,
    view: "macro",
    history: [{ seed: 13, events: 1600, days: 300, kinds: DESK_KINDS }],
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
            now: "The operator runs `app.close` on ticket-4822: skipped, `tickets` is behind",
            pipe: { name: "close", at: 0, fail: true },
            say: "A year later, closed tickets still sit in the log, taking up space and slowing every scan. Time to close the books, carefully. Ticket 4822 is done, but the tickets projection has only read up to {#c-4823}, so the stream is **skipped** for now. A close never drops events a reaction hasn't seen.",
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
              { op: "target", id: "tickets", reaction: "tickets" },
              { op: "ack", target: "tickets", at: "c-4823" },
              { op: "flag", on: "target:tickets", text: "behind: skipped" },
            ],
          },
          {
            now: "`tickets` catches up; close commits the guard {#c-guard} `__tombstone__` · ticket-4822 v3",
            pipe: { name: "close", at: 1 },
            say: "The projection catches up, and close tries again. It commits a tombstone **guard** at the stream's version ({#c-guard}, v3). From here on, nobody can write to it.",
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
            now: "The archive callback runs while the stream is guarded",
            pipe: { name: "close", at: 2 },
            say: "The archive callback runs while the stream is guarded. If it fails, the stream stays guarded and nothing is deleted, so the close can simply try again.",
            moves: [
              { from: "cell:c-guard", to: "s3", label: "archive" },
              { from: "s3", to: "close", label: "ok", tone: "good" },
            ],
          },
          {
            now: "Truncate deletes ticket-4822 and seeds {#c-seed} `__tombstone__` v0",
            pipe: { name: "close", at: 5 },
            say: "Then the stream's events are deleted in one transaction, leaving a single seed: a tombstone at **version 0** ({#c-seed}). The cache is updated, and a closed event fires.",
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
            now: "`AddMessage` on ticket-4822: refused in the action layer at load (`StreamClosedError`)",
            pipe: { name: "action", at: 1, fail: true },
            say: "Any action on a closed stream now gets a `StreamClosedError`. The tombstone is its final word.",
            moves: [
              { from: "ops", to: "log", label: "AddMessage", tone: "bad" },
            ],
            ops: [
              {
                op: "reject",
                stream: "ticket-4822",
                name: "MessageAdded",
                error: "StreamClosedError",
                stage: "load",
              },
            ],
          },
          {
            now: "Restart agent-ana: guard {#c-ana-guard}, then seed {#c-ana-seed} `__snapshot__` v0",
            pipe: { name: "close", at: 5 },
            say: "A **restart** is the gentler close. Ana's stream is guarded and deleted, then seeded with a snapshot of her final state at v0 ({#c-ana-seed}).",
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
            now: "Ana's next action lands as {#c-ana-took} `TicketTaken` · agent-ana v1",
            say: "Her next action lands on v1 ({#c-ana-took}), picking up right where the seed left off. The log gets lighter, and the state carries on.",
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
      {
        title: "Closing the books at scale",
        nodes: [
          actor("ops", "operator"),
          action("close", "app.close"),
          outside("s3", "archive", "S3 bucket"),
        ],
        api: [
          "app.close(targets)",
          "CloseResult.skipped",
          "store().query_stats",
        ],
        doc: doc(
          "Close policies § Pruning streams that have gone silent",
          "guides/close-policies#pruning-streams-that-have-gone-silent"
        ),
        test: test(
          core("close.spec.ts"),
          "should close streams and truncate events"
        ),
        code: `// tickets whose head is older than the cutoff (day 150 here, picked for the example)
const page = await store().query_stats({}, { limit: 500 });
const idle = [...page].filter(([s, { head }]) => s.startsWith("ticket-") && head.created < cutoff);
await app.close(idle.slice(0, 40).map(([stream]) => ({ stream, archive: () => archive(stream) })));`,
        steps: [
          {
            now: "The operator closes the first {retired} tickets idle since day 150: {retired_events} events archived, one tombstone seed each",
            pipe: { name: "close", at: 5 },
            say: "At scale the same dance runs stream by stream: check for pending work, guard, archive, delete, and leave one tombstone at v0. The dots lift away into the archive, leaving holes, and the seeds land at the end.",
            moves: [
              { from: "ops", to: "close", label: "40 targets" },
              { from: "close", to: "s3", label: "archive" },
              { from: "close", to: "field:main", label: "truncate + seed" },
            ],
            ops: [
              {
                op: "retire",
                prefix: "ticket",
                count: 40,
                idle: 150,
                archive: true,
              },
            ],
          },
          {
            now: "The store now holds {events} events on {streams} streams; {closed} are closed",
            say: "The ids of deleted events are never reused, so the holes stay until a restore tidies up. The counts in the store's header always come from the store itself.",
            focus: ["field:main"],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 14
  {
    id: "policies",
    app: APP_POLICIES,
    view: "macro",
    history: [{ seed: 14, events: 1500, days: 300, kinds: LEDGER_KINDS }],
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
            now: "`__autoclose__:ticket-7001` is deferred until May 21",
            pipe: { name: "reaction", at: 3 },
            say: "Nobody wants to remember to close tickets by hand, months after they're done. An autoclose rule becomes a reaction on the state's events, one target per stream. Ticket 7001 closed on Feb 20, so the reaction waits **90 days**: a stored schedule, with no sweep.",
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
                reaction: "autoclose",
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
            now: "Due: guard {#p-guard}, archive, then seed {#p-seed} `__tombstone__` · ticket-7001 v0",
            pipe: { name: "close", at: 5 },
            say: "When it comes due, inside the quiet off-hours window, it checks the **live head**. Still closed, so it runs the same close an operator would, archiving through the state's own archive. A reopened ticket would be left alone.",
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
          {
            now: "Over the following weeks, more cooldowns come due: {retired} closed tickets retire, {retired_events} events archived",
            pipe: { name: "close", at: 5 },
            say: "There's no sweep job anywhere. Each stream's own timer comes due by itself, and each close runs only when that ticket is still closed and old enough. Here the ones due by day 210, a day picked for the example, retire together.",
            moves: [{ from: "auto", to: "field:main", label: "close" }],
            ops: [
              {
                op: "retire",
                prefix: "ticket",
                count: 80,
                idle: 210,
                is: ["TicketClosed"],
                archive: true,
              },
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
            now: "The closest snapshot older than the Apr 4 cutoff is {#l-snap1}",
            say: "Some streams never end. A ledger keeps taking entries for years, and its oldest history just costs space. Keeping 180 days trims anything older. Say today is Oct 1 (the dates here are picked for the example), so the cutoff is Apr 4. The closest snapshot before that is from Mar 01 ({#l-snap1}).",
            ops: [
              { op: "flag", on: "cell:l-snap1", text: "closest safe snapshot" },
            ],
            focus: ["cell:l-snap1"],
          },
          {
            now: "The windowed close prunes {#l-1}, {#l-2} and {#l-3}, below {#l-snap1}",
            say: "A **windowed** close deletes only the events **below** that snapshot. No tombstone and no seed: the snapshot holds the balance, and the ledger keeps going.",
            moves: [{ from: "auto", to: "cell:l-snap1", label: "prune below" }],
            ops: [
              { op: "unflag" },
              { op: "prune", stream: "ledger-9", below: "l-snap1" },
            ],
          },
          {
            now: "`app.close([{ stream, before }])` prunes a quiet stream",
            say: "The window moves forward as the ledger commits. A ledger that went quiet gets trimmed with an explicit windowed close, which archives only through its own archive.",
            code: `const cutoff = new Date(Date.now() - 180 * 86_400_000);
await app.close([{ stream: "ledger-9", before: cutoff, archive: () => archiveLedger(cutoff) }]);`,
            moves: [
              { from: "ops", to: "cell:l-snap1", label: "before: cutoff" },
            ],
          },
          {
            now: "`keep` runs on every ledger: {pruned} events pruned on {pruned_streams} ledgers, each below its closest snapshot older than day 180",
            say: "Every ledger plays by the same rule: find the closest snapshot older than the cutoff (day 180 here, picked for the example) and delete only what's below it. A ledger without one keeps everything. The snapshots stay, and every ledger stays live.",
            moves: [{ from: "auto", to: "field:main", label: "prune" }],
            ops: [{ op: "keep", prefix: "ledger", cutoff: 180 }],
          },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── 15
  {
    id: "restore",
    app: APP_OPS,
    view: "macro",
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
            now: "The operator runs `app.restore`: {restored} events into the SQLite store; the holes close and ids renumber densely",
            say: "After all that closing and trimming, the store looks like Swiss cheese, and an old event name is still hanging around. Restore copies a source into a sink in **one transaction**. Ids renumber neatly, created times are kept, and causation follows the new ids.",
            moves: [{ from: "restore", to: "log:sink", label: "scan → sink" }],
            ops: [
              { op: "unflag" },
              { op: "store", name: "main", label: "PostgresStore (source)" },
              { op: "store", name: "sink", label: "SqliteStore (new)" },
              { op: "restore", from: "main", store: "sink" },
            ],
          },
          {
            now: "Restore again with `drop_snapshots`: {dropped} snapshots dropped, {restored} events; each stream keeps its first",
            say: "It can tidy up on the way, dropping every snapshot that has history before it, while keeping a stream's **first** one, the one a trimmed or restarted stream starts from.",
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
            now: "Restore with `event_migrations`: `Posted` becomes `Posted_v2`",
            say: "It can update old events too. On the live store an event never changes, and a new name like `Posted_v2` takes over from the old one. A restore can rewrite the old ones as they pass, checked on both sides.",
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
            now: "Clear the cache and rebuild projections with `app.reset`",
            say: "Restore leaves the cache and your read models alone. So after a big restore, clear the cache and rebuild the projections with a reset.",
            code: `await cache().clear();
await app.reset({ stream: "^proj-" });`,
          },
          {
            now: "`app.audit()` flags ledger-9 as a close candidate",
            say: "And before trouble finds you, an audit walks the store and tells the operator what needs attention: schema drift, close and restart candidates, stuck reactions, snapshot drift and correlation gaps.",
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
    app: APP_SCALE,
    view: "macro",
    history: [{ seed: 16, events: 1200, days: 300, kinds: DESK_KINDS }],
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
            now: "Process A commits {#s-2} · ticket-8002; B sees it on its next poll",
            say: "The desk grows to two servers sharing one Postgres store, and each wants to know when the other writes. Without notify, server B only notices A's commit when it polls, every 10 s by default.",
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
            now: "A commits {#s-3} · ticket-8003; a Postgres NOTIFY wakes B at once",
            say: "With a store that notifies, A's commit taps B on the shoulder right away, and B settles. A server never hears its own commits, since those already settle locally. Inject the store before building the app, or nothing gets wired.",
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
            now: "Swap the wakeup channel with `withBroker`",
            say: "Notify is a nudge, not a promise. Correctness always comes from claiming and draining over the store, which is why the wake-up channel can be swapped, for example for Redis.",
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
            now: "Tenant A commits {#s-a} to tenant_a; tenant B, a store of its own, commits {#s-b} to tenant_b",
            say: "One process can also host several Acts, each with its **own store and cache**, passed in together. Two tenants, two logs, and no gossip between them. One store always belongs to one application.",
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
                op: "burst",
                store: "tenant-b",
                count: 500,
                seed: 161,
                kinds: DESK_KINDS,
                day: 0,
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
            now: "Both apps run `shutdown()`",
            say: "When it's time to go home, shutdown waits for in-flight drains up to a grace period, hands back the correlation lease, and starts nothing new.",
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
    app: APP_EDGE,
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
            now: "The browser POSTs `OpenTicket`: {#e-open} · ticket-8100 v0, answered 200",
            pipe: { name: "action", at: 7 },
            say: "Agents don't type `app.do`; they click buttons in a browser. The HTTP package walks the registry and builds a route for every action: the payload goes in, its snapshots come out, typed all the way to the browser.",
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
            now: "The browser closes ticket-8100 twice: refused in the action layer at preconditions, answered 409 `PRECONDITION`",
            pipe: { name: "action", at: 2, fail: true },
            say: "Errors map to status codes in one table, so a refused precondition comes back as **409** with PRECONDITION.",
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
                op: "reject",
                stream: "ticket-8100",
                name: "TicketClosed",
                error: "PreconditionError",
                stage: "preconditions",
              },
            ],
          },
          {
            now: "SSE pushes the v0 patch to the browser",
            say: "With server-sent events, every committed change reaches the browsers watching that state as a small, versioned patch. A browser that falls behind knows to refetch.",
            moves: [
              { from: "cell:e-open", to: "sse", label: "committed" },
              { from: "sse", to: "browser", label: "patch v0", tone: "good" },
            ],
          },
          {
            now: "A reaction calls out with `webhook(...)`",
            say: "Calls to the outside world are reactions too. A webhook handler comes with a timeout, an idempotency key taken from the event id, and typed errors that drive retries and blocking.",
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
    app: APP_EDGE,
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
            now: "Everything ran on the store port: `InMemoryStore`",
            say: "Everything you've watched ran on one **port**: the store. In-memory is the default, and Postgres and SQLite run the very same log in production. Inject one before building the app.",
            ops: [{ op: "store", name: "main", label: "InMemoryStore" }],
            focus: ["port"],
          },
          {
            now: "Swap in `SqliteStore`: the log is unchanged",
            say: "Swap the adapter, and nothing above the log changes: same ids, same versions, same leases.",
            ops: [{ op: "store", name: "main", label: "SqliteStore" }],
          },
          {
            now: "`runStoreTck` proves a new adapter",
            say: "A new adapter earns its badge with the **TCK**, the same test suite the built-in stores run. A commit across streams is all or nothing, a live lease belongs to one worker, a truncate leaves a seed, and notify never echoes.",
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
            now: "Every adapter applies the rules from `@rotorsoft/act/adapter`",
            say: "The rules a store must follow are exported from the adapter entry point, so every store refuses the same bad writes and plants the same seeds. And that's the tour: every capability you saw is something the log does.",
            code: `import { checkAppends, checkVersion, seedEvent } from "@rotorsoft/act/adapter";`,
          },
        ],
      },
    ],
  },
];

const tour: TourSpec = {
  title: "The Act framework tour",
  pipelines: {
    action: [
      "payload",
      "load",
      "preconditions",
      "handler",
      "fold",
      "state check",
      "commit",
    ],
    reaction: ["correlate", "claim", "fetch", "handle", "ack"],
    close: ["probe", "guard", "archive", "truncate", "seed"],
    projection: ["correlate", "claim", "fetch", "project", "write", "ack"],
  },
  stores: [{ name: "main", label: "InMemoryStore" }],
  chapters,
};
export default tour;
