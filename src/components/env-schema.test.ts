import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initEnv, getEnv, _resetEnv } from "./env-schema.js";

describe("env-schema", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetEnv();
    for (const k of ["SELFHEAL_MODE", "CTX_WARN_PCT", "ACTIVE_MEMORY"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    _resetEnv();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns frozen config with defaults", () => {
    const env = initEnv();
    expect(env.selfhealMode).toBe("off");
    expect(env.ctxWarnPct).toBe(70);
    expect(env.activeMemory).toBe(true);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("parses SELFHEAL_MODE values and fails closed on invalid", () => {
    process.env["SELFHEAL_MODE"] = "investigation";
    expect(initEnv().selfhealMode).toBe("investigation");
    _resetEnv();
    process.env["SELFHEAL_MODE"] = "full";
    expect(initEnv().selfhealMode).toBe("full");
    _resetEnv();
    process.env["SELFHEAL_MODE"] = "banana";
    expect(initEnv().selfhealMode).toBe("off");
  });

  it("getEnv auto-initializes on first call", () => {
    const env = getEnv();
    expect(env.ctxWarnPct).toBe(70);
  });

  it("getEnv returns same object after init", () => {
    initEnv();
    expect(getEnv()).toBe(getEnv());
  });

  it("parses overridden values", () => {
    process.env["CTX_WARN_PCT"] = "85";
    process.env["ACTIVE_MEMORY"] = "true";
    const env = initEnv();
    expect(env.ctxWarnPct).toBe(85);
    expect(env.activeMemory).toBe(true);
  });

  it("throws on invalid integer", () => {
    process.env["CTX_WARN_PCT"] = "banana";
    expect(() => initEnv()).toThrow("Invalid CTX_WARN_PCT");
  });

  it("getApiKey reads dynamic env var", async () => {
    process.env["GROQ_API_KEY"] = "gsk_test123";
    const env = initEnv();
    expect(env.getApiKey("GROQ_API_KEY")).toBe("gsk_test123");
    delete process.env["GROQ_API_KEY"];
  });

  describe("BASH_TOOL_TIMEOUT_SEC (#1716)", () => {
    it("defaults to 120", () => {
      expect(initEnv().bashToolTimeoutSec).toBe(120);
    });

    it("parses a valid override", () => {
      process.env["BASH_TOOL_TIMEOUT_SEC"] = "45";
      expect(initEnv().bashToolTimeoutSec).toBe(45);
    });

    it("throws strict on a non-integer value", () => {
      process.env["BASH_TOOL_TIMEOUT_SEC"] = "banana";
      expect(() => initEnv()).toThrow("Invalid BASH_TOOL_TIMEOUT_SEC");
    });

    it.each(["0", "-5", "3601"])("throws on out-of-range value %s", (value) => {
      process.env["BASH_TOOL_TIMEOUT_SEC"] = value;
      expect(() => initEnv()).toThrow(/expected integer between 1 and 3600/);
    });

    it("accepts the upper bound", () => {
      process.env["BASH_TOOL_TIMEOUT_SEC"] = "3600";
      expect(initEnv().bashToolTimeoutSec).toBe(3600);
    });
  });
});
