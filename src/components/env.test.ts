import { describe, it, expect, beforeEach, vi } from "vitest";
import { readEnv, readEnvWithDefault, _resetEnvWarnedForTests } from "./env.js";

vi.mock("./logger.js", () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import { logWarn } from "./logger.js";

describe("readEnv", () => {
  beforeEach(() => {
    _resetEnvWarnedForTests();
    vi.clearAllMocks();
    delete process.env["__TEST_ENV_VAR"];
  });

  it("returns the value when set", () => {
    process.env["__TEST_ENV_VAR"] = "hello";
    expect(readEnv("__TEST_ENV_VAR", "does nothing")).toBe("hello");
    expect(vi.mocked(logWarn)).not.toHaveBeenCalled();
  });

  it("returns undefined when unset", () => {
    expect(readEnv("__TEST_ENV_VAR", "does nothing")).toBeUndefined();
  });

  it("returns undefined when set to empty string", () => {
    process.env["__TEST_ENV_VAR"] = "";
    expect(readEnv("__TEST_ENV_VAR", "does nothing")).toBeUndefined();
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith("env", "__TEST_ENV_VAR not set — does nothing");
  });

  it("warns once per process per missing key", () => {
    readEnv("__TEST_ENV_VAR", "test impact");
    readEnv("__TEST_ENV_VAR", "test impact");
    readEnv("__TEST_ENV_VAR", "test impact");
    expect(vi.mocked(logWarn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith("env", "__TEST_ENV_VAR not set — test impact");
  });

  it("warns per distinct missing key", () => {
    readEnv("__TEST_ENV_VAR_A", "impact A");
    readEnv("__TEST_ENV_VAR_B", "impact B");
    expect(vi.mocked(logWarn)).toHaveBeenCalledTimes(2);
  });

  it("does not warn once var becomes set", () => {
    readEnv("__TEST_ENV_VAR", "test impact");
    process.env["__TEST_ENV_VAR"] = "now set";
    readEnv("__TEST_ENV_VAR", "test impact");
    expect(vi.mocked(logWarn)).toHaveBeenCalledTimes(1);
  });
});

describe("readEnvWithDefault", () => {
  beforeEach(() => {
    _resetEnvWarnedForTests();
    vi.clearAllMocks();
    delete process.env["__TEST_ENV_VAR"];
  });

  it("returns value when set", () => {
    process.env["__TEST_ENV_VAR"] = "actual";
    expect(readEnvWithDefault("__TEST_ENV_VAR", "fallback", "does nothing")).toBe("actual");
  });

  it("returns fallback when unset and warns", () => {
    expect(readEnvWithDefault("__TEST_ENV_VAR", "fallback", "streaming interval")).toBe("fallback");
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith(
      "env",
      '__TEST_ENV_VAR not set — streaming interval (falling back to "fallback")',
    );
  });
});
