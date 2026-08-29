# ACT-1592 — the strikes the database threw

Every stream Act reacts to carries a strike count. It goes up when work is handed to a worker and back to zero when that worker reports finishing. Run out of strikes and the stream is quarantined: it stops, stays stopped, and waits for someone to look at it. That is a good rule, because the alternative is a broken handler firing the same webhook every few milliseconds until a human notices.

The trouble is where the strike is recorded. It goes on the board at the moment work is handed out, before the handler has done anything, and it only comes off when the worker successfully reports back. Reporting back means writing to the database, and the database can say no. When it did, the whole round was abandoned and the strike stayed on the board even though the handler had run perfectly and finished its job.

Someone running the SQLite adapter under a watching dev server found out what that costs. Three of their subscriptions quarantined themselves at the same moment, and the log told them their handlers were too slow for their lease and they should give them a longer one. Their handlers finished in a few milliseconds against a ten second lease, and every command they had issued had committed. What had actually happened was sitting a few lines higher: a second connection to the database file, which is what you get for a moment when a watching dev server restarts over itself. We had already worked out, in an earlier issue, that this is normal on a store that allows one writer at a time and that turning up the database's patience setting is not the answer. So a condition that heals itself in a second turned into a quarantine that only a human could clear, diagnosed as a problem that did not exist.

The interesting part is that Act already knew whose fault it was. The same error handler that abandoned the round is the one that reports the failure to the circuit breaker as the store's. Two pieces of the system held opposite opinions about who had spent the strike, and nobody had ever put them in the same room.

---

The first fix I built took the ticket's suggestion literally: do not let a store failure spend the budget. That meant keeping a running tally, per stream, of strikes the database had thrown rather than the handler, subtracting it from the count every decision reads, and settling the tally each round depending on what the store had confirmed. It was exact. It also came to a hundred lines, added state that had to be reasoned about across rounds and restarts, and had a lifecycle of its own. Roger read it and said it looked overcomplicated, which it was.

The simpler question is what the quarantine is actually claiming when it fires. It claims that arriving past the budget with no error anywhere can only mean one thing, that every attempt lost its lease before it could report back. That claim was just false. A failing database produces the same picture. Rather than building bookkeeping to make the claim true again, the fix is to stop making it at a moment when it cannot be trusted.

So the quarantine now stands down whenever the store has failed since the last round that completed. The circuit breaker was already counting that, so nothing new had to be recorded anywhere:

```ts
get failing(): boolean {
  return this._failures > 0;
}
```

That reading is passed into the drain round and short-circuits the quarantine check. Waiting costs nothing. A stream that is genuinely stuck stays stuck, and the next round that completes either wipes the count, because the work finally went through, or leaves it standing for the quarantine to act on once the database is healthy.

Two designs got looked at and dropped along the way. Undoing the strike when the store fails reads well until you notice where that code sits: you are there because the database just refused a write, and your plan is to ask it for another one. Moving the strike from the moment work is handed out to the moment it is reported back is the more honest repair, and it changes a contract every adapter implements in order to fix an accounting detail. It also gives up something real. The strike is recorded up front precisely so it survives a worker that dies mid-handler and never reports anything at all, and that is what stops a stream whose events kill workers from killing workers forever.

One case still lands on the wrong side. If the database eats a few strikes and then a handler starts failing for real, that handler is quarantined sooner than its full budget would allow, because it inherits a count it did not earn. Its own error is logged either way, and unblocking resets the count, so the next round gives it the full budget. Being early on a genuinely broken handler is a much smaller wrong than quarantining a healthy one, and closing it was exactly the hundred lines that were not worth writing.

What this leaves behind is a rule worth carrying: a counter is only as honest as the thing it is documented to count, and the tell that it has drifted is a diagnostic message prescribing a remedy the reader can see is irrelevant. When that happens, the number has quietly started measuring two different things, and the cheapest repair is usually to stop trusting it at the one moment it cannot tell them apart.

See `libs/act/src/internal/drain-cycle.ts`, `libs/act/src/internal/circuit-breaker.ts`, `libs/act/test/store-failure-budget.spec.ts`, and [#1592](https://github.com/Rotorsoft/act-root/issues/1592).
