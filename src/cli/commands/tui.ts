/**
 * tui.ts — `abtars tui` client command (#1315).
 *
 * Foreground terminal client that connects to the bridge's TUI socket
 * (~/.abtars/tui.sock), owns the PTY in raw mode, and renders via pi-tui.
 *
 * Error semantics (per spec):
 *   - `error` frame BEFORE `ready` → startup failure → stderr + exit 1
 *   - `error` frame AFTER `ready`  → clean detach (new-attach-wins) → exit 0
 *   - socket `close` (normal)      → restore terminal → exit 0
 *
 * v1: whole-message `message` frames only. `chunk`/`chunk-end` are reserved
 * for #1319 (live mirroring) — never sent in v1.
 *
 * Pi-tui is loaded lazily via `lazyRequire` (the same shared install path
 * the daemon uses, ~/.local/lib/node_modules/) — single install surface,
 * daemon never imports it. See `OPTIONAL_DEPS.tui` in utils/lazy-require.ts.
 */

import { existsSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";

import { abtarsHome } from "../../paths.js";
import { lazyRequire } from "../../utils/lazy-require.js";
import {
  encodeFrame,
  createFrameDecoder,
  isServerFrame,
  type TuiAttachMode,
  type TuiClientFrame,
  type TuiServerFrame,
} from "../../platforms/tui/tui-protocol.js";

/** Pretty stderr writer (no colorful emoji per abtars.md). */
function stderr(line: string): void {
  process.stderr.write(line + "\n");
}

/** Pure: parse CLI args into an attach mode. Mutually exclusive flags. */
export function parseAttachMode(args: string[]): TuiAttachMode {
  let hasSession = false;
  let hasNew = false;
  let hasOrc = false;
  let sessionIndex: number | null = null;
  let newType: "A" | "B" | "C" = "A";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--orc") {
      hasOrc = true;
    } else if (a === "--session") {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error("--session requires a numeric argument (e.g. --session 2)");
      }
      const n = Number.parseInt(next, 10);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`--session value must be a non-negative integer (got "${next}")`);
      }
      sessionIndex = n;
      hasSession = true;
      i++;
    } else if (a?.startsWith("--session=")) {
      const v = a.slice("--session=".length);
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`--session value must be a non-negative integer (got "${v}")`);
      }
      sessionIndex = n;
      hasSession = true;
    } else if (a === "--new") {
      hasNew = true;
      // Optional TYPE argument
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        const u = next.toUpperCase();
        if (u !== "A" && u !== "B" && u !== "C") {
          throw new Error(`--new TYPE must be A, B, or C (got "${next}")`);
        }
        newType = u;
        i++;
      }
    } else if (a?.startsWith("--new=")) {
      const v = a.slice("--new=".length);
      const u = v.toUpperCase();
      if (u !== "A" && u !== "B" && u !== "C") {
        throw new Error(`--new TYPE must be A, B, or C (got "${v}")`);
      }
      newType = u;
      hasNew = true;
    }
  }

  const selected = (hasSession ? 1 : 0) + (hasNew ? 1 : 0) + (hasOrc ? 1 : 0);
  if (selected > 1) {
    throw new Error("--session, --new, and --orc are mutually exclusive");
  }

  if (hasOrc) return { kind: "orc" };
  if (hasSession) return { kind: "session", index: sessionIndex! };
  if (hasNew) return { kind: "new", sessionType: newType };
  return { kind: "resume" };
}

// ── #1333: Markdown theme + message construction ────────────────────

/** Roles passed to `appendMessage` and the message factory. */
export type MessageRole = "user" | "assistant" | "system";

/** Identity function reused across every theme key. */
const passthrough = (text: string): string => text;

/**
 * Complete no-op Markdown theme for pi-tui 0.80.6.
 *
 * Every key that `Markdown.render()` may invoke is present as the identity
 * function so a non-trivial response (bold, list, quote, hr, italic, etc.)
 * does not throw. Exported for direct contract testing — see tui.test.ts.
 */
export const TUI_MARKDOWN_THEME: import("@earendil-works/pi-tui").MarkdownTheme = {
  heading: passthrough,
  link: passthrough,
  linkUrl: passthrough,
  code: passthrough,
  codeBlock: passthrough,
  codeBlockBorder: passthrough,
  quote: passthrough,
  quoteBorder: passthrough,
  hr: passthrough,
  listBullet: passthrough,
  bold: passthrough,
  italic: passthrough,
  strikethrough: passthrough,
  underline: passthrough,
};

/**
 * Build a pi-tui `Markdown` component for a given role and content.
 * For "user" we wrap the text in a dim ANSI `> ` prefix so locally
 * echoed input stays visible after the editor clears on submit.
 * Throws if the underlying Markdown constructor throws — callers
 * are expected to wrap the call in the render error boundary.
 */
export function createMarkdownMessage(
  pit: Pick<typeof import("@earendil-works/pi-tui"), "Markdown">,
  role: MessageRole,
  markdown: string,
): import("@earendil-works/pi-tui").Markdown {
  const style: import("@earendil-works/pi-tui").DefaultTextStyle = {};
  const body = role === "user" ? `\u001b[2m> ${markdown}\u001b[0m` : markdown;
  return new pit.Markdown(body, 0, 0, TUI_MARKDOWN_THEME, style);
}

/**
 * Testable seam for the server-frame render path. If `frame.t` is not
 * "message" the call is a no-op. Otherwise the Markdown is constructed
 * inside a try/catch and any throw routes through `onRenderError` so
 * the TUI client can recover (terminal restore + stderr + exit 1) instead
 * of becoming an uncaught exception.
 */
export function processMessageFrame(
  pit: Pick<typeof import("@earendil-works/pi-tui"), "Markdown">,
  frame: TuiServerFrame,
  onRenderError: (err: Error) => void,
):
  | { ok: true; component: import("@earendil-works/pi-tui").Markdown | null }
  | { ok: false } {
  if (frame.t !== "message") return { ok: true, component: null };
  try {
    const component = createMarkdownMessage(pit, frame.role, frame.markdown);
    return { ok: true, component };
  } catch (err) {
    onRenderError(err instanceof Error ? err : new Error(String(err)));
    return { ok: false };
  }
}

/** Entry point for the `abtars tui` subcommand. */
export async function tui(args: string[]): Promise<number> {
  let mode: TuiAttachMode;
  try {
    mode = parseAttachMode(args);
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const socketPath = join(abtarsHome(), "tui.sock");
  if (!existsSync(socketPath)) {
    stderr(
      `No bridge socket at ${socketPath}\n` +
      `Is the bridge running with TUI_ENABLED=true? ` +
      `Enable with: abtars update --local && TUI_ENABLED=true in the env, or pass --tui to the bridge.`,
    );
    return 1;
  }

  const pit = await lazyRequire<typeof import("@earendil-works/pi-tui")>(
    "@earendil-works/pi-tui",
    "pi-tui terminal UI",
  );

  // Build the TUI.
  const terminal = new pit.ProcessTerminal();
  const ui = new pit.TUI(terminal, true);     // showHardwareCursor=true
  const log = new pit.Container();
  // Minimal editor theme — border only. pi-tui requires EditorTheme.
  const editorTheme: import("@earendil-works/pi-tui").EditorTheme = {
    borderColor: (s: string) => s,
    selectList: {
      itemName: (s: string) => s,
      itemDescription: (s: string) => s,
      noItems: (s: string) => s,
      scrollInfo: (s: string) => s,
      selectedPrefix: (s: string) => s,
      selectedText: (s: string) => s,
      description: (s: string) => s,
      hint: (s: string) => s,
    },
  };
  const editor = new pit.Editor(ui, editorTheme);
  ui.addChild(log);
  ui.addChild(editor);
  ui.setFocus(editor);

  // Connect.
  const conn = net.createConnection(socketPath);
  const decode = createFrameDecoder<TuiServerFrame>();
  let ready = false;             // pre-`ready` errors = startup failure (exit 1)
  let shouldExitCode: number | null = null;
  let stopping = false;

  // pi-tui's TUI.start() is NON-BLOCKING (event-driven: it sets up stdin/stdout
  // and returns). We need a promise to await so the process stays alive until
  // ui.stop() is called. Without this, tui() returns, Node exits 0, and the
  // user sees init→cleanup escape sequences with no actual TUI session.
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    shouldExitCode = code;
    try { ui.stop(); } catch { /* best effort */ }
    try { conn.destroy(); } catch { /* best effort */ }
    resolveStopped();
    // Defer the actual exit to the next tick so any in-flight renders finish.
    setImmediate(() => process.exit(code));
  };

  // Restore terminal on any abnormal exit path. The library cleans up
  // raw mode via ui.stop(); the extra handlers guard against a process
  // exit between stop and the eventual process.exit.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => stop(0));
  }
  process.once("exit", () => {
    try { ui.stop(); } catch { /* best effort */ }
  });

  conn.on("connect", () => {
    const attach: TuiClientFrame = {
      t: "attach",
      mode,
      cols: terminal.columns,
      rows: terminal.rows,
    };
    conn.write(encodeFrame(attach));
  });

  conn.on("data", (buf: Buffer) => {
    for (const frame of decode(buf.toString())) {
      if (!isServerFrame(frame)) continue;
      handleServerFrame(frame);
    }
  });

  conn.on("error", (err) => {
    if (!ready) {
      stderr(`Connection error: ${err.message}`);
      stop(1);
    } else {
      // Post-ready: treat as clean detach. The terminal is restored on stop().
      stop(0);
    }
  });

  conn.on("close", () => {
    // Bridge died mid-session or detached normally. Restore terminal, exit 0.
    stop(0);
  });

  // ── #1333: render error boundary ──────────────────────────────────
  // Stop the client when a Markdown render fails. Idempotent — reuses
  // the existing `stop()` lifecycle so terminal cleanup runs exactly once.
  // Prints a concise stderr line AFTER ui.stop() so the message is not
  // hidden behind the terminal's restore escape sequences.
  const stopForRenderError = (err: Error): void => {
    try { ui.stop(); } catch { /* best effort */ }
    try { conn.destroy(); } catch { /* best effort */ }
    process.stderr.write(`TUI render error: ${err.message}\n`);
    stop(1);
  };

  // Input handling — Ctrl-C / Ctrl-D → detach+exit. Editor onSubmit → input frame.
  ui.addInputListener((data: string) => {
    if (pit.matchesKey(data, "ctrl+c") || pit.matchesKey(data, "ctrl+d")) {
      conn.end();
      stop(0);
      return { consume: true };
    }
    return undefined;
  });

  editor.onSubmit = (text: string) => {
    if (!ready) return;        // can't send before attach accepted
    if (text.length === 0) return;
    // Mirror the user's input into the log so the line stays visible after
    // the editor clears on submit. In a "normal terminal" the user's own
    // message is part of the conversation history, not just an input box.
    appendMessage("user", text);
    conn.write(encodeFrame({ t: "input", text }));
  };

  function handleServerFrame(frame: TuiServerFrame): void {
    switch (frame.t) {
      case "ready":
        ready = true;
        return;
      case "error":
        if (!ready) {
          // Pre-`ready` error: attach failed. Fatal — exit 1.
          stderr(`Attach failed: ${frame.message}`);
          stop(1);
        } else {
          // Post-`ready` error: a new-attach-wins eviction. Clean detach, exit 0.
          stop(0);
        }
        return;
      case "message":
        appendMessage(frame.role, frame.markdown);
        return;
      case "chunk":
      case "chunk-end":
        // RESERVED — see "Streaming (v1)" in design.md. Never emitted in v1.
        return;
      case "typing":
        // Reserved for v1+ — render a transient indicator. For now, ignore.
        return;
    }
  }

  function appendMessage(role: MessageRole, markdown: string): void {
    // #1333: any failure during Markdown construction or addChild is
    // contained here so a renderer regression (e.g. a future pi-tui theme
    // method we forgot) cannot crash the whole client. On error we route
    // through `stopForRenderError` which restores the terminal, prints
    // a concise stderr line, and exits 1.
    try {
      const md = createMarkdownMessage(pit, role, markdown);
      log.addChild(md);
      ui.requestRender();
    } catch (err) {
      stopForRenderError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Hand the terminal over to pi-tui. From this point on, raw mode is
  // managed by the library. ui.start() itself is non-blocking; we await
  // the `stopped` promise which resolves in `stop()` (above) when the
  // session ends (Ctrl-C, Ctrl-D, detach, or error).
  ui.start();
  await stopped;
  return shouldExitCode ?? 0;
}
