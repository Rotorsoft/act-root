const disposeAndExitSpy = vi.spyOn(
  await import("../src/ports.js"),
  "disposeAndExit"
);
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
    // Stub instead of mutating process.env directly — vi.unstubAllEnvs() in
    // afterEach restores it, otherwise the change leaks into subsequent test
    // files (config.ts re-evaluates env on import). LOG_LEVEL=fatal silences
    // the registration info log and the production-ignore warn breadcrumb,
    // both of which are tested for behavior, not log content.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_LEVEL", "fatal");
    const { disposeAndExit } = await import("../src/ports.js");
    await expect(disposeAndExit("ERROR")).resolves.toBeUndefined();
  });

  it("should exit with code 1 on error", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LOG_LEVEL", "fatal");
    const { disposeAndExit } = await import("../src/ports.js");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    await disposeAndExit("ERROR");
    expect(exit).toHaveBeenCalledWith(1);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
});
