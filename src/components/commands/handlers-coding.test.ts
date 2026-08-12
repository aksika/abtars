/**
 * handlers-coding.test.ts — #1635 /coding command surface tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleCoding, setCodingCommandService } from "./handlers-coding.js";
import type { PiCodingSessionService } from "../pi-executor/pi-coding-session-service.js";

function makeCtx(overrides: Partial<{ userId: string; chatId: number; platform: string }> = {}) {
  const replies: string[] = [];
  const ctx = {
    userId: overrides.userId ?? "usr-1",
    chatId: overrides.chatId ?? 100,
    platform: overrides.platform ?? "telegram",
    reply: vi.fn(async (text: string) => { replies.push(text); return 1; }),
  };
  return { ctx, replies };
}

const svc = {
  createCodingSession: vi.fn(),
  getSession: vi.fn(),
  listForOwner: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
  endSession: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  svc.createCodingSession.mockReturnValue({ sessionId: "coding-1", spinSessionId: "coding-1" });
  svc.activate.mockReturnValue(true);
  svc.deactivate.mockResolvedValue(true);
  svc.endSession.mockReturnValue(true);
  setCodingCommandService(svc as never as PiCodingSessionService);
});

afterEach(() => {
  setCodingCommandService(null);
});

describe("/coding #1635", () => {
  it("new creates the session with the chat delivery target and activates it", async () => {
    const { ctx, replies } = makeCtx();
    await handleCoding("/coding new repo-a", ctx);
    expect(svc.createCodingSession).toHaveBeenCalledWith(expect.objectContaining({
      ownerPrincipal: "usr-1",
      workspaceAlias: "repo-a",
      chatId: "100",
    }));
    expect(svc.activate).toHaveBeenCalledWith("coding-1", "usr-1");
    expect(replies.join("\n")).toContain("Coding session created");
  });

  it("new without an alias shows usage", async () => {
    const { ctx, replies } = makeCtx();
    await handleCoding("/coding new", ctx);
    expect(svc.createCodingSession).not.toHaveBeenCalled();
    expect(replies.join("\n")).toContain("/coding new <workspace-alias>");
  });

  it("unknown workspace alias is refused before any session exists", async () => {
    svc.createCodingSession.mockImplementation(() => { throw new Error("Unknown workspace alias \"nope\""); });
    const { ctx, replies } = makeCtx();
    await handleCoding("/coding new nope", ctx);
    expect(replies.join("\n")).toContain("Unknown workspace alias");
    expect(svc.activate).not.toHaveBeenCalled();
  });

  it("status lists the owner's sessions with state and capability", async () => {
    svc.listForOwner.mockReturnValue([
      { sessionId: "coding-1", workspaceAlias: "repo-a", state: "running", runtimeGeneration: 3, resumeCapability: "available" },
      { sessionId: "coding-2", workspaceAlias: "repo-b", state: "idle", runtimeGeneration: 1, resumeCapability: "never_started" },
    ]);
    const { ctx, replies } = makeCtx();
    await handleCoding("/coding status", ctx);
    expect(replies.join("\n")).toContain("coding-1");
    expect(replies.join("\n")).toContain("running");
    expect(replies.join("\n")).toContain("never_started");
  });

  it("bare /coding resumes the single most recent session", async () => {
    svc.listForOwner.mockReturnValue([
      { sessionId: "coding-1", workspaceAlias: "repo-a", state: "idle" },
    ]);
    const { ctx, replies } = makeCtx();
    await handleCoding("/coding", ctx);
    expect(svc.activate).toHaveBeenCalledWith("coding-1", "usr-1");
    expect(replies.join("\n")).toContain("Resumed");
  });

  it("bare /coding with several sessions shows a bounded chooser", async () => {
    svc.listForOwner.mockReturnValue([
      { sessionId: "coding-1", workspaceAlias: "repo-a", state: "idle" },
      { sessionId: "coding-2", workspaceAlias: "repo-b", state: "idle" },
    ]);
    const { ctx, replies } = makeCtx();
    await handleCoding("/coding", ctx);
    expect(svc.activate).not.toHaveBeenCalled();
    expect(replies.join("\n")).toContain("Multiple coding sessions");
    expect(replies.join("\n")).toContain("coding-1");
    expect(replies.join("\n")).toContain("coding-2");
  });

  it("off deactivates and returns to the main session", async () => {
    svc.listForOwner.mockReturnValue([{ sessionId: "coding-1", workspaceAlias: "repo-a", state: "idle" }]);
    const { ctx, replies } = makeCtx();
    await handleCoding("/coding off", ctx);
    expect(svc.deactivate).toHaveBeenCalledWith("coding-1", "usr-1");
    expect(replies.join("\n")).toContain("deactivated");
  });

  it("end ends the session", async () => {
    svc.listForOwner.mockReturnValue([{ sessionId: "coding-1", workspaceAlias: "repo-a", state: "idle" }]);
    const { ctx, replies } = makeCtx();
    await handleCoding("/coding end", ctx);
    expect(svc.endSession).toHaveBeenCalledWith("coding-1", "usr-1");
    expect(replies.join("\n")).toContain("transcript preserved");
  });

  it("with no sessions at all, suggests /coding new", async () => {
    svc.listForOwner.mockReturnValue([]);
    const { ctx, replies } = makeCtx();
    await handleCoding("/coding", ctx);
    expect(replies.join("\n")).toContain("/coding new");
  });
});
