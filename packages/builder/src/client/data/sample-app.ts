/**
 * Sample Todo + Notification app — a complete Act project demonstrating
 * cross-slice reactions, invariants, projections, and the orchestrator.
 */

import type { FileTab } from "../types/file-tab.js";

/** Complete sample project files, ordered: app → states → slices → projection → config */
export const SAMPLE_APP: FileTab[] = [
  {
    path: "src/app.ts",
    content: `/**
 * Orchestrator — wires all slices together into a single application.
 *
 * act() composes slices (and standalone projections/reactions) into
 * an Act instance that provides:
 *   app.do(action, target, payload)  → execute an action
 *   app.load(State, stream)          → load current state
 *   app.drain()                      → process pending reactions
 *   app.settle()                     → debounced correlate + drain
 *
 * The orchestrator merges all state registries, validates there are
 * no duplicate action/event names, and builds the reaction graph.
 */
import { act } from "@rotorsoft/act";
import { TodoSlice, NotificationSlice } from "./slices.js";

export const app = act()
  .withSlice(TodoSlice)
  .withSlice(NotificationSlice)
  .build();
`,
  },
  {
    path: "src/states.ts",
    content: `/**
 * State definitions — the core domain model.
 *
 * Each state() call defines a state with:
 *   - A Zod schema describing the state shape
 *   - .init()    → default values for new instances
 *   - .emits()   → events this state can produce (past tense)
 *   - .patch()   → how each event updates the state (optional — passthrough by default)
 *   - .on()      → actions (commands) that trigger events (imperative)
 *   - .given()   → invariants checked before the action executes
 *   - .emit()    → which event(s) the action produces
 *
 * This file defines two states:
 *   Todo         — task lifecycle (create, assign, complete, reopen)
 *   Notification — delivery pipeline (queue, mark sent)
 */
import { state, type Invariant } from "@rotorsoft/act";
import { z } from "zod";

// ── Invariants (business rules) ─────────────────────────────────────
// Checked before an action executes. If valid() returns false, the
// action is rejected with an InvariantError.

const mustBeOpen: Invariant<{ status: string }> = {
  description: "Todo must be open",
  valid: (s) => s.status === "open",
};

const mustBeAssigned: Invariant<{ assignee: string }> = {
  description: "Todo must have an assignee",
  valid: (s) => s.assignee !== "",
};

// ── Todo state ──────────────────────────────────────────────────────

export const Todo = state({ Todo: z.object({
  title: z.string(),
  description: z.string(),
  status: z.string(),
  assignee: z.string(),
  priority: z.string(),
  createdBy: z.string(),
})})
  .init(() => ({
    title: "", description: "", status: "open",
    assignee: "", priority: "medium", createdBy: "",
  }))
  .emits({
    TodoCreated: z.object({
      title: z.string(), description: z.string(),
      priority: z.string(), createdBy: z.string(),
    }),
    TodoAssigned: z.object({ assignee: z.string() }),
    TodoCompleted: z.object({ completedBy: z.string() }),
    TodoReopened: z.object({ reason: z.string() }),
  })
  .patch({
    TodoCreated: ({ data }) => ({
      title: data.title, description: data.description,
      priority: data.priority, createdBy: data.createdBy, status: "open",
    }),
    TodoAssigned: ({ data }) => ({ assignee: data.assignee }),
    TodoCompleted: () => ({ status: "done" }),
    TodoReopened: () => ({ status: "open", assignee: "" }),
  })
  // Actions — each must emit at least one event
  .on({ CreateTodo: z.object({
    title: z.string(), description: z.string(),
    priority: z.string(), createdBy: z.string(),
  })})
    .emit("TodoCreated")  // passthrough: action payload becomes event data
  .on({ AssignTodo: z.object({ assignee: z.string() }) })
    .given([mustBeOpen])
    .emit("TodoAssigned")
  .on({ CompleteTodo: z.object({ completedBy: z.string() }) })
    .given([mustBeOpen, mustBeAssigned])  // both invariants must pass
    .emit("TodoCompleted")
  .on({ ReopenTodo: z.object({ reason: z.string() }) })
    .emit("TodoReopened")
  .build();

// ── Notification state ──────────────────────────────────────────────

export const Notification = state({ Notification: z.object({
  channel: z.string(),
  subject: z.string(),
  body: z.string(),
  status: z.string(),
})})
  .init(() => ({ channel: "", subject: "", body: "", status: "pending" }))
  .emits({
    NotificationQueued: z.object({
      channel: z.string(), subject: z.string(), body: z.string(),
    }),
    NotificationSent: z.object({ sentAt: z.string() }),
  })
  .patch({
    NotificationQueued: ({ data }) => ({
      channel: data.channel, subject: data.subject,
      body: data.body, status: "pending",
    }),
    NotificationSent: () => ({ status: "sent" }),
  })
  .on({ QueueNotification: z.object({
    channel: z.string(), subject: z.string(), body: z.string(),
  })})
    .emit("NotificationQueued")
  .on({ MarkNotificationSent: z.object({ sentAt: z.string() }) })
    .emit("NotificationSent")
  .build();
`,
  },
  {
    path: "src/slices.ts",
    content: [
      "/**",
      " * Slices — vertical feature modules grouping states + reactions.",
      " *",
      " * A slice owns one or more states and defines reactions that fire",
      " * when events are committed. Reaction handlers receive a typed",
      " * Dispatcher (app) to invoke actions — including actions on OTHER",
      " * states, enabling cross-slice workflows.",
      " *",
      " * Key patterns:",
      " *   .withState(S)        → register states whose actions handlers need",
      " *   .withProjection(P)   → embed a projection (events must be a subset)",
      ' *   .on("EventName")     → react to an event from this slice\'s states',
      " *     .do(handler)       → handler receives (event, stream, app)",
      " *     .to(resolver)      → target stream for drain processing",
      " *     .void()            → fire-and-forget (not processed by drain)",
      " *",
      " * IMPORTANT: .to() reactions are processed by drain() — they need a",
      " * target stream. Use .void() only for side-effects that don't need",
      " * guaranteed delivery.",
      " */",
      'import { slice } from "@rotorsoft/act";',
      'import { Todo, Notification } from "./states.js";',
      'import { TodoProjection } from "./projection.js";',
      "",
      "// ── Todo slice ──────────────────────────────────────────────────────",
      "// Owns the Todo state. Reactions dispatch into Notification (cross-slice).",
      "// Must .withState(Notification) so the dispatcher can call QueueNotification.",
      "",
      "export const TodoSlice = slice()",
      "  .withState(Todo)",
      "  .withState(Notification)",
      "  .withProjection(TodoProjection)",
      "",
      "  // When a todo is assigned → notify the new assignee",
      '  .on("TodoAssigned")',
      "    .do(async function notifyOnAssign(event, _stream, app) {",
      '      await app.do("QueueNotification",',
      '        { stream: "notif-assign-" + event.stream, actor: { id: "system", name: "Todo Bot" } },',
      '        { channel: "email", subject: "Todo assigned to you", body: "Todo " + event.stream + " assigned to " + event.data.assignee },',
      "        event  // pass the triggering event for correlation tracking",
      "      );",
      "    })",
      '    .to((event) => ({ target: "notif-assign-" + event.stream, source: event.stream }))',
      "",
      "  // When a todo is completed → notify the creator",
      '  .on("TodoCompleted")',
      "    .do(async function notifyOnComplete(event, _stream, app) {",
      '      await app.do("QueueNotification",',
      '        { stream: "notif-done-" + event.stream, actor: { id: "system", name: "Todo Bot" } },',
      '        { channel: "email", subject: "Todo completed", body: "Todo " + event.stream + " completed by " + event.data.completedBy },',
      "        event",
      "      );",
      "    })",
      '    .to((event) => ({ target: "notif-done-" + event.stream, source: event.stream }))',
      "",
      "  // When a high-priority todo is created → auto-assign to on-call",
      '  .on("TodoCreated")',
      "    .do(async function autoAssignUrgent(event, _stream, app) {",
      '      if (event.data.priority === "high") {',
      '        await app.do("AssignTodo",',
      '          { stream: event.stream, actor: { id: "system", name: "Auto-Assign" } },',
      '          { assignee: "oncall@team.com" },',
      "          event",
      "        );",
      "      }",
      "    })",
      '    .to((event) => ({ target: "auto-" + event.stream, source: event.stream }))',
      "  .build();",
      "",
      "// ── Notification slice ──────────────────────────────────────────────",
      '// Owns the Notification state. Reacts to its own events to "send"',
      "// the notification and mark it as sent (self-dispatch pattern).",
      "",
      "export const NotificationSlice = slice()",
      "  .withState(Notification)",
      "",
      "  // When a notification is queued → send it and mark as sent",
      '  .on("NotificationQueued")',
      "    .do(async function sendAndMarkSent(event, _stream, app) {",
      "      // In production: call email/SMS/push API here",
      '      console.log("Sending [" + event.data.channel + "]: " + event.data.subject);',
      '      await app.do("MarkNotificationSent",',
      '        { stream: event.stream, actor: { id: "system", name: "Mailer" } },',
      "        { sentAt: new Date().toISOString() },",
      "        event",
      "      );",
      "    })",
      '    .to((event) => ({ target: "send-" + event.stream, source: event.stream }))',
      "  .build();",
    ].join("\n"),
  },
  {
    path: "src/projection.ts",
    content: `/**
 * Projection — a read-model updater that reacts to events.
 *
 * Projections have NO state of their own and NO dispatcher.
 * Handlers receive (event, stream) and update external storage
 * (database tables, caches, search indexes, etc.).
 *
 * Use projection("target-name") to set a default resolver target,
 * or .to(resolver) per handler for different routing.
 */
import { projection } from "@rotorsoft/act";
import { z } from "zod";

export const TodoProjection = projection("todo-list")
  .on({ TodoCreated: z.object({
    title: z.string(), description: z.string(),
    priority: z.string(), createdBy: z.string(),
  })})
    .do(async ({ stream, data }) => {
      // INSERT into todo_list (id, title, description, priority, created_by, status)
      console.log("Project TodoCreated:", stream, data.title);
    })
  .on({ TodoAssigned: z.object({ assignee: z.string() }) })
    .do(async ({ stream, data }) => {
      // UPDATE todo_list SET assignee = $1 WHERE id = $2
      console.log("Project TodoAssigned:", stream, data.assignee);
    })
  .on({ TodoCompleted: z.object({ completedBy: z.string() }) })
    .do(async ({ stream, data }) => {
      // UPDATE todo_list SET status = 'done', completed_by = $1 WHERE id = $2
      console.log("Project TodoCompleted:", stream, data.completedBy);
    })
  .build();
`,
  },
  {
    path: "package.json",
    content: JSON.stringify(
      {
        name: "act-todo-app",
        version: "0.0.1",
        type: "module",
        scripts: { build: "tsc", test: "vitest", typecheck: "tsc --noEmit" },
        dependencies: { "@rotorsoft/act": "latest", zod: "^4" },
        devDependencies: { typescript: "~5.9", vitest: "^3" },
      },
      null,
      2
    ),
  },
  {
    path: "tsconfig.json",
    content: JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "node",
          strict: true,
          esModuleInterop: true,
          outDir: "dist",
          declaration: true,
          skipLibCheck: true,
        },
        include: ["src"],
      },
      null,
      2
    ),
  },
];

/** Default project config files — package.json name derived from project name */
export function projectFiles(name?: string): FileTab[] {
  const pkgName = (name || "act-app")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: pkgName,
          version: "0.0.1",
          type: "module",
          scripts: { build: "tsc", test: "vitest", typecheck: "tsc --noEmit" },
          dependencies: { "@rotorsoft/act": "latest", zod: "^4" },
          devDependencies: { typescript: "~5.9", vitest: "^3" },
        },
        null,
        2
      ),
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "node",
            strict: true,
            esModuleInterop: true,
            outDir: "dist",
            declaration: true,
            skipLibCheck: true,
          },
          include: ["src"],
        },
        null,
        2
      ),
    },
  ];
}

/** @deprecated Use projectFiles(name) instead */
export const PROJECT_FILES: FileTab[] = projectFiles();
