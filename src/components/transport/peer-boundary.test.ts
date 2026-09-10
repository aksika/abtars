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
  PeerCallError: class PeerCallError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "PeerCallError";
    }
  },
}));
vi.mock("../peer-sessions.js", () => ({
  getOrCreateSession: vi.fn(() => ({ ok: true, session: { id: "s1", messages: [], inFlight: false } })),
  addTurn: vi.fn((s: { messages: Array<{ role: string; content: string }> }, role: string, content: string) => {
    s.messages.push({ role, content });
  }),
  tryBeginTurn: vi.fn(() => true),
  endTurn: vi.fn(),
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
import { getOrCreateSession, tryBeginTurn } from "../peer-sessions.js";

const LOCAL_NAMES = ["O", "Orc", "orc", "T", "A", "B", "C", "K"];

describe("#1520 peer identity boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("peer_doorbell rejects local session identities with zero transport calls", async () => {
    for (const name of LOCAL_NAMES) {
      const out = await executeToolCall("peer_doorbell", { peer_name: name }, {} as never);
      const parsed = JSON.parse(out) as { code?: string; error?: string };
      expect(parsed.code).toBe("local_session_not_peer");
      expect(ringDoorbell).not.toHaveBeenCalled();
    }
    expect(vi.mocked(getPeerTransport)).not.toHaveBeenCalled();
  });

  it("peer_doorbell rejects unknown external names with zero transport calls", async () => {
    const out = await executeToolCall("peer_doorbell", { peer_name: "nobody" }, {} as never);
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
    expect(callPeer).toHaveBeenCalledWith("molty", "hello", 2, expect.objectContaining({
      sessionId: "s1",
      messages: [{ role: "user", content: "hello" }],
    }));
  });

  it("peer_session surfaces session_expired without sending", async () => {
    vi.mocked(getOrCreateSession).mockReturnValueOnce({
      ok: false, code: "session_expired", message: "Unknown or expired peer session: stale",
    });
    const out = await executeToolCall("peer_session", { peer_name: "molty", message: "hi", session_id: "stale" }, {});
    const parsed = JSON.parse(out) as { code?: string };
    expect(parsed.code).toBe("session_expired");
    expect(callPeer).not.toHaveBeenCalled();
  });

  it("peer_session rejects a second in-flight turn as session_busy", async () => {
    vi.mocked(tryBeginTurn).mockReturnValueOnce(false);
    const out = await executeToolCall("peer_session", { peer_name: "molty", message: "hi" }, {});
    const parsed = JSON.parse(out) as { code?: string };
    expect(parsed.code).toBe("session_busy");
    expect(callPeer).not.toHaveBeenCalled();
  });
  it("peer help egress rejects local identities before transport lookup", async () => {
    const out = await executeToolCall("peer_ask_help", { peer: "O", goal: "help" }, {});
    const parsed = JSON.parse(out) as { code?: string };
    expect(parsed.code).toBe("local_session_not_peer");
    expect(vi.mocked(getPeerTransport)).not.toHaveBeenCalled();
  });
});
