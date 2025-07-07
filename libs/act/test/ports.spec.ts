import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const exitSpy = vi.spyOn(await import("../src/ports.js"), "disposeAndExit");
const disposeSpy = vi.fn();

// to register signal handlers
import { dispose } from "../src/index.js";

describe("exit signal handlers", () => {
  beforeAll(() => {
    dispose(disposeSpy);
  });

  afterAll(() => {
    vi.resetAllMocks();
  });

  it("should exit on SIGINT", () => {
    process.emit("SIGINT");
    expect(exitSpy).toHaveBeenCalledWith("EXIT");
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("should exit on SIGTERM", () => {
    process.emit("SIGTERM");
    expect(exitSpy).toHaveBeenCalledWith("EXIT");
  });

  it("should exit on uncaughtException", () => {
    // @ts-expect-error simulate uncaughtException
    process.emit("uncaughtException");
    expect(exitSpy).toHaveBeenCalledWith("ERROR");
  });

  it("should exit on unhandledRejection", () => {
    // @ts-expect-error simulate unhandledRejection
    process.emit("unhandledRejection");
    expect(exitSpy).toHaveBeenCalledWith("ERROR");
  });

  it("should not exit in production on error", async () => {
    vi.resetModules();
    const { disposeAndExit } = await import("../src/ports.js");
    process.env.NODE_ENV = "production";
    await expect(disposeAndExit("ERROR")).resolves.toBeUndefined();
  });

  it("should exit with code 1 on error", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "development";
    const { disposeAndExit } = await import("../src/ports.js");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    await disposeAndExit("ERROR");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("should not exit in test environment", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    const { disposeAndExit } = await import("../src/ports.js");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    await disposeAndExit("EXIT");
    expect(exit).not.toHaveBeenCalled();
  });
});
