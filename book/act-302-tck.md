# ACT-302 — the TCK and extensible ports

ACT-302 lands an umbrella `@rotorsoft/act-tck` covering Store + Cache + Logger. Material for the extensibility and testing chapters.

The TCK turns "what is a Store contract?" from tribal knowledge (read three test files and reverse-engineer the union) into an executable spec a third party can run. It is the precondition for the 1.0 stability charter promising Store/Cache/Logger as stable extension points.

Weave these ideas into the book (likely the Extensibility / Adapters chapter, with a callout in the Testing chapter):

- **A port is not the interface alone — it is `interface + TCK`.** Without the TCK, the contract is undefined behavior at the union of whatever impls happen to test. Frame this as a lesson learned on the road to 1.0.
- **Capabilities pattern.** Optional methods (e.g., `Store.notify`) are gated by flags in the TCK so adapters can opt out of features they don't implement. Show this as a generalizable pattern for evolving ports without breaking existing adapters.
- **Reference implementation does double duty.** `InMemoryStore` / `InMemoryCache` / `ConsoleLogger` are both production-grade defaults *and* the first customers of the TCK — proves the TCK works before any external adapter ships.
- **Fixed fixture domain.** TCK ships its own tiny Counter-style domain rather than accepting event schemas via options. Self-contained, deterministic, identical coverage across adapters. Use this as a worked example of "test fixtures should be the simplest thing that exercises the contract."
- **Port evolution rule.** Changing a port interface (e.g., `Store.query_stats` shipped in #639 / #752) forces a matching TCK change in lockstep. Encode this as a contributor rule and tie it to the book's "evolving event-sourced systems" theme.
- **Third extension point — Logger.** Even though `Logger` is narrow, including it in the TCK signals that *all* extension points get the same treatment. Useful framing for the book: extensibility is uniform, not à la carte.

Chapter placement candidates:
- Extensibility / Adapters chapter — main treatment of the TCK pattern, with code excerpts.
- Testing chapter — short callout: "if you're writing an adapter, run the TCK; here's what it covers."
- Road-to-1.0 / Stability chapter (if it exists) — TCK as evidence that the 1.0 line is real.
