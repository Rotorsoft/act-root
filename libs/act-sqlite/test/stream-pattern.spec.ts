import { streamPatternToLike } from "../src/SqliteStore.js";

describe("streamPatternToLike", () => {
  describe("anchors", () => {
    it("strips both anchors → exact match", () => {
      expect(streamPatternToLike("^abc$")).toBe("abc");
    });

    it("strips leading ^ only → starts-with", () => {
      expect(streamPatternToLike("^abc")).toBe("abc%");
    });

    it("strips trailing $ only → ends-with", () => {
      expect(streamPatternToLike("abc$")).toBe("%abc");
    });

    it("no anchors → contains (both sides padded)", () => {
      expect(streamPatternToLike("abc")).toBe("%abc%");
    });

    it("handles empty input with both anchors", () => {
      expect(streamPatternToLike("^$")).toBe("");
    });

    it("handles empty input with no anchors (collapsed to %)", () => {
      expect(streamPatternToLike("")).toBe("%");
    });
  });

  describe("wildcards", () => {
    it("converts .* to % when anchored", () => {
      expect(streamPatternToLike("^abc.*$")).toBe("abc%");
    });

    it("converts .* to % when unanchored (still contains)", () => {
      // unanchored gets %-padded; .* becomes %; adjacent %s are collapsed
      expect(streamPatternToLike("abc.*")).toBe("%abc%");
    });

    it("converts single . to _ (single-char wildcard)", () => {
      expect(streamPatternToLike("^a.c$")).toBe("a_c");
    });

    it("converts mixed . and .* in a single pattern", () => {
      expect(streamPatternToLike("^a.b.*c$")).toBe("a_b%c");
    });

    it("handles only-wildcard pattern .*", () => {
      expect(streamPatternToLike("^.*$")).toBe("%");
    });
  });

  describe("realistic patterns", () => {
    it("starts-with via ^prefix.*", () => {
      expect(streamPatternToLike("^order-.*")).toBe("order-%");
    });

    it("starts-with via ^prefix (no .*)", () => {
      expect(streamPatternToLike("^order-")).toBe("order-%");
    });

    it("ends-with via .*suffix$", () => {
      expect(streamPatternToLike(".*-archive$")).toBe("%-archive");
    });

    it("contains via plain substring", () => {
      expect(streamPatternToLike("user")).toBe("%user%");
    });
  });
});
