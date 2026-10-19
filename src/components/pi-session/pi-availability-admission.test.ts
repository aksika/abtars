import { describe, expect, it } from "vitest";
import {
  admitPiSelection,
  observePiFailure,
} from "./pi-availability-admission.js";
import type { ProviderAvailabilityEntry } from "./provider-availability-memo.js";

const OPENAI = { authNamespace: "pi:openai", provider: "openai" };

function blockedEntry(): ProviderAvailabilityEntry {
  return {
    ...OPENAI,
    reason: "rate-limit",
    observedAt: 1000,
    unusableUntil: 1000 + 5 * 60 * 1000,
  };
}

describe("pi-availability-admission", () => {
  it("admits the first unblocked selection", () => {
    const verdict = admitPiSelection(
      [{ ...OPENAI, modelScope: "blocked-model" }, OPENAI],
      [{ ...blockedEntry(), modelScope: "blocked-model" }],
      1500,
    );
    expect(verdict).toEqual({ admit: true, selection: OPENAI });
  });

  it("reports unavailable with the earliest retry time when all selections cool down", () => {
    const verdict = admitPiSelection(
      [OPENAI, { authNamespace: "pi:other", provider: "other" }],
      [
        blockedEntry(),
        { authNamespace: "pi:other", provider: "other", reason: "temporary", observedAt: 1000, unusableUntil: 9000 },
      ],
      1500,
    );
    expect(verdict).toEqual({
      admit: false,
      reason: "all 2 allowed provider selection(s) are cooling down",
      retryAt: 9000,
    });
  });

  it("rejects an empty configured selection without a cooldown fiction", () => {
    expect(admitPiSelection([], [blockedEntry()], 1500)).toEqual({
      admit: false,
      reason: "no allowed provider selection is configured",
      retryAt: 1500,
    });
  });

  it("replaces the same-scope observation instead of accumulating", () => {
    const entries = observePiFailure([blockedEntry()], {
      ...OPENAI,
      kind: "temporary",
      observedAt: 2000,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ reason: "temporary", observedAt: 2000 });
  });

  it("keeps model-scoped failures from blocking sibling models", () => {
    const entries = observePiFailure([], { ...OPENAI, modelScope: "m1", kind: "rate-limit", observedAt: 1000 });
    const verdict = admitPiSelection([{ ...OPENAI, modelScope: "m2" }], entries, 1500);
    expect(verdict).toEqual({ admit: true, selection: { ...OPENAI, modelScope: "m2" } });
  });
});
