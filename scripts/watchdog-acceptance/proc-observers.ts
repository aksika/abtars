/**
 * Process-table observation adapters (#1712 design: Observers and waits).
 *
 * Linux/WSL reads /proc for identity and state; macOS uses ps fields that are
 * compatible with the production identity parser (src/supervisor/identity.ts).
 * If a required observation is unavailable, callers must treat the scenario as
 * inconclusive — never as a passing skip.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export function processStartIdentityOf(pid: number): string {
  if (process.platform === "darwin") {
    const out = psField(pid, "lstart");
    const ts = out === null ? NaN : Date.parse(out);
    return `${pid}:${Number.isFinite(ts) ? ts : 0}`;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const rp = stat.lastIndexOf(")");
    if (rp < 0) return `${pid}:0`;
    const fields = stat.slice(rp + 2).split(" ");
    // starttime is field 22 → index 19 after the comm close-paren.
    return `${pid}:${fields[19] ?? "0"}`;
  } catch {
    return `${pid}:0`;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True when the process is fully gone — dead AND reaped. A zombie still holds
 * its PID and must count as present for leak accounting, but a registered
 * process that exited on its own should not block cleanup forever just
 * because nobody reaped it yet.
 */
export function procGone(pid: number): boolean {
  if (!pidAlive(pid)) return true;
  const snap = procSnapshot(pid);
  return snap === null || snap.state === "Z";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until all PIDs are dead or the deadline passes. Returns survivors. */
export async function waitUntilDead(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(pids);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const pid of [...pending]) {
      if (!pidAlive(pid)) pending.delete(pid);
    }
    if (pending.size > 0) await sleep(40);
  }
  return [...pending];
}

export interface ProcSnapshot {
  pid: number;
  state: string;
  ppid: number;
  pgrp: number;
  comm: string;
  cmdline: string | null;
}

function psField(pid: number, field: string): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Full observation of one PID; null when the process cannot be observed. */
export function procSnapshot(pid: number): ProcSnapshot | null {
  if (!pidAlive(pid)) return null;
  if (process.platform === "darwin") {
    const state = psField(pid, "state");
    const ppid = psField(pid, "ppid");
    const pgrp = psField(pid, "pgid");
    const comm = psField(pid, "comm");
    const command = psField(pid, "command");
    if (state === null) return null;
    return {
      pid,
      state: state[0] ?? "?",
      ppid: Number(ppid ?? -1),
      pgrp: Number(pgrp ?? -1),
      comm: comm ?? "",
      cmdline: command,
    };
  }
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return null;
  }
  const rp = stat.lastIndexOf(")");
  if (rp < 0) return null;
  const head = stat.slice(0, rp + 1); // includes the closing paren
  const after = stat.slice(rp + 2).split(" ");
  const commMatch = head.match(/\((.*)\)$/);
  let cmdline: string | null;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ").trim() || null;
  } catch {
    cmdline = null;
  }
  return {
    pid,
    state: after[0] ?? "?",
    ppid: Number(after[1] ?? -1),
    pgrp: Number(after[2] ?? -1),
    comm: commMatch?.[1] ?? "",
    cmdline,
  };
}

/** Working directory of a PID via /proc (null on darwin or dead processes). */
export function processCwd(pid: number): string | null {
  if (process.platform === "darwin") return null;
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}
