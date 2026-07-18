/**
 * session-output-feed.test.ts — #1338 process-local output feed.
 *
 * Verifies: bounded payloads, session-scoped filtering, no cross-delivery
 * between overlapping sessions, observer invalidation, terminal events, and
 * cheap no-op publication with no subscribers.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SessionOutputFeed,
  SessionOutputObserver,
  createOutputObserver,
  MAX_DELTA_BYTES,
  MAX_TOOL_NAME_BYTES,
} from "./session-output-feed.js";

const SID = "1749563282_A_01";
const EID = `${SID}_1_1712345678000`;

describe("SessionOutputFeed", () => {
  it("delivers events only to subscribers matching the sessionId", () => {
    const feed = new SessionOutputFeed();
    const a = vi.fn();
    const b = vi.fn();
    feed.subscribe({ sessionId: "A" }, a);
    feed.subscribe({ sessionId: "B" }, b);
    feed.publish({ type: "delta", sessionId: "A", executionId: EID, streamId: "s1", text: "x" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("no-subscriber publication is a cheap no-op", () => {
    const feed = new SessionOutputFeed();
    // Should not throw and not accumulate anything.
    expect(() => feed.publish({ type: "delta", sessionId: SID, executionId: EID, streamId: "s1", text: "x" })).not.toThrow();
    expect(feed.subscriberCount).toBe(0);
  });

  it("unsubscribe stops delivery", () => {
    const feed = new SessionOutputFeed();
    const l = vi.fn();
    const unsub = feed.subscribe({ sessionId: SID }, l);
    feed.publish({ type: "delta", sessionId: SID, executionId: EID, streamId: "s1", text: "1" });
    unsub();
    feed.publish({ type: "delta", sessionId: SID, executionId: EID, streamId: "s1", text: "2" });
    expect(l).toHaveBeenCalledTimes(1);
  });

  it("overlapping sessions cannot cross-deliver output", () => {
    const feed = new SessionOutputFeed();
    const a = vi.fn();
    const b = vi.fn();
    feed.subscribe({ sessionId: "A_01" }, a);
    feed.subscribe({ sessionId: "A_02" }, b);
    feed.publish({ type: "delta", sessionId: "A_01", executionId: EID, streamId: "s1", text: "a" });
    feed.publish({ type: "delta", sessionId: "A_02", executionId: EID, streamId: "s2", text: "b" });
    expect(a).toHaveBeenCalledTimes(1);
    expect((a.mock.calls[0][0] as any).text).toBe("a");
    expect(b).toHaveBeenCalledTimes(1);
    expect((b.mock.calls[0][0] as any).text).toBe("b");
  });
});

describe("SessionOutputObserver", () => {
  it("emits start, textual deltas, tool-start, and end in order", () => {
    const feed = new SessionOutputFeed();
    const events: string[] = [];
    feed.subscribe({ sessionId: SID }, (e) => events.push(e.type));
    const obs = createOutputObserver(feed, { sessionId: SID, executionId: EID });
    const sid = obs.streamId;
    obs.onDelta({ kind: "text", text: "hello" });
    obs.onToolStart({ name: "search" });
    obs.end("complete");
    expect(events).toEqual(["start", "delta", "tool-start", "end"]);
    const end = feed as any; // noop
    void end;
    expect(sid).toBeTruthy();
  });

  it("excludes thinking deltas from TUI frames", () => {
    const feed = new SessionOutputFeed();
    const received: Array<{ type: string; text?: string }> = [];
    feed.subscribe({ sessionId: SID }, (e) => received.push(e as any));
    const obs = createOutputObserver(feed, { sessionId: SID, executionId: EID });
    obs.onDelta({ kind: "thinking", text: "secret thought" });
    obs.onDelta({ kind: "text", text: "visible" });
    const deltas = received.filter((e) => e.type === "delta");
    expect(deltas.length).toBe(1);
    expect(deltas[0]!.text).toBe("visible");
  });

  it("bounds delta and tool name payloads", () => {
    const feed = new SessionOutputFeed();
    let lastDelta = "";
    let lastName = "";
    feed.subscribe({ sessionId: SID }, (e) => {
      if (e.type === "delta") lastDelta = e.text;
      if (e.type === "tool-start") lastName = e.name;
    });
    const obs = createOutputObserver(feed, { sessionId: SID, executionId: EID });
    obs.onDelta({ kind: "text", text: "x".repeat(MAX_DELTA_BYTES + 500) });
    obs.onToolStart({ name: "y".repeat(MAX_TOOL_NAME_BYTES + 500) });
    expect(Buffer.byteLength(lastDelta, "utf8")).toBeLessThanOrEqual(MAX_DELTA_BYTES);
    expect(Buffer.byteLength(lastName, "utf8")).toBeLessThanOrEqual(MAX_TOOL_NAME_BYTES);
  });

  it("publication after invalidate is a no-op", () => {
    const feed = new SessionOutputFeed();
    const received = vi.fn();
    feed.subscribe({ sessionId: SID }, received);
    const obs = createOutputObserver(feed, { sessionId: SID, executionId: EID });
    obs.invalidate();
    obs.onDelta({ kind: "text", text: "late" });
    obs.onToolStart({ name: "tool" });
    obs.end("complete");
    expect(received).toHaveBeenCalledTimes(1); // only the start event
  });

  it("end is emitted exactly once even if called twice", () => {
    const feed = new SessionOutputFeed();
    const ends: string[] = [];
    feed.subscribe({ sessionId: SID }, (e) => { if (e.type === "end") ends.push((e as any).reason); });
    const obs = createOutputObserver(feed, { sessionId: SID, executionId: EID });
    obs.end("complete");
    obs.end("error");
    expect(ends).toEqual(["complete"]);
  });
});
