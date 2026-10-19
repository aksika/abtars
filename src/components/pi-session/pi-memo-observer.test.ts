import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoKindForErrorKind, recordPiMemoObservation } from "./pi-memo-observer.js";
import { loadAvailabilityMemo } from "./provider-availability-memo.js";

const TARGET = { authNamespace: "pi:openai", provider: "openai" };

describe("pi-memo-observer", () => {
  it("maps only provider unavailability to memoizable kinds", () => {
    expect(memoKindForErrorKind("auth")).toBe("auth");
    expect(memoKindForErrorKind("credits")).toBe("account-limit");
    expect(memoKindForErrorKind("rate_limit")).toBe("rate-limit");
    expect(memoKindForErrorKind("transient")).toBe("temporary");
    expect(memoKindForErrorKind("context_exceeded")).toBeNull();
    expect(memoKindForErrorKind("weak")).toBeNull();
    expect(memoKindForErrorKind("empty")).toBeNull();
    expect(memoKindForErrorKind("truncated")).toBeNull();
  });

  it("records memoizable failures without touching admission behavior", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-memo-obs-"));
    const recorded = recordPiMemoObservation(stateDir, TARGET, { kind: "rate_limit", retryAfterMs: 1000 }, 5000);
    expect(recorded).toBe(true);
    const loaded = loadAvailabilityMemo(stateDir);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]).toMatchObject({ reason: "rate-limit", observedAt: 5000, unusableUntil: 6000 });
  });

  it("ignores overflow and model-behavior failures entirely", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-memo-obs-"));
    const recorded = recordPiMemoObservation(stateDir, TARGET, { kind: "context_exceeded" }, 5000);
    expect(recorded).toBe(false);
    expect(loadAvailabilityMemo(stateDir).entries).toEqual([]);
  });
});
