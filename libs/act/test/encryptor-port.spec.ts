import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock config so the registration info log doesn't crowd test output.
vi.mock("../src/config.js", () => ({
  config: vi.fn().mockReturnValue({
    env: "development",
    logLevel: "fatal",
    logSingleLine: true,
  }),
}));

describe("encryptor() port", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns undefined before any adapter is wired", async () => {
    const { encryptor } = await import("../src/ports.js");
    expect(encryptor()).toBeUndefined();
  });

  it("registers and returns the wired adapter", async () => {
    const { encryptor } = await import("../src/ports.js");
    const { InMemoryEncryptor } = await import(
      "../src/adapters/in-memory-encryptor.js"
    );
    const adapter = new InMemoryEncryptor({ masterKey: randomBytes(32) });
    const returned = encryptor(adapter);
    expect(returned).toBe(adapter);
    expect(encryptor()).toBe(adapter);
  });

  it("ignores subsequent wires (first wins, like other ports)", async () => {
    const { encryptor } = await import("../src/ports.js");
    const { InMemoryEncryptor } = await import(
      "../src/adapters/in-memory-encryptor.js"
    );
    const first = new InMemoryEncryptor({ masterKey: randomBytes(32) });
    const second = new InMemoryEncryptor({ masterKey: randomBytes(32) });
    encryptor(first);
    const returned = encryptor(second);
    expect(returned).toBe(first);
    expect(encryptor()).toBe(first);
  });

  it("is disposed during disposeAndExit", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const { dispose, encryptor } = await import("../src/ports.js");
    const { InMemoryEncryptor } = await import(
      "../src/adapters/in-memory-encryptor.js"
    );
    const adapter = new InMemoryEncryptor({ masterKey: randomBytes(32) });
    const disposeSpy = vi.spyOn(adapter, "dispose");
    encryptor(adapter);
    await dispose()();
    expect(disposeSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("returns undefined again after disposal (singleton cleared)", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const { dispose, encryptor } = await import("../src/ports.js");
    const { InMemoryEncryptor } = await import(
      "../src/adapters/in-memory-encryptor.js"
    );
    encryptor(new InMemoryEncryptor({ masterKey: randomBytes(32) }));
    expect(encryptor()).toBeDefined();
    await dispose()();
    expect(encryptor()).toBeUndefined();
    exitSpy.mockRestore();
  });
});
