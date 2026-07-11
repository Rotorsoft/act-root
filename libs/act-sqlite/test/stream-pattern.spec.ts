import { ValidationError } from "@rotorsoft/act";
import { streamPatternToGlob } from "../src/sqlite-store.js";

describe("streamPatternToGlob", () => {
  describe("anchors", () => {
    it("strips both anchors → exact match", () => {
      expect(streamPatternToGlob("^abc$")).toBe("abc");
    });

    it("strips leading ^ only → starts-with", () => {
      expect(streamPatternToGlob("^abc")).toBe("abc*");
    });

    it("strips trailing $ only → ends-with", () => {
      expect(streamPatternToGlob("abc$")).toBe("*abc");
    });

    it("no anchors → contains (both sides padded)", () => {
      expect(streamPatternToGlob("abc")).toBe("*abc*");
    });

    it("handles empty input with both anchors", () => {
      expect(streamPatternToGlob("^$")).toBe("");
    });

    it("handles empty input with no anchors (collapsed to *)", () => {
      expect(streamPatternToGlob("")).toBe("*");
    });
  });

  describe("wildcards", () => {
    it("converts .* to * when anchored", () => {
      expect(streamPatternToGlob("^abc.*$")).toBe("abc*");
    });

    it("converts .* to * when unanchored (still contains)", () => {
      // unanchored gets *-padded; .* becomes *; adjacent *s are collapsed
      expect(streamPatternToGlob("abc.*")).toBe("*abc*");
    });

    it("converts single . to ? (single-char wildcard)", () => {
      expect(streamPatternToGlob("^a.c$")).toBe("a?c");
    });

    it("converts mixed . and .* in a single pattern", () => {
      expect(streamPatternToGlob("^a.b.*c$")).toBe("a?b*c");
    });

    it("handles only-wildcard pattern .*", () => {
      expect(streamPatternToGlob("^.*$")).toBe("*");
    });
  });

  describe("realistic patterns", () => {
    it("starts-with via ^prefix.*", () => {
      expect(streamPatternToGlob("^order-.*")).toBe("order-*");
    });

    it("starts-with via ^prefix (no .*)", () => {
      expect(streamPatternToGlob("^order-")).toBe("order-*");
    });

    it("ends-with via .*suffix$", () => {
      expect(streamPatternToGlob(".*-archive$")).toBe("*-archive");
    });

    it("contains via plain substring", () => {
      expect(streamPatternToGlob("user")).toBe("*user*");
    });
  });

  describe("GLOB literals need no escaping", () => {
    // Under GLOB, `_` and `%` are ordinary characters (not wildcards),
    // so they pass through verbatim — unlike LIKE, which needed ESCAPE.
    it("passes a literal underscore through unescaped", () => {
      expect(streamPatternToGlob("^user_1$")).toBe("user_1");
    });

    it("passes a literal percent through unescaped", () => {
      expect(streamPatternToGlob("^disc%off$")).toBe("disc%off");
    });

    it("passes _ and % through in unanchored (contains) patterns", () => {
      expect(streamPatternToGlob("a_b%c")).toBe("*a_b%c*");
    });

    it("keeps a literal % next to a trailing wildcard", () => {
      // contains "a%" — the literal % must survive next to the trailing
      // any-run wildcard, and the two must not collapse.
      expect(streamPatternToGlob("a%")).toBe("*a%*");
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
      expect(() => streamPatternToGlob(pattern)).toThrow(ValidationError);
    });

    it("names the offending pattern and enumerates the supported subset", () => {
      try {
        streamPatternToGlob("^a-(x|y)$");
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
