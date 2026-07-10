# RFC 1175: close cadence knobs — derive, deprecate, and speak in days

- **Status:** draft
- **Issue:** #1175 (follow-up to #1011)
- **Author:** Roger Torres (with Claude)
- **Created:** 2026-07-10

## Motivation

The design ruling from #1011 says close-the-books surfaces never speak in
milliseconds, seconds, or minutes. Three pre-existing `ActOptions` knobs still
did: `autocloseCycleMinutes`, `closeYieldMs`, and (by association) the
sweep-era `closeBatchSize`/`closeOnError` pair. Investigating consumers showed
the real story: since #1090 replaced the autoclose sweep with a synthesized
per-aggregate reaction, **three of the four knobs are dead** — validated,
defaulted, documented, and read by nothing. The only live consumer was one
line in `autoclose-reaction.ts` using `autocloseCycleMinutes` to blind-poll
when a tick lands outside `autocloseWindow`.

That polling was also a latency bug: with the default 720-minute cadence and a
short off-hours window (say `{ start: 2, end: 6 }`), the re-check could
oscillate around the window — deferred at 07:00, re-checked at 19:00, outside
again, re-checked at 07:00 — and effectively never land inside it.

## Public surface added

None. This RFC covers deprecations and a derived behavior:

- **`next_window_open(window, now)`** (internal, `autoclose-config.ts`) — the
  next instant the off-hours window opens, DST-correct via `Intl`. An
  off-window tick now defers to exactly that instant instead of polling.
- **`@deprecated`** on `ActOptions.autocloseCycleMinutes`, `closeBatchSize`,
  `closeYieldMs`, `closeOnError` and their `DEFAULT_*` constants. All four
  remain accepted and range-validated (typos still fail loudly at
  `act().build()`) and are ignored at runtime — the latter three already were.
  Removal is deferred to the next major.

## Alternatives considered

- **Rename `autocloseCycleMinutes` → `autocloseCycleHours`** (the ticket's
  first candidate, with an RFC-1139-style alias) — rejected once the consumer
  audit showed the knob's only job was pacing a poll that shouldn't exist.
  Deriving the re-check from the window is strictly better than any
  denomination of the cadence: it removes the knob's purpose, fixes the
  oscillation bug, and leaves zero duration-typed configuration on the close
  surface.
- **Relocate `closeYieldMs` to `SqliteStore`** — rejected as speculative; the
  truncate loop it yielded between no longer exists, and the adapter can grow
  its own option if a real writer-lock pressure case ever appears.
- **Raise the `after: { days }` floor to one day** — rejected. `after` is a
  cooldown, not a retention window; post-#1090 the reaction parks on exact
  due-times, so sub-day cooldowns are genuinely honorable. The input is
  day-denominated either way (`{ days: 1/24 }`), so the ruling holds: the
  one-minute floor is an internal validation bound, not a minutes-typed knob.
  This is the sanctioned exception, documented here so it isn't relitigated.
- **Remove the dead knobs now** — rejected; removal of `ActOptions` fields is
  breaking under STABILITY.md. Deprecate-and-ignore ships as MINOR; removal
  rides the next major.

## Stability / charter impact

- No renames, no removals, no narrowed types. Four fields gain `@deprecated`
  and stop being consumed — for `closeBatchSize`/`closeYieldMs`/`closeOnError`
  that is a pure documentation change (they were already ignored); for
  `autocloseCycleMinutes` the off-window re-check timing changes *within the
  documented intent* ("a tick only runs inside the window") from
  poll-every-N-minutes to park-until-open. Categorized additive/MINOR with
  this RFC as the decision record.
- No port or TCK impact; no adapter changes.

## Open questions

None.
