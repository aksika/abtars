import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  createFrameDecoder,
  isClientFrame,
  isServerFrame,
  validateClientFrame,
  MAX_TUI_FRAME_BYTES,
  MAX_INPUT_BYTES,
  MAX_TERMINAL_DIM,
  MAX_TUI_SESSION_ID_BYTES,
  MAX_TUI_INSTRUCTION_ID_BYTES,
  MAX_TUI_STEER_TEXT_BYTES,
} from "./tui-protocol.js";

describe("encodeFrame", () => {
  it("appends a single newline to a client attach frame", () => {
    const frame: TuiClientFrame = { t: "attach", mode: { kind: "resume" }, cols: 80, rows: 24 };
    expect(encodeFrame(frame)).toBe(JSON.stringify(frame) + "\n");
  });

  it("appends a single newline to a server message frame", () => {
    const frame: TuiServerFrame = { t: "message", role: "assistant", markdown: "hi" };
    expect(encodeFrame(frame)).toBe(JSON.stringify(frame) + "\n");
  });

  it("round-trips a chunk-end frame with an optional reason", () => {
    const decoder = createFrameDecoder<TuiServerFrame>();
    const noReason = decoder.push(Buffer.from(encodeFrame({ t: "chunk-end", id: "s1" })));
    expect(noReason).toEqual([{ t: "chunk-end", id: "s1" }]);
    const truncated = decoder.push(Buffer.from(encodeFrame({ t: "chunk-end", id: "s1", reason: "truncated" })));
    expect(truncated).toEqual([{ t: "chunk-end", id: "s1", reason: "truncated" }]);
    const cancelled = decoder.push(Buffer.from(encodeFrame({ t: "chunk-end", id: "s2", reason: "cancelled" })));
    expect(cancelled).toEqual([{ t: "chunk-end", id: "s2", reason: "cancelled" }]);
  });
});

describe("createFrameDecoder", () => {
  it("decodes a single full frame in one chunk", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const out = decoder.push(Buffer.from(encodeFrame({ t: "input", text: "hello" })));
    expect(out).toEqual([{ t: "input", text: "hello" }]);
  });

  it("decodes two frames in one chunk", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const a = encodeFrame({ t: "input", text: "one" });
    const b = encodeFrame({ t: "resize", cols: 100, rows: 30 });
    const out = decoder.push(Buffer.from(a + b));
    expect(out).toEqual([
      { t: "input", text: "one" },
      { t: "resize", cols: 100, rows: 30 },
    ]);
  });

  it("reassembles a frame split across two chunks", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const full = encodeFrame({ t: "input", text: "split me" });
    const cut = Math.floor(full.length / 2);
    const part1 = full.slice(0, cut);
    const part2 = full.slice(cut);
    expect(decoder.push(Buffer.from(part1))).toEqual([]);
    expect(decoder.push(Buffer.from(part2))).toEqual([{ t: "input", text: "split me" }]);
  });

  it("decodes a frame that arrives in three pieces", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const full = encodeFrame({ t: "input", text: "thrice" });
    expect(decoder.push(Buffer.from(full.slice(0, 3)))).toEqual([]);
    expect(decoder.push(Buffer.from(full.slice(3, 7)))).toEqual([]);
    expect(decoder.push(Buffer.from(full.slice(7)))).toEqual([{ t: "input", text: "thrice" }]);
  });

  it("decodes a frame split inside a UTF-8 multibyte boundary", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const full = encodeFrame({ t: "input", text: "café" });
    const cut = full.indexOf("é");
    expect(decoder.push(Buffer.from(full.slice(0, cut)))).toEqual([]);
    expect(decoder.push(Buffer.from(full.slice(cut)))).toEqual([{ t: "input", text: "café" }]);
  });

  it("strips a trailing \\r before JSON.parse", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const frame = { t: "input" as const, text: "win" };
    const out = decoder.push(Buffer.from(JSON.stringify(frame) + "\r\n"));
    expect(out).toEqual([frame]);
  });

  it("skips empty lines (consecutive newlines)", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const out = decoder.push(Buffer.from("\n" + encodeFrame({ t: "input", text: "x" }) + "\n\n"));
    expect(out).toEqual([{ t: "input", text: "x" }]);
  });

  it("drops a malformed line without poisoning the next frame", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const good = { t: "input" as const, text: "after-bad" };
    const out = decoder.push(Buffer.from("not-json\n" + encodeFrame(good)));
    expect(out).toEqual([good]);
  });

  it("returns [] for an empty chunk and preserves partial state", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    expect(decoder.push(Buffer.from(""))).toEqual([]);
    expect(decoder.push(Buffer.from('{"t":"inpu'))).toEqual([]);
    expect(decoder.push(Buffer.from('t","text":"x"}\n'))).toEqual([{ t: "input", text: "x" }]);
  });

  // ── #1400: Bounded decoder tests ─────────────────────────────────────

  it("rejects a single frame over the byte limit", () => {
    let fatalCalled = false;
    const decoder = createFrameDecoder<TuiClientFrame>({ maxFrameBytes: 10, onFatal: () => { fatalCalled = true; } });
    const payload = '{"t":"input","text":"x"}\n';
    expect(decoder.push(Buffer.from(payload))).toEqual([]);
    expect(decoder.failed).toBe(true);
    expect(fatalCalled).toBe(true);
  });

  it("rejects a partial line that exceeds the limit across chunks", () => {
    let fatalMsg = "";
    const decoder = createFrameDecoder<TuiClientFrame>({ maxFrameBytes: 10, onFatal: (err) => { fatalMsg = err.message; } });
    // Push 9 bytes without newline
    expect(decoder.push(Buffer.from("123456789"))).toEqual([]);
    expect(decoder.failed).toBe(false);
    // Push 2 more — total exceeds 10
    expect(decoder.push(Buffer.from("ab"))).toEqual([]);
    expect(decoder.failed).toBe(true);
    expect(fatalMsg).toContain("exceeds");
  });

  it("accepts frame at exact byte limit", () => {
    const decoder = createFrameDecoder<TuiClientFrame>({ maxFrameBytes: 20 });
    // '{"t":"input","text"}' is 20 bytes — no newline yet
    decoder.push(Buffer.from('{"t":"input","text"}'));
    expect(decoder.failed).toBe(false);
    expect(decoder.bufferedBytes).toBe(20);
  });

  it("one-byte chunks with no newline reach limit and trigger fatal", () => {
    const decoder = createFrameDecoder<TuiClientFrame>({ maxFrameBytes: 5, onFatal: () => {} });
    for (let i = 0; i < 5; i++) {
      decoder.push(Buffer.from("a"));
      expect(decoder.failed).toBe(false);
    }
    // One more byte should overflow
    decoder.push(Buffer.from("b"));
    expect(decoder.failed).toBe(true);
  });

  it("clears retained buffer and returns no frames after fatal", () => {
    let fatalCount = 0;
    const decoder = createFrameDecoder<TuiClientFrame>({ maxFrameBytes: 3, onFatal: () => { fatalCount++; } });
    decoder.push(Buffer.from("abcd"));
    expect(decoder.failed).toBe(true);
    expect(fatalCount).toBe(1);
    // Subsequent pushes return nothing
    expect(decoder.push(Buffer.from("still-here\n"))).toEqual([]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("only calls onFatal once", () => {
    let fatalCount = 0;
    const decoder = createFrameDecoder<TuiClientFrame>({ maxFrameBytes: 3, onFatal: () => { fatalCount++; } });
    decoder.push(Buffer.from("abcd"));
    decoder.push(Buffer.from("efgh"));
    expect(fatalCount).toBe(1);
  });

  it("handles multiple lines where one later line overflows", () => {
    let fatalCount = 0;
    const decoder = createFrameDecoder<TuiClientFrame>({ maxFrameBytes: 30, onFatal: () => { fatalCount++; } });
    // First line fits within the limit
    const smallFrame = encodeFrame({ t: "input", text: "ok" });
    // Second line is huge — exceeds 30
    const hugeLine = "x".repeat(40) + "\n";
    const out = decoder.push(Buffer.from(smallFrame + hugeLine));
    // Small frame should decode
    expect(out.length).toBe(1);
    expect((out[0] as TuiClientFrame).t).toBe("input");
    // Huge line should trigger fatal
    expect(decoder.failed).toBe(true);
    expect(fatalCount).toBe(1);
  });

  it("close() releases state without triggering fatal", () => {
    const decoder = createFrameDecoder<TuiClientFrame>({ maxFrameBytes: 10 });
    decoder.push(Buffer.from("partial"));
    expect(decoder.bufferedBytes).toBeGreaterThan(0);
    decoder.close();
    expect(decoder.bufferedBytes).toBe(0);
    expect(decoder.failed).toBe(false);
  });
});

describe("validateClientFrame", () => {
  it("accepts valid attach resume", () => {
    const result = validateClientFrame({ t: "attach", mode: { kind: "resume" }, cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
  });

  it("accepts valid attach session", () => {
    const result = validateClientFrame({ t: "attach", mode: { kind: "session", index: 3 }, cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
  });

  it("accepts valid attach new", () => {
    const result = validateClientFrame({ t: "attach", mode: { kind: "new", sessionType: "B" }, cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
  });

  it("accepts valid attach orc", () => {
    const result = validateClientFrame({ t: "attach", mode: { kind: "orc" }, cols: 80, rows: 24 });
    expect(result.ok).toBe(true);
  });

  it("rejects attach with out-of-range cols", () => {
    const result = validateClientFrame({ t: "attach", mode: { kind: "resume" }, cols: 0, rows: 24 });
    expect(result.ok).toBe(false);
  });

  it("rejects attach with out-of-range rows", () => {
    const result = validateClientFrame({ t: "attach", mode: { kind: "resume" }, cols: 80, rows: MAX_TERMINAL_DIM + 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects attach with unknown mode kind", () => {
    const result = validateClientFrame({ t: "attach", mode: { kind: "invalid" as any }, cols: 80, rows: 24 });
    expect(result.ok).toBe(false);
  });

  it("rejects attach session with non-numeric index", () => {
    const result = validateClientFrame({ t: "attach", mode: { kind: "session", index: "x" as any }, cols: 80, rows: 24 });
    expect(result.ok).toBe(false);
  });

  it("rejects attach new with invalid sessionType", () => {
    const result = validateClientFrame({ t: "attach", mode: { kind: "new", sessionType: "D" as any }, cols: 80, rows: 24 });
    expect(result.ok).toBe(false);
  });

  it("accepts valid input", () => {
    const result = validateClientFrame({ t: "input", text: "hello world" });
    expect(result.ok).toBe(true);
  });

  it("rejects input exceeding byte limit", () => {
    const large = "x".repeat(MAX_INPUT_BYTES + 1);
    const result = validateClientFrame({ t: "input", text: large });
    expect(result.ok).toBe(false);
  });

  it("rejects input with non-string text", () => {
    const result = validateClientFrame({ t: "input", text: 123 as any });
    expect(result.ok).toBe(false);
  });

  it("accepts valid resize", () => {
    const result = validateClientFrame({ t: "resize", cols: 100, rows: 30 });
    expect(result.ok).toBe(true);
  });

  it("rejects resize with negative dimensions", () => {
    const result = validateClientFrame({ t: "resize", cols: -1, rows: 30 });
    expect(result.ok).toBe(false);
  });

  it("accepts valid steer", () => {
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: "i1", text: "do something" });
    expect(result.ok).toBe(true);
  });

  it("rejects steer with empty text", () => {
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: "i1", text: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects steer with oversized text", () => {
    const large = "x".repeat(MAX_TUI_STEER_TEXT_BYTES + 1);
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: "i1", text: large });
    expect(result.ok).toBe(false);
  });

  it("rejects steer with whitespace-only text", () => {
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: "i1", text: "   " });
    expect(result.ok).toBe(false);
  });

  it("rejects steer with empty sessionId", () => {
    const result = validateClientFrame({ t: "steer", sessionId: "", instructionId: "i1", text: "hello" });
    expect(result.ok).toBe(false);
  });

  it("rejects steer with non-string sessionId", () => {
    const result = validateClientFrame({ t: "steer", sessionId: 123 as any, instructionId: "i1", text: "hello" });
    expect(result.ok).toBe(false);
  });

  it("rejects steer with oversized sessionId", () => {
    const large = "s".repeat(MAX_TUI_SESSION_ID_BYTES + 1);
    const result = validateClientFrame({ t: "steer", sessionId: large, instructionId: "i1", text: "hello" });
    expect(result.ok).toBe(false);
  });

  it("accepts steer with sessionId at exact byte limit", () => {
    const exact = "s".repeat(MAX_TUI_SESSION_ID_BYTES);
    const result = validateClientFrame({ t: "steer", sessionId: exact, instructionId: "i1", text: "hello" });
    expect(result.ok).toBe(true);
  });

  it("rejects steer with empty instructionId", () => {
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: "", text: "hello" });
    expect(result.ok).toBe(false);
  });

  it("rejects steer with non-string instructionId", () => {
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: null as any, text: "hello" });
    expect(result.ok).toBe(false);
  });

  it("rejects steer with oversized instructionId", () => {
    const large = "i".repeat(MAX_TUI_INSTRUCTION_ID_BYTES + 1);
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: large, text: "hello" });
    expect(result.ok).toBe(false);
  });

  it("accepts steer with instructionId at exact byte limit", () => {
    const exact = "i".repeat(MAX_TUI_INSTRUCTION_ID_BYTES);
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: exact, text: "hello" });
    expect(result.ok).toBe(true);
  });

  it("accepts steer with text at exact byte limit", () => {
    const exact = "x".repeat(MAX_TUI_STEER_TEXT_BYTES);
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: "i1", text: exact });
    expect(result.ok).toBe(true);
  });

  it("rejects steer with non-string text", () => {
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: "i1", text: 42 as any });
    expect(result.ok).toBe(false);
  });

  it("accepts steer with Unicode text (byte-accurate)", () => {
    const uni = "🚀".repeat(1024); // 4 bytes each * 1024 = 4 KiB = MAX_TUI_STEER_TEXT_BYTES
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: "i1", text: uni });
    expect(result.ok).toBe(true);
  });

  it("rejects steer with Unicode text one byte over limit", () => {
    const uni = "a".repeat(MAX_TUI_STEER_TEXT_BYTES - 3) + "🚀"; // 4 bytes rocket at the end = limit + 1
    const result = validateClientFrame({ t: "steer", sessionId: "s1", instructionId: "i1", text: uni });
    expect(result.ok).toBe(false);
  });
});

describe("isServerFrame / isClientFrame", () => {
  it("identifies server frames", () => {
    expect(isServerFrame({ t: "ready", sessionLabel: "M", sessionId: "x" })).toBe(true);
    expect(isServerFrame({ t: "message", role: "assistant", markdown: "" })).toBe(true);
    expect(isServerFrame({ t: "typing" })).toBe(true);
    expect(isServerFrame({ t: "input", text: "x" })).toBe(false);
    expect(isServerFrame({ t: "attach", mode: { kind: "resume" }, cols: 1, rows: 1 })).toBe(false);
    expect(isServerFrame({})).toBe(false);
    expect(isServerFrame(null)).toBe(false);
    expect(isServerFrame("ready")).toBe(false);
  });

  it("identifies client frames", () => {
    expect(isClientFrame({ t: "attach", mode: { kind: "resume" }, cols: 1, rows: 1 })).toBe(true);
    expect(isClientFrame({ t: "input", text: "x" })).toBe(true);
    expect(isClientFrame({ t: "resize", cols: 1, rows: 1 })).toBe(true);
    expect(isClientFrame({ t: "ready", sessionLabel: "", sessionId: "" })).toBe(false);
    expect(isClientFrame({ t: "message", role: "assistant", markdown: "" })).toBe(false);
    expect(isClientFrame({})).toBe(false);
  });
});
