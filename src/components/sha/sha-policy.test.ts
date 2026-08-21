import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveFix,
  disableFix,
  loadMergedFixes,
  logAdmissionAllowed,
  reload,
  validateFixRule,
} from "./sha-policy.js";

const savedHome = process.env["ABTARS_HOME"];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sha-policy-"));
  process.env["ABTARS_HOME"] = home;
  reload();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env["ABTARS_HOME"];
  else process.env["ABTARS_HOME"] = savedHome;
  reload();
});

function writePolicy(name: string, body: unknown): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", name), JSON.stringify(body));
}

describe("validateFixRule", () => {
  it("accepts a well-formed run rule with verifyCommand", () => {
    const rule = validateFixRule({
      pattern: "some distinctive error", action: "run",
      command: ["touch", "/tmp/x"], verifyCommand: ["test", "-f", "/tmp/x"],
      cooldownMin: 30, verified: true,
    });
    expect(rule?.pattern).toBe("some distinctive error");
    expect(rule?.verifyCommand).toEqual(["test", "-f", "/tmp/x"]);
  });

  it("rejects malformed rules from unknown", () => {
    expect(validateFixRule(null)).toBeNull();
    expect(validateFixRule("nope")).toBeNull();
    expect(validateFixRule({ pattern: "", cooldownMin: 1 })).toBeNull();
    expect(validateFixRule({ pattern: "p", cooldownMin: 1, command: ["ok", 42] })).toBeNull();
    expect(validateFixRule({ pattern: "p", cooldownMin: 1, command: [] })).toBeNull();
    expect(validateFixRule({ pattern: "p", cooldownMin: "30" })).toBeNull();
    expect(validateFixRule({ pattern: "p", cooldownMin: 1, action: "explode" })).toBeNull();
    expect(validateFixRule({ pattern: "p", cooldownMin: 1, verifyCommand: ["test", 7] })).toBeNull();
  });
});

describe("loadMergedFixes", () => {
  it("core wins on duplicate patterns; self rules merge", () => {
    writePolicy("sha-policy.json", {
      fixes: [{ pattern: "dup-pattern", action: "run", command: ["core"], cooldownMin: 5 }],
    });
    writePolicy("sha-policy-self.json", {
      fixes: [
        { pattern: "dup-pattern", action: "run", command: ["self"], cooldownMin: 5 },
        { pattern: "a self-generated rule that is long enough", action: "run", command: ["self2"], cooldownMin: 5, createdAt: "2026-01-01" },
      ],
    });
    const fixes = loadMergedFixes();
    expect(fixes).toHaveLength(2);
    const dup = fixes.find((f) => f.pattern === "dup-pattern");
    expect(dup?.command).toEqual(["core"]);
  });

  it("ignores short, disabled, and malformed self rules with bounded warnings", () => {
    writePolicy("sha-policy.json", { fixes: [] });
    writePolicy("sha-policy-self.json", {
      fixes: [
        { pattern: "short", cooldownMin: 5 },
        { pattern: "a disabled rule that is long enough", cooldownMin: 5, enabled: false },
        { pattern: 42, cooldownMin: 5 },
        { pattern: "a valid self rule that is long enough", action: "run", command: ["ok"], cooldownMin: 5 },
      ],
    });
    const fixes = loadMergedFixes();
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.pattern).toContain("valid self rule");
  });
});

describe("malformed core policy", () => {
  it("disables log admission but keeps scheduled policy loading usable", () => {
    writePolicy("sha-policy.json", { fixes: [] });
    writePolicy("sha-policy-self.json", { fixes: [] });
    expect(logAdmissionAllowed()).toBe(true);
    writeFileSync(join(home, "config", "sha-policy.json"), "{ not json");
    reload();
    expect(logAdmissionAllowed()).toBe(false);
    expect(loadMergedFixes()).toEqual([]);
  });
});

describe("approveFix / disableFix", () => {
  it("approve marks verified and persists; disable marks enabled=false", () => {
    writePolicy("sha-policy-self.json", {
      fixes: [{ pattern: "a self rule long enough for approval", action: "run", command: ["x"], cooldownMin: 5, verified: false }],
    });
    expect(approveFix("missing")).toBe(false);
    expect(approveFix("a self rule long enough for approval")).toBe(true);
    const after = loadMergedFixes();
    expect(after.find((f) => f.pattern === "a self rule long enough for approval")?.verified).toBe(true);
    expect(disableFix("a self rule long enough for approval")).toBe(true);
    expect(loadMergedFixes().find((f) => f.pattern === "a self rule long enough for approval")).toBeUndefined();
  });

  it("does not clobber a malformed self-policy file", () => {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "sha-policy-self.json"), "broken{");
    expect(approveFix("anything")).toBe(false);
    expect(disableFix("anything")).toBe(false);
  });
});