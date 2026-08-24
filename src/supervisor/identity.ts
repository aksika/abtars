import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

export type ValidationResult =
  | { readonly status: "valid"; readonly safeToSignal: true; readonly safeToAdopt: true }
  | { readonly status: "dead"; readonly safeToSignal: false; readonly safeToAdopt: false }
  | { readonly status: "reused"; readonly safeToSignal: false; readonly safeToAdopt: false }
  | { readonly status: "wrong-command"; readonly safeToSignal: false; readonly safeToAdopt: false }
  | { readonly status: "mismatch"; readonly safeToSignal: false; readonly safeToAdopt: false }
  | { readonly status: "corrupt"; readonly safeToSignal: false; readonly safeToAdopt: false };

// ── Canonical literal identity (#1711 R2) ─────────────────────────────────

/**
 * The canonical spawn target for a home. Identity is a LITERAL string
 * comparison against the process's exact argv element, so every speller
 * (watchdog shell, launcher, reconciliation, doctor) must produce byte-identical
 * output for the same home.
 *
 * Normalization happens exactly once, here: a non-absolute home is rejected,
 * and trailing separators are stripped. Without this, `/home/u/.abtars/` and
 * `/home/u/.abtars` would be two identity classes — a bridge spawned under one
 * spelling would be permanently identity-inconclusive to the other: never
 * contained, never spawned beside.
 *
 * Symlinks are deliberately NOT resolved: `app -> releases/current` means only
 * `current` moves during deployment, so an old-release survivor keeps the same
 * literal argv after activation and stays visible to reconciliation (B12).
 */
export function spawnTarget(home: string): string {
  if (!isAbsolute(home)) throw new Error(`ABTARS_HOME must be absolute: ${home}`);
  const base = home.replace(/\/+$/, "");
  return `${base}/app/bundle/abtars.js`;
}

/** One inspected process. PPID/cwd are evidence-only and never authorize action. */
export interface BridgeProcess {
  readonly pid: number;
  /** Process-start identity sufficient to reject PID reuse. */
  readonly startIdentity: string;
  /** Complete argv evidence needed to prove the exact target argument. */
  readonly argv: readonly string[];
  readonly exactTarget: boolean;
}

/**
 * Complete immutable snapshot, or a fail-closed marker. An empty result is
 * meaningful only when `complete` is true.
 */
export type ProcessEnumeration =
  | { readonly complete: true; readonly processes: readonly BridgeProcess[] }
  | { readonly complete: false; readonly reason: string };

function enumerateLinux(target: string): ProcessEnumeration {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch (err) {
    return { complete: false, reason: `proc-list:${(err as NodeJS.ErrnoException).code ?? "error"}` };
  }
  const processes: BridgeProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let argv: string[];
    try {
      const raw = readFileSync(`/proc/${entry}/cmdline`, "utf-8");
      argv = raw.split("\0").filter((arg) => arg.length > 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // exited mid-scan
      return { complete: false, reason: "cmdline-read" };
    }
    if (argv.length === 0) continue; // kernel thread or zombie — cannot be a bridge
    let startIdentity: string;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf-8");
      // comm (field 2) may contain spaces — parse from the LAST ')'. Fields
      // after it start at state (field 3); starttime is field 22 → index 19.
      const rp = stat.lastIndexOf(")");
      if (rp < 0) return { complete: false, reason: "stat-parse" };
      const fields = stat.slice(rp + 2).split(" ");
      const startTime = fields[19];
      if (startTime === undefined || startTime === "") return { complete: false, reason: "stat-parse" };
      startIdentity = `${entry}:${startTime}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // exited mid-scan
      return { complete: false, reason: "stat-read" };
    }
    processes.push({ pid: Number(entry), startIdentity, argv, exactTarget: argv.some((a) => a === target) });
  }
  return { complete: true, processes };
}

function enumerateDarwin(target: string): ProcessEnumeration {
  let out: string;
  try {
    out = execFileSync("ps", ["-axo", "pid=,lstart=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 1500,
    });
  } catch {
    return { complete: false, reason: "ps-failed" };
  }
  const processes: BridgeProcess[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const tokens = line.trim().split(/\s+/);
    const pid = Number(tokens[0]);
    // lstart renders as e.g. "Mon Aug 24 01:02:03 2026" — five tokens after pid.
    const lstart = tokens.slice(1, 6).join(" ");
    const timestamp = Date.parse(lstart);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(timestamp)) {
      return { complete: false, reason: "ps-parse" };
    }
    const command = tokens.slice(6).join(" ");
    // ps joins argv with single spaces, so re-splitting reconstructs exact
    // argv elements whenever no argument embeds a space. A spaced home would
    // split the target itself and simply never match — fail-closed direction.
    const argv = command.split(/\s+/).filter((a) => a.length > 0);
    processes.push({ pid, startIdentity: `${pid}:${timestamp}`, argv, exactTarget: argv.some((a) => a === target) });
  }
  return { complete: true, processes };
}

/**
 * Enumerate every process whose EXACT literal argv names this home's canonical
 * spawn target, together with all other processes (evidence). Returns either a
 * complete snapshot or a fail-closed marker; permission errors, truncated
 * records, and parse failures make the WHOLE snapshot inconclusive.
 */
export function enumerateBridgeProcesses(home: string): ProcessEnumeration {
  let target: string;
  try {
    target = spawnTarget(home);
  } catch {
    return { complete: false, reason: "invalid-home" };
  }
  return process.platform === "darwin" ? enumerateDarwin(target) : enumerateLinux(target);
}

/** Exact same-home bridge processes, or null when the snapshot is incomplete. */
export function exactBridgeProcesses(home: string): readonly BridgeProcess[] | null {
  const result = enumerateBridgeProcesses(home);
  return result.complete ? result.processes.filter((p) => p.exactTarget) : null;
}

/**
 * Spawn-proof predicate inputs (#1711 R2/R3). Broader than the containment
 * predicate BY DESIGN: a process whose argv COULD be this home's bridge blocks
 * spawning but is never contained, adopted, or signalled. Killing stays narrow
 * (exactTarget); refusing to create a duplicate is the cheap, fail-closed
 * direction.
 *
 * Attribution rules (#1711 R2.1, v5 — folded from the deleted #1718):
 * - exact canonical literal          -> always blocks;
 * - absolute spelling inside home    -> always blocks;
 * - relative `app/bundle/abtars.js`  -> attributed in this order, stopping at
 *   the first that answers:
 *     1. the lock: this home's bridge.lock names that PID with a matching
 *        start identity — authoritative and free (no cwd needed);
 *     2. cwd, where readable: Linux `/proc/<pid>/cwd`; macOS best-effort
 *        `lsof -a -p <pid> -d cwd -Fn` via execFile, never through a shell,
 *        with a short timeout, relative candidates only;
 *     3. otherwise `unattributable`.
 *   `this-home` and `unattributable` block the spawn; `other-home` does not.
 *   An unattributable process is NEVER a silent freeze: its PID, argv, and
 *   reason travel in the enumeration result, doctor//status surface it with
 *   operator recovery text, the watchdog logs one event line when the blocking
 *   set changes, and main.ts prints the PID list before its gate exits.
 *
 * cwd is evidence-only and mutable via chdir: it may pull a process INTO scope
 * for the spawn proof, but it never authorizes a signal.
 */
export interface UnattributableProcess {
  readonly pid: number;
  readonly startIdentity: string;
  readonly argv: readonly string[];
  readonly reason: string;
}

export type SpawnScope =
  | { readonly complete: false; readonly reason: string }
  | {
      readonly complete: true;
      /** Every process whose argv COULD be this home's bridge — blocks the spawn. */
      readonly blockers: readonly BridgeProcess[];
      /** Relative-spelled processes whose home could not be attributed — blocks, loudly. */
      readonly unattributable: readonly UnattributableProcess[];
    };

type RelativeAttribution =
  | { readonly kind: "this-home"; readonly via: "lock" | "cwd" }
  | { readonly kind: "other-home"; readonly via: "cwd" }
  | { readonly kind: "unattributable"; readonly reason: string };

/**
 * Three-step attribution for a relative-spelled candidate (#1711 R2.1).
 * Lock first (authoritative and free), then cwd (Linux /proc, macOS best-effort
 * lsof), then unattributable. A relative process attributed to THIS home is a
 * spawn blocker; one attributed elsewhere is not; one that cannot be attributed
 * is a LOUD blocker.
 */
function attributeRelativeProcess(home: string, base: string, p: BridgeProcess): RelativeAttribution {
  const lockPath = join(home, "bridge.lock");
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
    if (lock.pid === p.pid && lock.startIdentity === p.startIdentity) {
      return { kind: "this-home", via: "lock" };
    }
  } catch { /* missing/corrupt lock — fall through to cwd */ }

  const cwd = processCwd(p.pid);
  if (cwd !== null) {
    const normalized = cwd.replace(/\/+$/, "");
    if (normalized === base || normalized.startsWith(`${base}/`)) {
      return { kind: "this-home", via: "cwd" };
    }
    return { kind: "other-home", via: "cwd" };
  }
  return { kind: "unattributable", reason: `cwd-unreadable (${process.platform})` };
}

/**
 * Read a process cwd as ATTRIBUTION EVIDENCE ONLY (#1711 R2/R2.1). Linux reads
 * /proc; macOS uses `lsof -a -p <pid> -d cwd -Fn` via execFile — no shell, short
 * timeout, relative candidates only so the cost stays off the common path. A
 * null result means the cwd is unreadable on this platform: the caller treats
 * that as `unattributable`, never as a silent pass.
 */
function processCwd(pid: number): string | null {
  if (process.platform === "darwin") {
    try {
      const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 1500,
      });
      // lsof -Fn emits one `n<path>` record per fd; the cwd is the single
      // `ncwd`-style record. Take the first `n` line as the path.
      const match = output.match(/\nn([^\n]*)/);
      if (match === null || match[1] === undefined || match[1] === "") return null;
      return match[1];
    } catch {
      return null; // lsof absent or timed out -> unattributable, never a crash
    }
  }
  try {
    const dest = readlinkSync(`/proc/${pid}/cwd`);
    return dest;
  } catch {
    return null;
  }
}

export function potentialHomeBridgeProcesses(home: string): SpawnScope {
  const result = enumerateBridgeProcesses(home);
  if (!result.complete) return { complete: false, reason: result.reason };
  const base = home.replace(/\/+$/, "");
  const target = `${base}/app/bundle/abtars.js`;
  const blockers: BridgeProcess[] = [];
  const unattributable: UnattributableProcess[] = [];
  for (const p of result.processes) {
    let blocked = false;
    for (const arg of p.argv) {
      if (arg === target) { blocked = true; break; }
      if (arg.startsWith(`${base}/`) && arg.endsWith("/app/bundle/abtars.js")) { blocked = true; break; }
      if (arg === "app/bundle/abtars.js") {
        const attribution = attributeRelativeProcess(home, base, p);
        if (attribution.kind === "this-home") { blocked = true; break; }
        if (attribution.kind === "unattributable") {
          blocked = true;
          unattributable.push({ pid: p.pid, startIdentity: p.startIdentity, argv: p.argv, reason: attribution.reason });
          break;
        }
        // other-home: not this home's bridge — no block.
      }
    }
    if (blocked) blockers.push(p);
  }
  return { complete: true, blockers, unattributable };
}

function macProcessField(pid: number, field: "lstart" | "command"): string | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1500,
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

export function processStartIdentity(pid: number): string {
  if (process.platform === "darwin") {
    const startedAt = macProcessField(pid, "lstart");
    const timestamp = startedAt === null ? NaN : Date.parse(startedAt);
    return `${pid}:${Number.isFinite(timestamp) ? timestamp : 0}`;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // comm (field 2) is wrapped in parens and may contain spaces, so parse from
    // the LAST ')'. Fields after it are space-separated starting at field 3
    // (state); starttime is field 22 → index 22-3 = 19.
    const rp = stat.lastIndexOf(")");
    if (rp < 0) return `${pid}:0`;
    const fields = stat.slice(rp + 2).split(" ");
    const startTime = fields[19];
    return `${pid}:${startTime ?? "0"}`;
  } catch {
    return `${pid}:0`;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "darwin") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const rp = stat.lastIndexOf(")");
        // A zombie still accepts signal 0 until its parent reaps it, but it is
        // no longer a live target for supervision or containment.
        if (rp >= 0 && stat.slice(rp + 2, rp + 3) === "Z") return false;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      }
    }
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function validateBridgePid(
  pid: number,
  expectedIdentity: string | null,
  needles: readonly string[],
): ValidationResult {
  const alive = isPidAlive(pid);
  if (!alive) {
    return { status: "dead", safeToSignal: false, safeToAdopt: false };
  }
  if (expectedIdentity !== null) {
    const actual = processStartIdentity(pid);
    if (actual !== expectedIdentity) {
      return { status: "reused", safeToSignal: false, safeToAdopt: false };
    }
  }
  try {
    const cmdline = process.platform === "darwin"
      ? macProcessField(pid, "command")
      : readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    if (cmdline === null) {
      // macOS has no /proc fallback. If ps cannot identify the process, reject
      // the lock rather than trusting a PID that may have been reused.
      if (process.platform === "darwin") {
        return { status: "wrong-command", safeToSignal: false, safeToAdopt: false };
      }
      return { status: "valid", safeToSignal: true, safeToAdopt: true };
    }
    const match = needles.some((n) => cmdline.includes(n));
    if (!match) {
      return { status: "wrong-command", safeToSignal: false, safeToAdopt: false };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { status: "dead", safeToSignal: false, safeToAdopt: false }
      : { status: "mismatch", safeToSignal: false, safeToAdopt: false };
  }
  return { status: "valid", safeToSignal: true, safeToAdopt: true };
}

export function validateBridgeLock(
  lock: Record<string, unknown> | null,
  needles: readonly string[],
): ValidationResult {
  if (lock === null || typeof lock !== "object") {
    return { status: "corrupt", safeToSignal: false, safeToAdopt: false };
  }
  const pid = typeof lock.pid === "number" ? lock.pid : null;
  if (pid === null || pid <= 0) {
    return { status: "dead", safeToSignal: false, safeToAdopt: false };
  }
  // R6.2.4: the bridge instance identifier must be present — confirms the
  // bridge completed identity initialization. A lock missing it did not come
  // from a fully-initialized #1262 bridge and is not safe to adopt/signal.
  const instanceId = typeof lock.instanceId === "string" ? lock.instanceId : "";
  if (!instanceId) {
    return { status: "corrupt", safeToSignal: false, safeToAdopt: false };
  }
  const startIdentity = typeof lock.startIdentity === "string" ? lock.startIdentity : null;
  if (startIdentity === null || (process.platform !== "darwin" && startIdentity.endsWith(":0"))) {
    return { status: "corrupt", safeToSignal: false, safeToAdopt: false };
  }
  return validateBridgePid(pid, startIdentity, needles);
}

export function readBridgeLock(lockPath: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, unknown>; }
  catch { return null; }
}

/** Validate immediately before signalling; callers must not signal cached PIDs. */
export function signalValidatedBridge(
  lockPath: string,
  signal: NodeJS.Signals,
  needles: readonly string[] = ["abtars.js", "bundle"],
): ValidationResult {
  const lock = readBridgeLock(lockPath);
  const result = validateBridgeLock(lock, needles);
  if (!result.safeToSignal || !lock || typeof lock.pid !== "number") return result;
  process.kill(lock.pid, signal);
  return result;
}
