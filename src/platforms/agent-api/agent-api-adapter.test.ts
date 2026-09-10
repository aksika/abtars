/**
 * agent-api-adapter.test.ts — #1786 lane-1 shared P chat receiver.
 *
 * Cardless by construction (prompt, never goal), transient P session,
 * peer-scoped identity, deny-all tool policy. Only non-empty text succeeds.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const spinMock = vi.fn();

vi.mock("../../components/spin.js", () => ({
  spin: {
    spin: spinMock,
  },
}));

vi.mock("../../components/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import { AgentApiAdapter } from "./agent-api-adapter.js";

describe("AgentApiAdapter.handlePeerChat (#1786)", () => {
  let adapter: AgentApiAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AgentApiAdapter();
  });

  it("dispatches a cardless P turn with peer identity and deny-all policy", async () => {
    spinMock.mockResolvedValue({ result: "hello peer", outcome: "text" });
    const out = await adapter.handlePeerChat("molty", "sess_1", {
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
    });
    expect(out).toBe("hello peer");
    expect(spinMock).toHaveBeenCalledTimes(1);
    const spec = spinMock.mock.calls[0]![0];
    expect(spec.type).toBe("P");
    expect(spec.goal).toBeUndefined();
    expect(spec.cardId).toBeUndefined();
    expect(spec.prompt).toContain("q2");
    expect(spec.source).toBe("peer");
    expect(spec.sourcePeer).toBe("molty");
    expect(spec.userId).toBe("peer:molty");
    expect(spec.settlementOwner).toBe("spin");
    expect(spec.tools).toMatchObject({ allowedTools: [], allowedRead: [], allowedWrite: [], canExecuteBash: false });
  });

  it("rejects an expired deadline before dispatch", async () => {
    await expect(adapter.handlePeerChat("molty", "sess_1", {
      messages: [{ role: "user", content: "hi" }],
      deadlineAt: Date.now() - 1_000,
    })).rejects.toThrow(/timeout/);
    expect(spinMock).not.toHaveBeenCalled();
  });

  it("rejects a turn with no user content before dispatch", async () => {
    await expect(adapter.handlePeerChat("molty", "sess_1", {
      messages: [{ role: "assistant", content: "stale" }],
    })).rejects.toThrow(/invalid_request/);
    expect(spinMock).not.toHaveBeenCalled();
  });

  it.each(["no_reply", "reaction"])("rejects %s outcome with empty_response — never schedules work", async (outcome) => {
    spinMock.mockResolvedValue({ result: "", outcome });
    await expect(adapter.handlePeerChat("molty", "sess_1", {
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toThrow(/empty_response/);
  });

  it("rejects empty text even when the outcome is text", async () => {
    spinMock.mockResolvedValue({ result: "   ", outcome: "text" });
    await expect(adapter.handlePeerChat("molty", "sess_1", {
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toThrow(/empty_response/);
  });

  it("rejects a second concurrent turn for the same peer as busy", async () => {
    let release!: (v: { result: string; outcome: string }) => void;
    spinMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const first = adapter.handlePeerChat("molty", "sess_1", {
      messages: [{ role: "user", content: "one" }],
    });
    await expect(adapter.handlePeerChat("molty", "sess_2", {
      messages: [{ role: "user", content: "two" }],
    })).rejects.toThrow(/busy/);
    release({ result: "first done", outcome: "text" });
    await expect(first).resolves.toBe("first done");
    // Guard released — a follow-up works.
    spinMock.mockResolvedValueOnce({ result: "second done", outcome: "text" });
    await expect(adapter.handlePeerChat("molty", "sess_3", {
      messages: [{ role: "user", content: "three" }],
    })).resolves.toBe("second done");
  });

  it("allows concurrent turns for different peers", async () => {
    spinMock.mockResolvedValue({ result: "ok", outcome: "text" });
    await expect(adapter.handlePeerChat("molty", "s1", {
      messages: [{ role: "user", content: "hi" }],
    })).resolves.toBe("ok");
    await expect(adapter.handlePeerChat("kp", "s1", {
      messages: [{ role: "user", content: "hi" }],
    })).resolves.toBe("ok");
  });

  it("legacy handlePeerMessage routes into the shared P receiver", async () => {
    spinMock.mockResolvedValue({ result: "hello peer", outcome: "text" });
    await expect(adapter.handlePeerMessage("peer-1", "sess-1", "hi", 30_000)).resolves.toBe("hello peer");
    expect(spinMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "P", source: "peer", settlementOwner: "spin",
    }));
    const spec = spinMock.mock.calls[0]![0];
    expect(spec.goal).toBeUndefined();
  });
});
