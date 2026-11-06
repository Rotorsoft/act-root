---
id: rules-across-streams
title: Rules across streams
---

# Rules across streams

A rule that spans streams used to mean a reaction and a compensating event: take the seat, then find out the course was full, then give it back. For a business rule that must never be broken, even for a moment, that leaves a window where it is. `.loads` closes the window. One action loads the other states its decision needs, and appends to all of them in one commit, each stream guarded by the version it had when loaded.

This guide is the catalog: each pattern in plain words, its code, what a race does to it, and what it costs. Every scenario runs as a small state with tests in [the recipe](https://github.com/rotorsoft/act-root/tree/master/recipes/rules-across-streams), and the [flow animation](pathname:///flows/rules-across-streams.html) plays them. [`.loads`](../concepts/state-management.md#rules-across-streams-loads) is the reference for the mechanism.

All the snippets below come from the recipe.

## A unique value is a state of its own

**The rule.** No two users share an email. Vehicle plates, tokens redeemed once and one review per product per customer work the same way.

Make one stream per value, recording who holds it. Every action that takes or frees the value loads that stream and lists the event.

```typescript no-check
export const Email = state({
  Email: z.object({ holder: z.string().optional() }),
})
  .init(() => ({}))
  .emits({
    EmailTaken: z.object({ user: z.string() }),
    EmailReleased: ZodEmpty,
  })
  .patch({
    EmailTaken: ({ data }) => ({ holder: data.user }),
    EmailReleased: () => ({ holder: undefined }),
  })
  .build();

// on the User state
.on({ Register }, { maxRetries: 2 })
.loads(Email, (data) => emailStream(data.email), ["EmailTaken"])
.requires([
  {
    description: "the user isn't registered yet",
    holds: (_, state) => !state.emailStream,
  },
  {
    description: "the email is free",
    holds: (_, __, ___, { Email }) => !Email.holder,
  },
])
.emit((data, _, { stream }) => [
  ["Registered", { email: data.email, emailStream: emailStream(data.email) }],
  ["EmailTaken", { user: stream }],
])
```

**A race.** Two people register one address. Both load the stream as free, one commits, and the other's commit fails with `ConcurrencyError`. `maxRetries` runs it again with a fresh load, and the rule now refuses it with `PreconditionError`.

**The trade-off.** One more state and one stream per value, which is more code than a helper would be. In exchange every rule, event and stream is visible and tested like any other, and whether closing an account frees its email is just the closing action emitting `EmailReleased` or not.

Name the stream carefully: a stream name can't be forgotten, so a stream keyed by a sensitive value uses an HMAC of it. [Sensitive data](./sensitive-data.md#what-the-framework-does-not-do) has the details.

## A limit is a state with a count

**The rule.** A course has a capacity. A student takes at most three courses. A user has at most three sessions.

Make one stream per thing being limited, with a count. An action that takes a slot loads it and lists the event.

```typescript no-check
.on({ Enroll }, { maxRetries: 8 })
.loads(Seats, (data) => courseStream(data.course), ["SeatTaken"])
.loads(Student, (data) => studentStream(data.student), ["CourseAdded"])
.requires([
  {
    description: "the student isn't enrolled yet",
    holds: (_, state) => !state.active,
  },
  {
    description: "the course has a free seat",
    holds: (_, __, ___, { Seats }) => Seats.taken < Seats.capacity,
  },
])
.emit((data) => [
  ["Enrolled", data],
  ["SeatTaken", {}],
  ["CourseAdded", {}],
])
```

**A race.** Two students take the last seat. One commit lands and the other fails on `course-<id>`, so nothing of it lands: no `Enrolled`, no `CourseAdded`. Its retry sees the course full and refuses.

**The trade-off.** Everyone taking a slot writes to the same stream, so a busy limit retries a lot, which is why this action has a higher `maxRetries`. When that stream gets too hot, [split it](#a-hot-resource-splits-across-streams).

Gapless numbers are this pattern with no rule at all: `InvoiceCounter` hands out the next number, and its version check is what stops two invoices taking the same one.

## A schema holds what must always be true

**The rule.** A room's bookings never overlap. An invoice is never overpaid. Stock never goes below zero.

When a rule must hold whichever action emits, put it in the loaded state's schema. The action needs no precondition, because every fold of `Room` is checked before the commit.

```typescript no-check
export const Room = state({
  Room: z
    .object({ slots: z.array(Slot) })
    .refine(
      ({ slots }) =>
        slots.every((a, i) => slots.slice(i + 1).every((b) => !overlap(a, b))),
      "the room is double-booked"
    ),
})
  // ...

.on({ Book }, { maxRetries: 4 })
.loads(Room, (data) => `room-${data.room}`, ["RoomReserved"])
.emit((data) => [
  ["Booked", data],
  ["RoomReserved", { from: data.from, to: data.to }],
])
```

**A race.** Two bookings overlap. The loser's commit fails on the room's version, and its retry folds onto the new state. The schema refuses it with `ValidationError`, and nothing lands on either stream.

**The trade-off.** The caller gets a schema error, not a sentence written for it. Use a precondition when the caller needs a clear refusal or when the limit can change: `Seats` can be lowered below the seats already taken, so its limit can't be in the schema. Use both when you want both, as `Product` does.

## Several streams, all or none

**The rule.** A transfer debits one account and credits another, or does neither.

Load one state twice, naming each load.

```typescript no-check
.on({ TransferMoney }, { maxRetries: 4 })
.loads(Account, (data) => data.from, ["Debited"], "from")
.loads(Account, (data) => data.to, ["Credited"], "to")
.requires([
  {
    description: "enough funds",
    holds: (data, _, __, { from }) => from.balance >= data.amount,
  },
])
.emit((data) => [
  ["Transferred", data],
  ["Debited", { amount: data.amount }],
  ["Credited", { amount: data.amount }],
])
```

**A race.** A rival on either account fails the whole commit. A transfer to the same account names one stream twice and refuses with `PreconditionError`, so a client gets a 409.

**The trade-off.** Every stream appended to must be free of rivals at the same moment, so the more streams one action writes, the more often it retries. A commit also can't cross stores: every loaded state lives in the store of the Act that registers it.

## A read isn't guarded

**The rule.** The price a customer saw is still the price.

A load with no events is a read. The decision sees the state, but its stream is outside the commit.

```typescript no-check
.on({ AddToCart })
.loads(Product, (data) => data.product)
.requires([
  {
    description: "the displayed price is current",
    holds: (data, _, __, { Product }) => data.price === Product.price,
  },
])
.emit("ItemAdded")
```

**A race.** The price changes after the load and before the commit, and the commit lands anyway at the old price.

**The trade-off.** A read costs no conflicts and guards nothing, so use it where a slightly stale answer is acceptable. A decision that must be refused when a stream moves appends to that stream.

## A relation that may not exist yet

**The rule.** A ticket frees its agent's slot when it moves, if it has an agent.

A target returning `undefined` skips its load. `loaded` holds `undefined` for it, and events `.emit` returns that are listed on it are dropped, so `.emit` needn't repeat the check. From [Wolfdesk](../examples/wolfdesk.md):

```typescript no-check
.on({ AssignTicket }, { maxRetries: 4 })
.loads(Agent, (_, state) => state.agentId && agentStream(state.agentId), ["TicketDropped"], "current")
.loads(Agent, (data) => agentStream(data.agentId), ["TicketTaken"], "next")
.emit((data) => [
  ["TicketAssigned", data],
  ["TicketDropped", {}],
  ["TicketTaken", {}],
])
```

**A race.** Two people assign an unassigned ticket. "No agent yet" is a fact on the ticket's own stream, so its version guards it: the loser retries, sees the agent, and loads them.

**The trade-off.** A target that returns `undefined` by mistake drops its events without an error. Only the type of `loaded` warns you, and only if the action reads that load.

## A hot resource splits across streams

**The rule.** A flash sale has 1,000 slots and everyone wants one at once.

One count on one stream makes every buyer a rival of every other. Split the count across several streams, and send each buyer to one of them, trying the next when it's full. [`split-hot-stream.ts`](https://github.com/rotorsoft/act-root/tree/master/recipes/rules-across-streams/examples/split-hot-stream.ts) runs it.

**A race.** Buyers on different streams never conflict. Two on the same one race as usual, and the loser moves on.

**The trade-off.** The total stays exact, because each stream holds its own share. But one stream can fill while others have room, so buyers may try several, order of arrival isn't kept, and "sold out" takes asking every stream. Don't split until contention is a measured problem.

## A rule added to existing data

**The rule.** Emails must be unique from now on, and thousands of users already have one.

The new streams start empty, so every existing address looks free until they're filled from current state. [`fill-streams.ts`](https://github.com/rotorsoft/act-root/tree/master/recipes/rules-across-streams/examples/fill-streams.ts) is a script that does it. It's safe to run again, because it skips what's already filled, and it reports the duplicates it finds, for a person to resolve.

**The order matters.** Registrations keep arriving while it runs. Fill once, deploy the rule, then fill again: the second run catches anyone who registered in between, and any duplicate they created.

## When a reaction is the better choice

A shared commit makes every stream in it wait for the others. It's the right tool when the rule must never be broken, even for a moment. Reach for a reaction, with [compensation](../architecture/design-decisions.md#compensation--forward-recovery-not-a-rollback-framework) where a step can fail, when:

- **The other side is outside the store,** like a payment gateway or another service. A commit can't include it, and an action can't load across stores.
- **The steps take time,** or wait for a person. A commit is a moment.
- **A temporary breach is acceptable,** and undoing it is a normal business event. Overbooking a flight and rebooking someone is a policy, and many businesses prefer it to refusing a sale.
- **The streams are hot and independent.** A reaction doesn't make them rivals.

The two also combine. Wolfdesk's assign reaction picks an agent from a read model that may be behind, and the commit decides: the read model suggests, and a full agent is refused and picked again ([Picking an Agent](../examples/wolfdesk.md#picking-an-agent)).
