/**
 * Controllable world (#1712 Phase 0): fresh temporary application homes,
 * artifact seeding, watchdog/fixture controls, typed readers, bounded
 * predicate waits, and evidence timelines.
 *
 * Worlds are serial: one scenario = one world (a second home belongs to the
 * same world and process registry, e.g. B5).
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FixtureControlFile,
  FixtureMode,
  TimelineEntry,
  WorldApi,
} from "./contracts.ts";
import type { ProcessRegistry } from "./process-registry.ts";
import type { SuiteBuilder } from "./build.ts";
import { procSnapshot, processCwd } from "./proc-observers.ts";

export const TIMELINE_CAP = 200;
export const LOG_TAIL_LINES = 50;

export class ScenarioFailure extends Error {
  constructor(
    message: string,
    readonly kind: "assertion" | "timeout" | "setup" | "cleanup",
  ) {
    super(message);
    this.name = "ScenarioFailure";
  }
}

const POLL_YIELD_MS = 50;

interface WatchdogHandle {
  readonly pid: number;
  readonly exitCodeFile: string;
  readonly dogPidFile: string;
}

export class World implements WorldApi {
  readonly root: string;
  readonly registry: ProcessRegistry;
  private readonly builder: SuiteBuilder;
  private readonly profileName: string;
  private readonly homes = new Map<string, string>();
  private readonly watchdogs = new Map<string, WatchdogHandle[]>();
  private readonly timelineEntries: TimelineEntry[] = [];
  private readonly runStart = Date.now();

  constructor(parentDir: string, label: string, registry: ProcessRegistry, builder: SuiteBuilder, profileName: string) {
    this.root = mkdtempSync(join(tmpdir(), `${parentDir}-${label}-`));
    this.registry = registry;
    this.builder = builder;
    this.profileName = profileName;
    this.timeline("world-created", this.root);
  }

  // ── Homes ────────────────────────────────────────────────────────────────

  homeA(): string {
    return this.home("home-a");
  }

  homeB(): string {
    return this.home("home-b");
  }

  artifactsDir(): string {
    const d = join(this.root, "artifacts");
    mkdirSync(d, { recursive: true });
    return d;
  }

  private home(name: string): string {
    let h = this.homes.get(name);
    if (!h) {
      h = join(this.root, name);
      this.seedHome(h);
      this.homes.set(name, h);
    }
    return h;
  }

  /** Create the temporary application home and copy freshly built artifacts in. */
  seedHome(home: string): void {
    try {
      const bundleDir = join(home, "app", "bundle");
      mkdirSync(join(home, "logs"), { recursive: true });
      mkdirSync(bundleDir, { recursive: true });
      // The supervisor-state CLI must exist at the production-resolved path.
      // Bundles are ESM, so mark the directory accordingly.
      writeFileSync(join(bundleDir, "package.json"), '{"type":"module"}\n');
      const supervisorCli = this.builder.bundleSupervisorState(this.profileName);
      const fixtureBridge = this.builder.bundleFixtureBridge();
      cpSync(supervisorCli, join(bundleDir, "abtars-supervisor-state.js"));
      cpSync(fixtureBridge, join(bundleDir, "abtars.js"));
      this.timeline("home-seeded", home);
    } catch (err) {
      throw new ScenarioFailure(`seedHome failed: ${err instanceof Error ? err.message : String(err)}`, "setup");
    }
  }

  // ── Fixture control ─────────────────────────────────────────────────────

  setControl(home: string, patch: Partial<FixtureControlFile>): void {
    const p = join(home, "fixture-control.json");
    let current: FixtureControlFile = {
      defaultMode: { mode: "healthy" },
      nextSpawns: [],
      heartbeatMs: 200,
      live: { heartbeatEnabled: true, ignoreTerm: false },
    };
    if (existsSync(p)) current = JSON.parse(readFileSync(p, "utf-8")) as FixtureControlFile;
    const next: FixtureControlFile = {
      defaultMode: patch.defaultMode ?? current.defaultMode,
      nextSpawns: patch.nextSpawns ?? current.nextSpawns,
      heartbeatMs: patch.heartbeatMs ?? current.heartbeatMs,
      live: patch.live ? { ...current.live, ...patch.live } : current.live,
    };
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(next));
    // Atomic replace so a spawning fixture never observes a torn file.
    renameSafe(tmp, p);
  }

  /** Next generation number a future spawn will claim (for scheduling modes). */
  claimNextGeneration(home: string): number {
    const dir = join(home, "fixture-generation");
    if (!existsSync(dir)) return 1;
    let max = 0;
    for (const f of readdirSync(dir)) {
      const n = Number(f.split(".")[0]);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  }

  // ── Process controls ────────────────────────────────────────────────────

  async startWatchdog(home: string, extraEnv: Record<string, string> = {}): Promise<number> {
    const script = this.builder.produceWatchdogCopy(this.profileName);
    const n = this.watchdogCount(home);
    const stdioLog = join(this.artifactsDir(), `watchdog-${basename(home)}-${n}.log`);
    const exitCodeFile = stdioLog.replace(/\.log$/, ".exitcode");
    const dogPidFile = stdioLog.replace(/\.log$/, ".dogpid");
    // Wrapper: exists to hold a registered PID for the watchdog's lifetime and
    // record its real exit status. It IGNORES TERM/INT — deliberate, because a
    // trapped `wait` returns early under signal delivery and would both
    // abandon the watchdog and record a bogus 143. Intentional graceful stops
    // signal the WATCHDOG process directly (see signalWatchdogProcess); the
    // group-level cleanup TERM reaches the watchdog anyway, and the wrapper's
    // eventual SIGKILL escalation is harmless once the exit code no longer
    // matters.
    const wrapper = `"${script}" & D=$!
printf '%s' "$D" > "${dogPidFile}"
trap '' TERM INT
wait "$D"; rc=$?
printf '%s' "$rc" > "${exitCodeFile}"
exit "$rc"`;
    const pid = await this.registry.spawn({
      cmd: "bash",
      args: ["-c", wrapper, "wd-wrapper", script, exitCodeFile],
      role: "watchdog",
      home,
      env: { ABTARS_HOME: home, ...extraEnv },
      stdoutFile: stdioLog,
    });
    this.pushWatchdog(home, { pid, exitCodeFile, dogPidFile });
    this.timeline("watchdog-started", `home=${basename(home)} wrapper=${pid}`);
    return pid;
  }

  /**
   * The real watchdog script process (child of the wrapper). Signalling it is
   * only allowed after validating its parentage and cmdline — this is the one
   * harness path that signals a process which is not itself registered.
   */
  watchdogPidOf(home: string): number | null {
    const handles = this.watchdogsFor(home);
    const last = handles[handles.length - 1];
    if (!last) return null;
    if (!existsSync(last.dogPidFile)) return null;
    const raw = readFileSync(last.dogPidFile, "utf-8").trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const snap = procSnapshot(pid);
    if (!snap) return null;
    if (!snap.cmdline || !snap.cmdline.includes("abtars-watchdog.sh")) return null;
    if (snap.ppid !== last.pid) return null; // must still be our wrapper's child
    return pid;
  }

  /** Validated direct signal to the real watchdog script process. */
  signalWatchdogProcess(home: string, signal: NodeJS.Signals): void {
    const pid = this.watchdogPidOf(home);
    if (pid === null) throw new ScenarioFailure(`no live watchdog process to signal for ${basename(home)}`, "setup");
    process.kill(pid, signal);
    this.timeline(`watchdog-signalled`, `${signal} pid=${pid}`);
  }

  private watchdogCount(home: string): number {
    return (this.watchdogs.get(home)?.length ?? 0) + 1;
  }

  private pushWatchdog(home: string, handle: WatchdogHandle): void {
    const list = this.watchdogs.get(home) ?? [];
    list.push(handle);
    this.watchdogs.set(home, list);
  }

  watchdogsFor(home: string): readonly WatchdogHandle[] {
    return this.watchdogs.get(home) ?? [];
  }

  async plantBridge(home: string, mode: FixtureMode): Promise<number> {
    const pid = await this.registry.spawn({
      cmd: process.execPath,
      args: [join(home, "app", "bundle", "abtars.js")],
      role: "fixture",
      home,
      cwd: home,
      env: { ABTARS_HOME: home, ABTARS_FIXTURE_DIRECT: JSON.stringify(mode) },
    });
    this.timeline("bridge-planted", `home=${basename(home)} pid=${pid} mode=${mode.mode}`);
    return pid;
  }

  /** Graceful individual SIGTERM to the real watchdog process; returns its recorded exit code. */
  async stopWatchdogGracefully(home: string, timeoutMs = 8000): Promise<number> {
    const handles = [...this.watchdogsFor(home)];
    if (handles.length === 0) throw new ScenarioFailure(`no watchdog registered for ${home}`, "setup");
    this.signalWatchdogProcess(home, "SIGTERM");
    const last = handles[handles.length - 1];
    if (!last) throw new ScenarioFailure("missing watchdog handle", "setup");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(last.exitCodeFile)) break;
      await this.sleep(POLL_YIELD_MS);
    }
    const raw = existsSync(last.exitCodeFile) ? readFileSync(last.exitCodeFile, "utf-8").trim() : "";
    const code = Number(raw);
    this.registry.reapExited();
    this.timeline("watchdog-stopped", `home=${basename(home)} code=${raw || "unknown"}`);
    if (!Number.isFinite(code)) throw new ScenarioFailure(`watchdog did not record an exit code within ${timeoutMs}ms`, "timeout");
    return code;
  }

  watchdogExitCodeWhenAvailable(home: string): Promise<string | null> {
    const handles = this.watchdogsFor(home);
    const last = handles[handles.length - 1];
    if (!last) return Promise.resolve(null);
    return (async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (existsSync(last.exitCodeFile)) return readFileSync(last.exitCodeFile, "utf-8").trim();
        await this.sleep(POLL_YIELD_MS);
      }
      return null;
    })();
  }

  pauseWatchdog(home: string): void {
    // SIGSTOP the real watchdog script process — stopping the wrapper would
    // leave the watchdog running.
    this.signalWatchdogProcess(home, "SIGSTOP");
  }

  resumeWatchdog(home: string): void {
    this.signalWatchdogProcess(home, "SIGCONT");
  }

  // ── Invocations ─────────────────────────────────────────────────────────

  supervisorCli(home: string, args: string[]): { code: number; stdout: string; stderr: string } {
    const cli = this.builder.bundleSupervisorState(this.profileName);
    try {
      const stdout = execFileSync(process.execPath, [cli, ...args], {
        env: { ...process.env, ABTARS_HOME: home },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  /** Invoke the REAL bundled doctor CLI against `env` (B5's boundary). */
  runDoctor(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
    const cli = getDoctorBundle();
    try {
      const stdout = execFileSync(process.execPath, [cli, ...args], {
        env: { ...process.env, ...env },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  // ── Readers ─────────────────────────────────────────────────────────────

  lock(home: string): Record<string, unknown> | null {
    try {
      return JSON.parse(readFileSync(join(home, "bridge.lock"), "utf-8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  supervisorState(home: string): Record<string, unknown> | null {
    try {
      return JSON.parse(readFileSync(join(home, "supervisor.state"), "utf-8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  writeSupervisorState(home: string, state: Record<string, unknown>): void {
    const p = join(home, "supervisor.state");
    const tmp = p + `.harness-tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSafe(tmp, p);
  }

  /**
   * Validated direct signal to a bridge process belonging to THIS home (the
   * fixture the WATCHDOG spawned is not registry-owned). Ownership proof:
   * cmdline references abtars.js and its cwd is inside the harness-owned home.
   */
  signalBridgeProcess(home: string, pid: number, signal: NodeJS.Signals): void {
    const snap = procSnapshot(pid);
    if (!snap || snap.state === "Z") throw new ScenarioFailure(`bridge pid ${pid} is not observable`, "setup");
    if (!snap.cmdline || !snap.cmdline.includes("abtars.js")) {
      throw new ScenarioFailure(`pid ${pid} does not look like a bridge process`, "setup");
    }
    const cwd = processCwd(pid);
    if (cwd !== null && cwd !== home) throw new ScenarioFailure(`pid ${pid} belongs to another home (${cwd})`, "setup");
    process.kill(pid, signal);
    this.timeline("bridge-signalled", `${signal} pid=${pid}`);
  }

  writeLock(home: string, lock: Record<string, unknown>): void {
    const p = join(home, "bridge.lock");
    const tmp = p + `.harness-tmp`;
    writeFileSync(tmp, JSON.stringify(lock));
    renameSafe(tmp, p);
  }

  /**
   * B12 layout: releases/r1+r2 each carry a full app/bundle; <home>/app is a
   * symlink to <home>/current, which points at releases/r1. The production
   * spawn line's literal argv (`app/bundle/abtars.js`) resolves through the
   * chain, so repointing `current` changes which release NEW spawns execute
   * while existing processes keep running — release-invariant identity.
   * Must be used INSTEAD of homeA()/homeB() for that scenario (it replaces the
   * flat layout, it does not layer on top of it).
   */
  homeWithReleases(label = "home-a"): string {
    let h = this.homes.get(label);
    if (h) return h;
    h = join(this.root, label);
    for (const release of ["r1", "r2"]) {
      const bundleDir = join(h, "releases", release, "app", "bundle");
      mkdirSync(bundleDir, { recursive: true });
      mkdirSync(join(h, "releases", release, "logs"), { recursive: true });
      writeFileSync(join(bundleDir, "package.json"), '{"type":"module"}\n');
      cpSync(this.builder.bundleSupervisorState(this.profileName), join(bundleDir, "abtars-supervisor-state.js"));
      cpSync(this.builder.bundleFixtureBridge(), join(bundleDir, "abtars.js"));
    }
    mkdirSync(join(h, "logs"), { recursive: true });
    symlinkSync("releases/r1", join(h, "current"));
    symlinkSync("current", join(h, "app"));
    this.homes.set(label, h);
    this.timeline("home-seeded-releases", h);
    return h;
  }

  repointRelease(home: string, release: string): void {
    if (!["r1", "r2"].includes(release)) throw new ScenarioFailure(`unknown release ${release}`, "setup");
    const tmp = join(home, "current.tmp");
    const target = `releases/${release}`;
    try {
      rmSync(tmp, { force: true });
      symlinkSync(target, tmp);
      renameSync(tmp, join(home, "current"));
    } catch (err) {
      throw new ScenarioFailure(`release repoint failed: ${String(err)}`, "setup");
    }
    this.timeline("release-repointed", `${basename(home)} -> ${release}`);
  }

  watchdogLogLines(home: string, maxLines = LOG_TAIL_LINES): string[] {
    try {
      const raw = readFileSync(join(home, "logs", "watchdog.log"), "utf-8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }

  flockInode(home: string): number | null {
    try {
      return statSync(join(home, ".bridge.flock")).ino;
    } catch {
      return null;
    }
  }

  procSnapshot(pid: number): ReturnType<typeof procSnapshot> {
    return procSnapshot(pid);
  }

  processCwd(pid: number): string | null {
    return processCwd(pid);
  }

  /** Live processes whose cmdline references abtars.js and whose cwd is `home`. */
  listLiveBridgesByHome(home: string): number[] {
    const out: number[] = [];
    if (process.platform !== "linux") return out; // host-smoke owns macOS enumeration
    for (const entry of readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      const snap = procSnapshot(pid);
      if (!snap || snap.state === "Z") continue;
      if (!snap.cmdline || !snap.cmdline.includes("abtars.js") || snap.cmdline.includes("supervisor-state")) continue;
      if (processCwd(pid) === home) out.push(pid);
    }
    return out;
  }

  exitReportOf(home: string): { lastExitCode: unknown; lastExitAt: unknown } {
    const lock = this.lock(home);
    return { lastExitCode: lock?.lastExitCode, lastExitAt: lock?.lastExitAt };
  }

  /** Fixture self-registry entries ({pid, generation, mode}) for the home. */
  fixtureRegistryEntries(home: string): Array<{ pid: number; generation: number; mode: string }> {
    const dir = join(home, "fixture-registry");
    if (!existsSync(dir)) return [];
    const out: Array<{ pid: number; generation: number; mode: string }> = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f.includes(".tmp")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(dir, f), "utf-8")));
      } catch { /* torn or foreign file */ }
    }
    return out;
  }

  /** Homes materialized so far (lazily created by scenarios). */
  knownHomes(): string[] {
    return [...this.homes.values()];
  }

  // ── Waits, timeline, assertions ─────────────────────────────────────────

  async until(description: string, deadlineMs: number, predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    let last = false;
    let first = true;
    while (Date.now() < deadline) {
      const now = await predicate();
      if (now !== last || first) {
        this.timeline(first ? `until:${description}:initial=${now}` : `until:${description}:${last}->${now}`);
        first = false;
        last = now;
      }
      if (now) return;
      await this.sleep(POLL_YIELD_MS);
    }
    throw new ScenarioFailure(
      `deadline exceeded waiting for ${description} (last observed state: ${this.lastStateSummary()})`,
      "timeout",
    );
  }

  async expectEventually(deadlineMs: number, message: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
    try {
      await this.until(message, deadlineMs, predicate);
    } catch (err) {
      if (err instanceof ScenarioFailure && err.kind === "timeout") {
        throw new ScenarioFailure(`${message} (deadline exceeded after ${deadlineMs}ms; last state: ${this.lastStateSummary()})`, "timeout");
      }
      throw err;
    }
  }

  expect(condition: boolean, message: string): void {
    if (!condition) throw new ScenarioFailure(message, "assertion");
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  timeline(event: string, detail?: string): void {
    this.timelineEntries.push({ t: Date.now() - this.runStart, event, detail });
    if (this.timelineEntries.length > TIMELINE_CAP * 2) {
      // Keep memory bounded; the runner caps again at export time.
      this.timelineEntries.splice(0, this.timelineEntries.length - TIMELINE_CAP);
    }
  }

  cappedTimeline(): TimelineEntry[] {
    return this.timelineEntries.slice(-TIMELINE_CAP);
  }

  private lastStateSummary(): string {
    const parts: string[] = [];
    for (const [name, home] of this.homes) {
      const lock = this.lock(home);
      parts.push(`${name}.lock.pid=${lock?.pid ?? "none"} lock.lastHeartbeat=${lock?.lastHeartbeat ?? "none"}`);
    }
    return parts.join("; ");
  }

  destroy(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

// ── Local helpers ───────────────────────────────────────────────────────────

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function renameSafe(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    throw new ScenarioFailure(`atomic replace failed (${from} -> ${to}): ${String(err)}`, "setup");
  }
}

let doctorBundlePath: string | null = null;
/** run.ts injects the bundled real doctor CLI before scenarios execute. */
export function setDoctorBundle(path: string): void {
  doctorBundlePath = path;
}
export function getDoctorBundle(): string {
  if (!doctorBundlePath) throw new ScenarioFailure("doctor bundle not prepared", "setup");
  return doctorBundlePath;
}
