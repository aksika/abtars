import { describe, expect, it } from "vitest";
import { PiSoulGate } from "./pi-soul-gate.js";

const ADMIT = { abmindAvailable: true, archiveAcknowledged: true };

describe("pi-soul-gate", () => {
  it("starts hydration-pending and admits after fresh hydration", () => {
    const gate = new PiSoulGate();
    expect(gate.checkRequest(1, ADMIT)).toEqual({ admit: false, reason: "hydration-pending" });

    expect(gate.completeHydration({ bundle: 1 }, 1, 1)).toBe(true);
    expect(gate.checkRequest(1, ADMIT)).toEqual({ admit: true, generation: 1 });
  });

  it("invalidates the bundle on compaction and across replacement", () => {
    const gate = new PiSoulGate();
    expect(gate.completeHydration({ bundle: 1 }, 1, 1)).toBe(true);
    gate.invalidateOnCompaction();
    expect(gate.checkRequest(1, ADMIT)).toEqual({ admit: false, reason: "hydration-pending" });

    expect(gate.completeHydration({ bundle: 2 }, 1, 1)).toBe(true);
    gate.beginSession();
    expect(gate.checkRequest(1, ADMIT)).toEqual({ admit: false, reason: "hydration-pending" });
  });

  it("rejects late hydration for a superseded generation", () => {
    const gate = new PiSoulGate();
    expect(gate.completeHydration({ bundle: 1 }, 1, 2)).toBe(false);
    expect(gate.checkRequest(2, ADMIT)).toEqual({ admit: false, reason: "hydration-pending" });
  });

  it("rejects requests from a superseded generation and cancelled hydration", () => {
    const gate = new PiSoulGate();
    expect(gate.completeHydration({ bundle: 1 }, 1, 1)).toBe(true);
    expect(gate.checkRequest(2, ADMIT)).toEqual({ admit: false, reason: "generation-changed" });

    gate.cancel();
    expect(gate.checkRequest(1, ADMIT)).toEqual({ admit: false, reason: "hydration-pending" });
  });

  it("fails closed when abmind or required archive state is unavailable", () => {
    const gate = new PiSoulGate();
    expect(gate.completeHydration({ bundle: 1 }, 1, 1)).toBe(true);
    expect(gate.checkRequest(1, { abmindAvailable: false, archiveAcknowledged: true })).toEqual({
      admit: false,
      reason: "abmind-unavailable",
    });
    expect(gate.checkRequest(1, { abmindAvailable: true, archiveAcknowledged: false })).toEqual({
      admit: false,
      reason: "archive-gap",
    });
  });
});
