/**
 * Tiny color helpers. Wraps picocolors for the common 8-color palette
 * and adds 256-color escapes for the kind-specific accents (orange,
 * violet, pink/fuchsia, etc.) that picocolors doesn't ship with.
 *
 * All helpers respect picocolors' `isColorSupported` flag so output
 * stays readable when stdout is piped, NO_COLOR is set, etc.
 *
 * ## Color strategy
 *
 * Each kind has one signature color, used consistently across the
 * detail views, the match list, and the category selector. The
 * palette is picked from 256-color slots so the same hue lands the
 * same regardless of terminal theme:
 *
 *   event       orange      (208)
 *   action      cornflower  (33) — clear blue, no purple cast
 *   state       amber       (220)
 *   slice       violet      (141)
 *   projection  emerald     (41)
 *   reaction    fuchsia     (207)
 *
 * Status / meaning:
 *   green  → active / success
 *   red    → deprecated / error
 *   muted  → secondary metadata (file paths, counts, hints) — color 248
 *
 * `muted` is *not* the SGR-2 "dim" attribute. The dim attribute reads
 * as washed-out grey on most terminals; we use a neutral light-grey
 * 256-color slot instead, which keeps secondary info legible.
 *
 * Inside @clack/prompts selects, every kind label is prefixed with
 * "cancel dim" (`\x1b[22m`) so the inactive-row dimming clack applies
 * doesn't wash out our intended kind color.
 */
import pc from "picocolors";

const supported = pc.isColorSupported;

/** Cancel any active dim attribute so clack's outer dim wrap doesn't
 *  steal saturation from inactive option labels. */
const CANCEL_DIM = "\x1b[22m";

const ext = (code: number, s: string): string =>
  supported ? `${CANCEL_DIM}\x1b[38;5;${code}m${s}\x1b[39m` : s;

export const bold = pc.bold;
export const red = pc.red;
export const green = pc.green;
export const cyan = pc.cyan;
/** Secondary metadata. Brighter than SGR-2 dim so detail dialogs stay legible. */
export const muted = (s: string): string =>
  supported ? `\x1b[38;5;248m${s}\x1b[39m` : s;
/** Compat alias — older callers still import `dim`; map it to `muted`. */
export const dim = muted;

export const orange = (s: string): string => ext(208, s);
export const cornflower = (s: string): string => ext(33, s);
export const amber = (s: string): string => ext(220, s);
export const violet = (s: string): string => ext(141, s);
export const emerald = (s: string): string => ext(41, s);
export const fuchsia = (s: string): string => ext(207, s);
/** Backwards-compat: legacy aliases pointing at the action color. */
export const lilac = cornflower;
export const pink = cornflower;

export const kind_color: Record<
  "event" | "action" | "state" | "slice" | "projection" | "reaction",
  (s: string) => string
> = {
  event: orange,
  action: cornflower,
  state: amber,
  slice: violet,
  projection: emerald,
  reaction: fuchsia,
};
