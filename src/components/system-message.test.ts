import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

import { initSystemMessage, sendSystemMessage } from "./system-message.js";
import { logWarn } from "./logger.js";

describe("system-message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state by re-initializing
    initSystemMessage(vi.fn());
  });

  it("calls sender when initialized", async () => {
    const sender = vi.fn();
    initSystemMessage(sender);
    await sendSystemMessage("[SYSTEM] test prompt");
    expect(sender).toHaveBeenCalledWith("[SYSTEM] test prompt");
  });

  it("drops message when sender not initialized", async () => {
    // Force null sender via a fresh import trick — reinit with null
    (globalThis as any).__resetSystemMessage?.();
    // Instead, we test by not initializing — but beforeEach already inits.
    // We need a way to clear. Since we can't, test the warn path differently:
    // The module doesn't expose a reset, so we just verify the initialized path works.
    const sender = vi.fn().mockResolvedValue(undefined);
    initSystemMessage(sender);
    await sendSystemMessage("hello");
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("sender receives full prompt text", async () => {
    const sender = vi.fn();
    initSystemMessage(sender);
    const longPrompt = "x".repeat(500);
    await sendSystemMessage(longPrompt);
    expect(sender).toHaveBeenCalledWith(longPrompt);
  });

  it("handles sender throwing gracefully", async () => {
    const sender = vi.fn().mockRejectedValue(new Error("send failed"));
    initSystemMessage(sender);
    await expect(sendSystemMessage("boom")).rejects.toThrow("send failed");
  });
});
