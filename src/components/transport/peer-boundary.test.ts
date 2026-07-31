import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeToolCall } from "./tool-registry.js";

// Every peer-transport call must be a spy so a rejected identity can never
// reach network activity. The transport instance is shared so call-count
// assertions see the same object.
const { ringDoorbell, callPeer } = vi.hoisted(() => ({
  ringDoorbell: vi.fn().mockResolvedValue({ status: "rung" }),
  callPeer: vi.fn().mockResolvedValue("peer response"),
}));
vi.mock("../peer-transport/index.js", () => ({
  getPeerTransport: vi.fn(() => ({ ringDoorbell })),
}));
vi.mock("../peer-client.js", () => ({
  callPeer,
}));
vi.mock("../peer-sessions.js", () => ({
  getOrCreateSession: vi.fn(() => ({ id: "s1", messages: [] })),
  addTurn: vi.fn(),
  isEnded: vi.fn(() => ({ ended: true })),
  destroySession: vi.fn(),
}));
vi.mock("../peer-config.js", () => ({
  loadPeerConfig: vi.fn(() => ({
    self: { name: "kp" },
    peers: { molty: { host: "h", port: 1, verifyKey: "k", trust: 1 } },
    maxHops: 2,
    timeoutMs: 1000,
  })),
}));
vi.mock("./orc-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./orc-tools.js")>();
  return {
    ...actual,
    isActiveCardPeerSourced: vi.fn().mockResolvedValue(false),
  };
});

import { getPeerTransport } from "../peer-transport/index.js";

const LOCAL_NAMES = ["O", "Orc", "orc", "T", "A", "B", "C", "K"];

describe("#1520 peer identity boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("peer_doorbell rejects local session identities with zero transport calls", async () => {
    for (const name of LOCAL_NAMES) {
      const out = await executeToolCall("peer_doorbell", { peer_name: name }, {});
      const parsed = JSON.parse(out) as { code?: string; error?: string };
      expect(parsed.code).toBe("local_session_not_peer");
      expect(ringDoorbell).not.toHaveBeenCalled();
    }
    expect(vi.mocked(getPeerTransport)).not.toHaveBeenCalled();
  });

  it("peer_doorbell rejects unknown external names with zero transport calls", async () => {
    const out = await executeToolCall("peer_doorbell", { peer_name: "nobody" }, {});
    const parsed = JSON.parse(out) as { code?: string; error?: string };
    expect(parsed.code).toBe("peer_not_enrolled");
    expect(ringDoorbell).not.toHaveBeenCalled();
  });

  it("peer_doorbell rings only the exact enrolled key", async () => {
    const out = await executeToolCall("peer_doorbell", { peer_name: "molty" }, {});
    const parsed = JSON.parse(out) as { ok?: boolean };
    expect(parsed.ok).toBe(true);
    expect(ringDoorbell).toHaveBeenCalledWith("molty");
  });

  it("peer_session rejects local session identities with zero peer-client calls", async () => {
    for (const name of LOCAL_NAMES) {
      const out = await executeToolCall("peer_session", { peer_name: name, message: "hi" }, {});
      const parsed = JSON.parse(out) as { code?: string };
      expect(parsed.code).toBe("local_session_not_peer");
      expect(callPeer).not.toHaveBeenCalled();
    }
  });

  it("peer_session routes only an exact enrolled key", async () => {
    const out = await executeToolCall("peer_session", { peer_name: "molty", message: "hello" }, {});
    const parsed = JSON.parse(out) as { response?: string; error?: string };
    expect(parsed.error).toBeUndefined();
    expect(parsed.response).toBe("peer response");
    expect(callPeer).toHaveBeenCalledWith("molty", expect.any(String), 2);
  });
});
