/**
 * main-conversation-ingress.test.ts — #1724: trusted scheduled-announcement
 * handoff into Main's general conversation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SCHEDULED_ANNOUNCEMENT_TOKEN } from "../types/platform.js";
import type { ManagedSession } from "./spin-types.js";

const submitMock = vi.hoisted(() => vi.fn().mockResolvedValue("sent" as const));

vi.mock("./message-pipeline.js", () => ({
  submitTrustedInternalMessage: submitMock,
}));

import { MainConversationIngress, composeScheduledAnnouncementText } from "./main-conversation-ingress.js";

function makeAdapter() {
  return {
    name: "telegram",
    capabilities: { voice: false, reactions: false, typing: false, threads: false },
    start: vi.fn(), stop: vi.fn(), authorize: () => true,
    sendMessage: vi.fn().mockResolvedValue(1),
    chunkResponse: (t: string) => [t],
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    getPipelineDeps: vi.fn().mockReturnValue({ transport: {} }),
    getAdapter: vi.fn().mockReturnValue(makeAdapter()),
    ...overrides,
  };
}

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "1_A_01", userId: "master", platform: "telegram", chatId: 42424242,
    delivery: "streaming", active: true, status: "ready",
    idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [], shortIndex: 1,
    busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
    compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    ...overrides,
  };
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "scheduled-card:12",
    cardId: 12,
    title: "Morning greeting",
    userId: "master",
    platform: "telegram",
    chatId: "42424242",
    result: "Good morning! All clear today.",
    ...overrides,
  };
}

beforeEach(() => {
  submitMock.mockClear();
  submitMock.mockResolvedValue("sent");
});

afterEach(() => { vi.restoreAllMocks(); });

describe("composeScheduledAnnouncementText", () => {
  it("uses the stable delimited form carrying title, card id, and bounded result", () => {
    const text = composeScheduledAnnouncementText("Morning greeting", 12, "Hello!");
    expect(text).toContain("[SCHEDULED TASK COMPLETED]");
    expect(text).toContain("Task: Morning greeting");
    expect(text).toContain("Card ID: 12");
    expect(text).toContain("Hello!");
    expect(text).toContain("Do not invent additional task results");
    expect(text).toContain("do not use platform-delivery tools");
  });
});

describe("MainConversationIngress.announceToMain", () => {
  it("submits a trusted internal event with stable identity and returns the pipeline outcome", async () => {
    const spinMod = await import("./spin.js");
    const session = makeSession();
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(session);
    const deps = makeDeps();
    const ingress = new MainConversationIngress(deps);

    const outcome = await ingress.announceToMain(makeRequest());

    expect(outcome).toBe("sent");
    expect(deps.getPipelineDeps).toHaveBeenCalled();
    expect(deps.getAdapter).toHaveBeenCalledWith("telegram");
    expect(submitMock).toHaveBeenCalledTimes(1);
    const msg = submitMock.mock.calls[0]![0];
    expect(msg.platform).toBe("telegram");
    expect(msg.channelId).toBe("42424242");
    expect(msg.userId).toBe("master");
    // Stable identity — never parsed from the display title.
    expect(msg.internal?.kind).toBe("scheduled_announcement");
    expect((msg.internal as Record<symbol, unknown>)[SCHEDULED_ANNOUNCEMENT_TOKEN]).toBe(true);
    expect((msg.internal as { eventId: string }).eventId).toBe("scheduled-card:12");
    expect((msg.internal as { cardId: number }).cardId).toBe(12);
    expect(msg.text).toContain("[SCHEDULED TASK COMPLETED]");
    expect(msg.text).toContain("Card ID: 12");
    expect(msg.text).toContain("Good morning! All clear today.");
    // No platform message id — reactions/edits must not fire on a synthetic id.
    expect(msg.messageId).toBeUndefined();
  });

  it("maps every unavailable boundary to not_sent without submitting", async () => {
    const cases: Array<{ deps: Record<string, unknown>; request?: Record<string, unknown> }> = [
      { deps: makeDeps({ getPipelineDeps: () => null }) },
      { deps: makeDeps({ getAdapter: () => null }) },
      { deps: makeDeps(), request: makeRequest({ result: "" }) },
      { deps: makeDeps(), request: makeRequest({ result: "   " }) },
      { deps: makeDeps(), request: makeRequest({ userId: "" }) },
      { deps: makeDeps(), request: makeRequest({ chatId: "" }) },
      { deps: makeDeps(), request: makeRequest({ title: "" }) },
      { deps: makeDeps(), request: makeRequest({ eventId: "" }) },
      { deps: makeDeps(), request: makeRequest({ eventId: "scheduled-card:99" }) },
      { deps: makeDeps(), request: makeRequest({ cardId: 0 }) },
    ];
    for (const c of cases) {
      submitMock.mockClear();
      const ingress = new MainConversationIngress(c.deps);
      const outcome = await ingress.announceToMain(makeRequest(c.request ?? {}));
      expect(outcome).toBe("not_sent");
      expect(submitMock).not.toHaveBeenCalled();
    }
  });

  it("rejects an ended or mismatched target A session before submission", async () => {
    const spinMod = await import("./spin.js");
    const variants = [
      makeSession({ status: "ended" as const }),
      makeSession({ chatId: 999 }),
      makeSession({ id: "1_K_01" }),
      makeSession({ userId: "someone-else" }),
    ];
    for (const session of variants) {
      submitMock.mockClear();
      vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(session);
      const ingress = new MainConversationIngress(makeDeps());
      const outcome = await ingress.announceToMain(makeRequest());
      expect(outcome).toBe("not_sent");
      expect(submitMock).not.toHaveBeenCalled();
    }
  });

  it("fails closed when active-session lookup throws", async () => {
    const spinMod = await import("./spin.js");
    vi.spyOn(spinMod.spin, "getActiveSession").mockImplementation(() => {
      throw new Error("session registry unavailable");
    });

    const outcome = await new MainConversationIngress(makeDeps()).announceToMain(makeRequest());

    expect(outcome).toBe("not_sent");
    expect(submitMock).not.toHaveBeenCalled();
  });
});
