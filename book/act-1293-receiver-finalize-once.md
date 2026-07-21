# ACT-1293 — the finalizer that fired twice because two layers both owned it

The inbound receiver has a two-phase idempotency contract. When a webhook arrives, `checkWebhook` makes a *tentative* claim on its `Idempotency-Key`. Then exactly one of two things must happen once the business handler resolves: `commit` promotes the claim to a durable record so later retries dedup, or `release` drops it so the sender's retry re-processes. The whole point of splitting commit out of claim (#1193) is that a handler which throws leaves the key *not* committed, so the retry isn't silently deduped into a lost delivery.

`@rotorsoft/act-ops` even ships a guard for the obvious hazard. `make_finalizers` returns `commit`/`release` closures over a `settled` flag: the first one to fire flips `settled`, and every later call is a no-op. Its doc comment states the guarantee plainly — "an adapter that both auto-finalizes and lets the operator call `commit()`/`release()` can't double-fire." The mechanism to prevent double-finalization already existed and was already correct.

The receiver managed to double-finalize anyway, by not using it.

`receiver()` mounts the Hono `webhookMiddleware`, and that middleware auto-finalizes: after `await next()` it runs `if (status >= 500) release() else commit()`, through the guarded finalizers it stashed on the context. But the route handler `start.ts` mounts *inside* that middleware finalized too — and it reached past the finalizers to the raw store, calling `options.store.commit(key)` on success and `options.store.release(key)` on failure directly. So every delivery finalized twice: once by the route against the raw store, once by the middleware against the guarded closures. The `settled` flag guards the closures, but the route never touched them, so it sailed straight past the guard.

For a success this is inert — committing an already-committed key twice is harmless. The failure path is where it bites. `release` on the in-memory store *deletes* the tentative entry (`if (entry && !entry.committed) this._seen.delete(key)`). Picture delivery A failing: A's route releases the key, then a retry B arrives and re-claims it, and *then* A's middleware runs its second, stale release — which deletes B's live in-flight claim. Now a third delivery C for the same logical event isn't deduped, and the handler runs twice for one delivery. The exactly-once property the whole idempotency layer sells quietly breaks, and only under a concurrent re-claim window that no test happened to open — the existing suite never asserted finalize *counts*, so two commits looked identical to one.

---

**The wrong turn: drop the middleware's auto-finalize on the receiver path.**

The tempting fix is to notice that the route already finalizes, so the middleware's post-`next()` finalize is redundant on this path — delete it there and keep the route's explicit calls. It works, but it's the larger blast radius and it points the wrong way. `webhookMiddleware` is also exported standalone for hosts who compose their own Hono app around it; its auto-finalize is the contract *that* audience relies on. Carving a special case into the middleware to accommodate one caller that duplicated its work is fixing the shared thing to paper over the local mistake.

The route is the layer that overstepped, so the route is the layer that yields. It already has the guarded finalizers sitting on the context (`c.get("idempotency")` carries `commit`/`release`, not just `key`/`deduped`) — the fix is to call *those* instead of the raw store. The `settled` guard then does exactly what it was written to do: the route's `commit`/`release` settles the claim, and the middleware's later auto-finalize is a no-op. One store call per delivery, the standalone middleware untouched, and the guard finally guarding the case it names in its own doc comment.

The rule worth keeping: when a shared helper ships a guard against double-firing, the guard only works if every path finalizes *through* it. A callsite that reaches around the helper to the underlying store doesn't just skip a convenience — it opts out of the invariant the helper exists to hold.

See `libs/act-http/src/receiver/start.ts`, `libs/act-http/src/receiver/finalize.ts` (`make_finalizers`), and [#1293](https://github.com/Rotorsoft/act-root/issues/1293).
