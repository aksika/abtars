import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMemoSuccess,
  clearMemoNamespace,
  cooldownForObservation,
  isMemoBlocked,
  loadAvailabilityMemo,
  memoScopeMatches,
  saveAvailabilityMemo,
  type ProviderAvailabilityEntry,
} from "./provider-availability-memo.js";

function entry(partial: Partial<ProviderAvailabilityEntry> = {}): ProviderAvailabilityEntry {
  return {
    authNamespace: "pi:openai",
    provider: "openai",
    reason: "rate-limit",
    observedAt: 1000,
    unusableUntil: 2000,
    ...partial,
  };
}

describe("provider-availability-memo", () => {
  it("uses a five-minute cooldown without provider reset metadata", () => {
    expect(cooldownForObservation(undefined, 1000)).toBe(1000 + 5 * 60 * 1000);
  });

  it("bounds provider retry-after hints to 24 hours", () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    expect(cooldownForObservation(week, 1000)).toBe(1000 + 24 * 60 * 60 * 1000);
  });

  it("loads missing memos as empty without a diagnostic", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-memo-"));
    expect(loadAvailabilityMemo(dir)).toEqual({ entries: [] });
  });

  it("round-trips entries and rejects invalid data with an empty cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-memo-"));
    saveAvailabilityMemo(dir, [entry()]);
    expect(loadAvailabilityMemo(dir).entries).toHaveLength(1);

    writeFileSync(join(dir, "provider-availability-v1.json"), "{invalid");
    const loaded = loadAvailabilityMemo(dir);
    expect(loaded.entries).toEqual([]);
    expect(loaded.invalid).toBeDefined();
  });

  it("blocks only until expiry and matches scopes narrowly", () => {
    const blocked = entry({ unusableUntil: 2000 });
    expect(isMemoBlocked(blocked, 1500)).toBe(true);
    expect(isMemoBlocked(blocked, 2000)).toBe(false);
    expect(memoScopeMatches(blocked, { authNamespace: "pi:openai", provider: "openai" })).toBe(true);
    expect(memoScopeMatches(blocked, { authNamespace: "pi:other", provider: "openai" })).toBe(false);
  });

  it("lets stale completions keep a newer failure", () => {
    const old = entry({ observedAt: 1000, unusableUntil: 2000 });
    const newer = entry({ observedAt: 1500, unusableUntil: 3000 });
    const kept = applyMemoSuccess([old, newer], {
      authNamespace: "pi:openai",
      provider: "openai",
      admittedAt: 1200,
    });
    expect(kept).toEqual([newer]);
  });

  it("does not clear another model's scoped cooldown on success", () => {
    const thisModel = entry({ endpoint: "https://a/v1", modelScope: "m1", observedAt: 1000, unusableUntil: 2000 });
    const otherModel = entry({ endpoint: "https://a/v1", modelScope: "m2", observedAt: 1000, unusableUntil: 2000 });
    const kept = applyMemoSuccess([thisModel, otherModel], {
      authNamespace: "pi:openai",
      provider: "openai",
      endpoint: "https://a/v1",
      modelScope: "m1",
      admittedAt: 1200,
    });
    expect(kept).toEqual([otherModel]);
  });

  it("clears a namespace on explicit reset without touching others", () => {
    const kept = clearMemoNamespace([entry(), entry({ authNamespace: "pi:other", provider: "openai" })], "pi:openai");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.authNamespace).toBe("pi:other");
  });
});
