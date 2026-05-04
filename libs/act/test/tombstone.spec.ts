import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { tombstone } from "../src/internal/event-sourcing.js";
import { dispose, store } from "../src/ports.js";

describe("tombstone", () => {
  beforeEach(() => {
    store(new InMemoryStore());
  });

  afterEach(async () => {
    await dispose()();
    vi.restoreAllMocks();
  });

  it("returns the committed event on success", async () => {
    const committed = await tombstone("ts-stream", -1, "corr-1");
    expect(committed).toBeDefined();
    expect(committed!.name).toBe("__tombstone__");
    expect(committed!.stream).toBe("ts-stream");
  });

  it("returns undefined on ConcurrencyError (someone wrote first)", async () => {
    await tombstone("ts-race", -1, "corr-2");
    // Second tombstone at the same expected version → ConcurrencyError → undefined
    const second = await tombstone("ts-race", -1, "corr-3");
    expect(second).toBeUndefined();
  });

  it("re-throws non-ConcurrencyError commit failures", async () => {
    vi.spyOn(store(), "commit").mockRejectedValueOnce(new Error("disk full"));
    await expect(tombstone("ts-fail", -1, "corr-4")).rejects.toThrow(
      "disk full"
    );
  });
});
