const disposeAndExitSpy = vi.spyOn(
  await import("../src/ports.js"),
  "disposeAndExit"
);
const disposeSpy = vi.fn();

// to register signal handlers
import { build_tracer, dispose } from "../src/index.js";

describe("exit signal handlers", () => {
  beforeAll(() => {
    dispose(disposeSpy);
  });

  afterAll(() => {
    vi.resetAllMocks();
  });

  beforeEach(() => {
    vi.resetModules();
  });

  it("should exit on SIGINT", () => {
    process.emit("SIGINT");
    expect(disposeAndExitSpy).toHaveBeenCalledWith("EXIT");
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("should exit on SIGTERM", () => {
    process.emit("SIGTERM");
    expect(disposeAndExitSpy).toHaveBeenCalledWith("EXIT");
  });

  it("should exit on uncaughtException", () => {
    process.emit("uncaughtException");
    expect(disposeAndExitSpy).toHaveBeenCalledWith("ERROR");
  });

  it("should exit on unhandledRejection", () => {
    process.emit("unhandledRejection");
    expect(disposeAndExitSpy).toHaveBeenCalledWith("ERROR");
  });

  it("should not exit in production on error", async () => {
    process.env.NODE_ENV = "production";
    const { disposeAndExit } = await import("../src/ports.js");
    await expect(disposeAndExit("ERROR")).resolves.toBeUndefined();
  });

  it("should exit with code 1 on error", async () => {
    process.env.NODE_ENV = "development";
    const { disposeAndExit } = await import("../src/ports.js");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    await disposeAndExit("ERROR");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it.skip("should not exit in test environment", async () => {
    process.env.NODE_ENV = "test";
    const { disposeAndExit } = await import("../src/ports.js");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    await disposeAndExit("EXIT");
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("tracer", () => {
  it("should trace stuff", () => {
    const tracer = build_tracer("trace");
    tracer.fetched([
      {
        stream: "A",
        source: "B",
        at: 0,
        lagging: true,
        events: [
          {
            id: 1,
            stream: "A",
            name: "B",
            data: { a: 1 },
            created: new Date(),
            meta: { correlation: "1", causation: {} },
            version: 1,
          },
        ],
      },
      {
        stream: "A",
        at: 0,
        lagging: false,
        events: [],
      },
    ]);
    tracer.correlated([
      { stream: "A", source: "B", lagging: false, at: 1, by: "x", retry: 0 },
    ]);
    tracer.leased([
      { stream: "A", source: "B", lagging: false, at: 1, by: "x", retry: 0 },
    ]);
    tracer.acked([
      { stream: "A", source: "B", lagging: false, at: 1, by: "x", retry: 0 },
    ]);
    tracer.blocked([
      {
        stream: "A",
        source: "B",
        lagging: false,
        at: 1,
        by: "x",
        retry: 0,
        error: "error",
      },
    ]);
    expect(tracer).toBeDefined();
  });
});
