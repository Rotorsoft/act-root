import { ValidationError } from "@rotorsoft/act";
import { streamPatternToLike } from "../src/sqlite-store.js";

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

  describe("LIKE metacharacter escaping", () => {
    it("escapes literal underscore so it is not a single-char wildcard", () => {
      expect(streamPatternToLike("^user_1$")).toBe("user\\_1");
    });

    it("escapes literal percent so it is not an any-run wildcard", () => {
      expect(streamPatternToLike("^disc%off$")).toBe("disc\\%off");
    });

    it("escapes metacharacters in unanchored (contains) patterns", () => {
      expect(streamPatternToLike("a_b%c")).toBe("%a\\_b\\%c%");
    });

    it("does not collapse an escaped % into an adjacent wildcard", () => {
      // contains "a%" — the escaped literal must survive next to the
      // trailing any-run wildcard
      expect(streamPatternToLike("a%")).toBe("%a\\%%");
    });
  });

  describe("non-portable patterns throw ValidationError", () => {
    const cases = [
      ["alternation", "^order-(a|b)$"],
      ["character class", "^order-[0-9]$"],
      ["plus quantifier", "^a+$"],
      ["optional quantifier", "^ab?$"],
      ["bounded quantifier", "^a{2}$"],
      ["bare star quantifier", "^ab*$"],
      ["escaped dot", "^a\\.b$"],
      ["escape sequence", "^\\d+$"],
      ["mid-pattern caret", "a^b"],
      ["mid-pattern dollar", "a$b"],
    ] as const;

    it.each(cases)("throws on %s", (_label, pattern) => {
      expect(() => streamPatternToLike(pattern)).toThrow(ValidationError);
    });

    it("names the offending pattern and enumerates the supported subset", () => {
      try {
        streamPatternToLike("^a-(x|y)$");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const message = (error as ValidationError).message;
        expect(message).toContain('"^a-(x|y)$"');
        expect(message).toContain('"^"');
        expect(message).toContain('"$"');
        expect(message).toContain('"."');
        expect(message).toContain('".*"');
        expect(message).toContain("literal characters");
        expect((error as ValidationError).payload).toBe("^a-(x|y)$");
      }
    });
  });
});
