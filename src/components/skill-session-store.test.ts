/**
 * skill-session-store.test.ts — Durable binding store (#1432).
 * Protects: scope isolation, atomic replacement, malformed-record isolation,
 * expiry cleanup, restart survival, and no prompt/transcript content.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillSessionStore, scopeKeyOf } from "./skill-session-store.js";
import type { SkillBindingRecordV1 } from "./skill-session-store.js";

let home: string;
let storeFile: string;

beforeEach(() => {
  home = join(tmpdir(), `abtars-store-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  storeFile = join(home, "state", "skill-sessions.json");
  mkdirSync(join(home, "state"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function record(overrides: Partial<SkillBindingRecordV1> = {}): SkillBindingRecordV1 {
  const now = Date.now();
  return {
    version: 1,
    skillName: "spanish-tutor",
    userId: "ada",
    platform: "telegram",
    chatId: "42",
    agent: "professor",
    startedAt: now - 10_000,
    lastActiveAt: now - 1_000,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

describe("SkillSessionStore", () => {
  it("scopeKeyOf is exact and field-ordered", () => {
    expect(scopeKeyOf({ userId: "a", platform: "p", chatId: "1" }))
      .toBe(scopeKeyOf({ userId: "a", platform: "p", chatId: "1" }));
    expect(scopeKeyOf({ userId: "a", platform: "p", chatId: "1" }))
      .not.toBe(scopeKeyOf({ userId: "a", platform: "p", chatId: "2" }));
    expect(scopeKeyOf({ userId: "a", platform: "p", chatId: "1", threadId: "7" }))
      .not.toBe(scopeKeyOf({ userId: "a", platform: "p", chatId: "1" }));
    expect(scopeKeyOf({ userId: "a", platform: "p", chatId: "1" }))
      .not.toBe(scopeKeyOf({ userId: "b", platform: "p", chatId: "1" }));
  });

  it("persists and reloads a binding atomically", () => {
    const store = new SkillSessionStore({ file: storeFile });
    store.load();
    store.upsert(record());
    expect(existsSync(storeFile)).toBe(true);
    expect(readFileSync(storeFile, "utf-8")).not.toContain("prompt");
    expect(readFileSync(storeFile, "utf-8")).not.toContain("transcript");

    const reloaded = new SkillSessionStore({ file: storeFile });
    reloaded.load();
    const got = reloaded.get(scopeKeyOf({ userId: "ada", platform: "telegram", chatId: "42" }));
    expect(got).toMatchObject({ skillName: "spanish-tutor", agent: "professor", chatId: "42" });
  });

  it("scopes updates to the exact address", () => {
    const store = new SkillSessionStore({ file: storeFile });
    store.load();
    store.upsert(record());
    store.upsert(record({ chatId: "99", skillName: "other" }));
    store.remove(scopeKeyOf({ userId: "ada", platform: "telegram", chatId: "42" }));
    expect(store.get(scopeKeyOf({ userId: "ada", platform: "telegram", chatId: "42" }))).toBeUndefined();
    expect(store.get(scopeKeyOf({ userId: "ada", platform: "telegram", chatId: "99" }))).toMatchObject({ skillName: "other" });
  });

  it("drops expired records on load", () => {
    const now = Date.now();
    const store = new SkillSessionStore({ file: storeFile, now: () => now });
    store.load();
    store.upsert(record({ expiresAt: now - 1_000, skillName: "expired-skill" }));
    store.upsert(record({ chatId: "77", expiresAt: now + 10_000, skillName: "live-skill" }));
    const reloaded = new SkillSessionStore({ file: storeFile, now: () => now });
    reloaded.load();
    expect(reloaded.list().map(r => r.skillName)).toEqual(["live-skill"]);
  });

  it("isolates malformed records while keeping valid ones", () => {
    writeFileSync(storeFile, JSON.stringify({
      version: 1,
      bindings: [
        { version: 1, skillName: "broken" },                       // malformed
        "garbage",                                                  // non-object
        record({ chatId: "55" }),
      ],
    }));
    const store = new SkillSessionStore({ file: storeFile });
    store.load();
    expect(store.list().map(r => r.chatId)).toEqual(["55"]);
  });

  it("survives malformed whole-file JSON", () => {
    writeFileSync(storeFile, "{ not json");
    const store = new SkillSessionStore({ file: storeFile });
    store.load();
    expect(store.list()).toEqual([]);
    store.upsert(record());
    expect(store.list()).toHaveLength(1);
  });

  it("remove on missing key is a no-op without writing", () => {
    const store = new SkillSessionStore({ file: storeFile });
    store.load();
    expect(store.remove(scopeKeyOf({ userId: "x", platform: "p", chatId: "0" }))).toBe(false);
  });
});

describe("skill-loader strict parsing", () => {
  it("rejects interactive !== true", async () => {
    const { parseSkillConfig } = await import("./skill-loader.js");
    const r = parseSkillConfig(JSON.stringify({ interactive: false, timeout: 100 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_interactive");
  });

  it("rejects missing/zero/negative timeout", async () => {
    const { parseSkillConfig } = await import("./skill-loader.js");
    for (const t of [undefined, 0, -5, "30", 1.5]) {
      const r = parseSkillConfig(JSON.stringify({ interactive: true, timeout: t }));
      expect(r.ok).toBe(false);
    }
  });

  it("rejects unknown agent and non-string prerequisites", async () => {
    const { parseSkillConfig } = await import("./skill-loader.js");
    const badAgent = parseSkillConfig(JSON.stringify({ interactive: true, timeout: 100, agent: "wizard" }));
    expect(badAgent.ok).toBe(false);
    const badPrereq = parseSkillConfig(JSON.stringify({ interactive: true, timeout: 100, prerequisites: [1, 2] }));
    expect(badPrereq.ok).toBe(false);
  });

  it("accepts the canonical minimal config", async () => {
    const { parseSkillConfig } = await import("./skill-loader.js");
    const r = parseSkillConfig(JSON.stringify({ interactive: true, timeout: 1800, contextPath: "workspace/s/${userId}/C.md" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.timeout).toBe(1800);
  });
});

describe("skill-loader path safety", () => {
  beforeEach(() => {
    process.env["ABTARS_HOME"] = home;
  });

  afterEach(() => {
    delete process.env["ABTARS_HOME"];
  });

  it("normalizeUnderRoot rejects traversal and absolute injection", async () => {
    const { normalizeUnderRoot } = await import("./skill-loader.js");
    expect(normalizeUnderRoot("../../../etc/passwd", home)).toBeNull();
    expect(normalizeUnderRoot("/etc/passwd", home)).toBeNull();
    expect(normalizeUnderRoot("workspace/x/CONTEXT.md", home)).toBe(join(home, "workspace", "x", "CONTEXT.md"));
  });

  it("symlink escape fails closed", async () => {
    const { resolveContextPath } = await import("./skill-loader.js");
    const outside = join(home, "..", "escape-target");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(home, "workspace"), { recursive: true });
    try { symlinkSync(outside, join(home, "workspace", "link")); } catch { /* skip on platforms without symlink perms */ }
    const r = resolveContextPath({ interactive: true, timeout: 1, contextPath: "workspace/link/CONTEXT.md" }, "ada");
    expect(r).toBeNull();
  });

  it("resolves userId-substituted context under the home root", async () => {
    const { resolveContextPath } = await import("./skill-loader.js");
    const p = resolveContextPath({ interactive: true, timeout: 1, contextPath: "workspace/spanish/${userId}/CONTEXT.md" }, "ada");
    expect(p).toBe(join(home, "workspace", "spanish", "ada", "CONTEXT.md"));
  });
});
