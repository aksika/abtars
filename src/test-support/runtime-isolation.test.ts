import { describe, it, expect } from "vitest";
import { currentTestSandbox, assertSandboxPath, isolatedChildEnv, restoreEnvSnapshot } from "./runtime-isolation.js";
import { resolve, join } from "node:path";
import { existsSync, statSync } from "node:fs";

describe("runtime-isolation sandbox", () => {
  it("provides a sandbox with all expected directories", () => {
    const s = currentTestSandbox();
    expect(s.root).toBeTruthy();
    expect(s.home).toBeTruthy();
    expect(s.abtarsHome).toBeTruthy();
    expect(s.abmindHome).toBeTruthy();
    expect(s.releases).toBeTruthy();
    expect(s.bin).toBeTruthy();
    expect(s.xdgConfig).toBeTruthy();
    expect(s.xdgCache).toBeTruthy();
    expect(s.xdgState).toBeTruthy();
    expect(existsSync(s.home)).toBe(true);
    expect(existsSync(s.abtarsHome)).toBe(true);
    expect(existsSync(s.abmindHome)).toBe(true);
  });

  it("sets HOME and ABTARS_HOME to sandbox paths", () => {
    const s = currentTestSandbox();
    expect(process.env.HOME).toBe(s.home);
    expect(process.env.ABTARS_HOME).toBe(s.abtarsHome);
    expect(process.env.ABMIND_HOME).toBe(s.abmindHome);
    expect(process.env.AB_TEST_SANDBOX_ROOT).toBe(s.root);
  });

  it("assertSandboxPath accepts paths inside the sandbox", () => {
    const s = currentTestSandbox();
    const inside = join(s.abtarsHome, "state", "test.json");
    expect(assertSandboxPath(inside)).toBe(resolve(inside));
    const nested = join(s.abtarsHome, "skills", "self", "deep", "file.md");
    expect(assertSandboxPath(nested)).toBe(resolve(nested));
  });

  it("assertSandboxPath rejects paths outside the sandbox", () => {
    expect(() => assertSandboxPath("/tmp")).toThrow("outside the test sandbox root");
    expect(() => assertSandboxPath("/etc/passwd")).toThrow("outside the test sandbox root");
    expect(() => assertSandboxPath("..")).toThrow("outside the test sandbox root");
  });

  it("assertSandboxPath rejects the sandbox root itself as a file target", () => {
    const s = currentTestSandbox();
    expect(() => assertSandboxPath(s.root)).toThrow("outside the test sandbox root");
  });

  it("isolatedChildEnv contains sandbox variables", () => {
    const env = isolatedChildEnv();
    const s = currentTestSandbox();
    expect(env.ABTARS_HOME).toBe(s.abtarsHome);
    expect(env.HOME).toBe(s.home);
    expect(env.NODE_ENV).toBe("test");
  });

  it("isolatedChildEnv contains toolchain (PATH, NODE_PATH)", () => {
    const env = isolatedChildEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.NODE_PATH).toBe(process.env.NODE_PATH);
  });

  it("isolatedChildEnv does NOT contain common secret variables", () => {
    process.env.MY_API_KEY = "should-not-leak";
    process.env.OPENAI_TOKEN = "should-not-leak";
    try {
      const env = isolatedChildEnv();
      expect(env.MY_API_KEY).toBeUndefined();
      expect(env.OPENAI_TOKEN).toBeUndefined();
    } finally {
      delete process.env.MY_API_KEY;
      delete process.env.OPENAI_TOKEN;
    }
  });

  it("isolatedChildEnv applies explicit overrides", () => {
    const env = isolatedChildEnv({ MY_API_KEY: "fake-key", CUSTOM_VAR: "hello" });
    expect(env.MY_API_KEY).toBe("fake-key");
    expect(env.CUSTOM_VAR).toBe("hello");
  });

  it("restoreEnvSnapshot deletes previously-unset keys and preserves empty-string keys", () => {
    // Distinguishes "was unset" (delete) from "was the empty string" (restore to "").
    const env: Record<string, string | undefined> = { HOME: "will-be-deleted", KEEP: "v" };
    const snap = new Map<string, { wasSet: boolean; value: string }>([
      ["HOME", { wasSet: false, value: "" }],   // originally absent -> removed
      ["EMPTY", { wasSet: true, value: "" }],     // originally "" -> restored to ""
      ["KEEP", { wasSet: true, value: "v" }],     // originally "v" -> unchanged
      ["ABSENT", { wasSet: false, value: "" }],   // originally absent -> removed
    ]);
    restoreEnvSnapshot(env, snap);
    expect(env).toEqual({ KEEP: "v", EMPTY: "" });
    expect("HOME" in env).toBe(false);
    expect("ABSENT" in env).toBe(false);
    expect(env.EMPTY).toBe("");
  });

  it("currentTestSandbox returns a stable reference (idempotent within the file)", () => {
    const a = currentTestSandbox();
    const b = currentTestSandbox();
    expect(a).toBe(b);
  });

  it("sandbox root and its application homes exist on disk (cleanup ownership)", () => {
    const s = currentTestSandbox();
    expect(statSync(s.root).isDirectory()).toBe(true);
    expect(existsSync(s.abtarsHome)).toBe(true);
    expect(existsSync(s.abmindHome)).toBe(true);
    // The sandbox owns exactly its root; the root itself is never a valid target.
    expect(() => assertSandboxPath(s.root)).toThrow("outside the test sandbox root");
  });
});
