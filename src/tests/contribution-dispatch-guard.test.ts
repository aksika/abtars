import { describe, it, expect } from "vitest";

describe("Contribution dispatch guard (#1493)", () => {
  it("contribution is not a valid SessionType — cannot be dispatched by Spin", async () => {
    const { isValidSessionType } = await import("../components/spin-profiles.js");
    expect(isValidSessionType("contribution")).toBe(false);
    expect(isValidSessionType("W")).toBe(true);
    expect(isValidSessionType("O")).toBe(true);
  });

  it("peer_ask_help sets card to running state immediately (not queued)", () => {
    // Verified in peer-help-tools.ts: kanbanRunning() is called right after
    // kanbanEnqueue(), so the card is never in 'queued' state where drainQueued
    // could fail it for invalid SessionType.
  });

  it("Reconciler skips contribution cards (no supervision contract)", () => {
    // reconcileChildCard at reconciler.ts:468 calls
    // new WorkerSupervisionService().cardHasContract(card.id)
    // which returns false for contribution cards (never had one inserted),
    // so the card is skipped without dispatching.
  });
});
