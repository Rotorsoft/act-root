import { PinoLogger } from "../src/PinoLogger.js";

describe("PinoLogger", () => {
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

  it("creates with default options", () => {
    const logger = new PinoLogger({ pretty: false });
    expect(logger.level).toBe("error"); // test env default
  });

  it("creates with custom level", () => {
    const logger = new PinoLogger({ level: "debug", pretty: false });
    expect(logger.level).toBe("debug");
  });

  it("allows setting level", () => {
    const logger = new PinoLogger({ level: "info", pretty: false });
    logger.level = "debug";
    expect(logger.level).toBe("debug");
  });

  it("logs string messages", () => {
    const logger = new PinoLogger({ level: "trace", pretty: false });
    logger.info("hello");
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.msg).toBe("hello");
    expect(parsed.level).toBe(30); // pino info level
  });

  it("logs object with message", () => {
    const logger = new PinoLogger({ level: "trace", pretty: false });
    logger.info({ key: "val" }, "context");
    const parsed = JSON.parse(output[0]);
    expect(parsed.key).toBe("val");
    expect(parsed.msg).toBe("context");
  });

  it("logs object without message", () => {
    const logger = new PinoLogger({ level: "trace", pretty: false });
    logger.info({ key: "val" });
    const parsed = JSON.parse(output[0]);
    expect(parsed.key).toBe("val");
  });

  it("logs all levels", () => {
    const logger = new PinoLogger({ level: "trace", pretty: false });
    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");
    expect(output).toHaveLength(6);

    const levels = output.map((line) => JSON.parse(line).level);
    expect(levels).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("creates child logger with bindings", () => {
    const logger = new PinoLogger({ level: "trace", pretty: false });
    const child = logger.child({ requestId: "abc" });
    child.info("from child");
    const parsed = JSON.parse(output[0]);
    expect(parsed.requestId).toBe("abc");
    expect(parsed.msg).toBe("from child");
  });

  it("child inherits level", () => {
    const logger = new PinoLogger({ level: "error", pretty: false });
    const child = logger.child({ ctx: "test" });
    child.info("should not appear");
    expect(output).toHaveLength(0);
    child.error("should appear");
    expect(output).toHaveLength(1);
  });

  it("dispose flushes without error", async () => {
    const logger = new PinoLogger({ level: "info", pretty: false });
    await expect(logger.dispose()).resolves.toBeUndefined();
  });

  it("creates with pretty mode", () => {
    const logger = new PinoLogger({ level: "info", pretty: true });
    expect(logger.level).toBe("info");
  });

  it("creates with custom pino options", () => {
    const logger = new PinoLogger({
      level: "info",
      pretty: false,
      options: { name: "test-app" },
    });
    logger.info("with name");
    const parsed = JSON.parse(output[0]);
    expect(parsed.name).toBe("test-app");
  });

  it("passes non-pretty transport from options", () => {
    const logger = new PinoLogger({
      level: "info",
      pretty: false,
      options: {},
    });
    logger.info("no transport");
    expect(output).toHaveLength(1);
  });
});
