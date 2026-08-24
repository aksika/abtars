/**
 * bash-runner.ts — canonical bounded execution boundary for every bash tool
 * call (#1716). Owns the entire child lifetime: detached process-group spawn,
 * incremental bounded output capture, hard deadline settlement independent of
 * stream close, group-scoped SIGTERM→grace→SIGKILL containment, exactly-once
 * finalization.
 *
 * The incident this closes (#1716, Molty 2026-08-23): execFile-based runners
 * resolved their promise inside the completion callback, which fires only on
 * child exit AND stdio close. A grandchild inheriting the pipes kept them open
 * past the old shell-only timeout, so the tool promise never settled and the
 * generation wedged for hours. Here settlement happens at
 * min(deadline + grace, natural completion) unconditionally; reaping is a
 * best-effort background concern reported via cleanup_incomplete. Orphan
 * supervision remains #1711's responsibility.
 */

import { spawn } from "node:child_process";
import { fingerprintCommand, previewCommand } from "./transport/tool-failure-diagnostic.js";

export const STDOUT_CAP_CHARS = 50_000;
export const STDERR_CAP_CHARS = 10_000;
/** Preserve the old execFile maxBuffer safety boundary per output stream. */
export const MAX_BUFFER_BYTES = 1024 * 1024;
export const KILL_GRACE_MS = 3_000;

export interface BashRunnerRequest {
  readonly cmd: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly graceMs?: number | undefined;
}

export interface BashRunnerResult {
  command_fingerprint: string;
  command_preview: string;
  timed_out: boolean;
  aborted: boolean;
  cleanup_incomplete?: boolean;
  exit_code: number | null;
  process_error_code?: string;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

type TerminalReason = "exit" | "timeout" | "abort" | "max_buffer";

interface CaptureBuffer {
  text: string;
  truncated: boolean;
  cap: number;
  observedBytes: number;
}

function makeCapture(cap: number): CaptureBuffer {
  return { text: "", truncated: false, cap, observedBytes: 0 };
}

function appendCapture(buf: CaptureBuffer, chunk: string): boolean {
  buf.observedBytes += Buffer.byteLength(chunk, "utf8");
  if (buf.truncated) return buf.observedBytes > MAX_BUFFER_BYTES;
  if (buf.text.length + chunk.length >= buf.cap) {
    buf.text += chunk.slice(0, Math.max(0, buf.cap - buf.text.length));
    buf.truncated = true;
    return buf.observedBytes > MAX_BUFFER_BYTES;
  }
  buf.text += chunk;
  return buf.observedBytes > MAX_BUFFER_BYTES;
}

export function runBashCommand(req: BashRunnerRequest): Promise<BashRunnerResult> {
  const fingerprint = fingerprintCommand(req.cmd);
  const preview = previewCommand(req.cmd);
  const graceMs = req.graceMs ?? KILL_GRACE_MS;

  if (!Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0) {
    return Promise.reject(new Error(`bash-runner: invalid timeoutMs ${req.timeoutMs}`));
  }

  const abortedResult = (): BashRunnerResult => ({
    command_fingerprint: fingerprint,
    command_preview: preview,
    timed_out: false,
    aborted: true,
    exit_code: null,
    stderr: "Execution cancelled before start",
  });

  if (req.signal?.aborted) {
    return Promise.resolve(abortedResult());
  }

  return new Promise<BashRunnerResult>((resolve) => {
    let settled = false;
    let terminal: TerminalReason | null = null;
    let exitSeen = false;
    let exitCode: number | null = null;
    let exitSignal: string | undefined;
    let spawnErrorCode: string | undefined;

    const stdoutBuf = makeCapture(STDOUT_CAP_CHARS);
    const stderrBuf = makeCapture(STDERR_CAP_CHARS);

    const child = spawn(req.bin, [...req.args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: req.cwd,
      env: req.env,
    });

    let capTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      if (terminal === null) beginContainment("abort");
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    capTimer = setTimeout(() => beginContainment("timeout"), req.timeoutMs);

    function killGroup(sig: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          try {
            child.kill(sig);
          } catch {
            /* leader already gone */
          }
        }
      }
    }

    function streamsClosed(): boolean {
      return (child.stdout?.readableEnded ?? true) && (child.stderr?.readableEnded ?? true);
    }

    function buildResult(): BashRunnerResult {
      const result: BashRunnerResult = {
        command_fingerprint: fingerprint,
        command_preview: preview,
        timed_out: terminal === "timeout",
        aborted: terminal === "abort",
        exit_code: exitCode,
      };
      if (terminal === "max_buffer") {
        result.process_error_code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        result.exit_code = null;
      } else if (spawnErrorCode !== undefined) {
        result.process_error_code = spawnErrorCode;
        result.exit_code = null;
      } else if (exitSignal !== undefined) {
        result.signal = exitSignal;
      }
      if (stdoutBuf.text.length > 0) result.stdout = stdoutBuf.text;
      if (stderrBuf.text.length > 0) result.stderr = stderrBuf.text;
      if ((result.timed_out || result.aborted || terminal === "max_buffer") && !(exitSeen && streamsClosed())) {
        result.cleanup_incomplete = true;
      }
      return result;
    }

    function detach(): void {
      clearTimeout(capTimer);
      clearTimeout(graceTimer);
      req.signal?.removeEventListener("abort", onAbort);
    }

    function settleNow(): void {
      if (settled) return;
      settled = true;
      detach();
      resolve(buildResult());
    }

    function beginContainment(reason: "timeout" | "abort" | "max_buffer"): void {
      if (settled || terminal !== null) return;
      terminal = reason;
      killGroup("SIGTERM");
      if (exitSeen && streamsClosed()) {
        settleNow();
        return;
      }
      graceTimer = setTimeout(() => {
        if (settled) return;
        killGroup("SIGKILL");
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
        } catch {
          /* best effort */
        }
        settleNow();
      }, graceMs);
    }

    function onMaybeComplete(): void {
      if (settled) return;
      if (exitSeen && streamsClosed()) settleNow();
    }

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (!settled && appendCapture(stdoutBuf, chunk)) beginContainment("max_buffer");
    });
    child.stderr!.on("data", (chunk: string) => {
      if (!settled && appendCapture(stderrBuf, chunk)) beginContainment("max_buffer");
    });
    child.stdout!.on("close", onMaybeComplete);
    child.stderr!.on("close", onMaybeComplete);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (typeof err.code === "string") spawnErrorCode = err.code;
      exitSeen = true;
      onMaybeComplete();
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exitSeen = true;
      if (code !== null && typeof code === "number") exitCode = code;
      else {
        exitCode = null;
        if (signal) exitSignal = signal;
      }
      onMaybeComplete();
    });
  });
}
