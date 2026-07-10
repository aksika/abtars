import { describe, it, expect, vi } from "vitest";
import { OrcActivityFeed, type OrcActivityEvent } from "./orc-activity-feed.js";

const SID = "1749563282_O_01";
const EID = `${SID}_1_1712345678000`;

function event(overrides: Partial<OrcActivityEvent> = {}): Omit<OrcActivityEvent, "sequence" | "timestamp"> {
  return {
    kind: "execution.started",
    sessionId: SID,
    executionId: EID,
    ...overrides,
  } as any;
}

/** Flush pending microtasks (queueMicrotask) */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe("OrcActivityFeed", () => {
  it("delivers matching events to subscribed listener", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    feed.subscribe({ sessionId: SID, executionId: EID }, listener);
    feed.publish(event({ kind: "execution.started" }));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    const e = listener.mock.calls[0][0] as OrcActivityEvent;
    expect(e.sessionId).toBe(SID);
    expect(e.executionId).toBe(EID);
    expect(e.sequence).toBe(1);
  });

  it("does not deliver events for non-matching sessionId", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    feed.subscribe({ sessionId: SID, executionId: EID }, listener);
    feed.publish(event({ sessionId: "other", executionId: EID }));
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not deliver events for non-matching executionId", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    feed.subscribe({ sessionId: SID, executionId: "other_exec" }, listener);
    feed.publish(event({ kind: "execution.started" }));
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it("idle-follow mode only delivers execution.started", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    feed.subscribe({ sessionId: SID }, listener);
    feed.publish(event({ kind: "card.queued", title: "x", status: "queued" } as any));
    await flush();
    expect(listener).not.toHaveBeenCalled();
    feed.publish(event({ kind: "execution.started" }));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("produces monotonic sequences across all publishers", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    feed.subscribe({ sessionId: SID, executionId: EID }, listener);
    feed.publish(event({ kind: "execution.started" }));
    feed.publish(event({ kind: "card.queued", title: "x", status: "queued" } as any));
    feed.publish(event({ kind: "execution.completed", summary: "done" } as any));
    await flush();
    expect(listener).toHaveBeenCalledTimes(3);
    const seqs = listener.mock.calls.map(c => (c[0] as OrcActivityEvent).sequence);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("coalesces nonterminal card events for the same cardId", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    feed.subscribe({ sessionId: SID, executionId: EID }, listener);

    feed.publish(event({ kind: "card.running", title: "v1", status: "running", cardId: 5 } as any));
    feed.publish(event({ kind: "card.running", title: "v2", status: "running", cardId: 5 } as any));
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
    const e = listener.mock.calls[0][0] as OrcActivityEvent;
    expect(e.title).toBe("v2");
  });

  it("does not coalesce terminal card events", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    feed.subscribe({ sessionId: SID, executionId: EID }, listener);

    feed.publish(event({ kind: "card.completed", title: "done", status: "done", cardId: 5 } as any));
    feed.publish(event({ kind: "card.failed", title: "fail", status: "failed", cardId: 5 } as any));
    await flush();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("drops oldest nonterminal card on overflow and marks dirty", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    const unsub = feed.subscribe({ sessionId: SID, executionId: EID }, listener);

    for (let i = 0; i < 65; i++) {
      feed.publish(event({ kind: "card.queued", title: `c${i}`, status: "queued", cardId: i + 100 } as any));
    }
    await flush();

    unsub();
    expect(listener).toHaveBeenCalled();
  });

  it("subscriber isolation: one listener error does not affect others", async () => {
    const feed = new OrcActivityFeed();
    const bad = vi.fn(() => { throw new Error("bad"); });
    const good = vi.fn();
    feed.subscribe({ sessionId: SID, executionId: EID }, bad);
    feed.subscribe({ sessionId: SID, executionId: EID }, good);

    feed.publish(event({ kind: "execution.started" }));
    await flush();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops delivery", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    const unsub = feed.subscribe({ sessionId: SID, executionId: EID }, listener);
    unsub();
    feed.publish(event({ kind: "execution.started" }));
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers", async () => {
    const feed = new OrcActivityFeed();
    const l1 = vi.fn();
    const l2 = vi.fn();
    feed.subscribe({ sessionId: SID, executionId: EID }, l1);
    feed.subscribe({ sessionId: SID, executionId: EID }, l2);
    feed.publish(event({ kind: "execution.started" }));
    await flush();
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });
});
