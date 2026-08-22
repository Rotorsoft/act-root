# 1541 — the injection that depended on which reference you held

The docs had said the right thing for a long time. "When a slice handler calls `app.do(action, target, payload)` without the fourth `options` argument, the framework automatically threads the triggering event in as `reactingTo`." Read that sentence and you know what to expect: dispatch from inside a reaction, get the chain. Nobody reading it would think to ask *which* `app`.

The code asked. `build_handle` constructed a scoped `IAct` per lease and rebound its `do` before each payload, closing over the triggering event. Handlers that took the third argument got the promise. Handlers that didn't got a stranger — the module-level `app`, whose `do` has no idea a reaction is in progress. `action()` then took the only branch it could: no `reactingTo`, so mint a fresh correlation id and leave `causation.event` undefined.

What makes this worth an essay is not the mechanism, which is a one-line fix, but the shape of the failure. The reaction fired. The handler ran. The action committed. The read model was correct, the books balanced, the money moved. Everything a test would assert about *behavior* held. The only casualty was the record of why any of it happened — and a missing causal record announces itself the way a missing backup does, which is to say months later, when someone finally needs it.

The trigger was a real app. Seventy-three events exported from a consulting ledger, three of them side effects of payments, and not one event in the file carrying a `causation.event`. The app's author had written the ordinary thing:

```ts
export const app = act()
  .on("PaymentReceived")
    .do(async function bookIncome(event) {
      await app.do("UpdateGrossIncome", target, payload)
    })
```

That closure over `app` isn't sloppy. When the built instance is a module export — which is how essentially every Act app is organized, because routers and utilities need it too — reaching for the name already in scope is more natural than adding a parameter that shadows it. The framework had made the correct-looking code the wrong code, and said nothing.

**The fix is to stop passing the context and start ambient-ing it.** An `AsyncLocalStorage` installed around the handler invocation, and one fallback in `action()`:

```ts
const reactingTo = options?.reactingTo ?? current_reacting_to();
```

Now the question "am I inside a reaction?" is answered by where the call came from rather than which object reference made it. Explicit still wins, so the override path is untouched, and the scoped proxy stays exactly as it was — belt and braces, and still the documented way to override.

There's precedent sitting right there in `ports.ts`: `ActOptions.scoped` threads the per-Act store and cache through an ALS for exactly the same reason, so that `store()` and `cache()` resolve correctly no matter how deep the call stack got. Reaction context is the same kind of fact — true of a dynamic extent, not of an object — and it should have been carried the same way from the start. Argument-passing works when the argument survives one hop. It stops working the moment a handler delegates to a helper, which is the second thing every real handler does.

**What we deliberately didn't do.** Warning on a captured-`app` dispatch was tempting and wrong: the framework can't distinguish "forgot the chain" from "deliberately starting a new workflow," and a heuristic warning that fires on legitimate code trains people to ignore warnings. Requiring the injected argument — making the handler signature enforce it — would have been a breaking change that punishes the reader for the framework's leak. Batch projection handlers stay out of scope on their own merits: they receive no `IAct` and span many events, so there is no single triggering event to inherit, and inventing one would be a lie in the metadata.

One consequence rides along and deserves to be said out loud. `action()` keys its optimistic-concurrency skip on the same `reactingTo` value, so a dispatch made anywhere inside a handler now also skips the inferred version guard. That is the behavior the injected proxy always had; the change makes the two paths agree rather than introducing a third. Given the choice between "ambient for metadata but not for concurrency" and "ambient means ambient," the second is the one you can explain in a sentence, and the first is the one that produces the next bug of this kind.

**The lesson for the chapter on framework ergonomics:** a convenience that only works when the user holds the right reference is not a convenience, it's a trap with good documentation. The test that would have caught this in 2024 is the one nobody writes — the test that exercises the *ugly* call shape, the one the examples don't show, because that shape is what users actually type. The three tests added here are all of that kind: dispatch through a captured reference, dispatch outside any reaction at all, and two events on one lease to prove the ambient value doesn't bleed from one handler run into the next.
