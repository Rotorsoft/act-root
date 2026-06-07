import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { classify, enableVimKeys } from "../src/cli/vim-keys.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";

describe("classify — extra keys", () => {
  it("maps / to slash", () => {
    expect(classify(Buffer.from("/"))).toBe("slash");
  });
});

describe("classify", () => {
  it("maps j and k to down/up", () => {
    expect(classify(Buffer.from("j"))).toBe("down");
    expect(classify(Buffer.from("k"))).toBe("up");
  });

  it("maps q to cancel", () => {
    expect(classify(Buffer.from("q"))).toBe("cancel");
  });

  it("returns null for unhandled single bytes", () => {
    expect(classify(Buffer.from("a"))).toBeNull();
    expect(classify(Buffer.from("\r"))).toBeNull();
  });

  it("returns null for arrow keys (clack handles them natively)", () => {
    expect(classify(Buffer.from(UP))).toBeNull();
    expect(classify(Buffer.from(DOWN))).toBeNull();
    expect(classify(Buffer.from("\x1b[C"))).toBeNull();
    expect(classify(Buffer.from("\x1b[D"))).toBeNull();
  });

  it("returns null for unrelated multi-byte chunks", () => {
    expect(classify(Buffer.from("hello"))).toBeNull();
  });
});

describe("enableVimKeys", () => {
  const sink = () => {
    const stdin = new EventEmitter();
    const received: string[] = [];
    stdin.on("data", (chunk: Buffer) => received.push(chunk.toString()));
    return { stdin, received };
  };

  it("translates j and k to single down/up arrows", () => {
    const { stdin, received } = sink();
    const { restore } = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    stdin.emit("data", Buffer.from("j"));
    stdin.emit("data", Buffer.from("k"));
    restore();
    expect(received).toEqual([DOWN, UP]);
  });

  it("translates q to ESC", () => {
    const { stdin, received } = sink();
    const { restore } = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    stdin.emit("data", Buffer.from("q"));
    restore();
    expect(received).toEqual([ESC]);
  });

  it("translates / to ESC and fires the slash callback", () => {
    const { stdin, received } = sink();
    const handle = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    let fired = 0;
    handle.on_slash(() => {
      fired++;
    });
    stdin.emit("data", Buffer.from("/"));
    handle.restore();
    expect(received).toEqual([ESC]);
    expect(fired).toBe(1);
  });

  it("on_slash unsubscribe stops further callbacks", () => {
    const { stdin } = sink();
    const handle = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    let fired = 0;
    const unsub = handle.on_slash(() => {
      fired++;
    });
    stdin.emit("data", Buffer.from("/"));
    unsub();
    stdin.emit("data", Buffer.from("/"));
    // A second unsubscribe is a no-op (callback already removed).
    unsub();
    handle.restore();
    expect(fired).toBe(1);
  });

  it("pause() suspends translation; resume() restores it", () => {
    const { stdin, received } = sink();
    const handle = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    handle.pause();
    stdin.emit("data", Buffer.from("j"));
    handle.resume();
    stdin.emit("data", Buffer.from("j"));
    handle.restore();
    expect(received).toEqual(["j", DOWN]);
  });

  it("passes up/down arrows through unchanged", () => {
    const { stdin, received } = sink();
    const { restore } = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    stdin.emit("data", Buffer.from(UP));
    stdin.emit("data", Buffer.from(DOWN));
    restore();
    expect(received).toEqual([UP, DOWN]);
  });

  it("passes unrelated bytes through unchanged", () => {
    const { stdin, received } = sink();
    const { restore } = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    stdin.emit("data", Buffer.from("a"));
    restore();
    expect(received).toEqual(["a"]);
  });

  it("passes non-data events through unchanged", () => {
    const stdin = new EventEmitter();
    let seen: unknown = null;
    stdin.on("end", (val: unknown) => {
      seen = val;
    });
    const { restore } = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    stdin.emit("end", "done");
    restore();
    expect(seen).toBe("done");
  });

  it("passes non-Buffer data through unchanged", () => {
    const { stdin, received } = sink();
    const { restore } = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    (stdin as EventEmitter).emit("data", "j" as unknown as Buffer);
    restore();
    expect(received).toEqual(["j"]);
  });

  it("restore() removes the patch", () => {
    const { stdin, received } = sink();
    const { restore } = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    restore();
    stdin.emit("data", Buffer.from("j"));
    expect(received).toEqual(["j"]);
  });

  it("restore() is idempotent and safe if emit was swapped", () => {
    const stdin = new EventEmitter() as EventEmitter & {
      emit: EventEmitter["emit"];
    };
    const { restore } = enableVimKeys(
      stdin as unknown as Parameters<typeof enableVimKeys>[0]
    );
    const sentinel = () => true;
    stdin.emit = sentinel as unknown as EventEmitter["emit"];
    restore();
    expect(stdin.emit).toBe(sentinel);
    restore();
    expect(stdin.emit).toBe(sentinel);
  });
});
