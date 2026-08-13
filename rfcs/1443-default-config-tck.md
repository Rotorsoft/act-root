# RFC 1443: `default_factory` — the TCK covers an adapter's own defaults

- **Status:** draft
- **Issue:** #1443
- **Author:** Rotorsoft
- **Created:** 2026-08-11

## Motivation

A zero-config `new SqliteStore()` defaulted to `file::memory:`. libSQL hands every *connection* a private in-memory database and does not pin statements to one connection, so `seed()`'s DDL landed in a database that later statements could not see. The result was the worst available failure shape: `commit()` returned a committed event, and the readback threw `no such table: events`. A second commit failed outright, and version numbering restarted.

The suite was green over it because every spec in `libs/act-sqlite/test/` constructs the store with an explicit `file:` URL. The configuration a first-time user gets — the one in the getting-started snippet, the dev server, the embedded deployment that never set `url` — was exercised nowhere, including by the store TCK.

That gap is not SQLite-specific. The TCK is what a third-party adapter runs to badge conformance, and it currently says nothing about the constructor a new user reaches for first. Any adapter whose defaults point somewhere unusable ships the same silent data loss with a passing TCK.

## Public surface added

- **Public type field** — `StoreTckOptions.default_factory` (`libs/act-tck/src/store-tck.ts`):

  ```ts
  export type StoreTckOptions = {
    readonly name: string;
    readonly factory: () => Store | Promise<Store>;
    readonly default_factory?: () => Store | Promise<Store>;
    readonly capabilities?: StoreCapabilities;
  };
  ```

Optional, so every existing adapter keeps passing unchanged. Supplying it opts into one new case, `default configuration → "either refuses to construct or round-trips a commit"`, which admits exactly two outcomes:

1. **Construction throws.** The adapter has no safe default and says so, at construction, before a caller can hand it data.
2. **Construction succeeds and the store round-trips** — seed, commit, a *second* commit that advances the version, and a readback that returns both events.

The third outcome — construction succeeds, `commit` reports success, the data is not there — is the one the case exists to outlaw.

The suite never calls `drop()` and namespaces its stream with `uid()`, so pointing `default_factory` at a default that resolves to a real shared database is safe.

In-tree wiring: `InMemoryStore` takes the round-trip branch (its default is its only configuration), `SqliteStore` takes the refusal branch. `PostgresStore` supplies nothing — its defaults point at `localhost:5432`, which is not the docker instance the TCK runs against, so the case would be testing the developer's machine rather than the adapter.

Also in this change, and outside the TCK: `SqliteConfig.url` loses its default and becomes genuinely required, in-memory URLs are normalized to libSQL's shared-cache form, and `cache=private` throws. See "Stability / charter impact".

## Alternatives considered

- **Do nothing beyond fixing SQLite's default.** Fixes the instance, leaves the class. The ticket's second ask is precisely that a TCK case "would have caught this on day one, and would catch the equivalent in any third-party adapter."
- **Run the entire TCK a second time against the default config.** Maximum coverage, roughly doubles per-adapter TCK wall time, and for an adapter that (correctly) refuses a default there is no store to run it against — the second pass would have to be conditional anyway.
- **A boolean capability (`zero_config: true`) instead of a factory.** The TCK would have to construct the store itself, which means knowing the constructor shape. A thunk is both smaller and more honest about what "the default" means for that adapter.
- **A required option rather than optional.** Would break every existing third-party adapter's compile on upgrade to make a point about a default they may not have.
- **Separate `default_factory` + `expects_rejection: boolean` flag.** An adapter would then have to declare *which* of the two valid outcomes it produces. That is a second thing to keep in sync with the code, for no extra guarantee: the contract being pinned is "loud refusal or working round-trip," and a disjunctive assertion states it directly.
- **Keeping a working in-memory default for SQLite** (`file::memory:?cache=shared`, the only in-memory URL libSQL round-trips). Rejected: shared cache is one database *per process*, shared by every store pointed at it, and it survives `dispose()`. That trades silent data loss for silent cross-talk between store instances — and `extension-points.md` already names `InMemoryStore` as the adapter for tests and single-process dev, so `SqliteStore` has no reason to default to memory at all. An explicit `:memory:` is still honored and normalized, because a caller who asks for it by name should get something that works.

## Stability / charter impact

Two categories are touched.

**Additive — `@rotorsoft/act-tck` public types.** `StoreTckOptions.default_factory` is a new optional field. No existing caller changes; no adapter loses conformance.

**Narrowed — `@rotorsoft/act-sqlite` adapter constructor, shipped as a `fix`.** `SqliteStore`'s parameter narrows from `Partial<SqliteConfig> = {}` to `SqliteConfig`, so `new SqliteStore()` stops compiling and throws `ValidationError` at runtime. Read strictly, a narrowed type is breaking. It ships as a patch anyway, on the same reasoning as [`feedback_charter_pre_adoption`](../CLAUDE.md#rules-for-contributing-to-this-repo): the surface being removed had no working callers to break. Every zero-config `SqliteStore` ever constructed accepted writes into a database the next statement could not see, so there is no behavior anyone can be depending on, and the change converts a runtime data-loss bug into a compile error.

The migration is one line for anyone who was on that path: `new SqliteStore({ url: "file:myapp.db" })`, or `{ url: ":memory:" }` for the shared in-memory database. The known cost of the patch categorization is that a consumer on a caret range picks the change up without a major-version signal; the error message carries the fix, which is what makes that acceptable here and would not make it acceptable for a surface that worked.

No port method is added, so `Store` / `Cache` / `Logger` and their adapters are untouched. `libs/act-tck/src/store-tck.ts` is itself the TCK update this change requires.

## Open questions

Whether `PostgresStore` should eventually supply a `default_factory` behind an env guard, so the "defaults point at a reachable database" claim is covered for the adapter most likely to be deployed from a copy-pasted snippet. Left out here — a case that passes or fails based on what is listening on `localhost:5432` is worse than no case.
