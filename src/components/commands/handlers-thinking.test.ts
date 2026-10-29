/**
 * #1654 — handleThinking: /thinking is a display-only toggle. show/on → true,
 * hide/off → false, bare → report, other → usage. It never touches reasoning
 * effort (that is /effort), and a missing session is reported explicitly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./registry.js", () => ({ triggerResetSession: vi.fn() }));

const { handleThinking } = await import("./handlers-transport.js");
import type { CommandContext } from "./types.js";

function makeCtx(overrides: {
  session?: { showThinking?: boolean; setReasoningEffort?: ReturnType<typeof vi.fn> };
  sessionMissing?: boolean;
} = {}): { ctx: CommandContext; reply: ReturnType<typeof vi.fn>; session: { showThinking: boolean; setReasoningEffort: ReturnType<typeof vi.fn> } } {
  const reply = vi.fn().mockResolvedValue(1);
  const session = overrides.session ?? { showThinking: false, setReasoningEffort: vi.fn() };
  const ctx = {
    sessionKey: "1_A_01", chatId: 1, userId: "u", platform: "telegram",
    reply,
    transport: { getRuntimeStatus: vi.fn(() => ({})) },
    sessionManager: {
      getSessionById: vi.fn(() => (overrides.sessionMissing ? undefined : session)),
    },
  } as unknown as CommandContext;
  return { ctx, reply, session: session as { showThinking: boolean; setReasoningEffort: ReturnType<typeof vi.fn> } };
}

describe("handleThinking — display toggle (#1654)", () => {
  it("/thinking show enables the display flag", async () => {
    const { ctx, reply, session } = makeCtx();
    const out = await handleThinking("/thinking show", ctx);
    expect(out).toBe(true);
    expect(session.showThinking).toBe(true);
    expect(reply).toHaveBeenCalledWith("Thinking display: shown");
  });

  it("/thinking on is an alias for show", async () => {
    const { ctx, reply, session } = makeCtx({ session: { showThinking: false, setReasoningEffort: vi.fn() } });
    await handleThinking("/thinking on", ctx);
    expect(session.showThinking).toBe(true);
    expect(reply).toHaveBeenCalledWith("Thinking display: shown");
  });

  it("/thinking hide disables the display flag", async () => {
    const { ctx, reply, session } = makeCtx({ session: { showThinking: true, setReasoningEffort: vi.fn() } });
    const out = await handleThinking("/thinking hide", ctx);
    expect(out).toBe(true);
    expect(session.showThinking).toBe(false);
    expect(reply).toHaveBeenCalledWith("Thinking display: hidden");
  });

  it("/thinking off is an alias for hide", async () => {
    const { ctx, reply, session } = makeCtx({ session: { showThinking: true, setReasoningEffort: vi.fn() } });
    await handleThinking("/thinking off", ctx);
    expect(session.showThinking).toBe(false);
    expect(reply).toHaveBeenCalledWith("Thinking display: hidden");
  });

  it("bare /thinking reports the current state when shown", async () => {
    const { ctx, reply } = makeCtx({ session: { showThinking: true, setReasoningEffort: vi.fn() } });
    await handleThinking("/thinking", ctx);
    expect(reply).toHaveBeenCalledWith("Thinking display: shown");
  });

  it("bare /thinking reports the current state when hidden (default)", async () => {
    const { ctx, reply } = makeCtx();
    await handleThinking("/thinking", ctx);
    expect(reply).toHaveBeenCalledWith("Thinking display: hidden");
  });

  it("/thinking medium shows usage, leaves the flag untouched, and never touches reasoning effort", async () => {
    const { ctx, reply, session } = makeCtx();
    await handleThinking("/thinking medium", ctx);
    expect(reply).toHaveBeenCalledWith("Usage: /thinking show|hide (reasoning effort is /effort)");
    expect(session.showThinking).toBe(false);
    expect(session.setReasoningEffort).not.toHaveBeenCalled();
  });

  it("a missing session is reported explicitly, never silently ignored", async () => {
    const { ctx, reply } = makeCtx({ sessionMissing: true });
    await handleThinking("/thinking show", ctx);
    expect(reply).toHaveBeenCalledWith("No active session.");
  });
});
