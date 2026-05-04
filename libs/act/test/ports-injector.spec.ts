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
    logLevel: "fatal",
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
      const { InMemoryStore } =
        await import("../src/adapters/in-memory-store.js");
      const { store } = await import("../src/ports.js");
      const defaultStore = store();
      expect(defaultStore).toBeInstanceOf(InMemoryStore);
      const sameStore = store();
      expect(sameStore).toBe(defaultStore);
    });

    it("should allow a specific adapter to be injected", async () => {
      const { InMemoryStore } =
        await import("../src/adapters/in-memory-store.js");
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

    it("should call disposers in reverse registration order", async () => {
      // env=test → disposeAndExit skips process.exit, no spy needed.
      // logLevel=fatal silences the port registration info log emitted
      // when adapters first resolve.
      vi.doMock("../src/config.js", () => ({
        config: vi.fn().mockReturnValue({ env: "test", logLevel: "fatal" }),
      }));
      const { dispose } = await import("../src/ports.js");
      const order: string[] = [];

      dispose(() => Promise.resolve(void order.push("A")));
      dispose(() => Promise.resolve(void order.push("B")));
      const disposeAndExit = dispose(() =>
        Promise.resolve(void order.push("C"))
      );
      await disposeAndExit("EXIT");

      expect(order).toEqual(["C", "B", "A"]);
    });

    it("should not exit on error in production", async () => {
      // Mock config to return production+info. logLevel is "fatal" so the
      // registration info log and the disposeAndExit warn log are both gated
      // (this test asserts behavior, not log content — the production-only
      // warn breadcrumb is exercised separately in ports.spec.ts).
      vi.doMock("../src/config.js", () => ({
        config: vi
          .fn()
          .mockReturnValue({ env: "production", logLevel: "fatal" }),
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
