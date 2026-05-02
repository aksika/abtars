/**
 * #372 — agentbridge stop tests.
 *
 * Strategy: create a real temp AGENT_BRIDGE_HOME with real lock files, spawn
 * real child processes (sleep infinity / controlled children) as the "watchdog"
 * and "bridge," then run stop() and verify the processes die + locks are removed.
 *
 * This avoids mocking process.kill / fs and gives us real OS-level assertions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { stop } from "./stop.js";

describe("#372 — agentbridge stop", () => {
  let tmpHome: string;
  const savedHome = process.env["AGENT_BRIDGE_HOME"];
  const procs: ChildProcess[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";

  function captureStdio(): void {
    stdout = "";
    stderr = "";
    process.stdout.write = ((buf: string | Uint8Array) => { stdout += String(buf); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((buf: string | Uint8Array) => { stderr += String(buf); return true; }) as typeof process.stderr.write;
  }

  function restoreStdio(): void {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  }

  /**
   * Spawn a long-running child. Returns immediately with the PID.
   * argv0 can be set to make /proc/<pid>/cmdline look like a watchdog or bridge.
   */
  function spawnDummy(label: "watchdog" | "bridge"): number {
    // Use node running a tight sleep loop, with argv[0] label so cmdline contains the needle
    const args = label === "watchdog"
      ? ["-e", "setInterval(()=>{}, 1000)", "watchdog.sh"]
      : ["-e", "setInterval(()=>{}, 1000)", "agentbridge-main.js"];
    const child = spawn("node", args, { stdio: "ignore", detached: false });
    procs.push(child);
    if (!child.pid) throw new Error("failed to spawn dummy");
    return child.pid;
  }

  function waitDead(pid: number, maxMs = 2000): Promise<boolean> {
    return new Promise(resolve => {
      const start = Date.now();
      const tick = () => {
        try { process.kill(pid, 0); } catch { resolve(true); return; }
        if (Date.now() - start > maxMs) { resolve(false); return; }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "stop-test-"));
    process.env["AGENT_BRIDGE_HOME"] = tmpHome;
  });

  afterEach(async () => {
    restoreStdio();
    // Kill any leftover children
    for (const p of procs) {
      if (p.pid) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
    }
    procs.length = 0;
    if (savedHome === undefined) delete process.env["AGENT_BRIDGE_HOME"];
    else process.env["AGENT_BRIDGE_HOME"] = savedHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── No lock files at all ──────────────────────────────────────────────

  it("reports 'nothing to stop' when no lock files exist", async () => {
    captureStdio();
    const exit = await stop({});
    restoreStdio();
    expect(exit).toBe(0);
    expect(stdout).toContain("Nothing to stop");
  });

  // ── Watchdog alive + bridge alive ─────────────────────────────────────

  it("kills watchdog then bridge when both are running", async () => {
    const wdPid = spawnDummy("watchdog");
    const brPid = spawnDummy("bridge");
    // Let them settle
    await new Promise(r => setTimeout(r, 100));

    writeFileSync(join(tmpHome, "watchdog.lock"), JSON.stringify({ pid: wdPid, lastCheck: Date.now() }));
    writeFileSync(join(tmpHome, "bridge.lock"), JSON.stringify({ pid: brPid, lastHeartbeat: Date.now() }));

    captureStdio();
    const exit = await stop({});
    restoreStdio();

    expect(exit).toBe(0);
    expect(await waitDead(wdPid)).toBe(true);
    expect(await waitDead(brPid)).toBe(true);
    expect(existsSync(join(tmpHome, "watchdog.lock"))).toBe(false);
    expect(existsSync(join(tmpHome, "bridge.lock"))).toBe(false);
    expect(stdout).toContain("Watchdog stopped");
    expect(stdout).toContain("Bridge stopped");
  });

  // ── Only bridge running (no watchdog) ─────────────────────────────────

  it("kills bridge when watchdog isn't running", async () => {
    const brPid = spawnDummy("bridge");
    await new Promise(r => setTimeout(r, 100));

    writeFileSync(join(tmpHome, "bridge.lock"), JSON.stringify({ pid: brPid }));

    captureStdio();
    const exit = await stop({});
    restoreStdio();

    expect(exit).toBe(0);
    expect(await waitDead(brPid)).toBe(true);
    expect(stdout).toContain("Bridge stopped");
    expect(stdout).toContain("Watchdog was not running");
  });

  // ── Stale watchdog lock (PID not watchdog) ────────────────────────────

  it("treats watchdog.lock as stale when /proc cmdline doesn't match", async () => {
    // Spawn a dummy node process WITHOUT the watchdog.sh needle in argv
    const unrelated = spawn("node", ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
    procs.push(unrelated);
    await new Promise(r => setTimeout(r, 100));
    if (!unrelated.pid) throw new Error("spawn failed");

    writeFileSync(join(tmpHome, "watchdog.lock"), JSON.stringify({ pid: unrelated.pid }));

    captureStdio();
    const exit = await stop({});
    restoreStdio();

    // Process should NOT be killed (cmdline didn't match — guarded)
    expect(process.kill(unrelated.pid, 0)).toBe(true); // still alive
    // Lock should be removed as stale
    expect(existsSync(join(tmpHome, "watchdog.lock"))).toBe(false);
    expect(exit).toBe(0);
    expect(stdout).toContain("stale");
  });

  // ── Supervised-daemon refusal ─────────────────────────────────────────

  it("refuses when installMode is supervised-daemon without --force", async () => {
    writeFileSync(join(tmpHome, "manifest.json"), JSON.stringify({ installMode: "supervised-daemon" }));

    captureStdio();
    const exit = await stop({});
    restoreStdio();

    expect(exit).toBe(1);
    expect(stderr).toContain("supervised-daemon");
    expect(stderr).toMatch(/systemctl stop|launchctl bootout/);
  });

  it("proceeds when installMode is supervised-daemon with --force", async () => {
    const wdPid = spawnDummy("watchdog");
    await new Promise(r => setTimeout(r, 100));

    writeFileSync(join(tmpHome, "manifest.json"), JSON.stringify({ installMode: "supervised-daemon" }));
    writeFileSync(join(tmpHome, "watchdog.lock"), JSON.stringify({ pid: wdPid }));

    captureStdio();
    const exit = await stop({ force: true });
    restoreStdio();

    expect(exit).toBe(0);
    expect(await waitDead(wdPid)).toBe(true);
  });

  // ── Non-supervised (simple / supervised) passes through ───────────────

  it("proceeds normally when installMode is 'simple'", async () => {
    const brPid = spawnDummy("bridge");
    await new Promise(r => setTimeout(r, 100));

    writeFileSync(join(tmpHome, "manifest.json"), JSON.stringify({ installMode: "simple" }));
    writeFileSync(join(tmpHome, "bridge.lock"), JSON.stringify({ pid: brPid }));

    captureStdio();
    const exit = await stop({});
    restoreStdio();

    expect(exit).toBe(0);
    expect(await waitDead(brPid)).toBe(true);
  });

  // ── Lock with non-existent PID (bridge already died) ──────────────────

  it("handles bridge.lock pointing at a dead PID gracefully", async () => {
    // PID 1 always exists, use a guaranteed-dead high PID instead
    // Strategy: spawn + kill immediately
    const tmp = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
    const deadPid = tmp.pid!;
    await new Promise(r => setTimeout(r, 100)); // let it exit

    writeFileSync(join(tmpHome, "bridge.lock"), JSON.stringify({ pid: deadPid }));

    captureStdio();
    const exit = await stop({});
    restoreStdio();

    expect(exit).toBe(0);
    // Both treated as not-running → short-circuit "Nothing to stop" message
    expect(stdout).toContain("Nothing to stop");
  });

  // ── Malformed lock file ───────────────────────────────────────────────

  it("handles malformed JSON in lock files", async () => {
    writeFileSync(join(tmpHome, "watchdog.lock"), "not valid json {");

    captureStdio();
    const exit = await stop({});
    restoreStdio();

    // Shouldn't throw; should report nothing running
    expect(exit).toBe(0);
    expect(stdout).toContain("Nothing to stop");
  });

  // ── Manifest unreadable → treated as non-daemon mode ─────────────────

  it("treats missing manifest.json as non-daemon (no refusal)", async () => {
    // No manifest, no lock files either
    captureStdio();
    const exit = await stop({});
    restoreStdio();

    expect(exit).toBe(0);
    expect(stdout).toContain("Nothing to stop");
    expect(stderr).not.toContain("supervised-daemon");
  });
});
