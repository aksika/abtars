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
  type NativeCodingHandoffInfo,
} from "../../platforms/tui/tui-protocol.js";
import { TuiApp, nativeEditorTheme, type TuiPresentationModules } from "./tui-ui.js";
import {
  isNativeHandoffCommand,
  readClientPiConfig,
  buildNativeHandoffArgs,
  buildNativeHandoffEnv,
  spawnNativeHandoff,
  waitForNativeExit,
} from "./tui-coding-handoff.js";

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

  // Build the TUI. The editor MUST be constructed with a functional theme:
  // pi-tui renders with theme.borderColor, and the Loader in TuiApp's
  // constructor triggers an early render — an `{}` theme crashes the first
  // paint (#1612 regression on the live client). The shell adds the editor
  // to the tree exactly once in TuiApp._buildShell.
  // #1612: pi-tui writes to process.stdout; an abruptly-destroyed PTY emits
  // 'error' (EIO) on it. Without a listener that becomes an unhandled crash
  // during teardown — swallow it, the terminal is already gone.
  process.stdout.on("error", () => { /* swallowed: terminal is gone */ });
  const terminal = new modules.tui.ProcessTerminal();
  const ui = new modules.tui.TUI(terminal, true);   // showHardwareCursor=true
  const editor = new modules.tui.Editor(ui, nativeEditorTheme(modules.codingAgent));

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
  // UI exactly once per running period; `uiRunning` tracks start/stop pairs (a
  // native handoff stops the UI and a later `ready` starts it again — safe because
  // pi-tui's stop() removes the listener its start() created).
  let uiRunning = false;

  // #1635 Phase 2 — native TUI handoff state.
  let handoffActive = false;
  let handoffSessionId: string | null = null;
  let handoffBridgeGone = false;
  let terminateAfterHandoff = false;
  let handoffAcceptWaiter: ((outcome: HandoffAcceptOutcome) => void) | null = null;
  let handoffReleaseWaiter: (() => void) | null = null;

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
  // #1635 Phase 2: while a native handoff runs, signals belong to Pi (the
  // foreground child shares the terminal). The client defers its own exit
  // until after Pi exits; terminateAfterHandoff then stops the client.
  const onSignal = (): void => {
    if (handoffActive) {
      terminateAfterHandoff = true;
      return;
    }
    stop(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, onSignal);
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
    if (handoffActive) {
      // Bridge died mid-handoff — Pi keeps the terminal until it exits.
      handoffBridgeGone = true;
      return;
    }
    if (!ready) {
      stderr(`Connection error: ${err.message}`);
      stop(1);
    } else {
      // Post-ready: treat as clean detach. The terminal is restored on stop().
      stop(0);
    }
  });

  conn.on("close", () => {
    if (handoffActive) {
      // Bridge died mid-handoff — let Pi finish; degrade after exit.
      handoffBridgeGone = true;
      return;
    }
    // Bridge died mid-session or detached normally. Restore terminal, exit 0.
    stop(0);
  });

  // Input handling — Ctrl-C / Ctrl-D → detach+exit. Editor onSubmit → input frame.
  ui.addInputListener((data: string) => {
    if (modules.tui.matchesKey(data, "ctrl+c") || modules.tui.matchesKey(data, "ctrl+d")) {
      if (handoffActive) return { consume: true };
      conn!.end();
      stop(0);
      return { consume: true };
    }
    return undefined;
  });

  editor.onSubmit = (text: string) => {
    if (handoffActive) return;   // the terminal belongs to Pi
    if (!ready) return;        // can't send before attach accepted
    if (text.length === 0) return;
    // #1369: /exit is a local command — exit the client, don't touch the wire.
    if (isTuiExitCommand(text)) {
      conn!.end();
      stop(0);
      return;
    }
    // #1635 Phase 2: /coding (and new/resume) triggers the native handoff
    // instead of an RPC turn — the client spawns the pinned Pi interactively.
    if (isNativeHandoffCommand(text)) {
      void runCodingHandoff(text);
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
      case "coding-handoff-accepted":
        handoffAcceptWaiter?.({ kind: "accepted", handoff: frame.handoff });
        handoffAcceptWaiter = null;
        return;
      case "coding-handoff-rejected":
        handoffAcceptWaiter?.({ kind: "rejected", message: frame.message });
        handoffAcceptWaiter = null;
        return;
      case "coding-handoff-released":
        if (handoffReleaseWaiter) { handoffReleaseWaiter(); handoffReleaseWaiter = null; }
        return;
    }
    if (handoffActive) return;   // gate: no render frames while Pi owns the terminal
    switch (frame.t) {
      case "ready":
        ready = true;
        if (!uiRunning) {
          uiRunning = true;
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

  // #1635 Phase 2 — native TUI handoff orchestration. The client keeps the
  // bridge connection open the whole time; the bridge holds the lease, the
  // workspace claim and a shared Pi slot until the exit frame releases them.
  function waitForHandoffAccept(timeoutMs = 15_000): Promise<HandoffAcceptOutcome> {
    return new Promise<HandoffAcceptOutcome>((resolve) => {
      handoffAcceptWaiter = resolve;
      const timer = setTimeout(() => {
        if (handoffAcceptWaiter === resolve) {
          handoffAcceptWaiter = null;
          resolve({ kind: "timeout" });
        }
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  function waitForHandoffRelease(timeoutMs = 30_000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (handoffBridgeGone) { resolve(false); return; }
      handoffReleaseWaiter = () => resolve(true);
      const timer = setTimeout(() => {
        if (handoffReleaseWaiter) { handoffReleaseWaiter = null; resolve(false); }
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  /** Ask the bridge to release the reserved handoff resources. */
  function sendHandoffExit(code: number | null): void {
    const sid = handoffSessionId;
    if (!sid || !conn) return;
    try {
      conn.write(encodeFrame({ t: "coding-handoff-exit", sessionId: sid, code }));
    } catch { /* bridge is gone */ }
  }

  /** Show a bounded system message on the running shell (reject/error path). */
  function showSystemMessage(markdown: string): void {
    try {
      app?.handleFrame({ t: "message", role: "system", markdown: markdown.slice(0, 2000) });
    } catch { /* best effort */ }
  }

  /**
   * The full handoff: request -> accept -> suspend TUI -> spawn pinned Pi
   * interactively -> on exit send the release frame -> re-attach -> resume.
   */
  async function runCodingHandoff(text: string): Promise<void> {
    if (!ready || !conn || handoffActive) return;

    // 1. Ask the bridge to resolve the session and reserve the resources.
    conn.write(encodeFrame({ t: "coding-handoff", text: text.slice(0, 4096) }));
    const accepted = await waitForHandoffAccept();
    if (accepted.kind !== "accepted") {
      if (accepted.kind === "rejected") {
        showSystemMessage(`Coding handoff rejected: ${accepted.message}`);
      } else {
        showSystemMessage("Coding handoff did not reach the bridge in time — try again.");
      }
      return;
    }
    const info = accepted.handoff;
    handoffActive = true;
    handoffSessionId = info.sessionId;

    // 2. Client-side resolution BEFORE touching the terminal (local-host
    //    rule: the executable and every argument come from this host).
    let executable: string;
    let args: string[];
    let env: Record<string, string>;
    try {
      const piResult = resolvePiInstallation();
      if (piResult.state !== "compatible") {
        throw new Error(`Pi is ${piResult.state} — install it with: abtars deps install pi`);
      }
      const piConfig = readClientPiConfig(abtarsHome());
      if (!piConfig) {
        throw new Error("pi-executor.json is missing or unreadable — the handoff cannot build Pi arguments");
      }
      executable = piResult.installation.executable;
      args = buildNativeHandoffArgs(info, piConfig);
      env = buildNativeHandoffEnv(process.env);
    } catch (err) {
      // Fail closed: nothing was spawned — release the reservation and stay.
      sendHandoffExit(null);
      handoffActive = false;
      handoffSessionId = null;
      showSystemMessage(`Coding handoff aborted: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // 3. Suspend the abTARS render shell — pi-tui restores the terminal.
    //    (The app is NOT disposed: the post-handoff `ready` resets it via
    //    resetForReady, which clears the pre-handoff attachment state.)
    try { ui.stop(); } catch { /* best effort */ }
    uiRunning = false;

    // 4. Spawn the pinned Pi executable interactively; Pi owns the terminal.
    let code: number | null;
    try {
      const child = spawnNativeHandoff(executable, args, info.canonicalPath, env);
      if (child.pid) {
        // record the writer fence immediately — the accept-time prior-writer
        // check uses it if this client dies mid-handoff
        try {
          conn!.write(encodeFrame({ t: "coding-handoff-started", sessionId: info.sessionId, pid: child.pid }));
        } catch { /* bridge gone — recorded at next accept via writer fence */ }
      }
      code = await waitForNativeExit(child);
    } catch (err) {
      code = null;
      stderr(`Pi handoff launch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Release the generation-owned resources the bridge held for us.
    sendHandoffExit(code);
    const released = await waitForHandoffRelease();
    handoffActive = false;
    handoffSessionId = null;

    if (handoffBridgeGone) {
      stderr("Bridge disconnected during the Pi handoff — the bridge will reconcile the session at next start.");
      stop(0);
      return;
    }
    if (!released) {
      showSystemMessage("The bridge did not confirm the Pi handoff release — resources will be released when this TUI exits.");
    }

    // 6. Reconnect the prior abTARS session; the fresh `ready` restarts the
    //    render shell (resetForReady clears the pre-handoff state).
    try {
      conn!.write(encodeFrame({ t: "attach", mode: { kind: "resume" }, cols: terminal.columns, rows: terminal.rows }));
    } catch { /* best effort */ }

    if (terminateAfterHandoff) {
      stop(0);
    }
  }

  // ui.start() is called inside the `ready` frame handler, not here.
  // If the attach fails (no Orc session etc.), we never enter raw mode
  // and avoid terminal escape-sequence leakage on exit.
  // The `stopped` promise keeps the process alive until stop() is called.
  await stopped;
  return shouldExitCode ?? 0;
}

type HandoffAcceptOutcome =
  | { kind: "accepted"; handoff: NativeCodingHandoffInfo }
  | { kind: "rejected"; message: string }
  | { kind: "timeout" };
