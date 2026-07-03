# Temporal recipes

Playbooks for the moments where an Act application needs something to happen *because time passed*. A ticket goes quiet and needs a nudge a day later. An order sits unpaid and must expire after thirty minutes. A cooldown has to run out before a follow-up fires. These are the workflows that wait on the absence of an event rather than its arrival.

Most timing needs are one-shot, and the framework already ships them as plain reaction surfaces. The declarative `.defer(when)` builder step and the imperative `throw new DeferSignal(when)` escape hatch both hold a reaction's triggering event pending until a due-time, then run the handler once. A single deadline, a single cooldown, a single delayed follow-up: reach for those directly. They are documented in [Deferred reactions](../../docs/docs/concepts/state-management.md#deferred-reactions), and nothing in this folder replaces them.

This folder exists for the case the one-shot surfaces deliberately do not cover: **recurrence.** There is no `{ every }` schedule form, because holding one event forever to re-fire it would pin the stream's watermark and stall every other reaction on that stream. Recurrence is built instead as a composition of the shipped one-shot primitives, and that composition is common enough to deserve a written pattern.

## Recipe index

| Recipe | Use when |
|---|---|
| [recurring-timers/README.md](recurring-timers/README.md) | You need a reaction to re-fire on a cadence (a repeating nudge, a widening escalation, a bounded series of retries, a wall-clock-aligned tick) rather than fire once. |

If your need is genuinely one-shot, you don't want a recipe at all; you want [`.defer(when)`](../../docs/docs/concepts/state-management.md#deferred-reactions). Come back here the moment the thing has to happen more than once.

For the broader operator playbook (storage growth, archival, partitioning), see [recipes/README.md](../README.md).
