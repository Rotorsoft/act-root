# The gate that guarded three doors out of four

Act isolates sensitive event fields into a separate `pii` column and puts a gate
in front of every read that leaves the framework. The gate's own doc-comment is
blunt about what it is for: the external view never carries the isolated `pii`
sidecar, because dropping it is the whole point. A caller with no actor gets
`[REDACTED]` in place of every declared sensitive field, and the sidecar does not
ride along behind it.

That gate was wired onto `load`, `query`, and `query_array`. It was not wired
onto `drain`.

`app.drain()` returns a `Drain` object describing the cycle it just ran, and one
of its fields is `fetched` — the events each leased stream produced. Those come
straight out of the store, into the type, and back to whoever called drain,
without passing the gate. On a state with no `.discloses` policy at all, which
is the framework's own default-deny case, `app.query_array` returned
`email: "[REDACTED]"` while `app.drain().fetched[0].events[0]` returned
`pii: { email: "u@example.com" }`. On Postgres with encryption at rest it is
worse in an interesting way: the adapter decrypts the column on read, so the
value handed to the caller is plaintext that was ciphertext on disk a microsecond
earlier, and nothing in between re-gated it.

None of this needs a cast or a private field. `Fetch.events` is typed
`Committed[]`, and `Message.pii` is a public typed property. The leak is
reachable through the ordinary API with ordinary types.

What kept it from being obvious is that the *handler* path was always safe, and
the handler path is what anyone thinks about when they think about reactions.
Every reaction handler is wrapped with its own reader that removes sensitive keys
before the event reaches user code, and that wrapping has its own tests. So the
data flowing into the code an application author writes was correct all along.
The leak was in the value drain hands *back* — the bookkeeping return, the thing
you log or aggregate or assert on in a test. Whether it ever escaped a given
deployment depends on what the host did with a drain result, which is exactly the
kind of question a security boundary should not leave to chance.

There is a small design detail that made the fix a two-line change rather than a
one-line change, and it is worth understanding because it rules out the tempting
shortcut. The handler reader and the query gate do different things to the same
event. The gate *redacts*: it replaces each sensitive value with a placeholder so
a reader can see that a field exists and is withheld. The handler strip
*removes*: the key is simply gone, because a reaction handler has no business
knowing. So the obvious fix — gate the events where they are fetched, once,
before anything sees them — would have changed what handlers receive, replacing
absent keys with `[REDACTED]` strings. That is a different contract and would
have broken the handler tests, correctly.

The gate therefore belongs at the return boundary, where the cycle's results are
aggregated to hand back to the caller, and nowhere earlier. One of the tests
written for this fix asserts exactly that separation: the handler still sees
`{ plan: "pro" }`, keys removed, while the returned view sees
`{ email: "[REDACTED]", name: "[REDACTED]", plan: "pro" }` with no sidecar. Two
transformations of one event, for two audiences, and the bug was that only one of
them existed.

The pattern to carry forward is about enumeration. The gate was not subtly
wrong; it was absent from one member of a set, and nothing anywhere wrote the
set down. Two earlier bugs in the same family had already been fixed one at a
time — the actor-less query surfaces, then a store introspection method that
carried the sidecar on a single adapter — and each fix named "any other read
surface" as the remaining risk without enumerating what those were. A security
property that holds "on every read surface" is only as good as someone's list of
read surfaces, and `drain` was not on it because it does not look like a read.
It looks like an orchestration verb that happens to return what it saw.

Source: `libs/act/src/act.ts` (`_drain_all`, where cycle results are
aggregated), `libs/act/src/builders/event-builder.ts` (the two readers, gate and
strip), tests in `libs/act/test/read-gate.spec.ts`. Issue #1673, following
#1277 and #1294.
