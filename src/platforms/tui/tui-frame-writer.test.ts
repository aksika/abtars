/**
 * tui-frame-writer.test.ts — #1339 bounded per-connection writer.
 *
 * Uses a FakeSocket that lets tests simulate backpressure (writable=false)
 * and fire `drain` on demand, so the queue invariants and delivery classes
 * can be asserted without real kernel buffers.
 *
 * NOTE on semantics: when `socket.write()` returns `false`, Node has accepted
 * the bytes into its internal buffer and WILL send them; the writer must NOT
 * re-enqueue that frame. So the FIRST enqueue while blocked is "buffered"
 * (not in `queuedFrameList`). Content-asserting tests call `prime()` first to
 * spend that one buffered slot, after which every enqueue lands in the queue.
 */

import { describe, it, expect, vi } from "vitest";
import * as net from "node:net";
import {
  TuiFrameWriter,
  MAX_QUEUED_FRAMES,
  MAX_QUEUED_BYTES,
  MAX_FRAME_BYTES,
  MAX_COALESCED_CHUNK_BYTES,
  TRUNCATION_MARKER,
  type TuiFrameWriterOptions,
} from "./tui-frame-writer.js";
import { encodeFrame, type TuiServerFrame } from "./tui-protocol.js";

class FakeSocket {
  writable = true;
  destroyed = false;
  written: string[] = [];
  private drainHandlers: Array<() => void> = [];
  private errorHandlers: Array<(e: Error) => void> = [];
  write(s: string): boolean { this.written.push(s); return this.writable; }
  on(ev: string, cb: () => void): this {
    if (ev === "drain") this.drainHandlers.push(cb);
    else if (ev === "error") this.errorHandlers.push(cb as (e: Error) => void);
    return this;
  }
  removeListener(ev: string, cb: () => void): this {
    if (ev === "drain") this.drainHandlers = this.drainHandlers.filter((h) => h !== cb);
    else if (ev === "error") this.errorHandlers = this.errorHandlers.filter((h) => h !== cb);
    return this;
  }
  emitDrain(): void { for (const h of this.drainHandlers) h(); }
  asNet(): net.Socket { return this as unknown as net.Socket; }
}

interface Ctx {
  writer: TuiFrameWriter;
  socket: FakeSocket;
  /** Spend the one buffered slot so subsequent enqueues land in the queue. */
  prime: () => void;
}

function makeWriter(opts: Partial<TuiFrameWriterOptions> = {}): Ctx {
  const socket = new FakeSocket();
  const writer = new TuiFrameWriter(socket.asNet(), {
    isCurrent: opts.isCurrent ?? (() => true),
    onSemanticOverflow: opts.onSemanticOverflow ?? (() => {}),
    onWritable: opts.onWritable ?? (() => {}),
    maxFrames: opts.maxFrames,
    maxBytes: opts.maxBytes,
    maxFrameBytes: opts.maxFrameBytes,
    maxChunkBytes: opts.maxChunkBytes,
  });
  let primed = false;
  const prime = () => {
    if (primed) return;
    // First write under a paused socket returns false → buffered (not queued).
    socket.writable = false;
    writer.enqueue({ t: "typing" });
    primed = true;
  };
  return { writer, socket, prime };
}

function activity(cardId: number, title: string, seq: number): TuiServerFrame {
  return {
    t: "activity",
    event: { kind: "card.running", title, status: "running", cardId, sequence: seq, timestamp: 0, sessionId: "x", executionId: "e" } as any,
  };
}

describe("TuiFrameWriter — defaults + direct write", () => {
  it("uses exported default limits", () => {
    const { writer, socket } = makeWriter();
    expect(writer.enqueue({ t: "ready", sessionLabel: "M", sessionId: "x" })).toBe("written");
    expect(socket.written.length).toBe(1);
    expect(writer.queuedFrames).toBe(0);
    writer.close();
  });

  it("write(false) prevents further direct writes until the matching drain", () => {
    const { writer, socket } = makeWriter();
    socket.writable = true;
    expect(writer.enqueue({ t: "typing" })).toBe("written"); // direct, returns true
    socket.writable = false;
    expect(writer.enqueue({ t: "typing" })).toBe("written"); // buffered (false), blocked
    expect(writer.enqueue({ t: "typing" })).toBe("queued");   // goes to queue, no direct write
    // No third direct write happened while blocked:
    expect(socket.written.length).toBe(2);
    expect(writer.queuedFrames).toBe(1);
    // Drain flushes the queued frame and resumes direct writes.
    socket.emitDrain();
    expect(writer.queuedFrames).toBe(0);
    expect(socket.written.length).toBe(3);
    writer.close();
  });
});

describe("TuiFrameWriter — queue bounds", () => {
  it("queued frames and bytes never exceed configured limits under flood", () => {
    const { writer, socket } = makeWriter({ maxFrames: 10, maxBytes: 300, maxFrameBytes: 200 });
    socket.writable = false; // everything queues
    for (let i = 0; i < 500; i++) {
      writer.enqueue({ t: "typing" });
      expect(writer.queuedFrames).toBeLessThanOrEqual(10);
      expect(writer.queuedBytes).toBeLessThanOrEqual(300);
    }
    writer.close();
  });

  it("does not exceed default production limits", () => {
    const { writer, socket } = makeWriter();
    socket.writable = false;
    for (let i = 0; i < 5000; i++) {
      writer.enqueue({ t: "typing" });
      expect(writer.queuedFrames).toBeLessThanOrEqual(MAX_QUEUED_FRAMES);
      expect(writer.queuedBytes).toBeLessThanOrEqual(MAX_QUEUED_BYTES);
    }
    writer.close();
  });
});

describe("TuiFrameWriter — oversized frame bounding", () => {
  it("bounds an oversized message with a visible truncation marker", () => {
    const { writer, socket, prime } = makeWriter({ maxFrameBytes: 80 });
    prime();
    const big = "x".repeat(1000);
    expect(writer.enqueue({ t: "message", role: "assistant", markdown: big })).toBe("queued");
    const msg = writer.queuedFrameList.find((f) => f.t === "message") as Extract<TuiServerFrame, { t: "message" }>;
    expect(msg).toBeDefined();
    expect(msg.markdown.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(encodeFrame(msg), "utf8")).toBeLessThanOrEqual(80);
    writer.close();
  });

  it("bounds an oversized chunk delta and marks the stream truncated", () => {
    const { writer, socket, prime } = makeWriter({ maxFrameBytes: 80 });
    prime();
    writer.enqueue({ t: "chunk", id: "s1", delta: "y".repeat(1000) });
    expect(writer.truncatedStreamCount).toBe(1);
    const term = writer.queuedFrameList.find(
      (f) => f.t === "chunk-end" && (f as any).reason === "truncated",
    );
    expect(term).toBeDefined();
    writer.close();
  });
});

describe("TuiFrameWriter — coalescing", () => {
  it("replaces older status with the newest revision", () => {
    const { writer, prime } = makeWriter();
    prime();
    writer.enqueue({ t: "status", status: { sessionId: "x", revision: 1 } as any });
    writer.enqueue({ t: "status", status: { sessionId: "x", revision: 2 } as any });
    const statuses = writer.queuedFrameList.filter((f) => f.t === "status");
    expect(statuses.length).toBe(1);
    expect((statuses[0] as any).status.revision).toBe(2);
    writer.close();
  });

  it("replaces older snapshot with the newest", () => {
    const { writer, prime } = makeWriter();
    prime();
    writer.enqueue({ t: "activity-snapshot", sequence: 1, snapshot: { sessionId: "x" } as any });
    writer.enqueue({ t: "activity-snapshot", sequence: 5, snapshot: { sessionId: "x" } as any });
    const snaps = writer.queuedFrameList.filter((f) => f.t === "activity-snapshot");
    expect(snaps.length).toBe(1);
    expect((snaps[0] as any).sequence).toBe(5);
    writer.close();
  });

  it("keeps at most one typing frame", () => {
    const { writer, prime } = makeWriter();
    prime();
    writer.enqueue({ t: "typing" });
    writer.enqueue({ t: "typing" });
    expect(writer.queuedFrameList.filter((f) => f.t === "typing").length).toBe(1);
    writer.close();
  });

  it("coalesces same-stream chunks and preserves stream identity", () => {
    const { writer, prime } = makeWriter({ maxChunkBytes: 100 });
    prime();
    writer.enqueue({ t: "chunk", id: "s1", delta: "ab" });
    writer.enqueue({ t: "chunk", id: "s1", delta: "cd" });
    writer.enqueue({ t: "chunk", id: "s2", delta: "zz" });
    const chunks = writer.queuedFrameList.filter((f) => f.t === "chunk") as Array<{ id: string; delta: string }>;
    expect(chunks.length).toBe(2);
    const s1 = chunks.find((c) => c.id === "s1")!;
    expect(s1.delta).toBe("abcd");
    writer.close();
  });

  it("coalesces nonterminal activity for the same card", () => {
    const { writer, prime } = makeWriter();
    prime();
    writer.enqueue(activity(7, "v1", 1));
    writer.enqueue(activity(7, "v2", 2));
    const acts = writer.queuedFrameList.filter((f) => f.t === "activity");
    expect(acts.length).toBe(1);
    expect((acts[0] as any).event.title).toBe("v2");
    writer.close();
  });

  it("caps coalesced chunks at maxChunkBytes and marks the stream truncated", () => {
    const { writer, prime } = makeWriter({ maxChunkBytes: 10 });
    prime();
    writer.enqueue({ t: "chunk", id: "s1", delta: "12345" });
    writer.enqueue({ t: "chunk", id: "s1", delta: "67890" }); // combined 10, ok
    writer.enqueue({ t: "chunk", id: "s1", delta: "MORE" });  // exceeds cap → truncated
    const s1 = (writer.queuedFrameList.find((f) => f.t === "chunk" && (f as any).id === "s1") as any);
    expect(s1.delta.length).toBeLessThanOrEqual(10);
    expect(writer.truncatedStreamCount).toBe(1);
    writer.close();
  });
});

describe("TuiFrameWriter — eviction preserves control/terminal", () => {
  it("evicts replaceable data (typing→status→progress→chunk) to fit a terminal", () => {
    const { writer, prime } = makeWriter({ maxFrames: 3, maxBytes: 400, maxFrameBytes: 200 });
    prime();
    writer.enqueue({ t: "typing" });                                          // queued (1)
    writer.enqueue({ t: "status", status: { sessionId: "x", revision: 1 } as any }); // queued (2)
    writer.enqueue(activity(9, "p", 1));                                      // queued (3) full
    expect(writer.queuedFrames).toBe(3);
    // A terminal frame forces eviction of lowest-priority replaceable data.
    writer.enqueue({ t: "message", role: "assistant", markdown: "final" });
    const q = writer.queuedFrameList;
    expect(q.length).toBeLessThanOrEqual(3);
    expect(q.some((f) => f.t === "message")).toBe(true);
    expect(q.some((f) => f.t === "typing")).toBe(false); // lowest priority evicted
    writer.close();
  });

  it("a control frame survives saturation and evicts activity", () => {
    const { writer, prime } = makeWriter({ maxFrames: 1, maxBytes: 400, maxFrameBytes: 200 });
    prime();
    writer.enqueue(activity(1, "a", 1)); // queued (1) full
    writer.enqueue({ t: "ready", sessionLabel: "M", sessionId: "x" }); // control → evict activity
    const q = writer.queuedFrameList;
    expect(q.some((f) => f.t === "ready")).toBe(true);
    expect(q.some((f) => f.t === "activity")).toBe(false);
    writer.close();
  });
});

describe("TuiFrameWriter — model stream truncation", () => {
  it("emits exactly one truncated terminal and rejects later deltas", () => {
    const { writer, socket } = makeWriter({ maxFrames: 10, maxBytes: 1000, maxFrameBytes: 200 });
    socket.writable = false;
    // Fill the queue with preserve-class frames so a new chunk must be dropped.
    for (let i = 0; i < 11; i++) {
      writer.enqueue({ t: "ready", sessionLabel: `M${i}`, sessionId: `x${i}` });
    }
    expect(writer.queuedFrames).toBe(10);
    // First delta for s1 is dropped → truncated terminal emitted, stream marked.
    expect(writer.enqueue({ t: "chunk", id: "s1", delta: "hello" })).toBe("dropped");
    expect(writer.truncatedStreamCount).toBe(1);
    // Later deltas for the same stream are rejected, no new terminal.
    expect(writer.enqueue({ t: "chunk", id: "s1", delta: "world" })).toBe("dropped");
    expect(writer.truncatedStreamCount).toBe(1);
    const terms = writer.queuedFrameList.filter(
      (f) => f.t === "chunk-end" && (f as any).reason === "truncated",
    );
    expect(terms.length).toBe(1);
    writer.close();
  });
});

describe("TuiFrameWriter — semantic overflow + recovery hooks", () => {
  it("invokes onSemanticOverflow when a nonterminal activity is dropped", () => {
    const onOverflow = vi.fn();
    const { writer, prime } = makeWriter({ maxFrames: 1, maxBytes: 400, onSemanticOverflow: onOverflow });
    prime();
    writer.enqueue(activity(1, "a", 1)); // queued (1) full
    writer.enqueue(activity(2, "b", 2)); // drop → evict activity a → onOverflow
    expect(onOverflow).toHaveBeenCalled();
    writer.close();
  });

  it("invokes onWritable once per drain transition after a block", () => {
    const onWritable = vi.fn();
    const { writer, socket } = makeWriter({ onWritable });
    socket.writable = false;
    writer.enqueue({ t: "typing" }); // buffered
    writer.enqueue({ t: "typing" }); // queued
    expect(onWritable).not.toHaveBeenCalled();
    socket.emitDrain();
    expect(onWritable).toHaveBeenCalledTimes(1);
    writer.close();
  });
});

describe("TuiFrameWriter — attachment + lifecycle", () => {
  it("dropActivity removes queued incremental activity only", () => {
    const { writer, prime } = makeWriter();
    prime();
    writer.enqueue({ t: "typing" });
    writer.enqueue(activity(1, "a", 1));
    writer.enqueue({ t: "status", status: { sessionId: "x", revision: 1 } as any });
    writer.enqueue({ t: "activity-snapshot", sequence: 1, snapshot: { sessionId: "x" } as any });
    writer.dropActivity();
    const q = writer.queuedFrameList;
    expect(q.some((f) => f.t === "activity")).toBe(false);
    expect(q.some((f) => f.t === "status")).toBe(true);
    expect(q.some((f) => f.t === "activity-snapshot")).toBe(true);
    writer.close();
  });

  it("clearAttachment removes status/activity/snapshot/typing but keeps control+terminal", () => {
    const { writer, prime } = makeWriter();
    prime();
    writer.enqueue({ t: "ready", sessionLabel: "M", sessionId: "x" });
    writer.enqueue({ t: "typing" });
    writer.enqueue({ t: "status", status: { sessionId: "x", revision: 1 } as any });
    writer.enqueue({ t: "activity-snapshot", sequence: 1, snapshot: { sessionId: "x" } as any });
    writer.enqueue({ t: "message", role: "assistant", markdown: "hi" });
    writer.clearAttachment();
    const q = writer.queuedFrameList;
    expect(q.some((f) => f.t === "ready")).toBe(true);
    expect(q.some((f) => f.t === "message")).toBe(true);
    expect(q.some((f) => f.t === "typing")).toBe(false);
    expect(q.some((f) => f.t === "status")).toBe(false);
    expect(q.some((f) => f.t === "activity-snapshot")).toBe(false);
    writer.close();
  });

  it("close is idempotent, invalidates the instance, and removes listeners", () => {
    const { writer, socket } = makeWriter();
    socket.writable = false;
    writer.enqueue({ t: "typing" });
    writer.close();
    expect(writer.isClosed).toBe(true);
    expect(writer.enqueue({ t: "typing" })).toBe("dropped");
    socket.emitDrain(); // no flush
    expect(socket.written.length).toBe(1);
    writer.close(); // second close is safe
    expect(writer.isClosed).toBe(true);
  });

  it("stale isCurrent() drops enqueues and ignores drain", () => {
    const { writer, socket } = makeWriter({ isCurrent: () => false });
    socket.writable = true;
    expect(writer.enqueue({ t: "typing" })).toBe("dropped");
    expect(socket.written.length).toBe(0);
    socket.emitDrain(); // no flush, no onWritable side effects
    expect(socket.written.length).toBe(0);
    writer.close();
  });
});

describe("TuiFrameWriter — no producer awaits socket I/O", () => {
  it("enqueue is synchronous and never returns a promise", () => {
    const { writer, socket } = makeWriter();
    socket.writable = false;
    const res = writer.enqueue({ t: "typing" });
    expect(res).not.toBeInstanceOf(Promise);
    writer.close();
  });
});
