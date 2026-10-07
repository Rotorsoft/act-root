# Learnings

What building Act has taught, as rules to check a design or a fix against. Read it before proposing anything. These are evidence, not law: an entry, or the decision it records, can be challenged when the reasons behind it no longer hold, and a challenge that wins replaces the entry. Each entry is a rule and the evidence (ticket or PR). Keep it under 150 lines: the retrospective merges duplicates, drops what stopped being true, and promotes a rule that keeps recurring into a ground rule or a smell in `lenses.md`. Add an entry only when a change taught something not already here.

## Design

- Look for the invariant that turns a new verb into an option on an old one. (#1011: rolling-window close shipped as three optional fields because replay is snapshot-anchored)
- Check whether a recovery path already exists and whether the defect is the promise, before building machinery. A fix that needs a second mechanism to undo its own side effect is the wrong design. (#1795 closed for the doc fix #1801)
- A background path that repeats a foreground path drifts, because nothing exercises it. Make it trigger the foreground path. (#1804: polling marked work and never drained)
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
- A lease is mutual exclusion for one attempt; pacing across attempts is a separate, persisted schedule. Don't overload a primitive because it resembles what you need. (#1262)
- Reserve, then confirm: never record success on acquisition. (#1193)
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
- A window that one-based ids happened to paper over should be removed, not propagated. (#1446)

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
- A test whose verdict depends on the machine it runs on teaches people to ignore red. (#1443)
- Trust boundaries pool around user code; enforce the contract the user already declared (opt-in when it costs). (#1238)
- Type quality is judged at the weakest boundary; prefer generics with defaults, and the widest true type over a cast. (#1185)
- Making the test seam the API can be the right call. (#402: `act -q`)
- Benchmark on real adapters; InMemory understates every win. (#102)

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

- Process steps are a cost on every change; each must have caught something to keep its place. Per-ticket narrative essays were dropped for this file. (2026-10)
- Ticket numbers belong in git and here, not in code comments or test names.
