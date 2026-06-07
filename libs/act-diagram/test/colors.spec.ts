import { describe, expect, it, vi } from "vitest";

describe("colors", () => {
  it("emits 256-color escapes when picocolors reports support", async () => {
    vi.resetModules();
    vi.doMock("picocolors", () => ({
      default: {
        isColorSupported: true,
        dim: (s: string) => `D:${s}`,
        bold: (s: string) => `B:${s}`,
        red: (s: string) => s,
        green: (s: string) => s,
        cyan: (s: string) => s,
      },
    }));
    const colors = await import("../src/cli/colors.js");
    expect(colors.orange("x")).toBe("\x1b[22m\x1b[38;5;208mx\x1b[39m");
    expect(colors.violet("y")).toContain("141m");
    expect(colors.cornflower("y")).toContain("33m");
    expect(colors.kind_color.event("z")).toContain("208m");
    expect(colors.kind_color.action("z")).toContain("33m"); // cornflower blue
    // CANCEL_DIM is included so clack's outer dim wrap doesn't wash out
    // inactive option labels.
    expect(colors.orange("x").startsWith("\x1b[22m")).toBe(true);
    // muted uses a brighter grey (248), not SGR dim, so detail dialogs
    // stay legible.
    expect(colors.muted("hi")).toContain("248m");
    // Compat aliases still resolve to the action color.
    expect(colors.pink("y")).toBe(colors.cornflower("y"));
    expect(colors.lilac("y")).toBe(colors.cornflower("y"));
    vi.doUnmock("picocolors");
    vi.resetModules();
  });

  it("returns raw strings when picocolors reports no support", async () => {
    vi.resetModules();
    vi.doMock("picocolors", () => ({
      default: {
        isColorSupported: false,
        dim: (s: string) => s,
        bold: (s: string) => s,
        red: (s: string) => s,
        green: (s: string) => s,
        cyan: (s: string) => s,
      },
    }));
    const colors = await import("../src/cli/colors.js");
    expect(colors.orange("hello")).toBe("hello");
    expect(colors.muted("hello")).toBe("hello");
    expect(colors.kind_color.slice("S")).toBe("S");
    vi.doUnmock("picocolors");
    vi.resetModules();
  });
});
