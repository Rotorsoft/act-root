import { beforeEach, describe, expect, it, vi } from "vitest";

const pinoSpy = vi.fn(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  trace: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("pino", () => ({
  pino: pinoSpy,
}));

// Mock config to control environment for tests
vi.mock("../src/config.js", () => ({
  config: vi.fn().mockReturnValue({
    env: "development",
    logLevel: "info",
    logSingleLine: true,
  }),
}));

describe("ports-injector", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("port injector", () => {
    it("should inject a default adapter and return the same instance", async () => {
      // Import InMemoryStore dynamically to solve instanceof issue
      const { InMemoryStore } = await import(
        "../src/adapters/InMemoryStore.js"
      );
      const { store } = await import("../src/ports.js");
      const defaultStore = store();
      expect(defaultStore).toBeInstanceOf(InMemoryStore);
      const sameStore = store();
      expect(sameStore).toBe(defaultStore);
    });

    it("should allow a specific adapter to be injected", async () => {
      const { InMemoryStore } = await import(
        "../src/adapters/InMemoryStore.js"
      );
      const { store } = await import("../src/ports.js");
      class CustomStore extends InMemoryStore {}
      const customStore = new CustomStore();
      const injectedStore = store(customStore);
      expect(injectedStore).toBeInstanceOf(CustomStore);
      const sameStore = store();
      expect(sameStore).toBe(customStore);
    });
  });

  describe("dispose logic", () => {
    it("should register and call disposers on exit", async () => {
      const processExitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const { dispose, store } = await import("../src/ports.js");
      const customDisposer = vi.fn();
      const disposeAndExit = dispose(customDisposer);
      const adapter = store();
      const adapterDisposeSpy = vi.spyOn(adapter, "dispose");
      await disposeAndExit("EXIT");
      expect(customDisposer).toHaveBeenCalledOnce();
      expect(adapterDisposeSpy).toHaveBeenCalledOnce();
      processExitSpy.mockRestore();
    });

    it("should not exit on error in production", async () => {
      vi.doMock("../src/config.js", () => ({
        config: vi
          .fn()
          .mockReturnValue({ env: "production", logLevel: "info" }),
      }));
      const { dispose } = await import("../src/ports.js");
      const disposeAndExit = dispose();
      const processExitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      await disposeAndExit("ERROR");
      expect(processExitSpy).not.toHaveBeenCalled();
      processExitSpy.mockRestore();
    });
  });
});
