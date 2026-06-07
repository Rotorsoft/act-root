import { ConsoleLogger } from "../src/adapters/console-logger.js";

describe("ConsoleLogger", () => {
  let output: string[];
  const originalWrite = process.stdout.write.bind(process.stdout);

  beforeEach(() => {
    output = [];
    process.stdout.write = (chunk: string | Uint8Array) => {
      output.push(chunk.toString());
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  describe("pretty mode", () => {
    it("logs string messages", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: true });
      logger.info("hello");
      expect(output).toHaveLength(1);
      expect(output[0]).toContain("INFO");
      expect(output[0]).toContain("hello");
    });

    it("logs object with message", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: true });
      logger.info({ key: "val" }, "context");
      expect(output[0]).toContain("context");
      expect(output[0]).toContain('"key":"val"');
    });

    it("logs object without message", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: true });
      logger.info({ key: "val" });
      expect(output[0]).toContain('"key":"val"');
    });

    it("logs null without crashing", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: true });
      logger.info(null, "null value");
      expect(output[0]).toContain("null value");
    });

    it("handles non-serializable objects", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: true });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      logger.info(circular, "circular");
      expect(output[0]).toContain("circular");
    });

    it("includes bindings in output", () => {
      const logger = new ConsoleLogger({
        level: "trace",
        pretty: true,
        bindings: { service: "test" },
      });
      logger.info("with bindings");
      expect(output[0]).toContain("service");
      expect(output[0]).toContain("test");
    });

    it("logs all levels", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: true });
      logger.fatal("f");
      logger.error("e");
      logger.warn("w");
      logger.info("i");
      logger.debug("d");
      logger.trace("t");
      expect(output).toHaveLength(6);
      expect(output[0]).toContain("FATAL");
      expect(output[1]).toContain("ERROR");
      expect(output[2]).toContain("WARN");
      expect(output[3]).toContain("INFO");
      expect(output[4]).toContain("DEBUG");
      expect(output[5]).toContain("TRACE");
    });

    it("renders Error instances with their message + stack, not '{}'", () => {
      // JSON.stringify(err) === "{}" — operators staring at "ERROR {}"
      // wasn't useful. ConsoleLogger now extracts the Error fields.
      const logger = new ConsoleLogger({ level: "trace", pretty: true });
      const err = new Error("boom");
      logger.error(err);
      expect(output[0]).toContain("ERROR");
      expect(output[0]).toContain("boom");
      // Stack is data; in pretty mode it's the trailing payload.
      expect(output[0]).toContain("Error: boom");
    });

    it("uses supplied msg ahead of Error.message when both are provided", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: true });
      logger.error(new Error("inner"), "handler threw");
      expect(output[0]).toContain("handler threw");
      // Message replaces err.message; the stack still trails.
      expect(output[0]).toContain("Error: inner");
    });
  });

  describe("json mode", () => {
    it("logs string messages as JSON", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: false });
      logger.info("hello");
      const parsed = JSON.parse(output[0]);
      expect(parsed.level).toBe("info");
      expect(parsed.msg).toBe("hello");
      expect(parsed.time).toBeTypeOf("number");
    });

    it("logs object with message as JSON", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: false });
      logger.info({ key: "val" }, "context");
      const parsed = JSON.parse(output[0]);
      expect(parsed.key).toBe("val");
      expect(parsed.msg).toBe("context");
    });

    it("logs object without message as JSON", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: false });
      logger.info({ key: "val" });
      const parsed = JSON.parse(output[0]);
      expect(parsed.key).toBe("val");
      expect(parsed.msg).toBeUndefined();
    });

    it("wraps primitives in value field", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: false });
      logger.info(42, "number");
      const parsed = JSON.parse(output[0]);
      expect(parsed.value).toBe(42);
      expect(parsed.msg).toBe("number");
    });

    it("includes bindings in JSON", () => {
      const logger = new ConsoleLogger({
        level: "trace",
        pretty: false,
        bindings: { service: "test" },
      });
      logger.info("with bindings");
      const parsed = JSON.parse(output[0]);
      expect(parsed.service).toBe("test");
    });

    it("captures Error name/message/stack as structured fields", () => {
      // JSON.stringify(err) === "{}" — JSON mode previously emitted
      // empty objects for Error logs. Now the Error fields land
      // explicitly so log aggregators can index them.
      const logger = new ConsoleLogger({ level: "trace", pretty: false });
      const err = new TypeError("nope");
      logger.error(err);
      const parsed = JSON.parse(output[0]);
      expect(parsed.error?.message).toBe("nope");
      expect(parsed.error?.name).toBe("TypeError");
      expect(parsed.stack).toContain("TypeError: nope");
      expect(parsed.msg).toBe("nope");
    });
  });

  describe("level gating", () => {
    it("gates lower levels as noop", () => {
      const logger = new ConsoleLogger({ level: "error", pretty: true });
      logger.trace("should not appear");
      logger.debug("should not appear");
      logger.info("should not appear");
      logger.warn("should not appear");
      expect(output).toHaveLength(0);
      logger.error("should appear");
      logger.fatal("should appear");
      expect(output).toHaveLength(2);
    });

    it("defaults to info level", () => {
      const logger = new ConsoleLogger({ pretty: true });
      expect(logger.level).toBe("info");
    });

    it("gates all levels below fatal", () => {
      const logger = new ConsoleLogger({ level: "fatal", pretty: true });
      logger.error("should not appear");
      logger.warn("should not appear");
      logger.info("should not appear");
      logger.debug("should not appear");
      logger.trace("should not appear");
      expect(output).toHaveLength(0);
      logger.fatal("should appear");
      expect(output).toHaveLength(1);
    });

    it("handles unknown level with default threshold", () => {
      const logger = new ConsoleLogger({ level: "custom", pretty: true });
      logger.info("should appear at default threshold");
      expect(output).toHaveLength(1);
    });
  });

  describe("child", () => {
    it("creates child logger with bindings", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: false });
      const child = logger.child({ request_id: "abc" });
      child.info("from child");
      const parsed = JSON.parse(output[0]);
      expect(parsed.request_id).toBe("abc");
      expect(parsed.msg).toBe("from child");
    });

    it("inherits level from parent", () => {
      const logger = new ConsoleLogger({ level: "error", pretty: true });
      const child = logger.child({ ctx: "test" });
      child.info("should not appear");
      expect(output).toHaveLength(0);
      child.error("should appear");
      expect(output).toHaveLength(1);
    });
  });

  describe("dispose", () => {
    it("resolves without error", async () => {
      const logger = new ConsoleLogger();
      await expect(logger.dispose()).resolves.toBeUndefined();
    });
  });

  describe("cyclic payload", () => {
    it("json mode emits a minimal line instead of crashing", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: false });
      const cyclic: Record<string, unknown> = { name: "loop" };
      cyclic.self = cyclic;
      logger.info(cyclic, "cycle test");
      expect(output).toHaveLength(1);
      const parsed = JSON.parse(output[0]) as Record<string, unknown>;
      expect(parsed.unserializable).toBe(true);
      expect(parsed.msg).toBe("cycle test");
    });

    it("json mode falls back to a placeholder msg when none was provided", () => {
      const logger = new ConsoleLogger({ level: "trace", pretty: false });
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      logger.info(cyclic);
      const parsed = JSON.parse(output[0]) as Record<string, unknown>;
      expect(parsed.unserializable).toBe(true);
      expect(parsed.msg).toBe("[unserializable]");
    });
  });
});
