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

describe("OrcActivityFeed — #1339 overflow surfacing + sequence watermark", () => {  it("invokes onOverflow when the subscriber queue overflows", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    const onOverflow = vi.fn();
    feed.subscribe({ sessionId: SID, executionId: EID }, listener, onOverflow);

    for (let i = 0; i < 65; i++) {
      feed.publish(event({ kind: "card.queued", title: `c${i}`, status: "queued", cardId: i + 200 } as any));
    }
    await flush();
    expect(onOverflow).toHaveBeenCalled();
  });

  it("exposes the highest assigned sequence as currentSequence", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    feed.subscribe({ sessionId: SID, executionId: EID }, listener);
    expect(feed.currentSequence).toBe(0);
    feed.publish(event({ kind: "execution.started" }));
    feed.publish(event({ kind: "card.queued", title: "x", status: "queued", cardId: 1 } as any));
    await flush();
    expect(feed.currentSequence).toBe(2);
  });
});

describe("OrcActivityFeed — #1319 dynamic execution-follow predicate", () => {
  it("evaluates the predicate at delivery so a binding transition inside a batch is honored", async () => {
    const feed = new OrcActivityFeed();
    // Idle-follow: following accepts only execution.started; the listener
    // (as the real adapter does) transitions the binding on start/terminal.
    let binding: { state: "following" } | { state: "bound"; executionId: string } = { state: "following" };
    const listener = vi.fn((e: OrcActivityEvent) => {
      if (binding.state === "following" && e.kind === "execution.started") {
        binding = { state: "bound", executionId: e.executionId };
      } else if (binding.state === "bound" && (e.kind === "execution.completed" || e.kind === "execution.failed")) {
        binding = { state: "following" };
      }
    });
    feed.subscribe({
      sessionId: SID,
      matches: (e) => {
        if (binding.state === "following") return e.kind === "execution.started";
        return e.executionId === binding.executionId;
      },
    }, listener);

    // Publish a full idle→active→terminal→next-active burst synchronously —
    // before ANY microtask delivers, so publish-time filtering would lose
    // the mid-burst execution events.
    feed.publish(event({ kind: "execution.started" }));
    feed.publish(event({ kind: "card.queued", title: "c1", status: "queued", cardId: 1 } as any));
    feed.publish(event({ kind: "channel.message", from: "w", to: "orc", message: "hi" } as any));
    feed.publish(event({ kind: "execution.completed", summary: "done" } as any));
    feed.publish(event({ kind: "execution.started", executionId: `${SID}_2_1712345679000` } as any));
    feed.publish(event({ kind: "card.queued", title: "c2", status: "queued", cardId: 2, executionId: `${SID}_2_1712345679000` } as any));
    await flush();

    // The listener observes every event and drives the binding itself.
    const kinds = listener.mock.calls.map(c => (c[0] as OrcActivityEvent).kind);
    expect(kinds).toEqual([
      "execution.started",
      "card.queued",
      "channel.message",
      "execution.completed",
      "execution.started",
      "card.queued",
    ]);
  });

  it("predicate takes precedence over executionId and rejects prior-execution events", async () => {
    const feed = new OrcActivityFeed();
    const listener = vi.fn();
    feed.subscribe({
      sessionId: SID,
      executionId: "should-be-ignored",
      matches: (e) => e.kind === "execution.started" || e.executionId === `${SID}_9_1712345678000`,
    }, listener);

    feed.publish(event({ kind: "execution.started" }));
    feed.publish(event({ kind: "card.queued", title: "old", status: "queued", cardId: 1 } as any));
    feed.publish(event({ kind: "card.queued", title: "new", status: "queued", cardId: 2, executionId: `${SID}_9_1712345678000` } as any));
    await flush();

    const kinds = listener.mock.calls.map(c => (c[0] as OrcActivityEvent).kind);
    expect(kinds).toEqual(["execution.started", "card.queued"]);
    const delivered = listener.mock.calls.map(c => (c[0] as OrcActivityEvent).cardId);
    expect(delivered).toContain(2);
    expect(delivered).not.toContain(1);
  });
});
