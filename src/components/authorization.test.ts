import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeBashCommand, authorizePath, resolveSecurityMode, writeAuthorizationAudit } from "./authorization.js";
import { buildPolicy } from "./tool-sandbox.js";
import { _resetEnv } from "./env-schema.js";
import type { ActionGate } from "./action-gate.js";
import type { SandboxPolicy } from "./tool-sandbox.js";

const ENV_KEYS = ["HOME", "ABTARS_HOME", "ABMIND_HOME", "SECURITY_MODE"] as const;

let sandbox: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "authorization-1851-"));
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env["HOME"] = sandbox;
  process.env["ABTARS_HOME"] = join(sandbox, ".abtars");
  process.env["ABMIND_HOME"] = join(sandbox, ".abmind");
  mkdirSync(sandbox, { recursive: true });
  delete process.env["SECURITY_MODE"];
  _resetEnv();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
  _resetEnv();
});

function setMode(mode: string | undefined): void {
  if (mode === undefined) delete process.env["SECURITY_MODE"];
  else process.env["SECURITY_MODE"] = mode;
  _resetEnv();
}

function auditRows(): Array<Record<string, unknown>> {
  const path = join(process.env["ABTARS_HOME"]!, "logs", "audit.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function fakeGate(outcome: unknown): { requestAuth: ReturnType<typeof vi.fn> } {
  return { requestAuth: vi.fn(async () => outcome) };
}

describe("resolveSecurityMode", () => {
  it("defaults to off when unset", () => {
    expect(resolveSecurityMode()).toEqual({ configured: "off", effective: "off", fallback: false });
  });

  it("keeps off and guardrails as themselves", () => {
    setMode("guardrails");
    expect(resolveSecurityMode()).toEqual({ configured: "guardrails", effective: "guardrails", fallback: false });
    setMode("off");
    expect(resolveSecurityMode()).toEqual({ configured: "off", effective: "off", fallback: false });
  });

  it("falls back seatbelt, docker, and unrecognized values to guardrails", () => {
    for (const mode of ["seatbelt", "docker", "guardrail"]) {
      setMode(mode);
      expect(resolveSecurityMode()).toEqual({ configured: mode, effective: "guardrails", fallback: true });
    }
  });
});

describe("authorizeBashCommand — mode off", () => {
  it("runs a guardrails-blocked command with no classifier, prompt, or decision audit", async () => {
    setMode("off");
    const gate = fakeGate({ granted: true, by: "once" });
    const decision = await authorizeBashCommand("rm -rf /", {
      actionGate: gate as unknown as ActionGate,
      authorizationMode: "interactive",
    });
    expect(decision).toEqual({ decision: "allow", by: "mode-off" });
    expect(gate.requestAuth).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
  });

  it("runs an auth-required command silently", async () => {
    setMode("off");
    const gate = fakeGate({ granted: false, by: "master" });
    const decision = await authorizeBashCommand("sudo id", { actionGate: gate as unknown as ActionGate });
    expect(decision).toEqual({ decision: "allow", by: "mode-off" });
    expect(gate.requestAuth).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
  });

  it("still blocks bridge spawn/kill and records the block", async () => {
    setMode("off");
    const decision = await authorizeBashCommand("node main.js", { actionGate: null });
    expect(decision).toMatchObject({ decision: "block", by: "bridge-self-protection" });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "authorization", surface: "bash", outcome: "block", source: "bridge-self-protection",
    });
  });
});

describe("authorizeBashCommand — guardrails", () => {
  it("blocks the classifier block tier and audits it once", async () => {
    setMode("guardrails");
    const decision = await authorizeBashCommand("rm -rf /", { actionGate: null });
    expect(decision).toMatchObject({ decision: "block", by: "classifier" });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "authorization", surface: "bash", outcome: "block", source: "guardrails" });
  });

  it("audits root-scope allows once", async () => {
    setMode("guardrails");
    mkdirSync(join(process.env["ABTARS_HOME"]!, "cache"), { recursive: true });
    const decision = await authorizeBashCommand("rm -rf ~/.abtars/cache", { actionGate: null });
    expect(decision).toMatchObject({ decision: "allow", by: "root-scope" });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "authorization", surface: "bash", outcome: "allow", source: "root-scope" });
  });

  it("returns approved-by-rule and records one approval row", async () => {
    setMode("guardrails");
    const gate = fakeGate({ granted: true, by: "rule", pattern: "sudo echo*" });
    const decision = await authorizeBashCommand("sudo echo hello", {
      actionGate: gate as unknown as ActionGate,
      authorizationMode: "interactive",
    });
    expect(decision).toEqual({ decision: "approved", by: "rule", pattern: "sudo echo*" });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "authorization", surface: "bash", outcome: "approved", source: "rule", pattern: "sudo echo*",
    });
  });

  it("returns a block and records one denial row when the master denies", async () => {
    setMode("guardrails");
    const gate = fakeGate({ granted: false, by: "timeout" });
    const decision = await authorizeBashCommand("sudo echo hello", {
      actionGate: gate as unknown as ActionGate,
      authorizationMode: "interactive",
    });
    expect(decision).toMatchObject({ decision: "block", by: "approval" });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "authorization", surface: "bash", outcome: "denied", source: "timeout" });
  });

  it("lets unattended-sleep bypass the classifier, bridge protection, and ActionGate", async () => {
    setMode("guardrails");
    const gate = fakeGate({ granted: true, by: "once" });
    const decision = await authorizeBashCommand("printf '%s' main.js", {
      actionGate: gate as unknown as ActionGate,
      authorizationMode: "unattended-sleep",
    });
    expect(decision).toEqual({ decision: "allow", by: "unattended-sleep" });
    expect(gate.requestAuth).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
  });
});

describe("authorizePath — owner wildcard across modes", () => {
  const owner = buildPolicy("owner");

  it("stays unrestricted when the mode is off", () => {
    setMode("off");
    expect(authorizePath("~/.ssh/id_ed25519", "read", owner).allowed).toBe(true);
    expect(authorizePath("/etc/passwd", "read", owner).allowed).toBe(true);
    expect(authorizePath("~/.abtars/secret/key", "write", owner).allowed).toBe(true);
    expect(auditRows()).toEqual([]);
  });

  it("refuses secret, abmind, ssh, and system paths under guardrails for owner sessions", () => {
    setMode("guardrails");
    const cases: Array<[string, "read" | "write"]> = [
      ["~/.ssh/id_ed25519", "read"],
      ["~/.abtars/secret/key", "write"],
      ["~/.abmind/memory/memory.db", "read"],
      ["/etc/passwd", "read"],
    ];
    for (const [filePath, mode] of cases) {
      expect(authorizePath(filePath, mode, owner).allowed, `${mode} ${filePath}`).toBe(false);
    }
    const rows = auditRows();
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) {
      expect(row).toMatchObject({ event: "authorization", surface: "path", outcome: "block", source: "guardrail-path" });
    }
  });

  it("still allows ordinary paths under guardrails", () => {
    setMode("guardrails");
    expect(authorizePath("/tmp/out.txt", "write", owner).allowed).toBe(true);
    expect(authorizePath(join(process.env["HOME"]!, "notes.txt"), "read", owner).allowed).toBe(true);
    expect(auditRows()).toEqual([]);
  });

  it("keeps write-only entries writable-blocked but readable", () => {
    setMode("guardrails");
    expect(authorizePath("~/.kiro/settings.json", "write", owner).allowed).toBe(false);
    expect(authorizePath("~/.kiro/settings.json", "read", owner).allowed).toBe(true);
  });
});

describe("authorizePath — session policy and traversal", () => {
  it("keeps peer session policy enforced when the mode is off", () => {
    setMode("off");
    const peer = buildPolicy("peer", { allowedRead: ["/tmp"], allowedWrite: [] });
    expect(authorizePath("/tmp/file.txt", "read", peer).allowed).toBe(true);
    expect(authorizePath("/etc/passwd", "read", peer).allowed).toBe(false);
    expect(authorizePath(join(homedir(), ".abmind", "memory.db"), "read", peer).allowed).toBe(false);
    expect(authorizePath("/tmp/file.txt", "write", peer).allowed).toBe(false);
  });

  const traversalPolicy: SandboxPolicy = {
    allowedTools: ["file_read", "file_write"],
    allowedRead: ["~/.abtars/workspace/a2a/"],
    allowedWrite: ["~/.abtars/workspace/a2a/"],
    canExecuteBash: false,
  };

  it("blocks ../ traversal to config, secret, and abmind", () => {
    setMode("off");
    expect(authorizePath("~/.abtars/workspace/a2a/../../config/.env", "read", traversalPolicy).allowed).toBe(false);
    expect(authorizePath("~/.abtars/workspace/a2a/../secret/OPENAI_API_KEY", "read", traversalPolicy).allowed).toBe(false);
    expect(authorizePath("~/.abtars/workspace/a2a/../../../.abmind/memory/memory.db", "read", traversalPolicy).allowed).toBe(false);
    expect(authorizePath("~/.abtars/workspace/a2a/./../../config/peers.json", "read", traversalPolicy).allowed).toBe(false);
  });

  it("allows a path inside the session sandbox", () => {
    setMode("off");
    expect(authorizePath("~/.abtars/workspace/a2a/output.json", "write", traversalPolicy).allowed).toBe(true);
  });
});

describe("authorization audit schema", () => {
  it("writes block, approval, and root-scope decisions with one schema", async () => {
    setMode("guardrails");
    mkdirSync(join(process.env["ABTARS_HOME"]!, "cache"), { recursive: true });
    await authorizeBashCommand("rm -rf /", { actionGate: null });
    await authorizeBashCommand("rm -rf ~/.abtars/cache", { actionGate: null });
    const gate = fakeGate({ granted: true, by: "once" });
    await authorizeBashCommand("sudo echo hello", { actionGate: gate as unknown as ActionGate, authorizationMode: "interactive" });
    authorizePath("~/.ssh/id_ed25519", "read", buildPolicy("owner"));

    const rows = auditRows();
    expect(rows).toHaveLength(4);
    const bashRows = rows.filter((row) => row["surface"] === "bash");
    const keySets = new Set(bashRows.map((row) => Object.keys(row).sort().join(",")));
    expect(keySets.size).toBe(1);
    expect(rows.map((row) => row["outcome"]).sort()).toEqual(["allow", "approved", "block", "block"]);
    expect(rows.map((row) => row["surface"]).sort()).toEqual(["bash", "bash", "bash", "path"]);
  });

  it("direct writer failures never surface to the caller", () => {
    const blocker = join(sandbox, "blocker");
    writeFileSync(blocker, "not a directory");
    process.env["ABTARS_HOME"] = join(blocker, "sub");
    expect(() => writeAuthorizationAudit({ surface: "bash", outcome: "block", source: "test", detail: "x" })).not.toThrow();
  });

  it("scrubs sealed-handle tokens from audited details and patterns", () => {
    setMode("guardrails");
    writeAuthorizationAudit({
      surface: "bash",
      outcome: "denied",
      source: "master",
      detail: "echo secret:abcDEF123-_ and more",
      pattern: "echo secret:abcDEF123-_",
    });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("secret:abcDEF123-_");
    expect(rows[0]).toMatchObject({ detail: "echo [SEALED_HANDLE] and more", pattern: "echo [SEALED_HANDLE]" });
  });
});
