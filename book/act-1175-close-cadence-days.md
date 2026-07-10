# ACT-1175 — The knob that turned out to be a bug

## The pain that started it

During the windowed-close review Roger kept circling one discomfort: the closing process, a thing that reasons about retention in months and years, kept millis, seconds, and minutes in its vocabulary. ACT-1011 scrubbed the new surface, but four older `ActOptions` knobs remained, led by `autocloseCycleMinutes`, a poll interval for a books-closing engine. The follow-up ticket asked how to re-denominate them.

## Why the obvious answer didn't fit

The obvious answer was a rename. Turn `autocloseCycleMinutes` into `autocloseCycleHours`, keep a deprecation alias, call it consistent. But the consumer audit that should have been a formality changed the question entirely. Since ACT-1090 replaced the autoclose sweep with a synthesized per-aggregate reaction, three of the four knobs were read by nothing at all. They were validated, defaulted, documented, and dead. The fourth had exactly one job left: when a tick landed outside the off-hours window, defer by that many minutes and try again.

Staring at that one line long enough revealed it was not a knob, it was a bug wearing a knob's clothes. With the default twelve-hour cadence and a four-hour maintenance window, the blind re-check could land outside the window, defer twelve hours, land outside again, and oscillate around the window indefinitely. Renaming the interval would have preserved the oscillation in a nicer unit.

## The decision

Derive instead of configure. The reaction now asks the window itself when it next opens, walking forward hour by hour through `Intl` so daylight-saving days of twenty-three or twenty-five hours resolve exactly as the zone database says, and parks until that instant. `next_window_open` lives beside `in_autoclose_window` in `autoclose-config.ts`; the deferral is optimal by construction, and there is nothing left to tune. All four knobs stay on `ActOptions` as accepted, range-validated, and ignored, because removing an options field is a breaking change and deprecation ships as a minor. The one-minute floor on `after: { days }` stays too, sanctioned in the RFC: a cooldown is not a retention window, the input is denominated in days either way, and post-1090 the reaction genuinely honors sub-day due-times.

## What this teaches

When a configuration value feels wrongly denominated, check who reads it before choosing a better unit. A knob nobody consumes is documentation debt, and a knob that paces a poll is often standing where a derivation should be. The best cadence configuration is the one the system computes for itself.

## Connections to other chapters

The days-only ruling comes from ACT-1011, where the close surface learned to speak in calendar terms. The synthesized reaction and its defer mechanic are ACT-1090's story, and the deprecate-rather-than-remove path follows the stability charter's treatment of shipped options, the same reasoning that governed the camelCase aliases of RFC 1139.
