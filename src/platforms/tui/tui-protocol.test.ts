import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  createFrameDecoder,
  isClientFrame,
  isServerFrame,
  type TuiClientFrame,
  type TuiServerFrame,
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
    const noReason = decoder(encodeFrame({ t: "chunk-end", id: "s1" }));
    expect(noReason).toEqual([{ t: "chunk-end", id: "s1" }]);
    const truncated = decoder(encodeFrame({ t: "chunk-end", id: "s1", reason: "truncated" }));
    expect(truncated).toEqual([{ t: "chunk-end", id: "s1", reason: "truncated" }]);
    const cancelled = decoder(encodeFrame({ t: "chunk-end", id: "s2", reason: "cancelled" }));
    expect(cancelled).toEqual([{ t: "chunk-end", id: "s2", reason: "cancelled" }]);
  });
});

describe("createFrameDecoder", () => {
  it("decodes a single full frame in one chunk", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const out = decoder(encodeFrame({ t: "input", text: "hello" }));
    expect(out).toEqual([{ t: "input", text: "hello" }]);
  });

  it("decodes two frames in one chunk", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const a = encodeFrame({ t: "input", text: "one" });
    const b = encodeFrame({ t: "resize", cols: 100, rows: 30 });
    const out = decoder(a + b);
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
    expect(decoder(part1)).toEqual([]);
    expect(decoder(part2)).toEqual([{ t: "input", text: "split me" }]);
  });

  it("decodes a frame that arrives in three pieces", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const full = encodeFrame({ t: "input", text: "thrice" });
    expect(decoder(full.slice(0, 3))).toEqual([]);
    expect(decoder(full.slice(3, 7))).toEqual([]);
    expect(decoder(full.slice(7))).toEqual([{ t: "input", text: "thrice" }]);
  });

  it("decodes a frame split inside a UTF-8 multibyte boundary", () => {
    // "café" → "caf" (5 bytes) + "é" (2 bytes). Decoder must reassemble by chars, not bytes.
    const decoder = createFrameDecoder<TuiClientFrame>();
    const full = encodeFrame({ t: "input", text: "café" });
    const cut = full.indexOf("é"); // byte position of the multibyte char
    expect(decoder(full.slice(0, cut))).toEqual([]);
    expect(decoder(full.slice(cut))).toEqual([{ t: "input", text: "café" }]);
  });

  it("strips a trailing \\r before JSON.parse", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const frame = { t: "input" as const, text: "win" };
    const out = decoder(JSON.stringify(frame) + "\r\n");
    expect(out).toEqual([frame]);
  });

  it("skips empty lines (consecutive newlines)", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const out = decoder("\n" + encodeFrame({ t: "input", text: "x" }) + "\n\n");
    expect(out).toEqual([{ t: "input", text: "x" }]);
  });

  it("drops a malformed line without poisoning the next frame", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    const good = { t: "input" as const, text: "after-bad" };
    const out = decoder("not-json\n" + encodeFrame(good));
    expect(out).toEqual([good]);
  });

  it("returns [] for an empty chunk and preserves partial state", () => {
    const decoder = createFrameDecoder<TuiClientFrame>();
    expect(decoder("")).toEqual([]);
    // Partial frame, no newline yet
    expect(decoder('{"t":"inpu')).toEqual([]);
    // Completion arrives
    expect(decoder('t","text":"x"}\n')).toEqual([{ t: "input", text: "x" }]);
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
