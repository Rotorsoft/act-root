# RFC 2578: Generated APIs that address entities, skip actions, and publish their own live updates

- **Issue:** #2578, #2579, #2580
- **Author:** rotorsoft
- **Created:** 2026-11-18

## Motivation

`trpc(app)`, `hono(app)` and `openapi(app)` remove hand-written procedures for apps whose streams are constants or tenant prefixes. They stop short of three things a real app with entity streams needs, so the app writes the procedures by hand again. konsult (a books app on act 2.1) has 25 actions behind 35 hand-written tRPC mutations; 22 of them only call `app.do`.

1. **Addressing one entity (#2578).** The only way to pick the stream is `stream(action, input, ctx)`. Voiding invoice 42 means putting the id in the payload (the emit handler then copies the address onto every event), inventing an untyped header the OpenAPI document doesn't describe, or hand-writing the procedure.
2. **Leaving an action out (#2579).** Every registered action gets a route. When a hand-written procedure owns an action (it derives the stream, snapshots another aggregate into the payload, or sends mail after the commit), the generated twin stays mounted beside it and bypasses that work.
3. **Live updates end to end (#2580).** The generators emit the subscription side only. Every host writes the same `committed` → `publish` listener, including the `.snap` empty patch the real-time guide warns about; read-model views (lists, dashboards) have no signal that their projection caught up; and nothing tells the host how many clients are connected.

All of this is act-http only. Core already emits what it needs: `committed` carries the snapshots, and `settled` carries the acked leases.

## Public surface added

All additive, act-http only (a minor release). No new export except where named.

### `streams`: caller-addressed states (`trpc`, `hono`, `openapi`)

```ts
trpc(app, {
  actor,
  stream: () => "settings",            // every state not listed below, as today
  streams: {
    Invoice: /^invoice-[a-z0-9-]+-\d{4}-\d{2}$/,
    Client: (stream) => stream.startsWith("client-"),
  },
});
```

- `streams?: { [State in AppStateNames]?: RegExp | ((stream: string) => boolean) }`, typed against the registry's state names.
- Only caller-addressed states go in it. Every other state still resolves through `stream`, which becomes optional: generation fails, naming the states, when some state is in neither.
- For a listed state's actions, the caller sends the stream:
  - tRPC: the input is `{ stream: string; payload: <action input> }`. The payload stays exactly the action's schema.
  - Hono: `POST <base>/actions/<Action>/:stream`.
  - OpenAPI: that route with a `stream` path parameter, carrying `pattern` when the entry is a `RegExp`.
- A stream that doesn't match is refused before `app.do`: `422` with code `INVALID_STREAM` on Hono and OpenAPI, `BAD_REQUEST` with the same code on tRPC.
- `expectedVersion` receives the resolved stream, so a per-entity `If-Match` works.

### `actions`: which actions get a route (`trpc`, `hono`, `openapi`)

- `actions?: { include: readonly ActionName[] } | { exclude: readonly ActionName[] }`, typed against the registry's action names; exactly one of the two.
- An excluded action gets no route, no OpenAPI operation and no key in the router type, so calling it doesn't compile.
- An unknown name fails at generation. The default (every action) is unchanged.

### `sse` gains three optional fields (`trpc`, `hono`)

- `publish?: boolean`: when true, the generator registers one `committed` listener per broadcast state and publishes each commit once, with the real-time guide's algorithm (patches in order, an empty patch when `.snap` took a version, `_v` set). Plus one new export on `@rotorsoft/act-http/sse`, for hosts outside the generators: `publishCommits(app, channel, states?): () => void`, taking the app structurally (`registry` and `on`) so the subpath never imports the framework and stays browser-safe.
- `settled?: boolean`: adds one subscription, `subscribe.$settled` on tRPC and `GET <base>/sse/$settled` on Hono (a `$` name can't collide with a state name). It yields `{ kind: "settled", data: { targets: string[] } }` once per `settled` event, where `targets` are the acked leases' streams. It shares the connection cap and `maxPendingPerConnection` with the state subscriptions.
- `onConnections?: (count: number) => void`: called on every open and close across the generated subscriptions.

`publish` and `settled` need `app.on`. `ActSurface` gains an optional `on`, and generation fails when either flag is set on a surface without it.

## Alternatives considered

- **`streams` taking singletons too** (`Settings: "settings"`), as #2578 first proposed. It overlaps `stream`, which already resolves constants, and needs a "both passed" error. Patterns only keeps one way per case.
- **The id in the payload, or a header convention.** Rejected in #2578: the payload is intent and the stream is the address; a header is untyped, invisible to OpenAPI, and fixed per hook render in React.
- **A tRPC stream as a second argument or in the context.** tRPC procedures take one input; an envelope is the typed way to carry two things.
- **Only `exclude` for #2579.** `include` reads better for an app that generates a few routes and hand-writes the rest; both are one typed list, and "exactly one" keeps it unambiguous.
- **Publishing from projections or per call site.** The real-time guide's rule is one publication per commit; the library owning it removes the double-apply bug class instead of documenting it.
- **A settled signal per projection subscription** instead of one `$settled` stream with targets. One subscription per client is cheaper, and the client maps targets to queries with the helper below.
- **Exporting the connection counter.** A callback says what the host needs (a count on change) without publishing a class.

## Stability / charter impact

- Additive optional fields on the `trpc`, `hono` and `openapi` options, three optional fields on `SseOptions`, an optional `on` on `ActSurface`, and one export (`publishCommits`). `stream` becoming optional widens an input. Nothing breaks: an app that passes none of the new options gets today's routes and types.
- One reserved subscription name, `$settled`, only when `settled` is set.
- No port, builder or lifecycle-event change; no TCK change.
- New behavior-contract rows: a caller-addressed stream outside its pattern is refused before `app.do`; an excluded action has no route; `publish` sends one publication per commit per stream, `.snap` included; `$settled` yields once per `settled` with the acked targets.

## Open questions

- **Delivery order.** #2579 first (small, independent), then #2578, then #2580; one PR each, each linking this RFC.
- **`invalidateOnSettled(frame, map)`**, the browser helper #2580 sketches for mapping targets to query keys: ship it, or leave the two-line mapping to the client? This RFC leaves it out.
