import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initEnv, getEnv, _resetEnv } from "./env-schema.js";

describe("env-schema", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetEnv();
    for (const k of ["BED_TIME", "SELFHEAL_ENABLED", "CTX_WARN_PCT", "ACTIVE_MEMORY"]) {
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
    expect(env.bedTime.hour).toBe(0);
    expect(env.bedTime.minute).toBe(30);
    expect(env.selfhealEnabled).toBe(false);
    expect(env.ctxWarnPct).toBe(70);
    expect(env.activeMemory).toBe(false);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("getEnv auto-initializes on first call", () => {
    const env = getEnv();
    expect(env.bedTime.hour).toBe(0);
  });

  it("getEnv returns same object after init", () => {
    initEnv();
    expect(getEnv()).toBe(getEnv());
  });

  it("parses overridden values", () => {
    process.env["BED_TIME"] = "2:15";
    process.env["CTX_WARN_PCT"] = "85";
    process.env["ACTIVE_MEMORY"] = "true";
    const env = initEnv();
    expect(env.bedTime.hour).toBe(2);
    expect(env.bedTime.minute).toBe(15);
    expect(env.ctxWarnPct).toBe(85);
    expect(env.activeMemory).toBe(true);
  });

  it("throws on invalid integer", () => {
    process.env["CTX_WARN_PCT"] = "banana";
    expect(() => initEnv()).toThrow("Invalid CTX_WARN_PCT");
  });

  it("throws on invalid time", () => {
    process.env["BED_TIME"] = "banana";
    expect(() => initEnv()).toThrow("Invalid BED_TIME");
  });

  it("getApiKey reads dynamic env var", () => {
    process.env["GROQ_API_KEY"] = "gsk_test123";
    const env = initEnv();
    expect(env.getApiKey("GROQ_API_KEY")).toBe("gsk_test123");
    delete process.env["GROQ_API_KEY"];
  });
});
