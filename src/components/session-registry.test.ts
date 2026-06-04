import { describe, it, expect, vi } from "vitest";
import { SessionRegistry } from "./session-registry.js";

describe("SessionRegistry", () => {
  it("getOrCreate returns fresh entry", () => {
    const reg = new SessionRegistry();
    const entry = reg.getOrCreate("a:tg");
    expect(entry.busy).toBe(false);
    expect(entry.queue).toEqual([]);
    expect(entry.primingTerms).toEqual([]);
  });

  it("getOrCreate returns same entry on second call", () => {
    const reg = new SessionRegistry();
    const a = reg.getOrCreate("a:tg");
    a.busy = true;
    const b = reg.getOrCreate("a:tg");
    expect(b.busy).toBe(true);
    expect(a).toBe(b);
  });

  it("get returns undefined for unknown key", () => {
    const reg = new SessionRegistry();
    expect(reg.get("nope")).toBeUndefined();
  });

  it("delete removes entry", () => {
    const reg = new SessionRegistry();
    reg.getOrCreate("a:tg");
    reg.delete("a:tg");
    expect(reg.has("a:tg")).toBe(false);
    expect(reg.size).toBe(0);
  });

  it("snapshot returns all entries", () => {
    const reg = new SessionRegistry();
    reg.getOrCreate("a:tg").fullMode = true;
    reg.getOrCreate("b:dc");
    const snap = reg.snapshot();
    expect(Object.keys(snap)).toEqual(["a:tg", "b:dc"]);
    expect(snap["a:tg"]!.fullMode).toBe(true);
  });

  it("prune removes idle entries older than threshold", () => {
    const reg = new SessionRegistry();
    const old = reg.getOrCreate("old:tg");
    old.lastActiveAt = Date.now() - 4 * 60 * 60 * 1000; // 4h ago
    reg.getOrCreate("fresh:tg"); // just created
    const pruned = reg.prune(3 * 60 * 60 * 1000);
    expect(pruned).toBe(1);
    expect(reg.has("old:tg")).toBe(false);
    expect(reg.has("fresh:tg")).toBe(true);
  });

  it("prune keeps busy entries even if old", () => {
    const reg = new SessionRegistry();
    const entry = reg.getOrCreate("busy:tg");
    entry.lastActiveAt = Date.now() - 4 * 60 * 60 * 1000;
    entry.busy = true;
    expect(reg.prune(3 * 60 * 60 * 1000)).toBe(0);
    expect(reg.has("busy:tg")).toBe(true);
  });

  it("prune keeps entries with queued messages", () => {
    const reg = new SessionRegistry();
    const entry = reg.getOrCreate("queued:tg");
    entry.lastActiveAt = Date.now() - 4 * 60 * 60 * 1000;
    entry.queue.push({ msg: {} as any, adapter: {} as any });
    expect(reg.prune(3 * 60 * 60 * 1000)).toBe(0);
  });
});
