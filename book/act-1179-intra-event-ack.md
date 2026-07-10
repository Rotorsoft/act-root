# ACT-1179 — The watermark that moved one reaction too soon

## The pain that started it

An architectural review went hunting for holes in the at-least-once guarantee and found one hiding in plain sight. When two reactions subscribe to the same event and share a target watermark, the dispatcher advanced that watermark after each successful handler rather than after each completed event. Let the first reaction succeed and the second throw, and the finalize rule saw partial progress, acked at exactly the failed event, and the fetch that runs strictly after the watermark never brought that event back. The second reaction had silently never run, while the error log insisted a retry was coming.

## Why the obvious answer didn't fit

The tempting patch was to stop acking when any error occurred in the pass. That breaks the case the code already handled correctly: when event one completes fully and event two fails, acking through event one is exactly right, and refusing to would rewind healthy progress on every hiccup. The unit of progress was simply wrong. A payload is one reaction's view of one event; the watermark's unit is the event. The other subtle trap was the retry counter. Acking resets it, so if a mid-group failure still produced an ack for its own event, a permanently broken second reaction would ride an infinite loop of partial passes, each one resetting the budget that was supposed to quarantine it, and `blockOnError` would never fire.

## The decision

The dispatcher now indexes the last payload belonging to each event id and advances the watermark only when that payload succeeds, which makes `handled` a count of completed events rather than completed handlers. A mid-group failure therefore finalizes with the watermark at the last fully completed event and no progress recorded for the broken one, so nothing is acked, the whole group redelivers, the already-successful reaction runs again exactly as the at-least-once contract promises, and the retry counter climbs toward the block it was always meant to reach. Single-reaction streams take the identical path they always took, which is why every one of the thousand existing tests passed unchanged. The new behavior-contract row pins the claim to three tests so the next refactor cannot quietly reintroduce the hole.

## What this teaches

When progress tracking and delivery guarantees share a variable, ask what the variable's unit is. The bug was not a missing try/catch or a race; it was an off-by-one level of granularity, invisible at every altitude except the one where two reactions meet one event. Reviews that read code against the guarantee, rather than against the tests that exist, are how that altitude gets visited.

## Connections to other chapters

The finalize trichotomy this slots into comes from the defer work in ACT-1090, and the behavior-contracts ledger that now pins it is ACT-1029's legacy. The sibling finding from the same review, the Postgres id-visibility gap of ACT-1178, is the same lesson one layer down: an ordering assumption that holds everywhere except where two writers meet one sequence.
