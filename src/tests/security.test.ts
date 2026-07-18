/**
 * Security regression tests — ensures security controls stay intact.
 */

import { describe, it, expect } from "vitest";
import { redactSecrets } from "../components/logger.js";
import { isWithinRoot } from "../components/path-guard.js";

describe("credential redaction", () => {
  it("redacts OpenAI keys", () => {
    expect(redactSecrets("key is sk-abc123def456ghi789jkl012mno")).toContain("sk-***REDACTED***");
  });

  it("redacts GitHub PATs", () => {
    expect(redactSecrets("token ghp_1234567890abcdefghijklmnopqrstuvwxyz")).toContain("ghp_***REDACTED***");
  });

  it("redacts Telegram bot tokens", () => {
    expect(redactSecrets("bot 123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789a")).toContain("***BOT_TOKEN***");
  });

  it("redacts AWS access key IDs", () => {
    expect(redactSecrets("aws AKIAIOSFODNN7EXAMPLE")).toContain("AKIA***REDACTED***");
  });

  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc")).toContain("Bearer ***REDACTED***");
  });

  it("redacts env assignments", () => {
    expect(redactSecrets("TELEGRAM_BOT_TOKEN=123456:ABCdef_secret_value")).toContain("***REDACTED***");
  });

  it("redacts JSON secret fields", () => {
    expect(redactSecrets('{"apiKey": "sk-very-secret-key-here"}')).toContain("***REDACTED***");
  });

  it("preserves non-secret text", () => {
    const safe = "User said hello at 2026-04-05T12:00:00";
    expect(redactSecrets(safe)).toBe(safe);
  });
});

describe("path traversal protection", () => {
  it("allows paths within root", () => {
    expect(isWithinRoot("memory/test.db", "/home/user/.abtars")).toBe(true);
  });

  it("blocks ../ escape", () => {
    expect(isWithinRoot("../../.ssh/authorized_keys", "/home/user/.abtars")).toBe(false);
  });

  it("blocks absolute path outside root", () => {
    expect(isWithinRoot("/etc/passwd", "/home/user/.abtars")).toBe(false);
  });

  it("allows root itself", () => {
    expect(isWithinRoot(".", "/home/user/.abtars")).toBe(true);
  });
});
