describe("signals.ts logger injection", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should not lock the logger when index.js (which imports signals) is loaded first", async () => {
    // Importing the package triggers signals.ts side effects.
    // signals.ts must not call log() at module load — that would
    // register the default ConsoleLogger before user code can inject.
    await import("../src/index.js");

    const { log } = await import("../src/ports.js");
    const stubLogger = {
      level: "info",
      fatal: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      dispose: vi.fn(),
    };

    const injected = log(stubLogger);
    expect(injected).toBe(stubLogger);
  });
});
