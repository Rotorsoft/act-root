# RFC 2226: A committed listener scoped to one state

- **Issue:** #2226
- **Author:** Rotorsoft
- **Created:** 2026-10-31

## Motivation

`app.on("committed", listener)` hears every state's commits, so its snapshots are typed `Snapshot<Schema, TEvents>[]`, and `Schema` is `Record<string, any>`: every state field reads as `any`. A host that does something with the committed state (publish it to an SSE channel, update a metric, audit it) casts to get real types. The calculator server did; the scaffold skill taught the same cast. With the generated APIs typed end to end (#2224), this listener was the last place an Act app had to write types by hand.

The existing listener can't be retyped without breaking anyone. A union of the app's states breaks every listener that reads a field only some states have. Anything still compatible with `Record<string, any>` stays `any`. And a commit carries nothing that says which state made it, so TypeScript has nothing to narrow on.

## Public surface added

- **`Act.on` / `Act.off` overloads** (no new export, no new event name):

  ```ts
  on<TNewState, TNewEvents, TNewActions>(
    event: "committed",
    state: State<TNewState, TNewEvents, TNewActions>,
    listener: (snapshots: Snapshot<TNewState, TNewEvents>[]) => void
  ): this;
  on<TKey extends keyof TStateMap & string>(
    event: "committed",
    state: TKey,
    listener: (snapshots: Snapshot<TStateMap[TKey], TEvents>[]) => void
  ): this;
  ```

  `off` takes the same two shapes. The listener runs only for commits by the actions of that state, by name, so a partial state and its merged state hear the same commits. A state the app doesn't register throws at registration. Listeners are contained like every lifecycle listener: one that throws is logged and the others still run.

- **`BroadcastChannel.publish`** (act-http): `patches` widens from `Partial<S>[]` to `Readonly<Patch<S>>[]`, the type snapshots carry (`null` deletes a key), so a snapshot's `patch` passes without a cast. Every `Partial<S>` is a `Patch<S>`, so existing calls still compile.

## Alternatives considered

- **Retype `committed`'s payload.** Breaking, for the reasons above.
- **act-http publishes commits to the SSE channel itself** (`sse: { channel, publish: true }`). Typed, but it covers only "publish every commit as-is". A host that overlays presence or computed fields keeps its own listener and its cast, and it moves a documented host decision (what gets broadcast) into the library.
- **A new lifecycle event** (`committed:<State>` as a public name). Leaks an emitter key convention into the public surface; the overload keeps one event name.
- **Do nothing.** Every host that reads committed state keeps a cast.

## Stability / charter impact

- Category: `Act` methods (`act.ts`, charter-covered); act-http's `sse` subpath.
- All additive. The existing `on("committed", listener)` keeps its payload type, and its listeners run as before. The runtime export count doesn't change (overloads, not new functions). No port, TCK or adapter change.

## Open questions

None.
