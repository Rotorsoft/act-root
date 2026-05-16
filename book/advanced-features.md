# Advanced features for later chapters

Advanced event sourcing features implemented in Act that should be covered in the book, especially Part IV.

**Close the Books** (`app.close()`) — Archive, tombstone, and truncate streams. Guard-first safety (commits tombstone with expectedVersion to block concurrent writes). Per-stream archive callbacks for exporting to cold storage. Atomic truncate + seed (snapshot for restart, tombstone for permanent close). Skips streams with pending reactions. Emits "closed" lifecycle event. Idempotent.

**Time-Travel Queries** (`app.load()` with `asOf`) — Load state at any historical point. Filters: `before` (event ID), `created_before` (timestamp), `created_after`, `limit`. Bypasses cache entirely, replays from scratch. Doesn't corrupt current cache state.

**Batched Projections** (`.batch()`) — Bulk event processing for projections with static targets. Discriminated union typing for exhaustive switch. 10-100x faster than per-event handlers on large volumes. Always called, even for single events.

**Settle Cycle** (`app.settle()`) — Non-blocking debounced correlate→drain loop. Emits "settled" lifecycle event. Configurable debounce window, max passes. Production-preferred over manual correlate/drain.

**Drain Optimization** — `_needs_drain` flag tracks whether reactive events were committed. Drain returns immediately when flag is false, saving 3 DB round-trips per non-reactive cycle. `_reactive_events` set built at build time.

**Correlation Optimization** — Static resolvers pre-subscribed at init. Dynamic resolvers scanned incrementally with watermark checkpoint. When no dynamic resolvers exist, correlate is skipped entirely in settle.

**Projection Rebuild** (`store().reset()`) — Reset watermarks to -1, next drain replays all events through updated handlers. Production workflow: deploy new code, clear read model, reset, drain.

**Lifecycle Events** — `committed`, `acked`, `blocked`, `settled`, `closed`. Full observability into the event processing pipeline.

**GDPR / Data Erasure** — NOT YET IMPLEMENTED. This is a gap. Event sourcing and GDPR create tension (immutable events vs right to erasure). Common patterns: crypto-shredding (encrypt PII per subject, delete key on erasure request), event redaction (replace PII fields with tombstone markers). The book should discuss the challenge and show how `close()` plus crypto-shredding could address it, even if Act doesn't have a built-in GDPR feature yet.

These features distinguish Act from toy ES frameworks. The book should show readers that Act handles real production concerns.

**Placement:**
- Ch 4: mention time-travel as a teaser
- Ch 5: batched projections, projection rebuild
- Ch 12: projection rebuild in production context
- Ch 14: deep dive on close the books, time-travel, settle/drain tuning, GDPR discussion, lifecycle events for monitoring
