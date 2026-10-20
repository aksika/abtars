/**
 * handlers-transport-compact.test.ts — #1940 /compact through the Pi
 * session: exact attached-transport resolution, bounded instructions,
 * and unavailability paths.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./registry.js", () => ({ triggerResetSession: vi.fn() }));

const { handleCompact, formatCompactReply } = await import("./handlers-transport.js");
import type { CommandContext } from "./types.js";

function makeCtx(
  sessionKey = "1_A_01",
  transport?: CommandContext["transport"],
): { ctx: CommandContext; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue(1);
  const ctx = {
    sessionKey, chatId: 1, userId: "u", platform: "telegram",
    reply,
    transport: (transport ?? {}) as unknown as CommandContext["transport"],
  } as unknown as CommandContext;
  return { ctx, reply };
}

describe("handleCompact #1940", () => {
  it("rejects non-compactable sessions before touching any transport", async () => {
    const compactSession = vi.fn();
    const { ctx, reply } = makeCtx("1_K_01", { compactSession } as never);
    const out = await handleCompact("/compact", ctx);
    expect(out).toBe(true);
    expect(reply).toHaveBeenCalledWith("Compaction not available for this session.");
    expect(compactSession).not.toHaveBeenCalled();
  });

  it("compacts the attached Pi session with the custom instructions", async () => {
    const compactSession = vi.fn().mockResolvedValue({ summary: "s" });
    const invalidateContextUsage = vi.fn();
    const { ctx, reply } = makeCtx("1_A_01", { compactSession, invalidateContextUsage } as never);
    const out = await handleCompact("/compact focus on plans", ctx);
    expect(out).toBe(true);
    expect(compactSession).toHaveBeenCalledWith("1_A_01", "focus on plans");
    expect(invalidateContextUsage).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("Compaction complete.");
  });

  it("passes no instructions when the command has no arguments", async () => {
    const compactSession = vi.fn().mockResolvedValue({});
    const { ctx } = makeCtx("1_A_01", { compactSession } as never);
    await handleCompact("/compact", ctx);
    expect(compactSession).toHaveBeenCalledWith("1_A_01", undefined);
  });

  it("bounds oversized custom instructions", async () => {
    const compactSession = vi.fn();
    const { ctx, reply } = makeCtx("1_A_01", { compactSession } as never);
    await handleCompact(`/compact ${"x".repeat(5000)}`, ctx);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("exceed"));
    expect(compactSession).not.toHaveBeenCalled();
  });

  it("reports unsupported when the attached transport has no Pi session", async () => {
    const { ctx, reply } = makeCtx();
    await handleCompact("/compact", ctx);
    expect(reply).toHaveBeenCalledWith("Compaction is not supported for this session.");
  });

  it("maps stale/busy/unsupported/failed results truthfully", () => {
    expect(formatCompactReply({ status: "stale", message: "" })).toContain("newer checkpoint");
    expect(formatCompactReply({ status: "busy", message: "" })).toContain("already in progress");
    expect(formatCompactReply({ status: "unsupported", message: "" })).toContain("not supported");
    expect(formatCompactReply({ status: "failed", message: "secret detail" })).toBe("Compaction failed.");
  });

  it("never forwards slash text as a model prompt for unsupported targets", async () => {
    const compactSession = vi.fn();
    const { ctx } = makeCtx("1_K_01", { compactSession } as never);
    await handleCompact("/compact", ctx);
    expect(compactSession).not.toHaveBeenCalled();
  });
});
