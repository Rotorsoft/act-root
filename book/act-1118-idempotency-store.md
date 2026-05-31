# ACT-1118 — naming a port that's almost a Cache (but isn't)

## What this ticket actually closes

[ACT-603](./act-603-external-integration.md) shipped the *story* — inline vs forwarded, the receiver-side idempotency contract, the TTL math. The cache itself was demo code under `packages/server/`. A reader who liked the contract had to copy a class out of an example app and rename it into their service. That's not how a contract ships; that's how a pattern ships.

ACT-1118 promotes the contract to a port: `IdempotencyStore.claim(key, now?) → boolean | Promise<boolean>`. Drops a reference implementation next to it: `InMemoryIdempotencyStore`, lifted from the demo with the class renamed and the method renamed to match the framework's existing `Store.claim` vocabulary (the demo had it as `recordIfFresh`). Both ship from `@rotorsoft/act-ops`, the zero-`act`-dependency lib bootstrapped by [ACT-1117](https://github.com/Rotorsoft/act-root/issues/745) for exactly this kind of cross-cutting operational primitive.

It's a small ticket. The implementation is sixty lines. The reasoning is most of why the ticket exists.

## The naming question that took longer than the code

`Cache` was the first instinct. The demo class was called `IdempotencyCache`. The doc colloquially called these "cache shapes." Every Redis tutorial that shows `SET NX EX` calls it a cache. The name had two years of momentum behind it.

The thing it stores, though, isn't cache-shaped. In this codebase `Cache` has a specific meaning: *rebuildable from a source of truth*. The snapshot cache is the canonical case — lose it and you replay events from the store. Cost is a cold-load latency spike, not a correctness bug. The reaction's authoritative state lives in the event log; the cache is just a fast path.

Dedup state isn't that. There *is* no source of truth to replay from. The sender doesn't know you've already processed key `X`; it'll cheerfully retry and your receiver will cheerfully run the side effect a second time. Losing a dedup record causes a *duplicate side effect* — pay the same invoice twice, send the same email twice, open the same incident twice. That's a correctness bug, not a rebuild cost. The dedup record is authoritative. There's nothing to "rebuild" it from.

`Store` is the codebase's word for "authoritative state." The event store is the canonical case; the snapshot cache is its rebuildable shadow. By that taxonomy the dedup primitive is straightforwardly a Store. So `IdempotencyStore`.

The naming choice has a practical consequence. When an operator picks an implementation — say, swapping the in-memory reference impl for Redis at production deploy time — they should be picking on the load-bearing property: *persistence*. Redis `SET NX EX` qualifies because the data survives the consuming process. A genuinely volatile cache (TTL too short relative to retry envelope, or worse, an unbounded LRU that evicts a hot key in the middle of a retry burst) is *unsafe*, not just *suboptimal*. The taxonomy makes that legible. A "Cache" tolerates eviction by definition; a "Store" doesn't.

This is the kind of naming decision that's tempting to fast-forward through in code review. The compiler doesn't care; the tests don't care; the runtime behavior of `claim` is identical either way. Future ports and future ports of *those* ports do care: every operator who reads `IdempotencyStore` should already know, before they look at the API, what the failure mode of losing data is.

## The method name, and why it's `claim` and not anything else

The demo code called the operation `recordIfFresh(key) → boolean`. That name is descriptive — you can read it cold — but it's twelve characters and not in anyone's vocabulary outside this codebase. Promoting it into a public port was the moment to ask: is there a shorter, established name for *atomic acquire-or-fail of a contested slot*?

The first pass through the candidates was unproductive. The Java/Spring convention is `putIfAbsent` / `setIfAbsent` — three words, weaker domain framing (the operator has to remember that "absent" means "fresh"). Memcached uses `add`, which is ambiguous about what success means. Redis exposes `SET NX EX`, which isn't a method-shape at all. Rust's `try_*` prefix (`try_insert`, `try_lock`) is cleaner — every reader knows `try_*` returns a boolean — but importing a generic convention when a domain-specific verb is available is a downgrade in clarity, not an upgrade.

The domain-specific verb was already in the codebase, sitting in plain sight: `Store.claim`. Drain calls `store.claim(opts)` to atomically lease N streams for processing; competing workers race for the right to drain a stream, and the loser gets nothing. That's *the exact same shape* as the idempotency operation. Different resource (stream vs request key), identical action: atomic acquire of a contested slot, with at most one winner.

There's no inheritance involved. `Store` and `IdempotencyStore` are unrelated interfaces; no class implements both. So when both interfaces expose a method called `claim`, there's no conflict — there's just *vocabulary alignment*. A reader who's learned what `Store.claim` does has already learned what `IdempotencyStore.claim` does, modulo the swapped resource. That's free communication. It also teaches Act's mental model: "atomic acquire of a contested resource" is a shape the framework names consistently, regardless of which port you're holding.

The rejection cycle that led here was instructive. The first proposal (`record_if_fresh`, sixteen characters, snake-case per CLAUDE.md) was technically correct under the framework's naming rule for multi-word public-API methods. It was also six characters wasted and a verb nobody outside the codebase uses. The second proposal (`mark`, four characters, no precedent in Act) compressed but lost domain-grounding — "mark this key" is passive and abstract; the operation isn't labeling, it's *taking ownership*. The `try_*` family did better but imported a foreign convention. Only `claim` actually fit: it was the right semantic, it was already in the codebase's working vocabulary, and it required zero explanation in any sentence that already established the operation's atomic-acquire shape.

The lesson is small but worth foregrounding. When a primitive's action shape matches one the framework already names, reuse the verb. The shorter form falls out for free, the documentation collapses (the docstring for `IdempotencyStore.claim` is half the length of the docstring for `Store.claim`, because half the explanation is "see Store.claim"), and the framework teaches its own vocabulary more cleanly. The aesthetic loss — that two different ports both have a `claim` method, which momentarily looks like ambiguity — is actually the point: the verb describes the action, not the resource. That's how all the framework's port methods work (`commit`, `notify`, `subscribe`, `query` — all of them name actions that recur across contexts). `claim` joins the club.

## Why a separate package, not `libs/act`

The dedup contract gets consumed by receivers. Some of those receivers are Act apps — the wolfdesk webhook-receiver demo is one. Many won't be. The forwarded-shape integrations in ACT-603 explicitly anticipate a non-Act consumer: a Kafka topic with a worker that processes events from a bus, no event store of its own, no orchestrator running, no `app.do()` calls. That worker still has to honor `Idempotency-Key`. The contract has to be reachable from there.

Putting `IdempotencyStore` in `libs/act` would force every receiver to pull in the orchestrator just to call `claim`. That's a tax of tens of kilobytes plus the conceptual overhead of "wait, do I need an event store?" — for a service that doesn't. Bad shape.

The alternative `libs/act-http` was considered and dropped. `act-http` already owns the *outbound* webhook helper (the sender side that sets `Idempotency-Key`), and one might argue the receiver-side port belongs alongside its mirror. But durable adapters of the port — Postgres, Redis, future ones — have nothing to do with HTTP. A Kafka receiver wouldn't depend on `act-http` just to get the dedup port. Putting the port in `act-http` would mean either: (a) every durable adapter pulls in HTTP plumbing it doesn't need, or (b) the port lives in *both* packages with weird re-exports. Neither shape is good.

So `@rotorsoft/act-ops` — a deliberately broad name, scoped for future cross-cutting operational primitives that share the same "non-Act apps want this too" property. The next two siblings already line up: `computeMinSafeTtl` (the TTL math from ACT-603, finally as a helper instead of a prose paragraph) and the retry-budget classifiers that ACT-601 hinted at. All of them are math, not orchestration. None of them need `@rotorsoft/act` at runtime. The package is the home.

The load-bearing constraint shows up as a one-line grep in CI: no `@rotorsoft/act` import anywhere in `libs/act-ops/`. The package's bootstrap PR ([ACT-1117](https://github.com/Rotorsoft/act-root/issues/745)) called this out explicitly; this ticket is the first to actually pay the constraint off.

## The sync-or-async return type, and why it isn't a Promise

The port signature is `claim(key: string, now?: number): boolean | Promise<boolean>`. Not `Promise<boolean>`. The union return.

The first instinct here is to always `Promise<boolean>` and force every implementation to be async. It's the conventional shape: durable adapters need to be async (they wait on I/O), and a sync in-memory impl that "returns immediately" still works under `await` — `await` on a non-Promise resolves synchronously, same microtask. Why not just standardize on Promise?

Two reasons. The first is observable in benchmarks: an `await` on a synchronous-returned value is not free. The microtask scheduling has a real cost (~100ns on V8), measurable across the millions of webhooks an active receiver processes daily. The in-memory store is the right answer for single-process receivers — the bench should reflect what it actually costs to use. Forcing it to be async would erase the speed advantage that motivated picking the in-memory impl in the first place.

The second is taste, but it's a load-bearing taste. `Promise<boolean>` says "this might do I/O." That's a lie for the in-memory impl. The contract should describe what implementations *actually* return, not paper over the difference to make the call site marginally simpler. Consumers that need to be polymorphic across implementations can write `await store.claim(key)` and TypeScript narrows the union for them. Consumers that know they have the in-memory impl can omit the `await` and pay no microtask cost. Both shapes are correct.

This is the same trade-off the Store interface makes (`commit` returns `Promise<Committed[]>` everywhere because it's *always* I/O; `claim` doesn't because it isn't always). Once you've named the property — "the in-memory impl is sync, the durable ones are async, the type system says so" — the union-return decision falls out.

## The defensive branch that has to die

There's a single-line cleanup in the in-memory implementation that wouldn't be worth mentioning except that it's why this code moves into `libs/` and not into `packages/` again. The pre-existing class had:

```ts
if (this.seen.size > this.maxEntries) {
  const oldest = this.seen.keys().next().value;
  if (oldest !== undefined) this.seen.delete(oldest);
}
```

The outer guard is meaningful: we just `set` a key, so size is at least 1, and we only enter the branch when size *exceeds* `maxEntries`. The inner guard (`if (oldest !== undefined)`) is satisfying TypeScript's type system, not protecting against a runtime case. By construction the map has at least one entry, so `.keys().next().value` is a string; `undefined` is impossible.

In `packages/server` the inner guard doesn't matter. The package isn't under the 100%-coverage gate; nobody is going to write a test that hits the `if (oldest !== undefined)` false branch because it's unreachable. The guard quietly costs no one anything.

In `libs/`, it does matter. The 100%-coverage rule says: every branch gets covered, or the branch dies. There's no way to cover the false case without mutating private state, and a test that mutates private state to prove an unreachable branch is unreachable would be parodically bad. So the guard goes. The cleanup makes the code one line shorter and exactly as correct. A non-null assertion (`as string`) replaces the runtime check, with an inline comment explaining why the assertion holds.

This is a small example of a bigger pattern. The 100%-coverage rule isn't really about coverage. It's a forcing function for *removing unreachable code*. Every defensive branch the rule catches is an opportunity to either prove a contract more cleanly or admit that the runtime can do something the author wasn't expecting. The in-memory impl falls in the first bucket. After the move, the construction-by-design property ("size > 0 when we enter the branch") is documented at the call site instead of hidden behind a vestigial null check.

The book chapter on "what's special about Act's libs" should foreground this. It's the cleanest example of how a small library guarantee — every branch is reachable, or it doesn't exist — propagates into clearer code. Most of the codebase is already there; the parts that aren't get fixed during PRs like this one.

## The migration story, and why nothing changes at the call site

The wolfdesk demo's webhook-receiver imports `IdempotencyCache` today. After this ticket it imports `InMemoryIdempotencyStore`. The class renamed; the constructor signature is identical; the one used method (`claim`) is identical. The diff in `webhook-receiver.ts` is a one-import change and a `cache` → `dedup` variable rename. That's all.

This matters because the contract was correct on day one. The shape that emerged from the demo was the shape the port wants. The ticket didn't need to *design* anything — it needed to *promote* something. The work was in the doc (renaming, scoping, getting the API surface right) and in the move (extracting the class, dropping the defensive branch, wiring the workspace dep).

A different ticket would have looked at the same code and decided to redesign. Maybe split `claim` into `has` + `put` for "flexibility." Maybe make it generic over the value type so callers can store metadata alongside the key. Maybe add an `options` bag for per-call TTL overrides. Each of those changes would have been a defensible local optimization and a globally worse design — more surface to maintain, more decisions at the call site, no real demand from any consumer. The contract stays small. One method. One return. The reason it stays small is that nobody has asked for it to be bigger.

The follow-ups are named (PostgresIdempotencyStore in `act-pg`, idempotencyTck in `act-tck`) and explicitly *deferred* to milestone 1.2. The port should bake one release before durable adapters land. If a Postgres user shows up tomorrow with the working `INSERT … ON CONFLICT` shape from ACT-603's doc and asks for it to be the official impl, that's a conversation for then, not a chunk to negotiate here.

## What this unblocks

The framework-agnostic middleware in [ACT-1116](https://github.com/Rotorsoft/act-root/issues/744) consumes `IdempotencyStore`. It can't ship until the port exists. The middleware's job is to fold the port into a `(checkIdempotency, next)` shape that any HTTP framework can adapt — tRPC, Express, Fastify, Hono. Each adapter is fifteen lines wrapping the port-aware core. None of them need to know what implementation is behind the port.

That's the payoff. The receiver-side idempotency story from ACT-603 — the one with three cache shapes and a contract — has been waiting two releases for a port. With the port in, every piece of the story collapses into a single import: `InMemoryIdempotencyStore` from `@rotorsoft/act-ops` for the in-memory case, `(future) PostgresIdempotencyStore` from `@rotorsoft/act-pg`, `(future) RedisIdempotencyStore` from wherever. The doc stops describing patterns to copy and starts describing libraries to install.

The book chapter on integrations should close on this transition. Pattern-to-library is one of the strongest signals that a framework is maturing. It's also the kind of move that's only legible after the *second* ticket — the one where the port is consumed, not just declared. ACT-1116 is the consumption ticket. ACT-1118 is the precondition. Worth showing both essays together once they've shipped.
