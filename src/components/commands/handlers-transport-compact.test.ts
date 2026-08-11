/**
 * handlers-transport-compact.test.ts — #1406 /compact through the shared
 * command pipeline: exact durable target resolution, bounded instructions,
 * result mapping, and unavailability paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./registry.js", () => ({ triggerResetSession: vi.fn() }));

const { handleCompact, formatCompactReply } = await import("./handlers-transport.js");
import { SessionControlService } from "../session-control/service.js";
import { setSessionControlService } from "../session-control/instance.js";
import type { CommandContext } from "./types.js";

function makeCtx(sessionKey = "1_A_01"): { ctx: CommandContext; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue(1);
  const ctx = {
    sessionKey, chatId: 1, userId: "u", platform: "telegram",
    reply,
    transport: {} as unknown as CommandContext["transport"],
  } as unknown as CommandContext;
  return { ctx, reply };
}

describe("handleCompact #1406", () => {
  afterEach(() => {
    setSessionControlService(null);
  });

  it("rejects non-compactable sessions before touching the control plane", async () => {
    setSessionControlService(new SessionControlService());
    const { ctx, reply } = makeCtx("1_K_01");
    const out = await handleCompact("/compact", ctx);
    expect(out).toBe(true);
    expect(reply).toHaveBeenCalledWith("Compaction not available for this session.");
  });

  it("executes a manual durable compaction and maps the result to a bounded reply", async () => {
    const service = new SessionControlService();
    let executed: unknown = null;
    service.register({
      targetKind: "durable_conversation",
      supports: () => true,
      async execute(target, request) {
        executed = { target, request };
        return { status: "completed", targetKind: "durable_conversation", tokensBefore: 1000, tokensAfter: 150, message: "ok" };
      },
    });
    setSessionControlService(service);
    const { ctx, reply } = makeCtx();
    const out = await handleCompact("/compact focus on plans", ctx);
    expect(out).toBe(true);
    expect(executed).toMatchObject({
      target: { kind: "durable_conversation", principalId: "u", sessionId: "1_A_01" },
      request: { kind: "compact", reason: "manual", customInstructions: "focus on plans" },
    });
    expect(reply).toHaveBeenCalledWith("Compaction complete (85% smaller).");
  });

  it("passes no instructions when the command has no arguments", async () => {
    const service = new SessionControlService();
    let request: unknown = null;
    service.register({
      targetKind: "durable_conversation",
      supports: () => true,
      async execute(_t, r) { request = r; return { status: "nothing_to_compact", targetKind: "durable_conversation", message: "no-op" }; },
    });
    setSessionControlService(service);
    const { ctx, reply } = makeCtx();
    await handleCompact("/compact", ctx);
    expect(request).toMatchObject({ customInstructions: undefined });
    expect(reply).toHaveBeenCalledWith("Nothing to compact — history is within budget.");
  });

  it("bounds oversized custom instructions", async () => {
    setSessionControlService(new SessionControlService());
    const { ctx, reply } = makeCtx();
    await handleCompact(`/compact ${"x".repeat(5000)}`, ctx);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("exceed"));
  });

  it("reports unavailability when no control service is composed", async () => {
    const { ctx, reply } = makeCtx();
    await handleCompact("/compact", ctx);
    expect(reply).toHaveBeenCalledWith("Compaction is unavailable (control service not initialized).");
  });

  it("maps stale/busy/unsupported/failed results truthfully", () => {
    expect(formatCompactReply({ status: "stale", message: "" })).toContain("newer checkpoint");
    expect(formatCompactReply({ status: "busy", message: "" })).toContain("already in progress");
    expect(formatCompactReply({ status: "unsupported", message: "" })).toContain("not supported");
    expect(formatCompactReply({ status: "failed", message: "secret detail" })).toBe("Compaction failed.");
  });

  it("never forwards slash text as a model prompt for unsupported targets", async () => {
    // /compact on a non-durable session must not reach any adapter.
    const service = new SessionControlService();
    const spy = vi.fn();
    service.register({
      targetKind: "durable_conversation",
      supports: () => true,
      async execute() { spy(); return { status: "completed", targetKind: "durable_conversation", message: "x" }; },
    });
    setSessionControlService(service);
    const { ctx } = makeCtx("1_K_01");
    await handleCompact("/compact", ctx);
    expect(spy).not.toHaveBeenCalled();
  });
});
