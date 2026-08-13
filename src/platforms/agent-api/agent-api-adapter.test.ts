/**
 * agent-api-adapter.test.ts — #1651 v2: peer requests succeed only for real
 * text content; a silent turn reaches the HTTP error boundary as a stable
 * error, never a fabricated "No response" payload.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../components/spin.js", () => ({
  spin: {
    dispatchAwait: vi.fn(),
  },
}));

vi.mock("../../components/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import { AgentApiAdapter } from "./agent-api-adapter.js";
import { spin } from "../../components/spin.js";

const dispatchAwaitMock = vi.mocked(spin.dispatchAwait);

describe("AgentApiAdapter.handlePeerMessage (#1651 v2)", () => {
  let adapter: AgentApiAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AgentApiAdapter();
  });

  it("returns the provider text verbatim when the outcome is text", async () => {
    dispatchAwaitMock.mockResolvedValue({ cardId: 7, result: "hello peer", outcome: "text" });
    await expect(adapter.handlePeerMessage("peer-1", "sess-1", "hi", 30_000)).resolves.toBe("hello peer");
    expect(dispatchAwaitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "O", source: "peer", settlementOwner: "spin", timeoutMs: 30_000,
    }));
  });

  it.each<[string, string]>([
    ["reaction", "[REACT:👋]"],
    ["no_reply", "[NO_REPLY]"],
    ["empty", ""],
  ])("rejects a %s peer outcome with empty_model_response — never a fabricated payload", async (_name, raw) => {
    const { classifyContent } = await import("../../components/clean-response.js");
    dispatchAwaitMock.mockResolvedValue({ cardId: 7, result: raw, outcome: classifyContent(raw) });
    await expect(adapter.handlePeerMessage("peer-1", "sess-1", "hi", 30_000)).rejects.toThrow(/empty_model_response/);
  });
});
