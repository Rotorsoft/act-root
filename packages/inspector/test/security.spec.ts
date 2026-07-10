/**
 * Security regression tests for #1194 / #1195.
 *
 * #1194 — the `transfer` mutation built `CsvFile` / `SqliteStore`
 * adapters straight from client-supplied file paths with no
 * validation, letting a client read (`/etc/passwd`) or clobber
 * (`~/.bashrc`) arbitrary server-side files, and the destructive
 * transfer path was never gated by write-mode. These tests pin the
 * cwd-relative path guard and the write-mode gate.
 *
 * #1195 — the ssl-option mapping and the bind-host default. Unit-level,
 * exercised through the exported pure helpers so they stay covered
 * without booting the HTTP server.
 *
 * This file runs with ACT_INSPECTOR_WRITE unset — the default
 * read-only inspector — so the write-mode refusals are exercised as an
 * operator would hit them.
 */
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { SqliteStore } from "@rotorsoft/act-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The path-guard tests exercise the guard *after* the write-mode gate,
// so write-mode is enabled here (like write.spec / transfer.spec). The
// write-mode *refusal* is covered separately in write-gate.spec.ts,
// which runs with write-mode off.
vi.hoisted(() => {
  process.env.ACT_INSPECTOR_WRITE = "1";
});

const { inspectorRouter, resolveSslConfig, resolveUnderCwd } = await import(
  "../src/server/router.js"
);
const {
  DEFAULT_BIND_HOST,
  isOriginAllowed,
  mutationOriginAllowed,
  resolveBindHost,
} = await import("../src/server/security.js");

const caller = inspectorRouter.createCaller({});

let dir: string;
let rel: (name: string) => string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), "act-inspector-security-"));
  rel = (name) => path.relative(process.cwd(), path.join(dir, name));
});

afterEach(async () => {
  await caller.disconnect();
  await rm(dir, { recursive: true, force: true });
});

/** Build a valid in-cwd SQLite source so the guard is the only thing under test. */
async function buildRelativeSqlite(name: string, n: number): Promise<string> {
  const relPath = rel(name);
  const store = new SqliteStore({ url: `file:${path.join(dir, name)}` });
  try {
    await store.seed();
    for (let i = 0; i < n; i++)
      await store.commit("s1", [{ name: "Tick", data: { i } }], {
        correlation: "test",
        causation: {},
      });
  } finally {
    await store.dispose();
  }
  return relPath;
}

describe("#1194 path guard — transfer rejects out-of-cwd file paths", () => {
  it("rejects an absolute source path outside cwd (arbitrary read)", async () => {
    await expect(
      caller.transfer({
        source: { adapter: "csv", file: "/etc/hostname" },
        target: { adapter: "current" },
      })
    ).rejects.toThrow(/relative path under the inspector cwd/i);
  });

  it("rejects an absolute target path outside cwd (arbitrary write)", async () => {
    const src = await buildRelativeSqlite("sec-src-abs.sqlite", 1);
    await expect(
      caller.transfer({
        source: { adapter: "sqlite", file: src, table: "events" },
        target: { adapter: "csv", file: "/tmp/act-inspector-evil.csv" },
      })
    ).rejects.toThrow(/relative path under the inspector cwd/i);
  });

  it("rejects a `..` traversal path (arbitrary read)", async () => {
    await expect(
      caller.transfer({
        source: { adapter: "csv", file: "../../etc/passwd" },
        target: { adapter: "current" },
      })
    ).rejects.toThrow(/relative path under the inspector cwd/i);
  });

  it("rejects a `..` traversal sqlite target path", async () => {
    const src = await buildRelativeSqlite("sec-src-trav.sqlite", 1);
    await expect(
      caller.transfer({
        source: { adapter: "sqlite", file: src, table: "events" },
        target: {
          adapter: "sqlite",
          file: "../escape.sqlite",
          table: "events",
        },
      })
    ).rejects.toThrow(/relative path under the inspector cwd/i);
  });

  it("allows a legitimate in-cwd relative-path transfer", async () => {
    const src = await buildRelativeSqlite("sec-src-ok.sqlite", 3);
    const result = await caller.transfer({
      source: { adapter: "sqlite", file: src, table: "events" },
      target: { adapter: "csv", file: rel("sec-out-ok.csv") },
    });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
  });
});

describe("#1194 resolveUnderCwd", () => {
  it("resolves an in-cwd relative path to an absolute path", () => {
    expect(resolveUnderCwd("sub/file.csv", "csv file")).toBe(
      path.join(process.cwd(), "sub/file.csv")
    );
  });

  it("rejects an absolute path with the labelled error", () => {
    expect(() => resolveUnderCwd("/etc/passwd", "csv file")).toThrow(
      /csv file must be a relative path under the inspector cwd/
    );
  });

  it("rejects a `..` traversal path with the labelled error", () => {
    expect(() => resolveUnderCwd("../x", "sqlite file")).toThrow(
      /sqlite file must be a relative path under the inspector cwd/
    );
  });
});

describe("#1195 ssl-option mapping", () => {
  it("maps ssl:true to verified TLS (rejectUnauthorized:true)", () => {
    expect(resolveSslConfig(true, false)).toEqual({ rejectUnauthorized: true });
  });

  it("maps the explicit insecure opt-out to rejectUnauthorized:false and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveSslConfig(true, true)).toEqual({ rejectUnauthorized: false });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/certificate verification is DISABLED/i)
    );
    warn.mockRestore();
  });

  it("returns undefined when ssl is off", () => {
    expect(resolveSslConfig(false, false)).toBeUndefined();
    expect(resolveSslConfig(false, true)).toBeUndefined();
  });
});

describe("#1195 resolveBindHost", () => {
  it("defaults to loopback and does not warn", () => {
    const warn = vi.fn();
    expect(resolveBindHost(undefined, warn)).toBe(DEFAULT_BIND_HOST);
    expect(resolveBindHost("", warn)).toBe(DEFAULT_BIND_HOST);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps an explicit loopback host without warning", () => {
    const warn = vi.fn();
    expect(resolveBindHost("::1", warn)).toBe("::1");
    expect(resolveBindHost("localhost", warn)).toBe("localhost");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when binding to a non-loopback host", () => {
    const warn = vi.fn();
    expect(resolveBindHost("0.0.0.0", warn)).toBe("0.0.0.0");
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/reachable from the network/i)
    );
  });

  it("uses console.warn by default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveBindHost("0.0.0.0")).toBe("0.0.0.0");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("#1195 CORS origin decisions", () => {
  it("echoes only the exact origin when an allowlist is configured", () => {
    expect(isOriginAllowed("https://app.example", "https://app.example")).toBe(
      true
    );
    expect(isOriginAllowed("https://evil.example", "https://app.example")).toBe(
      false
    );
  });

  it("allows any localhost origin in local dev (no allowlist)", () => {
    expect(isOriginAllowed("http://localhost:5173", undefined)).toBe(true);
    expect(isOriginAllowed("https://localhost", undefined)).toBe(true);
    expect(isOriginAllowed("https://evil.example", undefined)).toBe(false);
  });

  it("allows origin-less reads in local dev", () => {
    expect(isOriginAllowed(undefined, undefined)).toBe(true);
  });

  it("refuses origin-less mutations in local dev (CSRF hardening)", () => {
    expect(mutationOriginAllowed(undefined, undefined)).toBe(false);
  });

  it("allows a localhost-origin mutation in local dev", () => {
    expect(mutationOriginAllowed("http://localhost:5173", undefined)).toBe(
      true
    );
    expect(mutationOriginAllowed("https://evil.example", undefined)).toBe(
      false
    );
  });

  it("requires an exact allowlist match for mutations when configured", () => {
    expect(
      mutationOriginAllowed("https://app.example", "https://app.example")
    ).toBe(true);
    expect(mutationOriginAllowed(undefined, "https://app.example")).toBe(false);
    expect(
      mutationOriginAllowed("https://evil.example", "https://app.example")
    ).toBe(false);
  });
});
