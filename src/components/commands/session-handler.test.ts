import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSession } from "./session-handler.js";

vi.mock("../master-user.js", () => ({
  getMasterUserId: () => "master-uid",
}));

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: "master-uid",
    platform: "telegram",
    chatId: 100,
    reply: vi.fn().mockResolvedValue(1),
    sessionManager: {
      formatList: vi.fn().mockReturnValue("Session list here"),
      createSession: vi.fn().mockReturnValue({ id: "1_A_01", shortIndex: 1 }),
      endSession: vi.fn().mockReturnValue({ id: "1_A_01", shortIndex: 1 }),
      greetSession: vi.fn(),
    },
    memory: null,
    ...overrides,
  } as any;
}

describe("handleSession", () => {
  it("/session (no args) lists sessions without crashing", async () => {
    const ctx = makeCtx();
    const result = await handleSession("/session", ctx);
    expect(result).toBe(true);
    expect(ctx.sessionManager.formatList).toHaveBeenCalledWith("master-uid", "telegram", true);
    expect(ctx.reply).toHaveBeenCalledWith("Session list here");
  });

  it("/session (no args) non-master gets isMaster=false", async () => {
    const ctx = makeCtx({ userId: "other-user" });
    await handleSession("/session", ctx);
    expect(ctx.sessionManager.formatList).toHaveBeenCalledWith("other-user", "telegram", false);
  });

  it("/session new creates a session", async () => {
    const ctx = makeCtx();
    await handleSession("/session new", ctx);
    expect(ctx.sessionManager.createSession).toHaveBeenCalledWith("master-uid", "telegram", "A");
  });

  it("/session new browse creates browse session", async () => {
    const ctx = makeCtx();
    await handleSession("/session new browse", ctx);
    expect(ctx.sessionManager.createSession).toHaveBeenCalledWith("master-uid", "telegram", "B");
  });
});
