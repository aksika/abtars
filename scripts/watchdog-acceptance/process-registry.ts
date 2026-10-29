/**
 * Process registry — the only component allowed to spawn or signal harness
 * processes (#1712 R3).
 *
 * Safety model:
 * - every process is spawned detached, so it leads its own process group;
 * - each registration records PID + start identity + PGID so a recycled PID is
 *   detected before any signal is delivered;
 * - signalling an unregistered or identity-mismatched PID throws — broad
 *   `pkill`/`killall`/command-search sweeps are deliberately unimplementable
 *   through this API;
 * - cleanup escalates from bounded group SIGTERM to validated SIGKILL and then
 *   asserts nothing registered survived.
 */
import { spawn } from "node:child_process";
import { openSync, closeSync, existsSync } from "node:fs";
import type { OwnedProcess, RegistryApi, SpawnOptions } from "./contracts.ts";
import { processStartIdentityOf, pidAlive, procGone, procSnapshot } from "./proc-observers.ts";

const GRACEFUL_TERM_MS = 3000;
const KILL_SETTLE_MS = 1500;

export class PidReuseError extends Error {
  constructor(pid: number) {
    super(`refusing to signal PID ${pid}: start identity changed since registration (PID reuse suspected)`);
    this.name = "PidReuseError";
  }
}

export class UnknownProcessError extends Error {
  constructor(pid: number) {
    super(`refusing to signal PID ${pid}: not owned by this harness run`);
    this.name = "UnknownProcessError";
  }
}

export class LeakError extends Error {
  constructor(survivors: readonly OwnedProcess[]) {
    super(`cleanup left ${survivors.length} registered process(es) alive: ${survivors.map((p) => `${p.pid}(${p.role})`).join(", ")}`);
    this.name = "LeakError";
  }
}

export class ProcessRegistry implements RegistryApi {
  private readonly procs = new Map<number, OwnedProcess>();
  private cleanedUp = false;

  all(): readonly OwnedProcess[] {
    return [...this.procs.values()];
  }

  get(pid: number): OwnedProcess | undefined {
    return this.procs.get(pid);
  }

  size(): number {
    return this.procs.size;
  }

  async spawn(opts: SpawnOptions): Promise<number> {
    let fd: number | undefined;
    if (opts.stdoutFile) {
      fd = openSync(opts.stdoutFile, "a");
    }
    try {
      const child = spawn(opts.cmd, [...opts.args], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: fd !== undefined ? ["ignore", fd, fd] : "ignore",
        detached: true,
      });
      const pid = child.pid;
      if (pid === undefined) {
        throw new Error(`spawn failed for ${opts.cmd} (role=${opts.role})`);
      }
      // The ChildProcess handle must be released: we manage lifecycle via
      // signals and /proc, and 'error' events have nowhere to go.
      child.unref();
      child.on("error", () => {});
      const entry: OwnedProcess = {
        pid,
        startIdentity: processStartIdentityOf(pid),
        processGroupId: pid,
        role: opts.role,
        home: opts.home,
      };
      this.procs.set(pid, entry);
      return pid;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Validate ownership AND start identity immediately before signalling. */
  private validated(pid: number): OwnedProcess {
    const entry = this.procs.get(pid);
    if (!entry) throw new UnknownProcessError(pid);
    if (!existsSync(`/proc/${pid}`) && process.platform !== "darwin") {
      // Already dead: still refuse unless it matches — a dead PID cannot be
      // usefully signalled, and treating it as reusable here would mask bugs.
      throw new Error(`refusing to signal PID ${pid}: no such process`);
    }
    const current = processStartIdentityOf(pid);
    if (current !== entry.startIdentity) throw new PidReuseError(pid);
    return entry;
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    const entry = this.validated(pid);
    try {
      process.kill(-entry.processGroupId, signal);
    } catch {
      // Group signal can fail if the leader already died between validation
      // and kill. Fall back to the validated individual PID only.
      process.kill(entry.pid, signal);
    }
  }

  /** Signal a single validated PID without touching its group. */
  signalPidOnly(pid: number, signal: NodeJS.Signals): void {
    const entry = this.validated(pid);
    process.kill(entry.pid, signal);
  }

  isAlive(pid: number): boolean {
    return pidAlive(pid);
  }

  /**
   * Bounded cleanup of every registered process: graceful group TERM, wait,
   * sweep per-home stragglers via the provided hook (bridges disowned by a
   * killed watchdog are not in any registry group), validated SIGKILL, verify.
   */
  async cleanupAll(reason: string): Promise<void> {
    this.cleanedUp = true;
    const entries = this.all();
    for (const e of entries) {
      try {
        this.signal(e.pid, "SIGTERM");
      } catch { /* may already be gone */ }
    }
    await waitUntilProcGone(entries.map((e) => e.pid), GRACEFUL_TERM_MS);

    for (const e of entries) {
      if (!procGone(e.pid)) {
        try {
          this.validated(e.pid);
          try { process.kill(-e.processGroupId, "SIGKILL"); } catch { process.kill(e.pid, "SIGKILL"); }
        } catch { /* identity changed — never signal */ }
      }
    }
    await waitUntilProcGone(entries.map((e) => e.pid), KILL_SETTLE_MS);

    const survivors = entries.filter((e) => !procGone(e.pid));
    if (survivors.length > 0) {
      const detail = survivors.map((e) => {
        const snap = procSnapshot(e.pid);
        return `${e.pid} state=${snap?.state ?? "?"} cmdline=${snap?.cmdline?.slice(0, 120) ?? "?"}`;
      }).join("; ");
      throw new Error(`cleanup left ${survivors.length} registered process(es) alive [${detail}]`);
    }
    // Fully exited registrations are forgotten so assertEmpty() reflects only
    // genuine leaks.
    this.procs.clear();
    void reason;
  }

  /**
   * Zombie-state processes are fully exited but unreaped; forget them so a
   * scenario whose watchdog children were reparented does not report a leak.
   */
  reapExited(): number[] {
    const reaped: number[] = [];
    for (const [pid] of this.procs) {
      if (procGone(pid)) {
        this.procs.delete(pid);
        reaped.push(pid);
      }
    }
    return reaped;
  }

  assertEmpty(): void {
    if (this.procs.size !== 0) {
      throw new LeakError(this.all());
    }
  }


  get isCleanedUp(): boolean {
    return this.cleanedUp;
  }
}

async function waitUntilProcGone(pids: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(pids);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const pid of [...pending]) {
      if (procGone(pid)) pending.delete(pid);
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, 40));
  }
}
