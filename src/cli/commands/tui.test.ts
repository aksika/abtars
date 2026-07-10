/**
 * tui.test.ts — `abtars tui` client tests (#1315 + #1333).
 *
 * parseAttachMode is pure and tested directly. The Markdown rendering path
 * is covered by:
 *   1. Required-key contract on `TUI_MARKDOWN_THEME`
 *   2. Real pi-tui render() against a representative fixture (skipped if absent)
 *   3. The render error boundary — a forced Markdown constructor throw is
 *      caught and routed to the cleanup path without uncaught process death.
 *
 * Full raw-mode foreground testing is manual on a live bridge —
 * see specs/1315/tasks.md Task 8.
 */

import { describe, it, expect } from "vitest";
import {
  parseAttachMode,
  TUI_MARKDOWN_THEME,
  createMarkdownMessage,
  processMessageFrame,
  type MessageRole,
} from "./tui.js";

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

// ── #1333: TUI MarkdownTheme contract ─────────────────────────────────

/** Exact key set pi-tui 0.80.6's Markdown.render() invokes. */
const REQUIRED_THEME_KEYS = [
  "heading",
  "link",
  "linkUrl",
  "code",
  "codeBlock",
  "codeBlockBorder",
  "quote",
  "quoteBorder",
  "hr",
  "listBullet",
  "bold",
  "italic",
  "strikethrough",
  "underline",
] as const;

describe("TUI_MARKDOWN_THEME (#1333)", () => {
  it("contains all 14 required keys as no-op functions", () => {
    for (const key of REQUIRED_THEME_KEYS) {
      expect(typeof TUI_MARKDOWN_THEME[key], `theme.${key} is not a function`).toBe("function");
    }
  });

  it("contains exactly the required keys (no extras drift)", () => {
    expect(Object.keys(TUI_MARKDOWN_THEME).sort()).toEqual([...REQUIRED_THEME_KEYS].sort());
  });

  it("every key is the identity function (no styling leakage)", () => {
    for (const key of REQUIRED_THEME_KEYS) {
      expect(TUI_MARKDOWN_THEME[key]("hello")).toBe("hello");
    }
  });
});

// ── #1333: real pi-tui render against a representative fixture ────────

const FIXTURE = [
  "# Heading",
  "",
  "**bold** *italic* ~~strike~~",
  "",
  "- one",
  "- two",
  "",
  "> a quote",
  "",
  "---",
  "",
  "[link](https://example.com) and `code`",
  "",
  "```ts",
  "const value = 1;",
  "```",
  "",
].join("\n");

describe("createMarkdownMessage (#1333)", () => {
  it("renders the fixture at width 80 without throwing", async () => {
    let pit: typeof import("@earendil-works/pi-tui") | undefined;
    try {
      pit = await import("@earendil-works/pi-tui");
    } catch {
      // pi-tui is an optional dep; integration test only runs when installed.
      return;
    }
    const md = createMarkdownMessage(pit, "assistant", FIXTURE);
    const lines = md.render(80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("renders the actual #1333 crash repro (bold + list) without throwing", async () => {
    let pit: typeof import("@earendil-works/pi-tui") | undefined;
    try {
      pit = await import("@earendil-works/pi-tui");
    } catch {
      return;
    }
    const repro = "Hey aksika. 👋\n\nIt's been a minute.\n\n- **Sleep** is still broken.\n- **Finance** report needs review.";
    const md = createMarkdownMessage(pit, "assistant", repro);
    const lines = md.render(80);
    expect(Array.isArray(lines)).toBe(true);
  });

  it("wraps user-role markdown with a dim '>' prefix and still renders", async () => {
    let pit: typeof import("@earendil-works/pi-tui") | undefined;
    try {
      pit = await import("@earendil-works/pi-tui");
    } catch {
      return;
    }
    const md = createMarkdownMessage(pit, "user", "/status");
    const lines = md.render(80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.join("\n")).toContain("/status");
  });
});

// ── #1333: render error boundary ──────────────────────────────────────

describe("processMessageFrame (#1333 error boundary)", () => {
  it("catches a synchronous Markdown constructor throw and routes to onRenderError", () => {
    const throwingPit = {
      Markdown: class {
        constructor() {
          throw new Error("boom from Markdown ctor");
        }
      },
    };
    let captured: Error | null = null;
    const onError = (err: Error): void => {
      captured = err;
    };
    const frame = { t: "message", role: "assistant", markdown: "x" } as const;
    const result = processMessageFrame(throwingPit, frame, onError);
    expect(result.ok).toBe(false);
    expect(captured).not.toBeNull();
    expect(captured!.message).toBe("boom from Markdown ctor");
  });

  it("returns ok=true when the Markdown constructor succeeds", () => {
    const okPit = {
      Markdown: class {
        // biome-ignore lint: empty placeholder
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        constructor(_text: string, _px: number, _py: number, _theme: unknown, _style?: unknown) {}
        // biome-ignore lint: empty placeholder
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        render(_w: number): string[] { return ["line"]; }
      },
    };
    let captured: Error | null = null;
    const onError = (err: Error): void => {
      captured = err;
    };
    const frame = { t: "message", role: "assistant", markdown: "x" } as const;
    const result = processMessageFrame(okPit, frame, onError);
    expect(result.ok).toBe(true);
    expect(captured).toBeNull();
  });

  it("ignores non-message frames without calling onRenderError", () => {
    const okPit = {
      Markdown: class {
        constructor() {
          throw new Error("should not be called for non-message");
        }
        render(): string[] { return []; }
      },
    };
    let captured: Error | null = null;
    const onError = (err: Error): void => {
      captured = err;
    };
    const frame = { t: "ready", sessionLabel: "M", sessionId: "1" } as const;
    const result = processMessageFrame(okPit, frame, onError);
    expect(result.ok).toBe(true);
    expect(captured).toBeNull();
  });
});

// Quiet the unused-type-import warning when MessageRole is only used in
// test code via createMarkdownMessage's parameter type.
type _MessageRoleUsed = MessageRole;
