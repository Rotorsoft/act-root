import { PinoLogger } from "../src/pino-logger.js";

const calls = vi.hoisted(() => [] as Array<Record<string, any>>);
vi.mock("pino", async (actual) => {
  const real = (await actual()) as { pino: (...args: any[]) => unknown };
  return {
    ...real,
    pino: (options: Record<string, any>) => {
      calls.push(options);
      return real.pino({ ...options, transport: undefined });
    },
  };
});

describe("PinoLogger pretty transport", () => {
  it("passes LOG_SINGLE_LINE under the name pino-pretty reads", () => {
    new PinoLogger({ pretty: true });
    const options = calls.at(-1)?.transport.options;
    expect(options).toHaveProperty("singleLine", true);
    expect(options).not.toHaveProperty("single_line");
  });
});
