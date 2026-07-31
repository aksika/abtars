import { describe, it, expect, vi } from "vitest";
import { resolvePeerName, isLocalSessionName } from "./peer-resolver.js";

vi.mock("../peer-config.js", () => ({
  loadPeerConfig: vi.fn(() => ({
    self: { name: "kp" },
    peers: {
      molty: { host: "h", port: 1, verifyKey: "k", trust: 1 },
    },
    maxHops: 2,
    timeoutMs: 1000,
  })),
}));

describe("resolvePeerName", () => {
  it("rejects every local session label before any config lookup", () => {
    for (const local of ["O", "Orc", "orc", "ORC", "A", "B", "C", "T", "P", "S", "W", "D", "H", "K", "Main", "Task", "Orc", "browse", "code", "task"]) {
      const r = resolvePeerName(local);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("local_session_not_peer");
      }
    }
  });

  it("rejects the machine's own identity as local", () => {
    const r = resolvePeerName("kp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("local_session_not_peer");
  });

  it("classifies unknown external names as peer_not_enrolled", () => {
    const r = resolvePeerName("nobody");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("peer_not_enrolled");
      expect(r.message).toContain("nobody");
    }
  });

  it("does not case-fold: 'Molty' is not the exact key 'molty'", () => {
    const r = resolvePeerName("Molty");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("peer_not_enrolled");
  });

  it("accepts only an exact enrolled key", () => {
    const r = resolvePeerName("molty");
    expect(r.ok).toBe(true);
  });

  it("rejects empty input", () => {
    const r = resolvePeerName("  ");
    expect(r.ok).toBe(false);
  });
});

describe("isLocalSessionName", () => {
  it("flags local labels and nothing else", () => {
    expect(isLocalSessionName("O")).toBe(true);
    expect(isLocalSessionName("orc")).toBe(true);
    expect(isLocalSessionName("master")).toBe(true);
    expect(isLocalSessionName("molty")).toBe(false);
    expect(isLocalSessionName("nobody")).toBe(false);
  });
});
