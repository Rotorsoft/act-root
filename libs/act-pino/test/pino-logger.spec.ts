import { PinoLogger } from "../src/pino-logger.js";

/** `process.report.getReport()` is typed as `object`; this is the one field we read. */
const worker_count = (): number =>
  (process.report.getReport() as unknown as { workers: unknown[] }).workers
    .length;

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
    expect(logger.level).toBe("fatal"); // test env default
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

  it("keeps the context message when the payload is a string (#1319)", () => {
    const logger = new PinoLogger({ level: "trace", pretty: false });
    logger.error("db connection lost", "Unhandled Rejection");
    const parsed = JSON.parse(output[0]);
    // The caller's message must survive, not be dropped for the payload.
    expect(parsed.msg).toBe("Unhandled Rejection");
    expect(parsed.payload).toBe("db connection lost");
    expect(parsed.level).toBe(50);
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
    const child = logger.child({ request_id: "abc" });
    child.info("from child");
    const parsed = JSON.parse(output[0]);
    expect(parsed.request_id).toBe("abc");
    expect(parsed.msg).toBe("from child");
  });

  it("child() spawns no transport worker (#1705)", async () => {
    // `child()` used to run the whole constructor, which builds a pino
    // instance — and a pino-pretty thread-stream Worker when `pretty` is on,
    // the default outside production — then discarded it. Since `child()` is
    // the per-request-context API, that leaked one OS thread per request.
    //
    // `pretty: true` is the point: the TCK and every other case here use
    // `pretty: false`, which creates no worker and so cannot see this.
    const logger = new PinoLogger({ pretty: true });
    // Let the base logger's own transport thread come up first.
    await new Promise((r) => setTimeout(r, 200));
    const before = worker_count();

    for (let i = 0; i < 5; i++) logger.child({ i });
    await new Promise((r) => setTimeout(r, 300));

    expect(worker_count()).toBe(before);
  });

  it("a child built without the constructor still logs and nests (#1705)", () => {
    // `Object.create(prototype)` skips field initialization, so prove the
    // instance is still whole: it logs, carries its bindings, and a
    // grandchild works — i.e. `child()` is callable on a child.
    const logger = new PinoLogger({ level: "trace", pretty: false });
    const child = logger.child({ a: 1 });
    const grandchild = child.child({ b: 2 });
    grandchild.info("nested");
    const parsed = JSON.parse(output[0]);
    expect(parsed.a).toBe(1);
    expect(parsed.b).toBe(2);
    expect(parsed.msg).toBe("nested");
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
