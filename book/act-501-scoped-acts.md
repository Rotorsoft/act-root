# ACT-501 — per-Act scoped ports (multi-tenant)

For the scaling/operations chapter (late in the book, alongside cross-process reactions and priority lanes).

**The core point:** running N Acts in one process is a real operational scenario — multi-tenant SaaS where tenants are numerous and lightweight, parallel test workers, hybrid storage per bounded context, side-by-side A/B store experiments. Act's 1.0 answer is `ActOptions.scoped: { store, cache }` — a bootstrap-layer composition primitive. The operator constructs whatever store + cache instances fit the scenario; the framework threads them via `AsyncLocalStorage` so internal `store()`/`cache()` calls resolve transparently.

**Canonical pattern — shared builder, one build per tenant.** Hold the builder in a constant, call `.build({ scoped: ... })` once per tenant. The builder is reusable: first call does the one-time projection merge + deprecation scan; subsequent calls reuse the merged registry to produce independent Acts.

```ts
// Per-tenant Postgres schema, dedicated cache, single shared process.
// Builder constructed once; each build() produces an independent Act.
const tenantBuilder = act()
  .withState(Order)
  .withProjection(OrderProjection)
  .on("OrderPlaced").do(reduceInventory).to("inventory");

const apps = new Map<string, ReturnType<typeof tenantBuilder.build>>();
for (const tenant of tenants) {
  apps.set(
    tenant,
    tenantBuilder.build({
      scoped: {
        store: new PostgresStore({ schema: tenant }),
        cache: new InMemoryCache({ maxSize: 5000 }),
      },
    })
  );
}

// New tenants can be added later by calling .build() again.
```

Worth calling out in the chapter: the per-Act mutable state (drain controller, correlate cycle, settle loop, notify subscription, lifecycle emitter) is *intentionally* per-Act — collapsing those into one shared instance would mean one drain throttle for all tenants, which is rarely what operators want. What's actually shared by reference across all N Acts is the read-only blueprint (registry, states map, batch handlers, deprecation set).

**Use cases to feature in the chapter:**

1. **Multi-tenant SaaS.** Each tenant gets a dedicated store (per-schema `PostgresStore` on a shared cluster, or one DB per tenant) and a dedicated cache. Application code stays singleton-style — no parameter threading — because internals read `store()`/`cache()` and the ALS context dispatches to the right tenant on every call. Pool sharing happens at the adapter level (each `PostgresStore` instance owns its pool, or you compose your own pool injection); the framework doesn't dictate.
2. **Parallel test workers.** Each test (or each worker) builds its own Act with fresh `InMemoryStore` + `InMemoryCache`. Concurrent test bodies don't leak through a process-global singleton.
3. **Hybrid storage per bounded context.** A monolith where "orders" lives in Postgres but "audit" lives in SQLite (or vice versa). Each bounded context gets its own Act bound to its own backing store.
4. **Side-by-side experiments.** Old store and candidate store running in the same process, fed by the same input traffic, to compare correctness or performance under live load.

**Why bootstrap-layer composition, not adapter-level scoping:**

The chapter should call out that the framework explicitly rejected an adapter-level `Store.scope(name)` API (the obvious alternative). Reasons:

- **Operator gets to choose the isolation strategy.** Per-schema, per-database, per-instance, per-adapter — these are all valid and trade off cost vs. blast-radius vs. ops complexity. Baking one into the adapter API picks for the operator.
- **Adapters stay simple.** No `_fqt`/`_fqs`/`_channel` plumbing, no sub-instance lifecycle asymmetries (`dispose` no-ops on views, `drop` scope-local), no validation regexes for table-name-safe scope strings.
- **Cross-cutting concerns belong at the boundary.** AsyncLocalStorage already exists for exactly this — passing implicit context through async call trees. The framework absorbs the threading; the user passes a bag.

**Why both store AND cache are required together:**

If the design let the operator share a cache across distinct stores (singleton cache, scoped stores), the cache's stream-keyed entries would collide — `order-1` in tenant_a and `order-1` in tenant_b would silently overwrite each other's snapshots. Making `Scoped` require both is the framework's way of refusing that footgun.

**AsyncLocalStorage as the technique:**

A sidebar/aside is worth writing. ALS is a Node primitive for threading values through async call trees — like a function argument promoted into the runtime. `als.run(value, fn)` binds; `als.getStore()` reads. The value propagates through every `await`, every microtask, every timer that descends from the `.run()` call. This is the property that makes the design work: a public `app.do()` call wraps its body in `scoped.run(bag, body)`, and every internal `store()` lookup the body triggers — including those across `await` points and inside reaction handlers that call back into `app.do()` — sees the right bag.

The book's mental model: port singleton = global variable (one value for all callers). ALS = function argument promoted into the runtime (value depends on which call-tree you're in, so parallel trees can see different values). They cooperate: `store()` checks ALS first, falls through to singleton — singleton is the default ergonomic path, ALS is the opt-in escape hatch.

**Anti-patterns to call out:**

- **Don't pass a shared `InMemoryCache` to two scoped Acts.** Defeats the point — TypeScript forbids it via the required-both contract, but operators sometimes try to work around the type.
- **Don't use scope to work around missing tenant identity in your domain.** If "tenant" is a first-class concept of your data model, it might belong in the stream name and the aggregate state, not just at the infra layer. Scoping is about *infrastructure isolation*, not domain modeling.
- **Don't expect the framework to dispose your scoped adapters.** They aren't registered with `dispose()` — the operator owns the lifecycle. Wire a `dispose()` callback that tears them down explicitly if you need shutdown ordering.

**Performance angle (rounds out the chapter):**

ALS overhead is essentially zero in modern Node (~65 ns per `store()` getter read, scoped or not). End-to-end `app.do()` and `app.load()` show no measurable difference between scoped and unscoped Acts. The bench evidence is in `libs/act/PERFORMANCE.md` and the bench file `libs/act/bench/scope-overhead.micro.bench.ts` — worth referencing as proof that the abstraction is free.

**Future direction (sidebar or footnote):**

A follow-up ticket explores collapsing the port-singleton Map and the ALS overlay into a single mechanism (one ALS-held "default scope," no Map fallback). The tradeoff is build-time-snapshotting vs. live-reading the default — affects test patterns that `dispose()() + reseed` mid-suite. Probably worth mentioning in the chapter as "the design is still evolving" rather than going deep on it.
