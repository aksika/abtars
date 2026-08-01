/**
 * child-process.ts — #1528 exact-PID child wrapper with bounded streams,
 * readiness probes, deadlines, graceful escalation, and exit metadata.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { TIMEOUTS } from "./contracts.js";

const STREAM_BOUND = 512 * 1024;

export interface SpawnedChildOptions {
  execPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Bounded stdout/stderr destination files (created alongside ring buffers). */
  logDir: string;
  name: string;
  /** Pipe stdin to the child (NDJSON control surfaces); default false. */
  input?: boolean;
}

export interface ChildExitMetadata {
  exitCode: number | null;
  signal: string | null;
  degradedCleanup: boolean;
  stdoutTail: string;
  stderrTail: string;
}

export class SpawnedChild {
  readonly pid: number;
  private child: ChildProcess;
  private stdoutBuf = "";
  private stderrBuf = "";
  private stdoutLen = 0;
  private stderrLen = 0;
  private exitCode: number | null = null;
  private signal: string | null = null;
  private usedSigkill = false;
  private exitPromise: Promise<void>;
  private stdoutPath: string;
  private stderrPath: string;
  readonly name: string;

  constructor(opts: SpawnedChildOptions) {
    this.name = opts.name;
    this.stdoutPath = join(opts.logDir, `${opts.name}.stdout.log`);
    this.stderrPath = join(opts.logDir, `${opts.name}.stderr.log`);
    this.child = spawn(opts.execPath, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.input === true ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    this.pid = this.child.pid!;

    this.child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      appendFileSync(this.stdoutPath, text);
      this.stdoutLen += text.length;
      this.stdoutBuf = this.stdoutLen > STREAM_BOUND ? this.stdoutBuf.slice(-STREAM_BOUND / 2) + text : this.stdoutBuf + text;
    });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      appendFileSync(this.stderrPath, text);
      this.stderrLen += text.length;
      this.stderrBuf = this.stderrLen > STREAM_BOUND ? this.stderrBuf.slice(-STREAM_BOUND / 2) + text : this.stderrBuf + text;
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code, sig) => {
        this.exitCode = code;
        this.signal = sig;
        resolve();
      });
    });
  }

  get stdout(): NodeJS.ReadableStream {
    return this.child.stdout!;
  }

  get stdin(): NodeJS.WritableStream {
    return this.child.stdin!;
  }

  get exited(): boolean {
    return this.exitCode !== null || this.signal !== null;
  }

  get exitCodeValue(): number | null {
    return this.exitCode;
  }

  get signalValue(): string | null {
    return this.signal;
  }

  get stdoutTail(): string {
    return this.stdoutBuf.slice(-2000);
  }

  get stderrTail(): string {
    return this.stderrBuf.slice(-2000);
  }

  get degradedCleanup(): boolean {
    return this.usedSigkill;
  }

  async waitForExit(timeoutMs: number): Promise<ChildExitMetadata> {
    await Promise.race([
      this.exitPromise,
      new Promise<void>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`${this.name} (pid ${this.pid}) did not exit within ${timeoutMs}ms`)), timeoutMs);
        this.exitPromise.then(() => clearTimeout(t));
      }),
    ]);
    return this.metadata();
  }

  /** SIGTERM, bounded grace, then SIGKILL. Resolves when the child is gone. */
  async terminate(graceMs: number = TIMEOUTS.childGraceMs): Promise<void> {
    if (this.exited) return;
    this.child.kill("SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && !this.exited) {
      await delay(100);
    }
    if (!this.exited) {
      this.usedSigkill = true;
      this.child.kill("SIGKILL");
    }
    await Promise.race([this.exitPromise, delay(2_000)]);
  }

  metadata(): ChildExitMetadata {
    return {
      exitCode: this.exitCode,
      signal: this.signal,
      degradedCleanup: this.usedSigkill,
      stdoutTail: this.stdoutTail,
      stderrTail: this.stderrTail,
    };
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until `probe()` resolves truthy, with a named deadline. Throws with a
 * bounded tail dump on timeout.
 */
export async function waitFor<T>(
  probe: () => Promise<T | null | false | undefined>,
  timeoutMs: number,
  what: string,
  tail: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | false | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) {
      if (process.env["PI_E2E_DEBUG_FRAMES"] === "1") console.error(`[waitFor] returning for ${what}`);
      return last as T;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${what} after ${timeoutMs}ms\n${tail()}`);
}
