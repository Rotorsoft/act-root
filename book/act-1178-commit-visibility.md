# ACT-1178 — The gap between assigned and visible

## The pain that started it

An architectural review asked an uncomfortable question of the Postgres adapter: what guarantees that event ids become visible in the order they were assigned? The answer was nothing. A serial id is handed out at INSERT and the row appears at COMMIT, and between those two moments another transaction can insert a higher id and commit first. Every watermark consumer in the framework, the claim probe, the fetch cursor, the correlate checkpoint, quietly assumed the two orders coincide. Under concurrent writes to different streams, a drain could ack past an id that did not exist yet, and when the slower transaction finally surfaced its event, the cursor that reads strictly after the watermark would never return it. Silent, permanent, and invisible to every test, because the in-memory reference store is synchronous and cannot produce the interleaving.

## Why the obvious answer didn't fit

The alluring fix was to leave the write path alone and fence the readers instead: compute a visibility horizon from the transaction snapshot and refuse to hand out events above the oldest in-flight append. That preserves concurrent commit throughput, and it is also a planner-hostile predicate threaded through every hot read the adapter has, from the claim CTE to the fetch to the stats queries, each one a new place for the horizon math to be subtly wrong. The other tempting answer was to declare the window small and the risk academic. The framework's own marketing argues against that: competing consumers and multi-worker drains are the load-bearing scaling story, which is precisely the load profile that widens the window.

## The decision

Serialize the append. Both `commit` and `truncate` now open their transaction by taking `pg_advisory_xact_lock` keyed on the events table, released automatically at COMMIT, so id assignment and visibility are linearized and the interleaving is impossible by construction rather than improbable by measurement. The same-stream case was never exposed, since the version unique index already serializes it; the lock extends that guarantee across streams. The bench recorded the bill honestly in `libs/act-pg/PERFORMANCE.md`: sequential commits lose about eighteen percent, and concurrent cross-stream commits collapse from roughly forty-five hundred per second to fourteen hundred, which is the fix doing its job, because visibility windows that must not overlap cannot also be parallel. Fourteen hundred is still several times the framework's realistic drain-inclusive pipeline rate, and correctness of at-least-once delivery is not a knob an operator should be able to trade away. A three-test spec pins the behavior with two raw connections interleaving real transactions, and the concurrency-model page now states the guarantee it silently depended on all along.

## What this teaches

Ordering assumptions are the hardest dependencies to see because they are satisfied by default in every environment too small to break them. The in-memory store could never violate id-order visibility, so the TCK could never catch the adapter that could. When a guarantee lives below the reach of the conformance kit, the review has to read the database's semantics against the consumer's assumptions directly, and the fix should make the bad interleaving unrepresentable instead of unlikely.

## Connections to other chapters

The sibling finding from the same review is ACT-1179, the same lesson one layer up, where two reactions met one event and the watermark moved a payload too early. The competing-consumers model this protects is the concurrency chapter's story, and the honest-bill accounting in PERFORMANCE.md follows the discipline set by the optimization essays since ACT-639.
