import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DomainAllowlist } from "./domain-allowlist.js";
import { _resetEnv } from "../../components/env-schema.js";

// ── Constructor & getters ───────────────────────────────────────────────────

describe("DomainAllowlist", () => {
  describe("constructor", () => {
    it("trims and lowercases patterns", () => {
      const al = new DomainAllowlist(["  Example.COM ", "*.FOO.bar "]);
      expect(al.patterns).toEqual(["example.com", "*.foo.bar"]);
    });

    it("filters out empty strings", () => {
      const al = new DomainAllowlist(["", "  ", "example.com", ""]);
      expect(al.patterns).toEqual(["example.com"]);
    });
  });

  describe("isOpenMode", () => {
    it("returns true when no patterns configured", () => {
      expect(new DomainAllowlist([]).isOpenMode).toBe(true);
    });

    it("returns false when patterns are configured", () => {
      expect(new DomainAllowlist(["example.com"]).isOpenMode).toBe(false);
    });
  });

  // ── Exact matching ──────────────────────────────────────────────────────

  describe("isAllowed — exact match", () => {
    const al = new DomainAllowlist(["example.com", "login.service.io"]);

    it("allows exact hostname match", () => {
      expect(al.isAllowed("https://example.com/path")).toBe(true);
      expect(al.isAllowed("https://login.service.io/auth")).toBe(true);
    });

    it("rejects non-matching hostname", () => {
      expect(al.isAllowed("https://evil.com")).toBe(false);
    });

    it("rejects subdomain when only exact pattern given", () => {
      expect(al.isAllowed("https://sub.example.com")).toBe(false);
    });
  });

  // ── Wildcard matching ───────────────────────────────────────────────────

  describe("isAllowed — wildcard match", () => {
    const al = new DomainAllowlist(["*.example.com"]);

    it("matches any subdomain", () => {
      expect(al.isAllowed("https://login.example.com")).toBe(true);
      expect(al.isAllowed("https://app.example.com/dashboard")).toBe(true);
    });

    it("matches deeply nested subdomains", () => {
      expect(al.isAllowed("https://a.b.c.example.com")).toBe(true);
    });

    it("matches the root domain itself", () => {
      expect(al.isAllowed("https://example.com")).toBe(true);
    });

    it("rejects unrelated domains", () => {
      expect(al.isAllowed("https://notexample.com")).toBe(false);
    });
  });

  // ── Open mode ───────────────────────────────────────────────────────────

  describe("isAllowed — open mode", () => {
    const al = new DomainAllowlist([]);

    it("allows any URL when no patterns configured", () => {
      expect(al.isAllowed("https://anything.com")).toBe(true);
      expect(al.isAllowed("http://localhost:3000")).toBe(true);
    });
  });

  // ── Invalid URLs ────────────────────────────────────────────────────────

  describe("isAllowed — invalid URLs", () => {
    const al = new DomainAllowlist(["example.com"]);

    it("rejects invalid URLs", () => {
      expect(al.isAllowed("not-a-url")).toBe(false);
    });
  });

  // ── fromEnv ─────────────────────────────────────────────────────────────

  describe("fromEnv", () => {
    const originalEnv = process.env["BROWSER_ALLOWED_DOMAINS"];

    afterEach(() => {
      _resetEnv();
      if (originalEnv === undefined) {
        delete process.env["BROWSER_ALLOWED_DOMAINS"];
      } else {
        process.env["BROWSER_ALLOWED_DOMAINS"] = originalEnv;
      }
    });

    it("returns open mode when env var is not set", () => {
      delete process.env["BROWSER_ALLOWED_DOMAINS"];
      const al = DomainAllowlist.fromEnv();
      expect(al.isOpenMode).toBe(true);
    });

    it("parses comma-separated domains", () => {
      process.env["BROWSER_ALLOWED_DOMAINS"] = "*.example.com, login.service.io";
      const al = DomainAllowlist.fromEnv();
      expect(al.patterns).toEqual(["*.example.com", "login.service.io"]);
      expect(al.isAllowed("https://app.example.com")).toBe(true);
      expect(al.isAllowed("https://login.service.io")).toBe(true);
      expect(al.isAllowed("https://evil.com")).toBe(false);
    });

    it("handles empty env var as open mode", () => {
      process.env["BROWSER_ALLOWED_DOMAINS"] = "";
      const al = DomainAllowlist.fromEnv();
      expect(al.isOpenMode).toBe(true);
    });
  });
});
