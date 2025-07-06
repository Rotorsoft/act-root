import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs to control package.json content
vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue(
    JSON.stringify({
      name: "test-pkg",
      version: "1.0.0",
      description: "A test package",
      author: "tester",
      license: "MIT",
      dependencies: {},
    })
  ),
}));

describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  it("should default to development when NODE_ENV is not set", async () => {
    delete process.env.NODE_ENV;
    const { config: loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.env).toBe("development");
    expect(config.logLevel).toBe("trace");
  });

  it("should handle test environment", async () => {
    process.env.NODE_ENV = "test";
    const { config: loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.env).toBe("test");
    expect(config.logLevel).toBe("error");
    expect(config.sleepMs).toBe(0);
  });

  it("should handle production environment", async () => {
    process.env.NODE_ENV = "production";
    // The logic checks for NODE_ENV, not LOG_LEVEL for this branch
    const { config: loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.env).toBe("production");
    // This is based on the logic: LOG_LEVEL is not set, NODE_ENV is prod
    const expectedLogLevel =
      process.env.NODE_ENV === "production" ? "info" : "trace";
    expect(config.logLevel).toBe(expectedLogLevel);
  });

  it("should respect explicit LOG_LEVEL", async () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "warn";
    const { config: loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.logLevel).toBe("warn");
  });

  it("should handle LOG_SINGLE_LINE", async () => {
    process.env.LOG_SINGLE_LINE = "false";
    const { config: loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.logSingleLine).toBe(false);
  });

  it("should handle SLEEP_MS", async () => {
    process.env.NODE_ENV = "development"; // Not test env
    process.env.SLEEP_MS = "500";
    const { config: loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.sleepMs).toBe(500);
  });

  it("should set logLevel based on NODE_ENV and LOG_LEVEL", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "warn";
    const { config } = await import("../src/config.js");
    // The config logic uses LOG_LEVEL if set, even in test mode
    expect(config().logLevel).toBe("warn");
    process.env.NODE_ENV = "production";
    process.env.LOG_LEVEL = "info";
    vi.resetModules();
    const { config: config2 } = await import("../src/config.js");
    expect(config2().logLevel).toBe("info");
  });

  it("should set logLevel to 'trace' if not test or production", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.LOG_LEVEL;
    const { config: loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.logLevel).toBe("trace");
  });
});
