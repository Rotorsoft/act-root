import { expect, it, vi } from "vitest";

it("should handle error in snap", async () => {
  vi.resetModules();
  const fakeLogger = { error: vi.fn(), trace: vi.fn() };
  vi.doMock("../src/ports.js", async (importOriginal) => {
    const actual = await importOriginal();
    return Object.assign({}, actual, {
      store: () => ({ commit: vi.fn().mockRejectedValue(new Error("fail")) }),
      logger: fakeLogger,
    });
  });
  const { snap } = await import("../src/event-sourcing.js");
  await snap({
    event: {
      id: 1,
      stream: "s",
      name: "E",
      meta: { correlation: "c", causation: {} },
      version: 1,
      data: {},
      created: new Date(),
    },
    state: {},
    patches: 0,
    snaps: 0,
  });
  expect(fakeLogger.error).toHaveBeenCalled();
});
