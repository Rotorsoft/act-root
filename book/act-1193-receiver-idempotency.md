# ACT-1193 — The dedup key that swallowed the delivery

## The pain that started it

A leaf-package scan went looking for the kind of bug that only shows up in the data, never in a log line, and found one in the webhook receiver. The idempotency contract had a single verb — `claim` — and the receiver called it the moment a request arrived, before the business handler ran a line. If the claim was fresh the handler ran; if it wasn't, the request was a duplicate and got a silent success. The whole design leaned on one unstated assumption: that recording the key and processing the event were the same event. They aren't.

Let the handler throw on a transient fault — a downstream timeout, a momentary 503 from the service it calls — and the receiver returned 500. Correct, so far. But the key was already claimed. The sender did exactly what a well-behaved sender does and retried under the same `Idempotency-Key`. This time the claim was not fresh, so the receiver treated the retry as a duplicate, skipped the handler, and answered 204. The sender saw success and stopped. The delivery was gone. Worse, the default dedup window is deliberately sized to outlast the sender's entire retry envelope — that sizing is what makes dedup correct in the happy case — so every retry landed inside the claimed window. One transient blip permanently dropped the event, and nothing anywhere said so.

## Why the obvious answer didn't fit

The first instinct is to run the handler first and record the key only after it succeeds. That closes the throw case and immediately reopens the one the original design got right: two copies of the same delivery arriving at once. Both would pass the "have I seen this key?" check before either recorded it, and both would run. The claim-before-handler ordering existed precisely to serialize that race. Removing it to fix data loss would trade a rare permanent drop for a rare double-process, which for a receiver that charges cards or opens incidents is not a trade at all.

The second instinct is to cache the first response and replay it on a duplicate. That needs a response store and a serialization contract the receiver deliberately refuses to carry — its standing convention is "ack the duplicate, do nothing else." And it doesn't even fix the throw: a cached 5xx replayed on retry is still a lost delivery.

The shape that actually fits is the one the framework already uses for streams. `Store.claim` there is a lease, not a commitment — a worker acquires the right to try, and the watermark only advances when it succeeds. The receiver's claim wanted the same two-phase life: reserve tentatively, confirm on outcome.

## The decision

`claim` stays, but its meaning narrows to a tentative reservation, and the contract grows two verbs to close it out. `commit(key)` promotes the reservation to a durable record so every later retry dedups; `release(key)` drops a still-tentative claim so the sender's retry re-processes. A tentative claim still returns `false` to a concurrent duplicate mid-flight, so the race the original design closed stays closed — the second caller serializes behind the first exactly as before. The only thing that changed is that a claim which never commits does not outlive the handler that made it.

The receiver builder, which owns the whole handler lifecycle, commits on success and releases on a throw. The wrapping adapters that see the downstream outcome — Hono and tRPC, which run `next()` and can read its result — finalize automatically: a 2xx or a resolved value commits, a 5xx or a thrown error releases. The middlewares that finish before the route handler runs — Express and Fastify — can't observe the outcome, so they hand the operator bound `commit` and `release` thunks and document the obligation. A finalizer that is called twice, or called on an already-deduped delivery, is inert, so an adapter that both auto-finalizes and exposes the thunks can never double-fire or let a duplicate release someone else's committed key. Skipping finalization entirely is the safe default: the claim simply expires on its TTL, deduping concurrent duplicates in the meantime and never permanently losing the delivery.

Because the in-memory store is the only in-tree implementation, the two sketch adapters in the integration guide — Redis and Postgres — grew the same two-phase shape, each guarding `release` so a committed key survives a late release. The `withIdempotency` helper on the generated-API side shared the exact bug through the exact same port, so it took the same fix in the same change.

## What this teaches

When one operation records a fact and another operation earns the right to record it, ask whether they are really the same operation. Here they had been fused into one verb, and the fusion was invisible until a handler failed between the two halves it was hiding. The lease pattern the framework already trusted for stream drain was the answer sitting one package over the whole time — reserve, then confirm, never commit on acquisition. The behavior-contract rows now pin the four halves of the guarantee to their tests, so the next person who reaches for "just record the key up front" finds a red suite instead of a silent data leak.

## Connections to other chapters

The lease-then-confirm instinct is the same one behind stream drain's watermark, which only advances on a successful ack — ACT-1179's intra-event ack fix is the same principle read at the orchestrator's altitude. The behavior-contracts ledger that pins this claim is ACT-1029's legacy, and the discipline of finding the bug by reading code against the guarantee rather than against the tests that exist is the review habit that also surfaced ACT-1178 and ACT-1179 in the same sweep.
