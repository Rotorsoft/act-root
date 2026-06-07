import {
  ConcurrencyError,
  InvariantError,
  NonRetryableError,
  StreamClosedError,
  ValidationError,
} from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { ERROR_MAP, toApiError } from "../../src/api/index.js";

describe("ERROR_MAP", () => {
  it("declares one entry per recognized framework error", () => {
    expect(Object.keys(ERROR_MAP).sort()).toEqual([
      "ConcurrencyError",
      "InvariantError",
      "NonRetryableError",
      "StreamClosedError",
      "ValidationError",
    ]);
  });

  it("uses the expected HTTP status + code per entry", () => {
    expect(ERROR_MAP.ValidationError).toEqual({
      status: 422,
      code: "VALIDATION",
    });
    expect(ERROR_MAP.InvariantError).toEqual({
      status: 409,
      code: "INVARIANT",
    });
    expect(ERROR_MAP.ConcurrencyError).toEqual({
      status: 412,
      code: "CONCURRENCY",
    });
    expect(ERROR_MAP.StreamClosedError).toEqual({
      status: 410,
      code: "STREAM_CLOSED",
    });
    expect(ERROR_MAP.NonRetryableError).toEqual({
      status: 400,
      code: "NON_RETRYABLE",
    });
  });
});

describe("toApiError", () => {
  it("maps ValidationError to 422 + VALIDATION", () => {
    const err = new ValidationError("doIt", { foo: "bar" }, {
      issues: [],
      name: "ZodError",
    } as unknown as import("zod").ZodError);
    const result = toApiError(err);
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      error: "ValidationError",
      code: "VALIDATION",
    });
    expect(result.body.detail).toBe(err.message);
  });

  it("maps InvariantError to 409 + INVARIANT", () => {
    const err = new InvariantError(
      "doIt",
      // biome-ignore lint/suspicious/noExplicitAny: placeholder payload for the mapping test
      { foo: "bar" } as any,
      { stream: "s", actor: { id: "1", name: "u" } },
      // biome-ignore lint/suspicious/noExplicitAny: minimal snapshot stand-in for the mapping test
      {} as any,
      "guard tripped"
    );
    const result = toApiError(err);
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("InvariantError");
    expect(result.body.code).toBe("INVARIANT");
    expect(result.body.detail).toBe(err.message);
  });

  it("maps ConcurrencyError to 412 + CONCURRENCY", () => {
    const err = new ConcurrencyError("order-1", 1, [], 2);
    const result = toApiError(err);
    expect(result.status).toBe(412);
    expect(result.body).toMatchObject({
      error: "ConcurrencyError",
      code: "CONCURRENCY",
    });
    expect(result.body.detail).toBe(err.message);
  });

  it("maps StreamClosedError to 410 + STREAM_CLOSED", () => {
    const err = new StreamClosedError("order-1");
    const result = toApiError(err);
    expect(result.status).toBe(410);
    expect(result.body).toMatchObject({
      error: "StreamClosedError",
      code: "STREAM_CLOSED",
    });
    expect(result.body.detail).toBe(err.message);
  });

  it("maps NonRetryableError to 400 + NON_RETRYABLE", () => {
    const err = new NonRetryableError("permanent failure");
    const result = toApiError(err);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: "NonRetryableError",
      code: "NON_RETRYABLE",
    });
    expect(result.body.detail).toBe(err.message);
  });

  it("maps an unknown Error to 500 + INTERNAL with detail", () => {
    const err = new Error("oops");
    const result = toApiError(err);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: "InternalError",
      detail: "oops",
      code: "INTERNAL",
    });
  });

  it("maps a non-Error throw to 500 + INTERNAL without detail", () => {
    const result = toApiError("a string was thrown");
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: "InternalError",
      code: "INTERNAL",
    });
    expect(result.body.detail).toBeUndefined();
  });

  it("handles null / undefined throws as 500 without detail", () => {
    expect(toApiError(null).status).toBe(500);
    expect(toApiError(null).body.detail).toBeUndefined();
    expect(toApiError(undefined).body).toEqual({
      error: "InternalError",
      code: "INTERNAL",
    });
  });
});
