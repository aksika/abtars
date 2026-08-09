/**
 * tui.ts — `abtars tui` client command (#1315, #1612).
 *
 * Foreground terminal client that connects to the bridge's TUI socket
 * (~/.abtars/tui.sock), owns the PTY in raw mode, and renders via pi-tui.
 *
 * Error semantics (per spec):
 *   - `error` frame BEFORE `ready` → startup failure → stderr + exit 1
 *   - `error` frame AFTER `ready`  → clean detach (new-attach-wins) → exit 0
 *   - socket `close` (normal)      → restore terminal → exit 0
 *
 * #1612: the client loads the low-level `@earendil-works/pi-tui` module from
 * the discovered installation's `moduleRoots.tui` AND the public presentation
 * package `@earendil-works/pi-coding-agent` from `packageRoot`, both via the
 * async ESM export-map loader `loadPiModule()`. Rendering lives in `tui-ui.ts`
 * (`TuiApp`); this command owns the socket, PTY, signals, and exit semantics.
 * The bridge/daemon never imports either Pi package.
 */

import { existsSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";

import { abtarsHome } from "../../paths.js";
import { resolvePiInstallation, loadPiModule } from "../../components/pi-installation.js";
import type { PiModuleSpecifier } from "../../components/pi-installation.js";
import { PI_COMPATIBILITY, formatPiPinWarning } from "../../config/pi-compatibility.js";
import {
  encodeFrame,
  createFrameDecoder,
  isServerFrame,
  type FrameDecoder,
  type TuiAttachMode,
  type TuiClientFrame,
  type TuiServerFrame,
} from "../../platforms/tui/tui-protocol.js";
import { TuiApp, type TuiPresentationModules } from "./tui-ui.js";

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

/** Pure predicate: does `text` request a local TUI exit? */
export function isTuiExitCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/exit";
}

/**
 * #1400: Testable seam for consuming raw server frame bytes.
 * Pushes the buffer through the decoder and dispatches valid server frames.
 */
export function consumeServerFrames(
  decoder: FrameDecoder<TuiServerFrame>,
  chunk: Buffer,
  onFrame: (frame: TuiServerFrame) => void,
): void {
  for (const frame of decoder.push(chunk)) {
    if (!isServerFrame(frame)) continue;
    onFrame(frame);
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

  const piResult = resolvePiInstallation();
  if (piResult.state !== "compatible") {
    stderr(
      `Pi is ${piResult.state === "absent" ? "not installed" : "in an invalid state (" + piResult.state + ")"}.\n` +
      `Install Pi with: abtars deps install pi\n` +
      `Then run 'abtars tui' again.`,
    );
    return 1;
  }

  // #1612: load BOTH public module surfaces before TUI.start(). A missing
  // required export is a bounded pre-ready startup failure — never a silent
  // fallback to the old no-op theme.
  const tuiSpec: PiModuleSpecifier = { package: "@earendil-works/pi-tui" };
  const codingAgentSpec: PiModuleSpecifier = { package: "@earendil-works/pi-coding-agent" };
  let modules: TuiPresentationModules;
  try {
    const [rawPit, rawCodingAgent] = await Promise.all([
      loadPiModule<Record<string, unknown>>(piResult.installation, tuiSpec),
      loadPiModule<Record<string, unknown>>(piResult.installation, codingAgentSpec),
    ]);

    const requiredTui = ["ProcessTerminal", "TUI", "Container", "Editor", "Text", "Markdown", "Loader", "matchesKey"] as const;
    const missingTui = requiredTui.filter(name => typeof rawPit[name] !== "function");
    if (missingTui.length > 0) {
      throw new Error(`pi-tui: missing required export(s): ${missingTui.join(", ")}`);
    }

    const requiredCodingAgent = [
      "initTheme", "getMarkdownTheme",
      "UserMessageComponent", "AssistantMessageComponent", "DynamicBorder",
    ] as const;
    const missingCodingAgent = requiredCodingAgent.filter(name => typeof rawCodingAgent[name] !== "function");
    if (missingCodingAgent.length > 0) {
      throw new Error(`pi-coding-agent: missing required export(s): ${missingCodingAgent.join(", ")}`);
    }

    modules = {
      tui: rawPit as unknown as TuiPresentationModules["tui"],
      codingAgent: rawCodingAgent as unknown as TuiPresentationModules["codingAgent"],
    };
  } catch (err) {
    stderr(
      `Pi TUI could not be loaded: ${err instanceof Error ? err.message : String(err)}\n` +
      `Reinstall Pi with: abtars deps install pi`,
    );
    return 1;
  }

  // Version check: warn when the installed Pi is above the pinned line
  if (piResult.installation.pinStatus === "above-pin") {
    const pinWarning = formatPiPinWarning(piResult.installation.version);
    stderr(`Warning: ${pinWarning ?? `Pi ${piResult.installation.version} above pin ${PI_COMPATIBILITY.pinnedRange}`}`);
  }

  // Build the TUI.
  const terminal = new modules.tui.ProcessTerminal();
  const ui = new modules.tui.TUI(terminal, true);   // showHardwareCursor=true
  const editor = new modules.tui.Editor(ui, {} as import("@earendil-works/pi-tui").EditorTheme);
  ui.addChild(editor);

  // Connect.
  let decoder: FrameDecoder<TuiServerFrame> | null = null;
  let conn: net.Socket | null = null;
  let app: TuiApp | null = null;
  let ready = false;             // pre-`ready` errors = startup failure (exit 1)
  let shouldExitCode: number | null = null;
  let stopping = false;
  // #1570: the bridge emits a fresh `ready` per attachment change (commitAttachment,
  // #1533 rebind). pi-tui's TUI.start() is NOT idempotent — it registers a new stdin
  // data listener per call, so repeated start() doubles every keystroke. Start the
  // UI exactly once per client lifetime; later `ready` frames only update state.
  let uiStarted = false;

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
    app?.dispose();
    try { ui.stop(); } catch { /* best effort */ }
    decoder?.close();
    try { conn?.destroy(); } catch { /* best effort */ }
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
    decoder?.close();
  });

  try {
    decoder = createFrameDecoder<TuiServerFrame>({
      onFatal: (error) => {
        process.stderr.write(`Protocol error: ${error.message}\n`);
        stop(1);
      },
    });
    conn = net.createConnection(socketPath);
    app = new TuiApp({
      modules,
      terminal,
      ui,
      editor,
      // #1612/#1333: render error boundary — restore terminal, bounded stderr
      // diagnostic, exit 1. Never an uncaught exception.
      onRenderError: (err: Error) => {
        try { ui.stop(); } catch { /* best effort */ }
        decoder?.close();
        try { conn?.destroy(); } catch { /* best effort */ }
        process.stderr.write(`TUI render error: ${err.message}\n`);
        stop(1);
      },
    });
  } catch (err) {
    // Component construction failed before TUI.start() — bounded pre-ready
    // failure with terminal restore and exit 1 (design R1.4/R5.5).
    try { ui.stop(); } catch { /* best effort */ }
    process.stderr.write(`TUI render error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  conn.on("connect", () => {
    const attach: TuiClientFrame = {
      t: "attach",
      mode,
      cols: terminal.columns,
      rows: terminal.rows,
    };
    conn!.write(encodeFrame(attach));
  });

  conn.on("data", (buf: Buffer) => {
    consumeServerFrames(decoder, buf, handleServerFrame);
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

  // Input handling — Ctrl-C / Ctrl-D → detach+exit. Editor onSubmit → input frame.
  ui.addInputListener((data: string) => {
    if (modules.tui.matchesKey(data, "ctrl+c") || modules.tui.matchesKey(data, "ctrl+d")) {
      conn!.end();
      stop(0);
      return { consume: true };
    }
    return undefined;
  });

  editor.onSubmit = (text: string) => {
    if (!ready) return;        // can't send before attach accepted
    if (text.length === 0) return;
    // #1369: /exit is a local command — exit the client, don't touch the wire.
    if (isTuiExitCommand(text)) {
      conn!.end();
      stop(0);
      return;
    }
    app!.submitUserText(text);
    // #1361: Detect /steer prefix in every attach mode and send a steer frame
    const currentSessionId = app!.sessionId;
    if (text.startsWith("/steer ")) {
      const body = text.slice("/steer ".length).trim();
      if (body && currentSessionId) {
        conn!.write(encodeFrame({ t: "steer", sessionId: currentSessionId, instructionId: `client_${Date.now()}`, text: body }));
        return;
      }
    }
    conn!.write(encodeFrame({ t: "input", text }));
  };

  function handleServerFrame(frame: TuiServerFrame): void {
    switch (frame.t) {
      case "ready":
        ready = true;
        if (!uiStarted) {
          uiStarted = true;
          ui.start();
        }
        app!.handleFrame(frame);
        return;
      case "error":
        if (!ready) {
          stderr(`Attach failed: ${frame.message}`);
          stop(1);
        } else {
          stop(0);
        }
        return;
      default:
        app!.handleFrame(frame);
        return;
    }
  }

  // ui.start() is called inside the `ready` frame handler, not here.
  // If the attach fails (no Orc session etc.), we never enter raw mode
  // and avoid terminal escape-sequence leakage on exit.
  // The `stopped` promise keeps the process alive until stop() is called.
  await stopped;
  return shouldExitCode ?? 0;
}
