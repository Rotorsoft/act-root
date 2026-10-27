# Learnings

What building Act has taught, as rules to check a design or a fix against. Read it before proposing anything. These are evidence, not law: an entry, or the decision it records, can be challenged when the reasons behind it no longer hold, and a challenge that wins replaces the entry. Each entry is a rule and the evidence (ticket or PR). Keep it under 150 lines: the retrospective merges duplicates, drops what stopped being true, and promotes a rule that keeps recurring into a ground rule or a smell in `lenses.md`. Add an entry only when a change taught something not already here.

## Design

- Look for the invariant that turns a new verb into an option on an old one. (#1011: rolling-window close shipped as three optional fields because replay is snapshot-anchored)
- Check whether a recovery path already exists and whether the defect is the promise, before building machinery. A fix that needs a second mechanism to undo its own side effect is the wrong design. (#1795 closed for the doc fix #1801)
- A background path that repeats a foreground path drifts, because nothing exercises it. Make it trigger the foreground path. (#1804: polling marked work and never drained; again in the defer timer, which only set a flag, 2026-10-08)
- When a capability is buried in one feature, re-express the feature as a use of a general primitive and delete the special machinery. (#1090: autoclose became a deferred reaction; its controller and ticker went away)
- Several features that look different can be one operation; find the shared verb before building separate guardrails. (#1128: backup, restore and transfer are all source → sink)
- Prefer declarations read by the orchestrator over new ports, columns or caller-side helpers. (#566: PII is a column plus `.sensitive`, three heavier designs rejected. Re-examined 2026-10-08: a `Store` decorator can't carry it, because gated reads and handler stripping need the schema markers and the actor; it stays in core.)
- Put the policy where the knowledge is: the author of a unit of work declares its retry profile; callers shouldn't. (#1111, #601)
- The call site is the spec. If the line doesn't read as plain English, the API isn't done, even when the types are right. (#1134)
- Packaging is a distribution choice, not a discipline. An expensive operator call can be an `IAct` method if it is never auto-invoked. (#723)
- Integration helpers live in their own package, scoped by shape (`act-http` is HTTP only). (#602)
- Small gaps left at ship time resolve better as targeted follow-ups than as an over-designed first version. (#602 → #604)
- The framework's job is narrow: express the declaration, route the data, gate the read, emit the lifecycle. Key management, encryption and compliance belong to the operator. (#566)
- Before promoting legacy code to a port, audit what it does by accident; accidents become contract. (#1124)
- A wakeup is a hint, never the truth: decorators that carry notifications must pass the full Store TCK unchanged. (#987)
- A field with two owners shows up as a rule in one layer and a guard in another that cancels it, and if the guard lives in a bounded memory, eviction breaks the rule. Before removing either owner, find why each exists: the store's re-lane on equal priority is how a restart applies an edited lane. (#1876, 2026-10-10)
- Probe every claim in a proposal, not only bug claims: of four interaction findings, one was a real bug, one proposed fix was wrong, and one count was off (9 → 7). (2026-10-10)
- Re-running a specialist's probe is not checking it: read its setup. A defer probe that "lost" 5 of 15 streams had only correlated 10 events, since one `app.correlate()` reads 10. (2026-10-11)
- A shared lease is sound only between interchangeable workers. Anything that narrows what a worker runs (`onlyLanes`) belongs in the lease key, or the holder does work for a lane it can't drain and the lane's own worker never wakes. (2026-10-10 review)
- Contain an error where it is raised, not where it lands. Classifying app errors at the breaker needed a new error class and a second breaker; a try/catch at each place app code runs (resolvers, archive callbacks) needed neither, and left the breaker untouched. When the new failure path needs a decision that already exists (retry or block), call it; #1913 copied `finalize` a third time. (#1913)

## State and invariants

- An invariant cannot live in a bounded memory (LRU, cache, set). The memory may cache the answer; durable state must own it. (#1599: lane forgotten on eviction; #1363)
- A dedup guarding a monotonic upgrade must store the value it dedups against, not a presence bit. (#1363)
- A value with two spellings (undefined vs "default", 0 vs no lease) has one meaning; every comparison must use the same spelling, on both operands. (#1598, #1647)
- One variable carrying two meanings is a latent bug; splitting them means finding every reader that relied on them being equal. (#1487: watermark meant seen and consumed)
- A counter is only as honest as what it is documented to count; a diagnostic prescribing an irrelevant remedy means it now counts two things. (#1592)
- Two representations of one fact (store vs cache, scope bag vs timer) drift where a background path or guard window separates them. Read code against the guarantee, not the tests. (#1188)
- A blueprint shared by reference is safe only while everything on it is inert; per-instance state must be minted per build. (#1369)
- Registries and observer lists that serve objects should hold them weakly. (#1441)
- A spread followed by an explicit re-list is an allow-list in disguise; ask what the spread silently decides. (#1645)
- A snapshot is a valid head only for the concurrency version; every domain decision must look past it. (#1356, #1374)
- A resume-from-checkpoint read must request everything that could rebaseline it (snapshots included). (#1345)
- A lease is mutual exclusion for one attempt; pacing across attempts is a separate, persisted schedule. Don't overload a primitive because it resembles what you need. (#1262; #1681 used the lease as the no-backoff retry timer, and #1872 then needed the last drain's options to keep that timing)
- Reserve, then confirm: never record success on acquisition. (#1193; again 2026-10-11: the defer timer dropped due entries before its drain ran, so streams the drain didn't reach were lost)
- A guard only holds if every path goes through it; a call site that reaches around a helper opts out of its invariant. (#1293)
- When two steps share a precondition and one consumes it, the consumer goes last. (#1296)
- Put the bound before the effect it bounds; otherwise the degenerate input (0) does the wrong thing. (#1600)
- A default right for external callers ("something reasonable") is wrong for internal ones ("everything"); internal walks must page explicitly. (#1371)
- A `catch` written for its first statements silently covers everything added later; re-derive the error policy when a try block grows. (#1373)
- Silence is a design decision: if data can be lost, make the loss visible. Keep the loss, add the signal. (#1646)
- Fix the question, not the heuristic: a rule that holds only when two things share a window will fail when they don't. (#1487)
- A trick that is cheap once (migration) can be a permanent tax as steady state; evaluate it against the right denominator. (#1488)
- Ordering assumptions are invisible in stores too small to break them; make the bad interleaving unrepresentable. (#1178)
- Progress tracking and delivery guarantees sharing a variable must agree on its unit (event vs reaction). (#1179)
- Derive defaults from relevant configuration, not new constants; and only from what is active now. (#1442, #1175)
- Distrust a guard that duplicates a condition already expressed downstream; it is usually narrower than the real rule. (#1445)
- Idle means nothing left to claim, not nothing succeeded. A pass whose claims all deferred or failed disarmed the drain and ended settle, so streams marked but never claimed waited for the next commit. (2026-10-15 probe: 5 of 12 reactions ran)
- A window that one-based ids happened to paper over should be removed, not propagated. (#1446)
- A loop added to a background path checks the stop flag on every turn: shutdown waits for the pass in flight, not the loop around it. (#1928's wake loop ran two handlers after `shutdown()` resolved, 2026-10-17)
- A stop flag checked at the top of a loop doesn't stop the pass already running, and shutdown's grace can run out mid-pass. Stop the work itself (a stopped drain claims nothing; a released lease stays released), and stop every scheduler before awaiting anything slow (a notify disposer). (#1973 left both, 2026-10-20 probes)
- A guard against a late reply must cover every reset of the state the reply writes, not only the reset that exposed it: #2025 dropped a renewal reply after shutdown's release, and `restart()` (a live restore) left the same window, so a stale scan wrote the old checkpoint into the restored store. Bump one epoch from every reset. (2026-10-20 probe)
- A race fix must cover every interleaving of the two operations' awaits (the reply before, during and after the other operation, and a pass that starts during it), not only the order the bug report showed. #2043 checked once after the scan and covered only a reply landing after the whole restore; the field's answer is to pause the other side: wait for the passes in flight, then reset. (2026-10-22 probes, InMemory and real Postgres)
- A read that narrows must not advance a position shared with readers who didn't: `app.correlate({ stream })` moved the one correlation checkpoint past every event its filter skipped, and those reactions never ran. A subscription's filter belongs to its definition, with its own checkpoint (KurrentDB, Marten); a shared checkpoint takes no per-call filter. (2026-10-23 probe)
- A test waits for an outcome, never for a time budget. A fixed sleep, a fixed number of correlate/drain passes, or a "not yet" check inside a real-clock window passes where it was written and fails on a stalled runner: a debounce race (#2098), ten fixed passes (#2118), three passes with a 50 ms lease (#2121), and six more found by injecting one stall (2026-10-25). Wait with `vi.waitFor` or loop until nothing is left; move a faked `Date` by hand for "not yet".
- A dedup keyed on a shared value can't tell "the same thing twice" from "two things that share a part": `merge.ts` skipped the duplicate-action check on schema identity, and two partials sharing `ZodEmpty` merged silently, one's rules with the other's handler. Key on the thing itself (the handler). (2026-10-25 probe)
- A check on the folded state only refuses if it runs before the append. Act commits, then folds, so `validateFoldedState` refuses a caller whose event is already stored, reactions run on it, and the stream then fails every load. The field folds first (Emmett's `handleCommand`, Axon's Unit of Work). Before calling a check a guard, find where it sits relative to the write. (2026-10-27 probe)
- A fake clock jump stands in for the lease or schedule it passes, not for the real-time timer behind it: a failed pass retries on a real 30 s timer, so after the jump nothing re-armed a lane that had disarmed. Name every wake the jump replaces and drive each one. (#2119, then #2153)
- Postgres advisory locks don't process catalog invalidations: a connection that looked a name up while it was missing trusts that stale entry after the lock, and `CREATE SCHEMA IF NOT EXISTS` fails with 23505. Read the catalog after taking the lock. (act-pg seed, 2026-10-20 probe)
- When a fix adds a stop check to one loop, grep for every loop in the same lifecycle: #1950 stopped the defer wake loop at shutdown, and settle's own pass loop, one file over, still ran 57 handlers after `shutdown()` resolved. (2026-10-18 probe)
- A safety-net timer must restart every stage that can go idle, not only the first: the `start_correlations` tick re-armed correlation, but lanes disarmed on an empty claim never claimed a dead worker's expired lease. (2026-10-18 probe)
- Several loops that feed one failure counter need the same recovery: #1928 made a failed drain pass retry and left a failed settle pass waiting for the breaker to open. Fix the class, then probe each loop.

## Contracts and tests

- A port is its interface plus its TCK; behavior the TCK doesn't pin is undefined. Optional methods are gated by capabilities. (#302)
- A conformance suite whose data lives in the overlap of the adapters can't find divergence. Feed adversarial inputs: zero, negative, empty, duplicates, mixed case. (#1182, #1600, #1672)
- A contract that holds across a matrix (adapter × option) belongs in the TCK, not in the adapter where the bug was found. (#1370, #1294)
- When a contract is disputed, the winner is what callers rely on, not the most expressive reading. (#1182, #1220)
- Name the distinction the data already contains before choosing one rule for two kinds of input. (#1220: literal vs pattern source)
- A doc comment, commit message or contract row is not evidence; the test is. Where a test covers only the half you edited, the bug is in the other half. (#1646)
- Watch a regression test fail before trusting it; a test written after the fix can point near the defect instead of at it. (#1647)
- Fixtures written through the raw store never produce what the framework produces (snapshots, tombstones); test through the framework too. (#1374)
- A convenience is a promise; an unexercised default decays into silent loss. Refuse a default you can't honor. (#1443)
- A test that skips by default is no contract. (#1441)
- A gate whose self-test checks only that something failed can pass for the wrong reason. The snippet check type-checked zero files for 2.5 months while its self-test passed on a missing-module error. (2026-10-08 review)
- A field list hand-copied into a doc comment drifts from its schema (`Act.query` listed `name`; the field is `names`); link the type instead. A hand-kept file list in a gate drifts when files move (`/release-check` missed the types #1959 moved); diff the artifact that already covers them. (2026-10-18)
- A type check can't see a rule enforced at build: 31 doc and skill examples passed `check:snippets` while passing arrow functions to `.do(...)`, which throws "must be a named function" when the app is built. (2026-10-15 review)
- A test whose verdict depends on the machine it runs on teaches people to ignore red. (#1443)
- Trust boundaries pool around user code; enforce the contract the user already declared (opt-in when it costs). (#1238)
- Type quality is judged at the weakest boundary; prefer generics with defaults, and the widest true type over a cast. (#1185)
- Making the test seam the API can be the right call. (#402: `act -q`)
- Benchmark on real adapters; InMemory understates every win. (#102)
- A performance mechanism serves a bench, not a contract row; "no row needs it" is no reason to remove it. Measure on a real adapter first. (#1923, closed)

## Hunting and fixing

- No finding ships without a red test and a control; then check it against the domain model. A red test that contradicts an invariant is a bug in the test. (debug-wave, #1254)
- In layered transports the status code is decided by the first layer to reject; validate where the error vocabulary lives. (#1295)
- A toolchain migration is usually blocked downstream of the thing migrated. (TS7: typedoc)

## Process

- A grep of this repo can't show who uses a published export. Never call an export "unused"; say what was searched, and don't deprecate public surface. (#1817)
- Estimate a comment cut by sampling first: stripping all history moved comments only 52% → 49%, because most comment volume is explanation. (#1820)
- Merging spec files without a shared fixture saves files, not lines. (#1821)
- A commit pushed after its PR merged is lost; check the PR is still open before pushing a follow-up. (#1816, #1819)
- A scripted comment rewrite can swallow code; diff the non-comment lines before trusting it. (#1820)
- Estimate lines saved after formatting: #2011 was simulated at −11 and shipped +15, because Biome spread the new six-argument call over many lines. (2026-10-20)
- Read a hook's config before obeying a doc's paraphrase of it: CLAUDE.md said subjects "must be lowercase"; commitlint only rejects a capitalized start, and six squash subjects lowercased type names for nothing. (2026-10-20)
- Measure prose in bytes, not lines: the CLAUDE.md trim cut 4 KB (9%) and left its line count at 333. (#1838, #1850)
- A proposal to delete a layer must name why the layer exists. `DrainOps` was proposed as a pass-through and turned out to be the trace seam, so it stayed. (#1841)
- A gate most PRs declare away protects nothing: the rfc-gate fired on comment edits because the stability snapshot copies all source, and 175 of 300 PRs carried an exemption. Fix what the gate measures before adding exemptions. (2026-10-08 review)
- Code the assistant writes into new apps (the scaffold skill) drifts like docs, and no check compiles it; two of its calls crashed. (2026-10-08 review)
- An entry point browser code imports must not import server code, dynamic imports included: a bundler builds a literal `import()` into its own chunk, and the browser build fails there. The gate assumed otherwise and passed for months; a downstream app's `vite build` found it. Remove the import rather than hide its path. (#2154)
- A downstream upgrade finds what in-repo CI can't: moving the Risk app from act 0.25 to 1.34 found the browser build failure, an adapter major that no longer fits `Store` (its tests ran in memory), and an act-sse patch release that dropped four methods. (2026-10-27)
- A change to a default or a timing breaks what nothing in CI runs. #1872 made a no-backoff retry wait 10 s; the gate passed, and the Prometheus recipe silently stopped blocking its poison stream, while three doc passages kept the old timing. Grep and run recipes and examples for the old behavior in the same PR. (2026-10-11 review)
- A test snapshot inside a published package releases that package on every change to it: 94 of 137 act-tck releases published identical code. Keep repo-wide gates out of published packages. (2026-10-10 review)
- When a mechanism is removed, grep for its name in comments, capability flags and docs in the same PR. Two months after `claim` stopped probing the event log (#1511), 14 comments still described the probe and the TCK still carried a flag that gated nothing. (#1864)
- A public method's inferred return type follows the private helpers it calls, so a return annotation on a module-private helper can loosen the public surface. Typing `InMemoryStream._lease` as `Lease` made `InMemoryStore.ack` return `lane?: string`; only the declaration snapshot showed it. (#2037)
- A declaration's doc comment is the JSDoc block directly above it: anything inserted between them (a type, a module-level helper) detaches it, and the published declaration ships with no doc. It happened to act-http's three generators (#2058) and again in a simulated patch for #2068. Read the declaration snapshot, which shows the doc missing.
- A getter over a private field is not trivial when it makes state read-only: TypeScript has no public-read, private-write field, so the getter is how a state-machine class keeps its state changed only through its methods. Don't propose stripping those getters as "guarding nothing"; follow standard TypeScript rules over line counts. (#2037)

- A cleanup that accepts "while you're here" redesigns grows: #2046 went from −2 to +44 source lines when breaker bookkeeping moved into correlate, whose double count then needed a flag. On a subtraction ticket, measure `git diff --shortstat` before accepting each suggestion, and brief a reviewer to judge the design, not only polish it. (#2046)
- A diagram drawn from the code is still prose about timing: the settle scene said the debounce restarts on each call because that is what "debounce" usually means; Act's joins the pass already scheduled. Draw timing from the scheduler's code, and add every place docs live (scenes, flow specs, skills) to the doc-audit list, or a behavior change leaves them stale the next day (#2092, #2084).
- A second layer added beside an existing one gets written through the first's helpers, or every layer grows a copy: #2115's `.requires` copied `.given`'s builder docs three times, its check loop in another style and its CLI lookups, and left two `@returns` describing the old chain.
- A check is a duplicate only if its other copy runs on every trigger the first did: docs-build runs the snippet self-test on `docs/**` changes, not on lockfile or TypeScript bumps, so ci-cd's copy stayed. (#2051)

- Process steps are a cost on every change; each must have caught something to keep its place. Per-ticket narrative essays were dropped for this file. (2026-10)
- Ticket numbers belong in git and here, not in code comments or test names.
