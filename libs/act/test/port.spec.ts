const exitSpy = vi.spyOn(await import("../src/ports"), "disposeAndExit");
const disposeSpy = vi.fn();

// to register signal handlers
import { dispose } from "../src";

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
});
