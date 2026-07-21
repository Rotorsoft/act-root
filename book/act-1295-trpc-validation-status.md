# ACT-1295 — where you validate decides the status code

The act-http package generates three transports from one Act registry — tRPC, Hono REST, and an OpenAPI document — and sells them on a single promise: a client talking to two of them "sees one shape for every framework error." The error table is mapped by identity through `toApiError`, so a `ConcurrencyError` is 412 everywhere, an `InvariantError` is 409 everywhere, a `ValidationError` is 422 everywhere. The whole point is that the transport is a thin skin over `app.do` and the error semantics don't leak through the skin.

They leaked through one seam: a malformed request body. On Hono, a body that fails the action's Zod schema returns `422 / VALIDATION` with the shared `ApiError` envelope — Hono's generator installs a custom `zValidator` hook precisely to funnel body-schema failures into the same 422 an in-`app.do` `ValidationError` produces. On tRPC, the same malformed body returned `400 BAD_REQUEST` carrying a raw ZodError, never touching `toApiError`. Same input, two statuses, two envelope shapes, on the most common client error there is — bad input. And nothing failed: each transport's own test asserted its own status in isolation, so the divergence sat in the gap between two green suites.

The cause is structural, and it's the interesting part. tRPC validates input in `.input(schema)`, which runs *before* the mutation resolver — and when that parse fails, tRPC throws its own `TRPCError({ code: 'BAD_REQUEST' })`. The generator's error mapping lives *inside* the resolver's try/catch, downstream of a failure that already short-circuited. The malformed body was rejected before the code that would have mapped it ever ran.

---

**The wrong turn: reshape the input error where it's thrown.**

The obvious fixes both aim at the `.input()` layer, and both are dead ends — which is worth recording, because they *look* right.

The first is an `errorFormatter` on `initTRPC.create({ ... })`. But `errorFormatter` reshapes the error *body*; the HTTP status is derived separately by the adapter from `error.code` via `getHTTPStatusCodeFromError`. A formatter can make the envelope look like `ApiError` and still ship it with a 400. Status parity is the actual promise, and the formatter can't touch the status.

The second is a custom input parser: `.input((raw) => { ...throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT' }) })`. This one is subtle enough that it needs a probe to kill. tRPC's input-parsing middleware catches whatever the parser throws and re-wraps it — a thrown `TRPCError`, ZodError, anything — as a fresh `BAD_REQUEST`. A quick experiment confirms it: a parser that explicitly throws `UNPROCESSABLE_CONTENT` still arrives at the client as `BAD_REQUEST/400`. The `.input()` layer is a status dead-end by construction; nothing you throw from inside it survives as anything but 400.

The fix is to stop validating there. The `.input()` parser becomes a passthrough — `(raw) => raw`, identity, never throws — so the raw body flows into the resolver untouched. The resolver then validates it with `validate(action_name, input, schema)`, the framework's own action-validation helper, which throws exactly the `ValidationError` that `app.do` would. That error lands in the resolver's existing catch, routes through `to_trpc_error`, and maps to `UNPROCESSABLE_CONTENT`/422 with the shared envelope — the identical path an invariant or concurrency failure already takes. Validation moved from tRPC's pre-resolver layer, where the status is frozen at 400, into the resolver, where the generator owns the mapping.

Two details made this safe rather than a rewrite. The generated router's public type comes from a `GeneratedRouter<TApp>` cast, not from `.input()`'s inference, so making the parser a passthrough doesn't change a single client-facing type. And validating at the *top* of the resolver, before the stream and expectedVersion resolvers run, mirrors Hono's zValidator-then-handler order — so a malformed body is rejected before a resolver can trip over its missing fields, exactly as on REST.

The rule worth keeping: in a layered transport, the status code is decided by the layer that first rejects the request, not by the layer that owns the error vocabulary. If those two layers are different — tRPC's input parser rejects, but the resolver owns `toApiError` — the rejection has to be moved to the layer that can speak the vocabulary. You don't translate the error where it's thrown; you throw it where the translator can hear it.

See `libs/act-http/src/trpc/index.ts` (the mutation loop), `libs/act/src/utils.ts` (`validate`), and [#1295](https://github.com/Rotorsoft/act-root/issues/1295).
