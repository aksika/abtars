import { describe, it, expect, beforeEach } from "vitest";
import { SleepQueue } from "./sleep-queue.js";
import type { PlatformAdapter, InboundMessage } from "../types/platform.js";

function makeMockAdapter(injected: InboundMessage[] = []): PlatformAdapter {
  return {
    name: "telegram",
    capabilities: { voice: false, reactions: false, typing: false, threads: false },
    start: async () => {},
    stop: () => {},
    authorize: () => true,
    sendMessage: async () => undefined,
    chunkResponse: (t) => [t],
    injectMessage: (msg) => { injected.push(msg); },
  };
}

describe("SleepQueue", () => {
  let queue: SleepQueue;

  beforeEach(() => {
    queue = new SleepQueue();
  });

  it("starts inactive", () => {
    expect(queue.isActive).toBe(false);
  });

  it("activate/deactivate toggles state", () => {
    queue.activate();
    expect(queue.isActive).toBe(true);
    queue.deactivate();
    expect(queue.isActive).toBe(false);
  });

  it("enqueue returns true for first message per session, false for subsequent", () => {
    queue.activate();
    const first = queue.enqueue({ sessionKey: "tg:1", channelId: "1", text: "hi", platform: "telegram" });
    const second = queue.enqueue({ sessionKey: "tg:1", channelId: "1", text: "hello", platform: "telegram" });
    const otherSession = queue.enqueue({ sessionKey: "tg:2", channelId: "2", text: "hey", platform: "telegram" });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(otherSession).toBe(true);
  });

  it("replay groups messages by sessionKey and calls adapter.injectMessage", () => {
    queue.activate();
    queue.enqueue({ sessionKey: "tg:1", channelId: "1", text: "msg1", platform: "telegram" });
    queue.enqueue({ sessionKey: "tg:1", channelId: "1", text: "msg2", platform: "telegram" });
    queue.enqueue({ sessionKey: "tg:2", channelId: "2", text: "msg3", platform: "telegram" });

    const injected: InboundMessage[] = [];
    const adapters = new Map([["telegram", makeMockAdapter(injected)]]);
    queue.replay(adapters);

    expect(injected).toHaveLength(2); // 2 groups
    expect(injected[0]!.text).toBe("msg1\n\nmsg2"); // merged
    expect(injected[1]!.text).toBe("msg3");
  });

  it("replay clears the queue", () => {
    queue.activate();
    queue.enqueue({ sessionKey: "tg:1", channelId: "1", text: "hi", platform: "telegram" });

    const injected: InboundMessage[] = [];
    const adapters = new Map([["telegram", makeMockAdapter(injected)]]);
    queue.replay(adapters);
    queue.replay(adapters); // second replay should be no-op

    expect(injected).toHaveLength(1);
  });

  it("deactivate clears replied sessions so next activate starts fresh", () => {
    queue.activate();
    queue.enqueue({ sessionKey: "tg:1", channelId: "1", text: "hi", platform: "telegram" });
    queue.deactivate();
    queue.activate();
    const isFirst = queue.enqueue({ sessionKey: "tg:1", channelId: "1", text: "hello", platform: "telegram" });
    expect(isFirst).toBe(true);
  });

  it("replay with no matching adapter drops messages without error", () => {
    queue.activate();
    queue.enqueue({ sessionKey: "dc:1", channelId: "1", text: "hi", platform: "discord" });
    const adapters = new Map([["telegram", makeMockAdapter()]]);
    expect(() => queue.replay(adapters)).not.toThrow();
  });
});
