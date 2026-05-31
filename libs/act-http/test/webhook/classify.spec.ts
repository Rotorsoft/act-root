import { describe, expect, it } from "vitest";
import { classifyHttpResponse } from "../../src/webhook/classify.js";

function response(status: number): Response {
  return new Response(null, { status });
}

describe("classifyHttpResponse", () => {
  describe("ok (2xx)", () => {
    it("classifies 200 as ok", () => {
      expect(classifyHttpResponse(response(200))).toBe("ok");
    });

    it("classifies 204 as ok", () => {
      expect(classifyHttpResponse(response(204))).toBe("ok");
    });
  });

  describe("retry (5xx)", () => {
    it("classifies 500 as retry", () => {
      expect(classifyHttpResponse(response(500))).toBe("retry");
    });

    it("classifies 503 as retry", () => {
      expect(classifyHttpResponse(response(503))).toBe("retry");
    });
  });

  describe("block (3xx, 4xx)", () => {
    it("classifies 301 as block", () => {
      expect(classifyHttpResponse(response(301))).toBe("block");
    });

    it("classifies 400 as block", () => {
      expect(classifyHttpResponse(response(400))).toBe("block");
    });

    it("classifies 403 as block", () => {
      expect(classifyHttpResponse(response(403))).toBe("block");
    });

    it("classifies 422 as block", () => {
      expect(classifyHttpResponse(response(422))).toBe("block");
    });
  });
});
