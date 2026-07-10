import { describe, it, expect } from "vitest";
import { compareSemver, versionBadge } from "./version-compare.js";

describe("compareSemver", () => {
  describe("equal", () => {
    it("returns 0 for identical strings", () => {
      expect(compareSemver("0.3.4", "0.3.4")).toBe(0);
      expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    });

    it("returns 0 for identical pre-release", () => {
      expect(compareSemver("0.3.5-alpha.0", "0.3.5-alpha.0")).toBe(0);
    });

    it("returns 0 for unparseable inputs (safe fallback)", () => {
      expect(compareSemver("garbage", "0.3.4")).toBe(0);
      expect(compareSemver("0.3.4", "garbage")).toBe(0);
      expect(compareSemver("", "0.3.4")).toBe(0);
    });
  });

  describe("major.minor.patch ordering", () => {
    it("0.3.4 < 0.3.5 (patch)", () => {
      expect(compareSemver("0.3.4", "0.3.5")).toBeLessThan(0);
      expect(compareSemver("0.3.5", "0.3.4")).toBeGreaterThan(0);
    });

    it("0.3.4 < 0.4.0 (minor)", () => {
      expect(compareSemver("0.3.4", "0.4.0")).toBeLessThan(0);
    });

    it("0.3.4 < 1.0.0 (major)", () => {
      expect(compareSemver("0.3.4", "1.0.0")).toBeLessThan(0);
    });
  });

  describe("pre-release vs stable (#the-actual-bug)", () => {
    // THE BUG: the old string-based check showed ⚠️ when deployed was
    // a NEWER pre-release. semver says: pre-release of 0.3.5 > stable 0.3.4.
    it("0.3.5-alpha.0 > 0.3.4 (deployed alpha ahead of npm stable)", () => {
      expect(compareSemver("0.3.5-alpha.0", "0.3.4")).toBeGreaterThan(0);
      expect(compareSemver("0.3.4", "0.3.5-alpha.0")).toBeLessThan(0);
    });

    it("0.2.7-alpha.0 > 0.2.6 (deployed alpha ahead of npm stable)", () => {
      expect(compareSemver("0.2.7-alpha.0", "0.2.6")).toBeGreaterThan(0);
      expect(compareSemver("0.2.6", "0.2.7-alpha.0")).toBeLessThan(0);
    });

    it("0.3.5-alpha.0-ab5e7ef (with commit hash) > 0.3.4", () => {
      expect(compareSemver("0.3.5-alpha.0-ab5e7ef", "0.3.4")).toBeGreaterThan(0);
    });

    it("0.2.7-alpha.0 < 0.2.7 (pre-release is LESS than its stable)", () => {
      expect(compareSemver("0.2.7-alpha.0", "0.2.7")).toBeLessThan(0);
      expect(compareSemver("0.2.7", "0.2.7-alpha.0")).toBeGreaterThan(0);
    });
  });

  describe("pre-release ordering", () => {
    it("alpha.0 < alpha.1 (numeric lex)", () => {
      expect(compareSemver("0.3.5-alpha.0", "0.3.5-alpha.1")).toBeLessThan(0);
    });

    it("alpha < beta (lex)", () => {
      expect(compareSemver("0.3.5-alpha.0", "0.3.5-beta.0")).toBeLessThan(0);
    });
  });

  describe("commit-suffix handling", () => {
    it("ignores a 7-char commit suffix on the pre-release", () => {
      expect(compareSemver("0.3.5-alpha.0-ab5e7ef", "0.3.5-alpha.0")).toBe(0);
    });

    it("ignores a 40-char commit suffix on the pre-release", () => {
      expect(compareSemver("0.3.5-alpha.0-ab5e7ef1234567890abcdef1234567890abcdef12", "0.3.5-alpha.0")).toBe(0);
    });

    it("preserves ordering when one has a commit and the other does not", () => {
      expect(compareSemver("0.3.5-alpha.1-ab5e7ef", "0.3.5-alpha.0")).toBeGreaterThan(0);
    });
  });
});

describe("versionBadge", () => {
  it("returns ✓ when versions match", () => {
    expect(versionBadge("0.3.4", "0.3.4")).toBe("✓");
  });

  it("returns ✓ (ahead of npm) when deployed is newer pre-release (THE BUG)", () => {
    expect(versionBadge("0.3.5-alpha.0", "0.3.4")).toBe("✓ (ahead of npm)");
    expect(versionBadge("0.3.5-alpha.0-ab5e7ef", "0.3.4")).toBe("✓ (ahead of npm)");
    expect(versionBadge("0.2.7-alpha.0", "0.2.6")).toBe("✓ (ahead of npm)");
  });

  it("returns ⚠️ (behind npm) when deployed is older", () => {
    expect(versionBadge("0.2.6", "0.2.7")).toBe("⚠️ (behind npm)");
    expect(versionBadge("0.2.7-alpha.0", "0.2.7")).toBe("⚠️ (behind npm)");
  });

  it("returns ✓ when deployed is newer stable", () => {
    expect(versionBadge("0.3.5", "0.3.4")).toBe("✓ (ahead of npm)");
  });
});
