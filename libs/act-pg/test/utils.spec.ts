import { dateReviver } from "../src/utils.js";

describe("act-pg utils", () => {
  it("should roll over invalid dates that pass regex", () => {
    const invalidDateString = "2023-02-30T10:00:00.000Z"; // Rolls over to March 2
    const result = dateReviver("key", invalidDateString) as Date;
    expect(result).toBeInstanceOf(Date);
    expect(result.getUTCFullYear()).toBe(2023);
    expect(result.getUTCMonth()).toBe(2); // 0-indexed, so 2 is March
    expect(result.getUTCDate()).toBe(2);
  });

  it("should return a Date object for a valid ISO 8601 string", () => {
    const validDateString = "2023-01-01T10:00:00.000Z";
    const result = dateReviver("key", validDateString);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe(validDateString);
  });

  it("should return original value for non-string values", () => {
    const notAString = 12345;
    // @ts-expect-error - testing with non-string value
    const result = dateReviver("key", notAString);
    expect(result).toBe(notAString);
  });

  it("should return original string for non-date strings", () => {
    const notADate = "hello world";
    const result = dateReviver("key", notADate);
    expect(result).toBe(notADate);
  });
});
