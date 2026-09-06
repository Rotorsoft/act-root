# RFC 1621: publish the HTTP delivery classifier

- **Status:** draft
- **Issue:** #1621
- **Author:** Rotorsoft
- **Created:** 2026-09-06

## Motivation

`@rotorsoft/act-http/webhook` ships `webhook(config)` for the common case: deliver an event to a URL over HTTP, and let the drain's retry and blocking machinery react to the response. The interesting decision inside it is small and easy to get subtly wrong — which HTTP status means "try again later", which means "stop and get an operator", and which means "done". The package answers it in one place: 2xx is done, 5xx is retryable, and 3xx/4xx are permanent, because a redirect at the delivery layer means the configured URL is wrong and retrying it cannot help.

Anyone delivering over something that is not `fetch` to a URL — a gRPC bridge, a vendor SDK, a queue publisher that returns HTTP-shaped errors — needs that same answer, and `webhook()` does not fit their transport. Today they have three choices: re-derive the rule and drift from it, deep-import `src/webhook/classify.js` (off the stability contract, and free to move in any release), or read the README, try the documented import, and find it does not exist.

That last one is the actual state. The README has documented `tryOk`, `classifyHttpResponse`, and `TryOkOptions` as public API of this subpath since the helpers were written. They are implemented, they have their own spec file, their doc-comment says the classification was "lifted here so custom integrations (gRPC bridges, SDK-based reactions, etc.) can apply the same retry semantics without inventing a parallel rule" — and the subpath never exported them. Nothing inside the package noticed, because `webhook()` calls the classifier directly and has never called `tryOk` at all.

The error classes these helpers throw (`RetryableHttpError`, `NonRetryableHttpError`) *are* exported. So the shipped surface currently lets a caller throw the right error but gives them no supported way to decide which one it is — half of a story that was meant to be whole.

## Public surface added

From the `@rotorsoft/act-http/webhook` subpath:

- **`classifyHttpResponse(response: Response): HttpDisposition`** — the three-bucket classifier `webhook()` uses internally. `HttpDisposition` (`"ok" | "retry" | "block"`) is already exported.
- **`tryOk(response: Response, options: TryOkOptions): Promise<void>`** — returns on 2xx; throws `RetryableHttpError` on 5xx and `NonRetryableHttpError` on 3xx/4xx, capturing the response body onto the error (best-effort).
- **`TryOkOptions`** — `{ url: string; label?: string }`. `url` is surfaced on the thrown error; `label` prefixes the message with the integration's identity (`"webhook"`, `"my_sdk"`, `"grpc"`).

Both functions are renamed from their snake_case definitions (`classify_http_response`, `try_ok`) to the camelCase the naming convention requires of anything reachable from a subpath entry point — and to the names the README has always used. The rename happens at the definition, not as an export alias, so there is one name per function rather than an internal and an external spelling that can drift.

## Alternatives considered

**Delete the three README entries.** Cheapest, and it makes the docs honest with no new surface. Rejected because it makes them honest in the wrong direction: the capability exists, is tested, and was deliberately factored out for external use. Deleting the entries leaves a custom-transport author with the exported error classes and no supported way to choose between them, which is the gap that motivated the helpers in the first place.

**Delete the entries and the code.** Also considered, since `tryOk` has no internal callers and is, strictly speaking, dead. Rejected for the same reason plus one more: `classifyHttpResponse` cannot go — `webhook()` needs it — so this would leave the rule half-published anyway, reachable only by deep import.

**Export as aliases and keep the snake_case definitions.** Keeps internal call sites unchanged. Rejected: two spellings for one function is exactly the kind of drift the naming convention exists to prevent, and the convention is explicit that anything reachable from a subpath entry point is camelCase.

**Do nothing.** The status quo is a README that documents three imports that fail. Not a real option.

## Stability / charter impact

**Category:** public types and exports of an adapter package (`@rotorsoft/act-http`, `/webhook` subpath). Not a core `IAct`, builder, or port surface.

**Additive.** Three new exports; nothing renamed, removed, or narrowed on the existing surface. The snake_case definitions were never exported, so their rename is not observable from outside the package — no `BREAKING CHANGE:` footer and no migration note.

Once merged, `STABILITY.md` protects all three: the signatures and the classification's meaning become contract. That is the intended cost, and it is small — the rule is deliberately simple and has not changed since it was written.

**No port method**, so no TCK work and no adapter changes.

## Open questions

Should the 3xx → `block` mapping be configurable? An integration whose transport uses redirects meaningfully would want 3xx treated as `retry` or `ok`. Left alone here: no such caller exists yet, `classifyHttpResponse` is cheap to wrap for anyone who needs a different rule, and adding an options bag now would freeze a shape before there is a second case to design against.
