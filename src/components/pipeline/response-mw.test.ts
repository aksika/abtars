import { describe, it, expect, vi } from "vitest";
import { deliverResponse } from "./response-mw.js";

function makeCtx(overrides: Partial<Parameters<typeof deliverResponse>[0]> = {}) {
  return {
    rawResponse: "Hello world",
    fullMode: false,
    cleanAnswer: undefined,
    session: { messageCount: 0, contextPercent: undefined, toolCallCount: 0 } as any,
    adapter: {
      sendMessage: vi.fn().mockResolvedValue(123),
      sendTyping: vi.fn(),
      chunkResponse: (t: string) => [t],
      setReaction: vi.fn().mockResolvedValue(undefined),
    } as any,
    msg: { platform: "telegram", channelId: "100", messageId: 1, threadId: undefined } as any,
    channelId: "100",
    transport: { contextPercent: 5, toolCallsSucceeded: 0 },
    retrySend: (fn: () => Promise<any>) => fn(),
    ...overrides,
  };
}

describe("deliverResponse", () => {
  it("delivers text and increments messageCount", async () => {
    const ctx = makeCtx({ rawResponse: "Hello!" });
    const result = await deliverResponse(ctx);
    expect(result.delivered).toBe(true);
    expect(result.userResponse).toBe("Hello!");
    expect(ctx.session.messageCount).toBe(1);
    expect(ctx.adapter.sendMessage).toHaveBeenCalledWith("100", "Hello!", { threadId: undefined });
  });

  it("delivers emoji and increments messageCount (no bypass)", async () => {
    const ctx = makeCtx({ rawResponse: "👋" });
    const result = await deliverResponse(ctx);
    expect(result.delivered).toBe(true);
    expect(ctx.session.messageCount).toBe(1);
  });

  it("delivers [REACT:emoji]-only and increments messageCount", async () => {
    const ctx = makeCtx({ rawResponse: "[REACT:👍]" });
    const result = await deliverResponse(ctx);
    expect(result.delivered).toBe(true);
    expect(ctx.session.messageCount).toBe(1);
  });

  it("drops NO_REPLY silently without incrementing", async () => {
    const ctx = makeCtx({ rawResponse: "[NO_REPLY]" });
    const result = await deliverResponse(ctx);
    expect(result.delivered).toBe(false);
    expect(ctx.session.messageCount).toBe(0);
  });

  it("handles empty response with tool calls (no error message)", async () => {
    const ctx = makeCtx({ rawResponse: "", transport: { contextPercent: 5, toolCallsSucceeded: 2 } });
    const result = await deliverResponse(ctx);
    expect(result.delivered).toBe(false);
    expect(ctx.adapter.sendMessage).not.toHaveBeenCalledWith("100", expect.stringContaining("empty"), expect.anything());
  });
});
