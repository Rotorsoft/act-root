---
id: contracts-cli
title: Inspect contracts with the `act` CLI
sidebar_position: 8
---

# Inspect contracts with the `act` CLI

In a large Act app, the question "who produces `OrderPlaced`? who reacts to it? which projections fold it?" is uncomfortably common. Grep gets you partial answers. The build-time **`act` CLI** is the proper answer: it walks the same parser the diagram uses, indexes every event, action, slice, projection, state, and reaction, and lets you explore them interactively from the terminal.

It's the build-time companion to [`act-inspector`](https://github.com/Rotorsoft/act-inspector). Where the inspector shows runtime state, `act` shows the *structural contract*.

## Two modes

### Interactive (default)

```bash
pnpm act                        # current directory
pnpm act packages/wolfdesk      # target a package
```

Pick a category (events, actions, slices, projections, states, reactions) → pick an entry → view the formatted neighborhood. From the detail view, press <kbd>enter</kbd> on **open in $EDITOR** to jump straight to the source line.

The CLI honors `$VISUAL`, then `$EDITOR`, falling back to `vi`. VS Code, Cursor, vim, nvim, nano, and emacs are recognized and invoked with the right "go to line" flag.

### Non-interactive (`-q`)

```bash
pnpm act -q TicketOpened
```

Prints the detail for a single match and exits 0. Two-or-more matches print a numbered list. Zero matches exit 1. This is what CI uses to smoke-test parser changes against the example apps.

## What the detail view shows

```
event TicketOpened
  defined: src/ticket-creation.ts
  on state: Ticket
  schema:  z.object({ title: z.string(), description: z.string() })
  status:  active
  producers:
    - action OpenTicket (state Ticket)  src/ticket-creation.ts
  consumers:
    - reaction TicketCreationSlice::assign → triggers AssignTicket  src/ticket-creation.ts
    - projection tickets  src/ticket-projections.ts
```

- **schema** — best-effort capture of the Zod expression as written in `.emits({ ... })`. ES2015 shorthand (`.emits({ TicketOpened })`) is captured as the bound identifier name; explicit expressions are captured verbatim. The same captured text appears in the diagram's event-node tooltips.
- **status** — derived from the [`_v<n>` versioning convention](../architecture/event-schema-evolution.md). An event `Foo` is reported as *deprecated, superseded by `Foo_v2`* whenever a higher version exists.
- **producers** — every action that emits this event, with its owning state and source location.
- **consumers** — every reaction and projection that observes this event.

## Scripted usage

The non-interactive `-q` mode is pipe-friendly:

```bash
# All ticket-related events
for ev in TicketOpened TicketAssigned TicketResolved; do
  pnpm act packages/wolfdesk -q "$ev"
  echo
done

# Exit code as a contract check in a pre-commit hook
pnpm act -q OrderPlaced > /dev/null || { echo "OrderPlaced missing!"; exit 1; }
```

## What gets scanned

The walker reads `.ts` files under the target directory, skipping:

- `node_modules`, `dist`, `coverage`, `build`, `.git`, `.turbo`, `.next`, `.vercel`
- Test directories (`test`, `tests`, `__tests__`, `e2e`) and test files (`*.test.ts`, `*.spec.ts`, `*.d.ts`, `*.tsx`)
- Benchmark directories (`bench`, `benches`, `benchmark`, `benchmarks`, `perf`) and `*.bench.ts` / `*.perf.ts` files
- `scripts/` directories

If your project hides Act sources somewhere unusual, point `pnpm act` at it directly: `pnpm act some/odd/path`.

## When schemas don't get captured

The parser is intentionally best-effort. If you see `schema: (not captured)` for an event, the likely cause is one of:

- The event was declared with a non-trivial expression the bracket-matcher can't recover (very rare in practice).
- The state file was skipped by the directory filters.
- The event lives only in a projection's `.handles` list (projections don't carry schemas — they observe whatever upstream defines).

Captured schema text feeds both the CLI's detail view and the diagram's event-node tooltips, so improvements to the extractor benefit both surfaces at once.

## Related

- [Diagram README](https://github.com/Rotorsoft/act-root/tree/master/libs/act-diagram) — the SVG component that shares the parser.
- [Event schema evolution](../architecture/event-schema-evolution.md) — the `_v<n>` convention that drives deprecation status.
- [`act-inspector`](https://github.com/Rotorsoft/act-root/tree/master/packages/inspector) — runtime counterpart for browsing live state.
