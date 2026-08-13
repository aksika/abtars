/**
 * spin-1515.test.ts — #1515 automatic boot-greeting question metadata.
 *
 * Proves: setBootGreetingQuestion attaches to the automatic greeting (and
 * retries), direct greetSession calls never attach it, and the question is a
 * bounded immutable copy.
 */

import { describe, it, expect, vi } from "vitest";
import { Spin } from "./spin.js";
import { setUserRegistryOverride, type UserRegistry, type UserEntry } from "./user-registry.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";

function makeUser(userId: string, role: "master" | "user" | "guest", telegram = 100): UserEntry {
  return { userId, role, maxClass: role === "master" ? 3 : 1, tools: ["all"], platforms: { telegram } };
}

function makeRegistry(users: UserEntry[]): UserRegistry {
  const registry: UserRegistry = { users, byPlatformId: new Map(), byUserId: new Map() };
  for (const u of users) {
    registry.byUserId.set(u.userId, u);
    if (u.platforms.telegram) registry.byPlatformId.set(`telegram:${u.platforms.telegram}`, u);
  }
  return registry;
}

function mockTransport(): IKiroTransport {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("Hello!"),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    get isReady() { return true; },
    get contextPercent() { return -1; },
    get answerOnly() { return ""; },
    get toolCallsSucceeded() { return 0; },
    get intermediateDeliveredText() { return ""; },
  } as unknown as IKiroTransport;
}

function setupSpin(): Spin {
  const spin = new Spin();
  const mockRuntime = {
    session: vi.fn().mockResolvedValue({
      sendPrompt: vi.fn().mockResolvedValue("agent response"),
      destroy: vi.fn(),
      get isReady() { return true; },
      get transport() { return mockTransport(); },
    }),
  };
  spin.setRuntime(mockRuntime as any);
  setUserRegistryOverride(makeRegistry([makeUser("aksika", "master", 111)]));
  return spin;
}

describe("#1515 boot greeting question", () => {
  it("attaches the question to the automatic boot greeting exactly once", () => {
    const spin = setupSpin();
    spin.setBootGreetingQuestion({ id: "q-1", text: "Did you prefer the old or the new city?" });
    const session = spin.getActiveSession("aksika", "telegram");
    session.transport = mockTransport();
    const adapter = { injectMessage: vi.fn() };
    spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport: session.transport });
    spin.setGreetingAdapter(adapter);
    expect(adapter.injectMessage).toHaveBeenCalledTimes(1);
    const msg = adapter.injectMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(msg.text).toBe("[SESSION START] You just came online. Greet the user.");
    expect(msg.internal).toEqual({ kind: "boot_greeting", dreamQuestion: { id: "q-1", text: "Did you prefer the old or the new city?" } });
  });

  it("a direct greetSession call (non-automatic) never attaches question metadata", () => {
    const spin = setupSpin();
    spin.setBootGreetingQuestion({ id: "q-1", text: "Did you prefer the old or the new city?" });
    const session = spin.getActiveSession("aksika", "telegram");
    session.transport = mockTransport();
    const adapter = { injectMessage: vi.fn() };
    spin.greetSession(session, 111, "aksika", adapter);
    expect(adapter.injectMessage).toHaveBeenCalledTimes(1);
    const msg = adapter.injectMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(msg.internal).toBeUndefined();
  });

  it("without a preloaded question the automatic greeting carries no metadata", () => {
    const spin = setupSpin();
    const session = spin.getActiveSession("aksika", "telegram");
    session.transport = mockTransport();
    const adapter = { injectMessage: vi.fn() };
    spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport: session.transport });
    spin.setGreetingAdapter(adapter);
    const msg = adapter.injectMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(msg.internal).toBeUndefined();
  });

  it("stores a bounded immutable copy — later mutation of the source is ignored", () => {
    const spin = setupSpin();
    const source = { id: "q-1", text: "original question?" };
    spin.setBootGreetingQuestion(source);
    source.text = "mutated question?";
    const session = spin.getActiveSession("aksika", "telegram");
    session.transport = mockTransport();
    const adapter = { injectMessage: vi.fn() };
    spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport: session.transport });
    spin.setGreetingAdapter(adapter);
    const msg = adapter.injectMessage.mock.calls[0]?.[0] as { internal?: { dreamQuestion?: { text: string } } };
    expect(msg.internal?.dreamQuestion?.text).toBe("original question?");
  });

  it("greeting retries reuse the same bounded metadata", () => {
    vi.useFakeTimers();
    try {
      const spin = setupSpin();
      spin.setBootGreetingQuestion({ id: "q-1", text: "retry question?" });
      const session = spin.getActiveSession("aksika", "telegram");
      session.transport = mockTransport();
      const adapter = { injectMessage: vi.fn() };
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport: session.transport });
      spin.setGreetingAdapter(adapter);
      // First inject; session still has no messages and is not busy → retry.
      expect(adapter.injectMessage).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(61_000);
      expect(adapter.injectMessage).toHaveBeenCalledTimes(2);
      const first = adapter.injectMessage.mock.calls[0]?.[0] as { internal?: unknown };
      const second = adapter.injectMessage.mock.calls[1]?.[0] as { internal?: unknown };
      expect(first.internal).toEqual(second.internal);
      expect((second.internal as { dreamQuestion?: { text: string } }).dreamQuestion?.text).toBe("retry question?");
    } finally {
      vi.useRealTimers();
    }
  });
});
