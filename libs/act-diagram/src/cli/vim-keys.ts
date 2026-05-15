/**
 * Patch a tty input stream so vim users can drive @clack/prompts.
 *
 *   j        → cursor down (\x1b[B)
 *   k        → cursor up   (\x1b[A)
 *   q        → ESC (clack treats ESC as cancel, which doubles as "back")
 *   /        → fires the registered "slash" callback AND emits ESC so
 *              the currently-active prompt cancels; the loop checks the
 *              callback's pending flag to decide whether to jump to
 *              search instead of going one level up.
 *
 * Arrow keys and every other byte pass through unchanged. `pause()`
 * disables translation entirely — used during text-input prompts so
 * `j`, `k`, `/`, etc. are typed literally.
 */

const UP = Buffer.from("\x1b[A");
const DOWN = Buffer.from("\x1b[B");
const ESC = Buffer.from("\x1b");

const matches = (chunk: Buffer, key: string): boolean =>
  chunk.length === key.length && chunk.toString("utf8") === key;

type Direction = "down" | "up" | "cancel" | "slash" | null;

/** Classify a chunk into one of our handled directions, or null. */
export function classify(chunk: Buffer): Direction {
  if (matches(chunk, "j")) return "down";
  if (matches(chunk, "k")) return "up";
  if (matches(chunk, "q")) return "cancel";
  if (matches(chunk, "/")) return "slash";
  return null;
}

type StreamLike = {
  emit: (event: string, ...args: unknown[]) => boolean;
};

export type VimKeysHandle = {
  /** Remove the patch entirely. Idempotent. */
  restore: () => void;
  /** Temporarily stop translating bytes (e.g. during a text-input prompt). */
  pause: () => void;
  /** Resume translating bytes after a `pause()`. */
  resume: () => void;
  /** Register a callback fired when `/` is pressed. Returns an unsubscribe fn. */
  onSlash: (cb: () => void) => () => void;
};

export function enableVimKeys(stdin: StreamLike): VimKeysHandle {
  const origEmit = stdin.emit.bind(stdin);
  let active = true;
  const slashListeners: Array<() => void> = [];

  const patched: StreamLike["emit"] = (event, ...args) => {
    if (active && event === "data" && args[0] instanceof Buffer) {
      const direction = classify(args[0] as Buffer);
      if (direction === "down") return origEmit("data", DOWN);
      if (direction === "up") return origEmit("data", UP);
      if (direction === "cancel") return origEmit("data", ESC);
      if (direction === "slash") {
        for (const cb of slashListeners) cb();
        return origEmit("data", ESC);
      }
    }
    return origEmit(event, ...args);
  };
  stdin.emit = patched;

  let restored = false;
  return {
    restore: () => {
      if (restored) return;
      restored = true;
      if (stdin.emit === patched) stdin.emit = origEmit;
    },
    pause: () => {
      active = false;
    },
    resume: () => {
      active = true;
    },
    onSlash: (cb) => {
      slashListeners.push(cb);
      return () => {
        const i = slashListeners.indexOf(cb);
        if (i >= 0) slashListeners.splice(i, 1);
      };
    },
  };
}
