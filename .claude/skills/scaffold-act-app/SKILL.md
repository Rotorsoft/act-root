---
name: scaffold-act-app
description: Scaffolds a new TypeScript application using the @rotorsoft/act event sourcing framework. Translates functional specs — event modeling diagrams, event storming artifacts, or user stories — into a working monorepo with domain logic, tRPC API, and React client. Use when the user wants to build a new app, create a new project, or translate a domain model into code using Act.
---

# Scaffold an Act Application

Build a TypeScript monorepo application using `@rotorsoft/act` from a functional specification.

**References:** [act-api.md](act-api.md) (type signatures & gotchas) · [domain.md](domain.md) (states, slices, projections, tests) · [api.md](api.md) (tRPC router & broadcast) · [client.md](client.md) (React hooks & SSE) · [server.md](server.md) (dev/prod servers & deployment) · [monorepo-template.md](monorepo-template.md) (workspace config files)

## Spec-to-Code Mapping

| Spec Artifact | Framework Artifact | Builder / API |
|---|---|---|
| Aggregate / Entity | State | `state({ Name: schema })` |
| Command | Action | `.on({ ActionName: schema })` |
| Domain Event | Event + Patch | `.emits({ Event: schema })` + optional `.patch({...})` for custom reducers |
| Business Rule / Guard | Invariant | `.given([{ description, valid }])` |
| Policy / Process Manager | Reaction (Slice or Act) | `.on("Event").do(handler)` |
| Read Model / Query | Projection | `projection("target").on({ Event }).do(handler)` |
| Bounded Context / Feature | Slice | `slice().withState(State)` |
| System / Orchestrator | Act | `act().withActor<T>().withSlice(Slice).build()` |

**Event Modeling**: Blue = Action, Orange = Event + Patch, Green = Projection, Lilac = Reaction, Aggregate swim lane = State.

**Event Storming**: Blue = Action, Orange = Event + Patch, Yellow = State, Lilac = Reaction, Green = Projection, Red = Invariant.

## Analyze the Specification

Before writing any code, fetch and parse the spec to extract domain artifacts. This section applies to **any** spec format — event modeling diagrams, event storming boards, domain stories, user stories, config files, or prose requirements.

### Fetch and Parse

1. Fetch the spec URL (or read the provided file/text)
2. Identify the format (JSON config, Miro export, markdown, YAML, prose, etc.)
3. Extract domain artifacts using the vocabulary mapping below

### Generic Vocabulary Mapping

Specs use varied terminology. Map to framework concepts:

| Spec Term (any tool/language) | Framework Concept | Builder API |
|---|---|---|
| Aggregate, Entity, Actor, Domain Object | State | `state({ Name: schema })` |
| Command, Action, Intent, Request | Action | `.on({ ActionName: schema })` |
| Domain Event, Fact, State Change | Event | `.emits({ Event: schema })` + optional `.patch({})` for custom reducers |
| Read Model, View, Query Model, Projection | Projection | `projection("target").on({ Event }).do(handler)` |
| Policy, Process Manager, Automation, Saga, Reactor | Reaction | `slice().withState(State).on("Event").do(handler)` |
| Invariant, Guard, Business Rule, Precondition, Constraint | Invariant | `.given([{ description, valid }])` |
| Specification, Acceptance Criteria, Given-When-Then, Scenario | Test case | `describe / it` block |
| Screen, UI, View, Page | Client component | tRPC procedure + React component |
| Bounded Context, Module, Feature, Slice | Slice | `slice().withState(State)` |
| External Event, Integration Event | Reaction trigger | Event from another aggregate's stream |
| User Role, Permission, Auth | Actor type + middleware | `withActor<T>()` + tRPC middleware |

### Field Type Mapping

Map spec field types to Zod schemas:

| Spec Type | Zod Schema |
|---|---|
| UUID, ID | `z.uuid()` |
| String, Text | `z.string()` |
| Number, Integer, Int | `z.int()` |
| Double, Float, Decimal | `z.number()` |
| Boolean, Bool | `z.boolean()` |
| Date, DateTime, Timestamp | `z.iso.datetime()` |
| List, Array, Collection | `z.array(innerSchema)` |
| Enum | `z.enum(["A", "B"])` |
| Optional, Nullable | `.optional()` |

### Deriving State Shape

The state schema is the **accumulation of all event fields** for that aggregate:

1. Collect every event the aggregate emits
2. Union all their fields — that is the state shape
3. `init()` returns zero/empty values for each field (`""` for strings, `0` for numbers, `false` for booleans, `[]` for arrays)

### External vs Internal Events

- **Internal events** — emitted by the aggregate's own actions → define in `.emits({})` and optionally `.patch({})` for custom reducers (passthrough is the default)
- **External/integration events** — emitted by other aggregates → handle as **reaction triggers** in a slice (`.on("ExternalEvent").do(handler)`) or at the act level

### Given/When/Then → Tests

Translate spec scenarios directly into test cases:

- **Given** (preconditions) → seed events via `app.do()` to set up state
- **When** (action) → dispatch the action under test via `app.do()`
- **Then** (assertions) → assert emitted events, final state (`app.load()`), or expected errors (`rejects.toThrow()`)

```typescript
it("should close an open ticket", async () => {
  // Given — an open ticket
  await app.do("OpenTicket", target, { title: "Bug" });
  // When — close it
  await app.do("CloseTicket", target, { reason: "Fixed" });
  // Then — state reflects closure
  const snap = await app.load(Ticket, target.stream);
  expect(snap.state.status).toBe("Closed");
});
```

## Monorepo Architecture

```
my-app/
├── packages/
│   ├── domain/           # Pure domain logic — zero infrastructure deps
│   │   ├── src/
│   │   │   ├── schemas.ts        # Zod schemas (actions, events, state) + AppActor type
│   │   │   ├── invariants.ts     # Business rules
│   │   │   ├── <feature>.ts      # State + Slice per feature (co-locate projection)
│   │   │   ├── bootstrap.ts      # act().withActor<T>().withSlice().build()
│   │   │   └── index.ts          # Barrel exports
│   │   └── test/
│   │       └── <feature>.spec.ts
│   └── app/              # Server + Client in one package
│       ├── src/
│       │   ├── api/              # tRPC router (decomposed)
│       │   │   ├── index.ts      # Router composition + AppRouter type
│       │   │   ├── trpc.ts       # tRPC init + middleware (public/authed/admin)
│       │   │   ├── context.ts    # Request context + token verification
│       │   │   ├── helpers.ts    # serializeEvents() for SSE payloads
│       │   │   ├── auth.ts       # Token signing, password hashing
│       │   │   ├── broadcast.ts      # BroadcastChannel + PresenceTracker (act-sse)
│       │   │   ├── auth.routes.ts    # Auth endpoints (login, signup, OAuth)
│       │   │   ├── domain.routes.ts  # Domain mutations + queries
│       │   │   └── events.routes.ts  # SSE subscriptions (state + events)
│       │   ├── client/           # React + Vite frontend
│       │   │   ├── App.tsx           # Root (providers, splitLink for SSE)
│       │   │   ├── main.tsx          # Entry point
│       │   │   ├── trpc.ts           # tRPC React client
│       │   │   ├── types.ts          # Shared client types
│       │   │   ├── data/             # Static catalog data
│       │   │   ├── hooks/            # Custom hooks (useAuth, useStateStream, useEventStream)
│       │   │   ├── components/       # UI components
│       │   │   ├── views/            # Page-level views
│       │   │   └── styles/           # CSS files
│       │   ├── server.ts         # Production server (static + API)
│       │   └── dev-server.ts     # Dev server (seed data + API)
│       ├── index.html
│       ├── vite.config.ts
│       ├── tsconfig.json         # References app + server configs
│       ├── tsconfig.app.json     # Client + API (bundler resolution)
│       └── tsconfig.server.json  # Server + API (emit JS)
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── vitest.config.ts
```

> **Important:** Every `package.json` that imports `@rotorsoft/act` must have `name` and `version` fields (both `z.string().min(1)`). Act reads `package.json` from CWD at import time and validates these fields — missing or empty values cause a startup error.

For complete workspace configuration files, see [monorepo-template.md](monorepo-template.md).

## Build Process

| Step | Component | Reference |
|---|---|---|
| 1 | Define Schemas & Actor Type | [domain.md](domain.md) § Schemas & Actor Type |
| 2 | Define Invariants | [domain.md](domain.md) § Invariants |
| 3 | Define States | [domain.md](domain.md) § States |
| 4 | Define Slices with Co-located Projections | [domain.md](domain.md) § Slices with Co-located Projections |
| 5 | Cross-Aggregate Projections | [domain.md](domain.md) § Cross-Aggregate Projections |
| 6 | Bootstrap with Generic Actor | [domain.md](domain.md) § Bootstrap |
| 7 | tRPC API | [api.md](api.md) |
| 8 | React Client | [client.md](client.md) |
| 9 | Tests | [domain.md](domain.md) § Tests |
| 10 | Install Dependencies | [monorepo-template.md](monorepo-template.md) § Install Commands |

## Strict Rules

1. **Immutable events** — Never modify a published event schema. Add new events instead.
2. **Zod schemas mandatory** — All actions, events, and states require Zod schemas. Use `ZodEmpty` for empty payloads.
3. **Actor context required** — Every `app.do()` needs `Target` with `{ stream, actor: { id, name } }`. Use `withActor<AppActor>()` to enforce typed actors.
4. **Partial patches** — Patch handlers return only changed fields, not the full state.
5. **Causation tracking** — Pass triggering event as 4th arg in reactions: `app.do(action, target, payload, event)`.
6. **Domain isolation** — `packages/domain` has zero infrastructure deps (except `@rotorsoft/act` and `zod`).
7. **InMemoryStore + InMemoryCache for tests** — Default store and cache. Call `store().seed()` in `beforeEach` and `dispose()()` in `afterAll`. Call `clear*()` for each projection in `beforeEach`.
8. **TypeScript strict mode** — All packages use `"strict": true`.
9. **ESM only** — All packages use `"type": "module"` and `.js` import extensions.
10. **Single-key records** — `state({})`, `.on({})`, `.emits({})` take single-key records. Multi-key throws at runtime.
11. **API decomposition** — Split tRPC router into focused route files (`auth.routes.ts`, `domain.routes.ts`, `events.routes.ts`). Keep `trpc.ts` for init + middleware, `context.ts` for request context, `helpers.ts` for shared utilities.
12. **settle() after mutations** — Call `app.settle()` after every `app.do()` in API mutations. This is non-blocking (returns immediately), debounced (coalesces rapid commits), and emits a `"settled"` event only after all correlate/drain iterations and projections are fully processed.

## Error Handling

| Error | Cause | Resolution |
|---|---|---|
| `ValidationError` | Payload fails Zod validation | Fix payload to match schema |
| `InvariantError` | Business rule failed in `.given()` | Check preconditions |
| `ConcurrencyError` | Stream version mismatch | Retry: reload state and re-dispatch |

For production deployment (PostgresStore, background processing, automated jobs), see [server.md](server.md).

## Completion Checklist

- [ ] All Zod schemas defined for actions, events, and states
- [ ] AppActor type defined extending Actor, systemActor constant exported
- [ ] Every action emits at least one event
- [ ] Patch handlers are pure functions returning partial state
- [ ] Invariants enforce all business rules
- [ ] Reactions pass triggering event for causation tracking
- [ ] Projections co-located with slices, with query and clear functions
- [ ] Projections register only lifecycle event handlers when using act-sse broadcast
- [ ] Tests use InMemoryStore with `store().seed()` and `clear*()` in `beforeEach`, `dispose()()` in `afterAll`
- [ ] Domain package has no infrastructure dependencies
- [ ] All packages use `"type": "module"` and TypeScript strict mode
- [ ] tRPC API decomposed into route files with typed middleware
- [ ] `broadcast.ts` sets up `BroadcastChannel` + `PresenceTracker` from `@rotorsoft/act-sse`
- [ ] `broadcastState()` called after every `app.do()` — sets `_v` from `snap.event.version`
- [ ] SSE `onStateChange` subscription uses `broadcast.subscribe()` for incremental state push
- [ ] SSE `onEvent` subscription wired with `app.on("settled")` for event replay
- [ ] `app.settle()` called after mutations (non-blocking, debounced, emits "settled" after reactions)
- [ ] Client `useStateStream` hook uses `applyBroadcastMessage()` from `@rotorsoft/act-sse`
- [ ] Client uses `splitLink` for SSE subscriptions + HTTP for mutations/queries
- [ ] Types compile with `npx tsc --noEmit`
