# ACT-101 — cross-process reactions and competing consumers

ACT-101 ships `Store.notify` (PG `LISTEN`/`NOTIFY` on a per-(schema,table) channel, auto-wired by the orchestrator) and a `notified` lifecycle event. Notes for the future "Scaling Act" chapter.

The framework's most natural deployment is single-process; everything else (multiple workers, read replicas, projection sidecars) inherits a brand-new class of concerns: cross-process coordination, competing consumers, topology choices. The book has to walk readers through this carefully — Act stays simple at the API surface, but the operational surface widens once you scale out. Weave these threads into the scaling chapter, after readers are comfortable with `do/settle/drain` in single-process. Use the Risk game examples (lots of dynamic projections per player) — natural fit for a multi-instance discussion.

---

### Threads to develop

**1. Why one process isn't enough.**
Frame the move from a single Act node to multiple as motivated by failure domains (uptime), throughput (more reactions/sec than one Node process can handle), and isolation (write path vs. projection path). Don't sell horizontal scaling as a default — many apps never need it.

**2. The cross-process latency problem.**
Single-process: `do()` arms drain locally, `settle()` runs reactions. Latency = work-time. Cross-process: the second node has no in-process signal. Without notify, it polls — `start_correlations` default = 10 s, common explicit poll loops = 50–500 ms. The polling interval becomes the floor on reaction latency. `Store.notify` is the bridge: PG's `LISTEN`/`NOTIFY` gives sub-millisecond wakeup so the second node responds as if it were local. See `PERFORMANCE.md` for the 3× → 1000× speedup band depending on poll interval.

**3. The auto-wire philosophy.**
Stress that the user does **nothing** to opt in. `act()...build()` checks for `store().notify` and wires it transparently. The story arc: "you wrote a single-process app; now run two of them — same code." This is a deliberate Act value: scale-out shouldn't require a code rewrite.

**4. Self-filter as a design pattern.**
Each PG store instance has a `_by` UUID. NOTIFY payloads carry it; the LISTEN handler skips payloads where `by === this._by`. This gives `notified` a clean cross-process semantic: "another writer did something." Call out the alternative (broadcast everything, let the consumer filter) as worse — it pollutes the local fast path with self-echoes and forces every listener to know about the filter.

**5. Competing consumers — the central scale-out concern.**
This is where the book has to slow down. Two or more processes running the same Act app against the same DB will all subscribe to the same projection target streams. Without coordination, they'd all run the same reaction for the same event — a duplicate side effect, or worse, a duplicated downstream commit.

Act's existing `claim()` primitive (uses `FOR UPDATE SKIP LOCKED` on the streams table) already solves this at the leasing layer: any single event on a target stream is leased by exactly one process at a time, so reactions don't double-fire. Notify changes nothing about that contract; it just lowers the wakeup latency.

What notify *does* change is the surface for thundering-herd-style behavior: every subscribed process wakes on every cross-process commit. They race for the lease — only one wins per stream, the others see no work and go back to sleep. That's correct but introduces some redundant work (claim attempts that find nothing). Discuss tuning:

- Sleep `settle()` for short bursts of remote commits instead of every-notify wake — set a small debounce on `notified`.
- Partition target streams across processes via a hash if extreme contention shows up — Act doesn't ship this primitive yet, but it's a natural extension.

**6. Topology shapes.**
Three common topologies:
- **Fat single process**: simplest, no notify needed. Good up to ~10k events/sec on a modern box.
- **Symmetric workers**: N identical processes, all running the same reactions, sharing a DB. Notify wakes them all; competing consumers via `claim()` ensures exactly-once-per-event per logical reaction. Easy to scale linearly until DB connection budget bites.
- **Specialized sidecars**: each process subscribes to a *subset* of reactions (e.g. one runs projections to ElasticSearch, another runs notifications to Slack). Notify wakes everyone but only the relevant subscriber does work. Scaling unit = the one subscriber doing the heavy work.

For the Risk game: a single process is plenty for a friendly game. A scaled tournament would lean to symmetric workers (the projection updates per turn dominate). A multi-game server might run specialized sidecars (game state vs. analytics vs. notifications).

**7. Connection budgeting.**
Each LISTEN subscription holds one PG client for the lifetime of the process. Multiply by N processes to size the pool. Mention this as the practical limit on horizontal scale-out — at 100 processes, you've burned 100 connections just for the wakeup signal.

**8. Hint, not contract — graceful degradation.**
Lost notifications fall back to the existing poll/debounce path. So users can run notify as the happy-path optimization while keeping the polling safety net for resilience. Frame this as a defining Act trait: every optimization is a hint that the framework is allowed to lose, not a contract that breaks correctness.

---

**Connections to existing chapters/notes:**
- `advanced-features.md` — settle, drain are prerequisites.
- `chapter-tools.md` — Inspector should surface `notified` events live (operational visibility for cross-process activity).
- "Risk tournament" example: natural place to introduce competing consumers via tournament-server scale-out.
