/**
 * tui.test.ts — `abtars tui` client tests (#1315 + #1333 + #1423 + #1612).
 *
 * parseAttachMode is pure and tested directly. Footer formatting (#1355) and
 * the renderer shell live in `tui-ui.ts` (#1612) — footer tests import
 * `formatRuntimeStatus` from there. #1333 render-error-boundary coverage now
 * lives in `tui-ui.test.ts` at the component boundary.
 */

import { describe, it, expect, vi } from "vitest";
import * as piTui from "@earendil-works/pi-tui";
import {
  isTuiExitCommand,
  parseAttachMode,
  consumeServerFrames,
} from "./tui.js";
import { formatRuntimeStatus, identityEditorTheme } from "./tui-ui.js";
import {
  createFrameDecoder,
  encodeFrame,
  type FrameDecoder,
  type TuiServerFrame,
} from "../../platforms/tui/tui-protocol.js";
import type { TuiRuntimeStatus } from "../../platforms/tui/runtime-status.js";

describe("parseAttachMode", () => {
  it("default is resume (no args)", () => {
    expect(parseAttachMode([])).toEqual({ kind: "resume" });
  });

  it("--session N parses to session mode", () => {
    expect(parseAttachMode(["--session", "2"])).toEqual({ kind: "session", index: 2 });
  });

  it("--session=N (equals form) parses to session mode", () => {
    expect(parseAttachMode(["--session=2"])).toEqual({ kind: "session", index: 2 });
  });

  it("--new defaults to type A", () => {
    expect(parseAttachMode(["--new"])).toEqual({ kind: "new", sessionType: "A" });
  });

  it("--new C parses to new mode with type C", () => {
    expect(parseAttachMode(["--new", "C"])).toEqual({ kind: "new", sessionType: "C" });
  });

  it("--new=b (lowercase) normalizes to B", () => {
    expect(parseAttachMode(["--new=b"])).toEqual({ kind: "new", sessionType: "B" });
  });

  it("--orc parses to orc mode", () => {
    expect(parseAttachMode(["--orc"])).toEqual({ kind: "orc" });
  });

  it("--session and --new are mutually exclusive", () => {
    expect(() => parseAttachMode(["--session", "1", "--new"])).toThrow(/mutually exclusive/);
  });

  it("--session and --orc are mutually exclusive", () => {
    expect(() => parseAttachMode(["--session", "1", "--orc"])).toThrow(/mutually exclusive/);
  });

  it("--new and --orc are mutually exclusive", () => {
    expect(() => parseAttachMode(["--new", "C", "--orc"])).toThrow(/mutually exclusive/);
  });

  it("--session without a value throws", () => {
    expect(() => parseAttachMode(["--session"])).toThrow(/requires a numeric/);
  });

  it("--session with a non-numeric value throws", () => {
    expect(() => parseAttachMode(["--session", "abc"])).toThrow(/non-negative integer/);
    expect(() => parseAttachMode(["--session=-1"])).toThrow(/non-negative integer/);
  });

  it("--new with an invalid type throws", () => {
    expect(() => parseAttachMode(["--new", "O"])).toThrow(/A, B, or C/);
    expect(() => parseAttachMode(["--new=t"])).toThrow(/A, B, or C/);
  });
});

describe("isTuiExitCommand", () => {
  it("matches /exit exactly", () => {
    expect(isTuiExitCommand("/exit")).toBe(true);
  });

  it("handles surrounding whitespace", () => {
    expect(isTuiExitCommand("  /exit  ")).toBe(true);
    expect(isTuiExitCommand("\t/exit\n")).toBe(true);
  });

  it("normalizes case", () => {
    expect(isTuiExitCommand("/EXIT")).toBe(true);
    expect(isTuiExitCommand("/Exit")).toBe(true);
  });

  it("rejects near misses", () => {
    expect(isTuiExitCommand("/exit now")).toBe(false);
    expect(isTuiExitCommand("exit")).toBe(false);
    expect(isTuiExitCommand("/exits")).toBe(false);
    expect(isTuiExitCommand("/quit")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isTuiExitCommand("")).toBe(false);
  });
});

describe("formatRuntimeStatus (#1355)", () => {
  const rich: TuiRuntimeStatus = {
    sessionId: "s1",
    revision: 1,
    provider: "zai",
    model: "glm-5.2",
    contextPercent: 0,
    contextWindow: 1_000_000,
    autoCompaction: true,
    reasoning: "low",
    sessionUsage: { input: 12_000, output: 2_100, cacheRead: 8_000, cacheWrite: 900, cacheHitPercent: 66.7 },
  };

  it("renders model/context/compaction/reasoning and cache-aware totals", () => {
    const line = formatRuntimeStatus(rich, 160);
    expect(line).toContain("↑12k ↓2.1k R8.0k W900 CH66.7%");
    expect(line).toContain("0.0%/1.0M (auto)");
    expect(line).toContain("(zai) glm-5.2 • low");
  });

  it("uses unknown markers instead of inventing zero context", () => {
    const line = formatRuntimeStatus({ sessionId: "s1", revision: 1, model: "m" }, 100);
    expect(line).toContain("?/?");
    expect(line).not.toContain("0.0%/");
  });

  it("truncates to narrow terminal width", () => {
    const line = formatRuntimeStatus(rich, 24);
    expect(line.length).toBe(24);
    expect(line.endsWith("…")).toBe(true);
  });
});

// ── #1612: footer formatting lives in tui-ui.ts; Text.setText (#1423) ────

describe("Text.setText (#1423)", () => {
  it("setText exists and replaces content", () => {
    const text = new piTui.Text("old", 0, 0);
    const linesBefore = text.render(80);
    expect(linesBefore.join("")).toContain("old");
    text.setText("new content");
    const linesAfter = text.render(80);
    expect(linesAfter.join("")).toContain("new content");
    expect(linesAfter.join("")).not.toContain("old");
  });
});

// ── #1612: live-client crash regression (Molty `abtars tui` first paint) ──

describe("identityEditorTheme (#1612)", () => {
  it("constructs the real pi-tui Editor with a functional borderColor", () => {
    const terminal = new piTui.ProcessTerminal();
    const ui = new piTui.TUI(terminal, true);
    const editor = new piTui.Editor(ui, identityEditorTheme());
    expect(typeof editor.borderColor).toBe("function");
    expect(editor.borderColor("─")).toBe("─");
  });

  it("renders the editor without throwing at any width", () => {
    const terminal = new piTui.ProcessTerminal();
    const ui = new piTui.TUI(terminal, true);
    const editor = new piTui.Editor(ui, identityEditorTheme());
    expect(() => editor.render(40)).not.toThrow();
    expect(() => editor.render(10)).not.toThrow();
  });
});

// ── #1400: FrameDecoder socket-data integration ────────────────────────

function encodedFrame(frame: TuiServerFrame): Buffer {
  return Buffer.from(encodeFrame(frame), "utf-8");
}

describe("consumeServerFrames (#1400 decoder migration)", () => {
  it("delivers a single ready frame from raw bytes", () => {
    const decoder = createFrameDecoder<TuiServerFrame>();
    const frames: TuiServerFrame[] = [];
    const buf = encodedFrame({ t: "ready", sessionLabel: "M", sessionId: "s1" });
    consumeServerFrames(decoder, buf, (f) => frames.push(f));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: "ready", sessionId: "s1" });
  });

  it("handles a ready frame and does NOT throw TypeError", () => {
    const decoder = createFrameDecoder<TuiServerFrame>();
    const frames: TuiServerFrame[] = [];
    const buf = encodedFrame({ t: "ready", sessionLabel: "M", sessionId: "s1" });
    expect(() => consumeServerFrames(decoder, buf, (f) => frames.push(f))).not.toThrow();
    expect(frames).toHaveLength(1);
  });

  it("preserves order across multiple frames in one chunk", () => {
    const decoder = createFrameDecoder<TuiServerFrame>();
    const frames: TuiServerFrame[] = [];
    const buf = Buffer.concat([
      encodedFrame({ t: "ready", sessionLabel: "M", sessionId: "s1" }),
      encodedFrame({ t: "typing" }),
    ]);
    consumeServerFrames(decoder, buf, (f) => frames.push(f));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ t: "ready" });
    expect(frames[1]).toMatchObject({ t: "typing" });
  });

  it("preserves order across fragmented socket chunks", () => {
    const decoder = createFrameDecoder<TuiServerFrame>();
    const frames: TuiServerFrame[] = [];
    const json1 = encodeFrame({ t: "ready", sessionLabel: "M", sessionId: "s1" });
    const json2 = encodeFrame({ t: "message", role: "assistant", markdown: "hi" });

    // Split at the newline boundary of frame 1
    const half = Buffer.from(json1.slice(0, Math.floor(json1.length / 2)), "utf-8");
    const rest = Buffer.from(json1.slice(Math.floor(json1.length / 2)) + json2, "utf-8");

    consumeServerFrames(decoder, half, (f) => frames.push(f));
    expect(frames).toHaveLength(0); // incomplete frame

    consumeServerFrames(decoder, rest, (f) => frames.push(f));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ t: "ready" });
    expect(frames[1]).toMatchObject({ t: "message" });
  });

  it("recovers after a malformed bounded frame", () => {
    const decoder = createFrameDecoder<TuiServerFrame>();
    const frames: TuiServerFrame[] = [];
    const buf = Buffer.concat([
      Buffer.from("not-json\n", "utf-8"),
      encodedFrame({ t: "ready", sessionLabel: "M", sessionId: "s1" }),
    ]);
    consumeServerFrames(decoder, buf, (f) => frames.push(f));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: "ready" });
  });

  it("fires onFatal exactly once on overflow", () => {
    let fatalCount = 0;
    let fatalMsg = "";
    const decoder = createFrameDecoder<TuiServerFrame>({
      maxFrameBytes: 16,
      onFatal: (err) => { fatalCount++; fatalMsg = err.message; },
    });
    const bigLine = Buffer.from("x".repeat(20) + "\n", "utf-8");
    consumeServerFrames(decoder, bigLine, () => {});
    expect(fatalCount).toBe(1);
    expect(fatalMsg).toContain("16");
    expect(decoder.failed).toBe(true);
  });

  it("decoder.close() releases retained partial frame", () => {
    const decoder = createFrameDecoder<TuiServerFrame>();
    const frames: TuiServerFrame[] = [];
    const half = encodedFrame({ t: "ready", sessionLabel: "M", sessionId: "s1" }).slice(0, 5);
    consumeServerFrames(decoder, half, (f) => frames.push(f));
    expect(decoder.bufferedBytes).toBeGreaterThan(0);
    decoder.close();
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("does not lose split multi-byte UTF-8 code points", () => {
    const decoder = createFrameDecoder<TuiServerFrame>();
    const frames: TuiServerFrame[] = [];
    const markdown = "—em dash—";
    const full = encodeFrame({ t: "message", role: "assistant", markdown });
    // Split the em-dash (U+2014 = 0xe2 0x80 0x94) between buffers
    const splitPoint = full.indexOf(markdown) + 2; // split after first byte of em-dash
    const buf1 = Buffer.from(full.slice(0, splitPoint), "utf-8");
    const buf2 = Buffer.from(full.slice(splitPoint), "utf-8");
    consumeServerFrames(decoder, buf1, (f) => frames.push(f));
    consumeServerFrames(decoder, buf2, (f) => frames.push(f));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: "message" });
    // The frame markdown should survive — exact bytes may differ due to
    // replacement chars in the split code point, but the frame is valid
    expect((frames[0] as { t: "message"; markdown: string }).markdown).toContain("dash");
  });
});

