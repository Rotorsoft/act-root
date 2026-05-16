# ACT-401 — slice composition and cross-slice event contracts

For the slices chapter. When a slice reacts to events owned by another slice, the reacting slice has to redeclare the event in `.emits({...})` so `.on(eventName)` compiles. The framework's invariant since ACT-401: both `.emits()` calls must reference **the same Zod schema instance** — different references throw at build time.

**Why this matters (book-worthy story):**

- The TypeScript type system sees two structurally-compatible `z.object({...})` calls and lets them through. Runtime Zod refinements, enums, and literals don't survive the structural check.
- The failure mode is *delayed* `ZodError` — one slice happily produces events the other slice's schema would reject, and the rejection fires at the next `load()` call far from the cause. Worst case, a chained reaction emits with the divergent schema, and the event is permanently unreadable for slices on the original contract.
- Reference identity is a build-time forcing function for the right design: shared event schemas belong in a shared module.

**Canonical pattern to show in the chapter:**

```ts
// schemas/order.ts
export const OrderPaid = z.object({ amount: z.number().positive() });

// slices/order-creation.ts
import { OrderPaid } from "../schemas/order.js";
state({ Order: ... }).emits({ OrderPaid })  // shorthand: { OrderPaid: OrderPaid }

// slices/order-billing.ts
import { OrderPaid } from "../schemas/order.js";
state({ Order: ... }).emits({ OrderPaid })  // same reference
```

The shorthand `{ OrderPaid }` (the constant name *is* the event name) keeps call sites clean — no aliasing.

**Anti-pattern to call out:**

```ts
// slice A
state({ Order }).emits({ OrderPaid: z.object({ amount: z.number().positive() }) })
// slice B
state({ Order }).emits({ OrderPaid: z.object({ amount: z.number() }) })  // diverged
```

Both compile. Build throws with: *"Event 'OrderPaid' in state 'Order' is declared with different Zod schemas across slices..."* The chapter can show the error and the mechanical fix (extract + import).

**How it relates to the rest of the framework:**

- Cross-state event collisions (same event name owned by *different* state names) still throw `Duplicate event` regardless of reference. The reference-identity rule is specifically for same-state-name partials.
- Custom-patch resolution is still the existing rule: one custom patch per event, passthroughs yield, two different custom patches throw.
- The rule pairs naturally with the versioned event names pattern (ACT's schema evolution): when you bump an event's name (e.g. `OrderPaid_v2`), the new schema also gets one canonical reference; old slices keep importing the old constant.

Wolfdesk in the repo already follows this pattern — `schemas/ticket.schemas.ts` exports `TicketOpened`, `TicketClosed`, `TicketResolved`, and three slices (`ticket-creation`, `ticket-messaging`, `ticket-operations`) all import them. Cite this as the real-world example in the chapter.
