import { describe, it, expect, beforeEach } from "vitest";
import { checkTool, checkPath, buildPolicy, ToolLoopGuard } from "./tool-sandbox.js";

describe("checkTool", () => {
  it("allows all tools with wildcard policy", () => {
    const policy = buildPolicy("owner");
    expect(checkTool("execute_bash", policy).allowed).toBe(true);
    expect(checkTool("memory_recall", policy).allowed).toBe(true);
  });

  it("denies all tools with empty allowedTools", () => {
    const policy = buildPolicy("peer");
    expect(checkTool("execute_bash", policy).allowed).toBe(false);
    expect(checkTool("memory_recall", policy).allowed).toBe(false);
  });

  it("allows only listed tools", () => {
    const policy = buildPolicy("peer", { allowedTools: ["web_fetch", "memory_recall"], canExecuteBash: false });
    expect(checkTool("web_fetch", policy).allowed).toBe(true);
    expect(checkTool("memory_recall", policy).allowed).toBe(true);
    expect(checkTool("execute_bash", policy).allowed).toBe(false);
  });

  it("denies execute_bash when canExecuteBash is false even if in allowedTools", () => {
    const policy = buildPolicy("peer", { allowedTools: ["execute_bash"], canExecuteBash: false });
    expect(checkTool("execute_bash", policy).allowed).toBe(false);
  });

  it("guest policy allows web_fetch only", () => {
    const policy = buildPolicy("guest");
    expect(checkTool("web_fetch", policy).allowed).toBe(true);
    expect(checkTool("execute_bash", policy).allowed).toBe(false);
    expect(checkTool("memory_store", policy).allowed).toBe(false);
  });
});

describe("checkPath", () => {
  it("allows all paths with wildcard policy", () => {
    const policy = buildPolicy("owner");
    expect(checkPath("/etc/passwd", "read", policy).allowed).toBe(true);
    expect(checkPath("~/.abtars/secret/key", "read", policy).allowed).toBe(true);
  });

  it("denies blacklisted paths for non-wildcard policies", () => {
    const policy = buildPolicy("peer", { allowedRead: ["/home"], allowedWrite: ["/home"] });
    expect(checkPath("~/.abtars/config/peers.json", "read", policy).allowed).toBe(false);
    expect(checkPath("~/.abtars/secret/KEY", "read", policy).allowed).toBe(false);
    expect(checkPath("~/.abmind/memory.db", "read", policy).allowed).toBe(false);
  });

  it("allows paths within allowed prefixes", () => {
    const policy = buildPolicy("peer", { allowedRead: ["/tmp", "/home/user/data"], allowedWrite: [] });
    expect(checkPath("/tmp/file.txt", "read", policy).allowed).toBe(true);
    expect(checkPath("/home/user/data/x.json", "read", policy).allowed).toBe(true);
    expect(checkPath("/home/user/other", "read", policy).allowed).toBe(false);
  });

  it("denies write with empty allowedWrite", () => {
    const policy = buildPolicy("peer", { allowedRead: ["/tmp"], allowedWrite: [] });
    expect(checkPath("/tmp/file.txt", "write", policy).allowed).toBe(false);
  });
});

describe("buildPolicy", () => {
  it("owner policy allows everything", () => {
    const p = buildPolicy("owner");
    expect(p.allowedTools).toEqual(["*"]);
    expect(p.allowedRead).toEqual(["*"]);
    expect(p.allowedWrite).toEqual(["*"]);
    expect(p.canExecuteBash).toBe(true);
  });

  it("peer policy denies everything by default", () => {
    const p = buildPolicy("peer");
    expect(p.allowedTools).toEqual([]);
    expect(p.canExecuteBash).toBe(false);
  });

  it("policy is frozen", () => {
    const p = buildPolicy("owner");
    expect(() => { (p as any).canExecuteBash = false; }).toThrow();
  });

  it("config overrides defaults", () => {
    const p = buildPolicy("peer", { allowedTools: ["memory_recall"], canExecuteBash: false });
    expect(p.allowedTools).toEqual(["memory_recall"]);
  });
});

describe("ToolLoopGuard", () => {
  let guard: ToolLoopGuard;

  beforeEach(() => { guard = new ToolLoopGuard(); });

  it("allows first call", () => {
    expect(guard.beforeCall("execute_bash", { command: "ls" }).allowed).toBe(true);
  });

  it("warns at 2 failures, blocks at 4", () => {
    const args = { command: "bad" };
    guard.afterCall("execute_bash", args, "", true);
    const warn = guard.afterCall("execute_bash", args, "", true);
    expect(warn).toContain("failed twice");

    guard.afterCall("execute_bash", args, "", true);
    guard.afterCall("execute_bash", args, "", true);
    expect(guard.beforeCall("execute_bash", args).allowed).toBe(false);
  });

  it("warns at 2 idempotent repeats, blocks at 4", () => {
    const args = { query: "test" };
    guard.afterCall("file_read", args, "same", false);
    const warn = guard.afterCall("file_read", args, "same", false);
    expect(warn).toContain("Same result");

    guard.afterCall("file_read", args, "same", false);
    guard.afterCall("file_read", args, "same", false);
    expect(guard.beforeCall("file_read", args).allowed).toBe(false);
  });

  it("resetForTurn clears counters", () => {
    const args = { command: "bad" };
    for (let i = 0; i < 4; i++) guard.afterCall("execute_bash", args, "", true);
    expect(guard.beforeCall("execute_bash", args).allowed).toBe(false);
    guard.resetForTurn();
    expect(guard.beforeCall("execute_bash", args).allowed).toBe(true);
  });
});
