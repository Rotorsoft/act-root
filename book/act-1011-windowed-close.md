# ACT-1011 — Closing the books on a rolling window

## The pain that started it

Closing the books had two endings and both of them were final. A stream either died under a tombstone or collapsed its entire history into one synthesized snapshot and carried on as if it had just been born. For streams whose lifecycle actually ends, that is exactly right. But the operator running a ledger under a hundred-and-eighty-day retention contract has a stream that never ends and a regulator who wants recent history kept as real, auditable events. Restart could not help them: the moment it runs, event-level granularity before "now" is gone. What they needed was a third retention contract, forget everything before the window instead of forget everything before now, and the framework had no way to say it.

## Why the obvious answer didn't fit

The first instinct was to mint new verbs. A `trim` method on the orchestrator, an `.autotrims` declaration on the builder, a `Store.trim` on the port. It would have worked, and it would have tripled the close surface for what is conceptually the same act of bookkeeping. Accounting closes periods, not just accounts. Once we said that sentence out loud, the rolling window stopped looking like a sibling feature and started looking like an optional boundary on the close we already had. The verb count stayed at one.

The second temptation came from the neighbors. Marten solves this exact problem with stream compacting: fold the state, write a synthesized `Compacted` event at the boundary, delete below it. That design has to rewrite history, and it has to fold state inside the storage operation, which means the store must understand reducers. We already had something better sitting in the log. A stream that snapshots itself via `.snap()` writes real `__snapshot__` events, and `load()` resets state at each one during replay, so everything below the latest snapshot contributes nothing to any load result. Deleting that prefix cannot change what anyone observes. The boundary did not need to be synthesized because the application had already written it. That observation turned the whole feature into a pure prefix delete, and it also produced the precondition: a state that never snapshots has nothing to prune behind, so the builder refuses `keep` until `.snap()` appears in the chain. The type system enforces it with a flag that `.snap()` flips, which reads oddly in the builder's type parameters until you realize it is the compile-time form of a sentence from the design review: a windowed close is meaningless without snapshots.

The third wrong turn was inherited rather than invented. The full close guards the head with a tombstone before archiving, because the whole stream is about to vanish and nothing may move while that happens. We almost carried the guard over. Then we worked out what the cutoff actually pins down: `before` is always in the past, so a snapshot written concurrently, stamped now, can never qualify as the boundary. Once the cutoff is fixed the boundary snapshot is fixed, the prefix below it is immutable, and appends land harmlessly at the head. The guard protected nothing. Consumer safety needed a different mechanism entirely, a cap probed from the subscriptions table so the boundary never rises past what the laggiest reaction has read. A lagging consumer degrades the prune to a smaller prune or a no-op, never to data loss, and the windowed close came out strictly lighter than the full one: no guard commit, no seed, no cache touch.

## The decision

Three optional fields, zero new methods. The `Store.truncate` target accepts `{ stream, before, max_id }` and answers with the surviving boundary snapshot in the `committed` slot where a full truncate reports its seed. `CloseTarget` accepts `before`, which routes `app.close` through a windowed branch that probes the minimum consumer watermark, runs the archive callback against the cutoff, and hands the boundary to the store. And the autoclose policy bag accepts `keep`:

```ts
const Ledger = state({ Ledger: schema })
  .init(init)
  .emits({ Posted })
  .on({ post: PostSchema }).emit("Posted")
  .snap((s) => s.patches >= 100)
  .autocloses({ keep: { days: 180 } })
  .build();
```

At runtime the same synthesized reaction that handles terminal autoclose evaluates the window. It reads the oldest surviving domain event, and when that event ages past `now − keep` it stages a windowed close through the same `CloseSignal` path; otherwise it parks itself until precisely the moment the tail will age out. There is no sweep and nothing runs hot. The window is denominated in days with a one-day floor, deliberately: close is low-cadence housekeeping, and a retention window you could express in minutes would be a misconfiguration wearing a type signature.

One consequence surfaced in the in-memory adapter and deserves its own confession. `InMemoryStore` had been assigning event ids from `_events.length` and starting its scans at array offsets, a pair of shortcuts that only hold while ids and indexes coincide. Windowed pruning deletes from the middle of the array on a stream that keeps living, which shattered that coincidence permanently. The adapter now carries a monotonic id counter and binary-searches its scan bounds. The shortcuts had actually been wrong since full truncate landed; the prune just made the latent bug impossible to ignore.

## What this teaches

When a feature request arrives shaped like a new verb, look for the invariant that makes it an option on an old one. The rolling window shipped as three optional fields because replay is snapshot-anchored, and that single load-path fact did all the heavy lifting: it made deletion safe, it chose the boundary, it justified dropping the guard, and it dictated the builder's type gate. The cheapest correctness argument is one the system already enforces for other reasons.

## Connections to other chapters

The close cycle this extends is the subject of the close-the-books essays around ACT-802 and the online policies from ACT-838 and ACT-1090, where the synthesized reaction and the defer mechanic were built. The snapshot anchoring that makes the prefix delete safe is the same property that ACT-1024 pinned with an executable behavior contract after the `with_snaps` regression. The archive-then-delete shape mirrors the cold-tier recipes under `recipes/scaling/archival/`, and the design ruling against new verbs echoes the ACT-1140 decision record: the framework grows by making existing surfaces more expressive, not by widening them.
