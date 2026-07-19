import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferTimer } from "../src/internal/defer-timer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("DeferTimer", () => {
  it("tracks size as streams are parked and dropped", () => {
    const t = new DeferTimer(() => {});
    expect(t.size).toBe(0);
    t.set("a", 1000);
    t.set("b", 2000);
    expect(t.size).toBe(2);
    t.delete("a");
    expect(t.size).toBe(1);
    // deleting an absent stream is a no-op
    t.delete("missing");
    expect(t.size).toBe(1);
  });

  it("is_deferred: absent → false, future → true, past → false", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const t = new DeferTimer(() => {});
    expect(t.is_deferred("a")).toBe(false); // absent
    t.set("a", 1000);
    expect(t.is_deferred("a")).toBe(true); // future
    vi.setSystemTime(1000);
    expect(t.is_deferred("a")).toBe(false); // due now (not strictly future)
    vi.setSystemTime(1500);
    expect(t.is_deferred("a")).toBe(false); // past
  });

  it("set overwrites the prior due-time for a stream", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const t = new DeferTimer(() => {});
    t.set("a", 1000);
    t.set("a", 5000); // overwrite, not merge
    expect(t.size).toBe(1);
    vi.setSystemTime(1000);
    expect(t.is_deferred("a")).toBe(true); // still deferred — uses the later time
  });

  it("wakes once at the earliest due-time and GCs only the come-due entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let wakes = 0;
    const t = new DeferTimer(() => {
      wakes++;
    });
    t.set("soon", 1000);
    t.set("later", 5000);
    t.schedule();

    vi.advanceTimersByTime(999);
    expect(wakes).toBe(0);
    vi.advanceTimersByTime(1); // earliest (1000) elapses
    expect(wakes).toBe(1);
    // "soon" is collected; "later" stays parked.
    expect(t.size).toBe(1);
    expect(t.is_deferred("later")).toBe(true);
  });

  it("schedule with an empty map is a no-op that clears any pending timer", () => {
    vi.useFakeTimers();
    let wakes = 0;
    const t = new DeferTimer(() => {
      wakes++;
    });
    t.set("a", 1000);
    t.schedule();
    // drop the only entry, reschedule with an empty map
    t.delete("a");
    t.schedule();
    vi.advanceTimersByTime(10_000);
    expect(wakes).toBe(0);
  });

  it("rescheduling cancels the prior timer (earliest wins, fires once)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let wakes = 0;
    const t = new DeferTimer(() => {
      wakes++;
    });
    t.set("a", 5000);
    t.schedule();
    // a nearer due-time arrives — reschedule
    t.set("b", 1000);
    t.schedule();
    vi.advanceTimersByTime(1000);
    expect(wakes).toBe(1); // fired at the nearer 1000, prior 5000 timer cancelled
    vi.advanceTimersByTime(5000);
    expect(wakes).toBe(1); // the cancelled timer never fires a second wake
  });

  it("clamps a past-due time to an immediate wake", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let wakes = 0;
    const t = new DeferTimer(() => {
      wakes++;
    });
    t.set("overdue", 1000); // already in the past
    t.schedule();
    vi.advanceTimersByTime(0);
    expect(wakes).toBe(1);
    expect(t.size).toBe(0); // collected on wake
  });

  it("stop cancels a pending wake and is idempotent", () => {
    vi.useFakeTimers();
    let wakes = 0;
    const t = new DeferTimer(() => {
      wakes++;
    });
    t.set("a", 1000);
    t.schedule();
    t.stop();
    t.stop(); // idempotent — no pending timer to clear
    vi.advanceTimersByTime(10_000);
    expect(wakes).toBe(0);
    // parked set is left intact for a later reschedule
    expect(t.size).toBe(1);
  });

  it("clamps a far-future due-time to the 32-bit timer ceiling and re-arms", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let wakes = 0;
    const t = new DeferTimer(() => {
      wakes++;
    });
    // 90 days out — well past setTimeout's ~24.8-day ceiling.
    t.set("far", 90 * 86_400_000);
    t.schedule();
    // Does not fire before the ceiling (would overflow → fire-now without the clamp).
    vi.advanceTimersByTime(2_147_483_646);
    expect(wakes).toBe(0);
    // Wakes at the ceiling; the still-future entry survives for a re-arm.
    vi.advanceTimersByTime(1);
    expect(wakes).toBe(1);
    expect(t.size).toBe(1);
    expect(t.is_deferred("far")).toBe(true);
    // #1288: the timer must self-re-arm — the consumer's on_wake here does
    // nothing. Advancing past the real due-time must fire again (through the
    // intermediate ceiling clamps) and finally GC the entry. Without the
    // re-arm, wakes stays 1 and the entry leaks in the parked set forever.
    vi.advanceTimersByTime(90 * 86_400_000);
    expect(wakes).toBeGreaterThan(1);
    expect(t.size).toBe(0);
    expect(t.is_deferred("far")).toBe(false);
  });
});
