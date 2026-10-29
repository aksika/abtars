/**
 * Preserved and forward-safety scenarios A1-A24 (#1712 Phase 0; A24 added by
 * #1719 as the in-fence genuine-crash counterweight).
 *
 * Each scenario asserts only externally observable outcomes (R1/R7): process
 * liveness/identity, bridge.lock fields, supervisor.state, bounded watchdog.log
 * events, exit statuses. All asynchronous waits use predicate deadlines.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioDefinition, WorldApi } from "../contracts.ts";
import { captureFailureDiagnostics } from "../world.ts";
import { processStartIdentityOf } from "../proc-observers.ts";
import {
  bridgeAliveWithIdentity,
  commandLiveExit,
  crashCycle,
  parseDeathEvents,
  sampleDuring,
  waitForOwnedBridge,
} from "./helpers.ts";

const A = (
  id: string,
  title: string,
  profile: string,
  run: ScenarioDefinition["run"],
): ScenarioDefinition => ({ id, title, profile, run });

async function startHealthyBridgeUnderWatchdog(w: WorldApi, home: string): Promise<{ pid: number }> {
  w.setControl(home, { defaultMode: { mode: "healthy" } });
  await w.startWatchdog(home);
  const lock = await waitForOwnedBridge(w, home, 20000);
  return { pid: Number(lock.pid) };
}

/** Wait until the watchdog log contains the given marker line fragment. */
async function waitForLogMarker(w: WorldApi, home: string, marker: string, deadlineMs: number): Promise<void> {
  await w.expectEventually(deadlineMs, `watchdog log should contain "${marker}"`, () =>
    w.watchdogLogLines(home, 100).some((l) => l.includes(marker)),
  );
}

// ── Lifecycle preservation ───────────────────────────────────────────────────

const A1 = A("A1", "Empty home starts exactly one identified bridge", "lifecycle", async (w) => {
  const home = w.homeA();
  w.setControl(home, { defaultMode: { mode: "healthy" } });
  await w.startWatchdog(home);
  const lock = await waitForOwnedBridge(w, home, 20000);
  const pid = Number(lock.pid);
  w.expect(typeof lock.instanceId === "string" && lock.instanceId.length > 0, "bridge.lock must contain an instance ID");
  w.expect(/^[0-9]+:[0-9]+$/.test(String(lock.startIdentity)), "bridge.lock must contain a start identity (pid:starttime)");
  const snap = w.procSnapshot(pid);
  w.expect(snap !== null && snap.cmdline !== null && snap.cmdline.includes("abtars.js"), "recorded PID must be a live abtars.js process");
  const bridges = w.listLiveBridgesByHome(home);
  w.expect(bridges.length === 1 && bridges[0] === pid, `exactly one bridge expected in the home (found ${bridges.join(",")})`);
});

const A2 = A("A2", "Self-reported non-zero death recorded once, then a new PID", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid: oldPid } = await startHealthyBridgeUnderWatchdog(w, home);
  await crashCycle(w, home, 1, 250);
  await w.expectEventually(15000, "exactly one death recorded", () => {
    const st = w.supervisorState(home);
    return Array.isArray(st?.recentDeaths) && st.recentDeaths.length >= 1;
  });
  const st = w.supervisorState(home);
  const deaths = st?.recentDeaths;
  w.expect(Array.isArray(deaths) && deaths.length === 1, `death must be recorded exactly once (got ${JSON.stringify(deaths)})`);
  w.expect(st?.restartCount === 1, `restartCount should be 1 after one unplanned death (got ${String(st?.restartCount)})`);
  void oldPid;
  const events = parseDeathEvents(w.watchdogLogLines(home, 50));
  w.expect(events.some((e) => e.reason.includes("exit=1")), `death reason must carry self-reported exit code 1 (events: ${JSON.stringify(events)})`);
});

const A3 = A("A3", "Backoff escalates with repeated deaths; backdated expiry decays it", "decayFast", async (w) => {
  const home = w.homeA();
  const { pid } = await startHealthyBridgeUnderWatchdog(w, home);
  void pid;
  // Backoff attempts escalate monotonically as controlled deaths accumulate.
  let previous = -1;
  for (const expected of [1, 2, 3]) {
    await crashCycle(w, home, 1, 120);
    await w.expectEventually(25000, `backoffAttempt should reach ${expected}`, () => {
      const st = w.supervisorState(home);
      return typeof st?.backoffAttempt === "number" && st.backoffAttempt >= expected;
    });
    const attempt = Number(w.supervisorState(home)?.backoffAttempt);
    w.expect(attempt >= previous, `backoffAttempt must be non-decreasing (${previous} -> ${attempt})`);
    previous = attempt;
  }
  // Stop the crash commands so the decay phase runs against a healthy bridge.
  commandLiveExit(w, home, null);
  const backoffOut = w.supervisorCli(home, ["get-backoff"]).stdout.trim();
  w.expect(Number(backoffOut) > 0, `active backoff expected while attempt=3 (get-backoff=${backoffOut})`);

  // Controlled decay: stop the watchdog (running handoff keeps the bridge),
  // backdate the death window beyond the healthy-accounting cutoff, restart.
  const handoffCode = await w.stopWatchdogGracefully(home);
  w.expect(handoffCode === 3, `graceful stop with running bridge must be handoff exit 3 (got ${handoffCode})`);
  const st = w.supervisorState(home);
  const shifted = Math.floor(Date.now() / 1000 - 6 * 60) * 1000;
  w.writeSupervisorState(home, {
    ...st,
    recentDeaths: (Array.isArray(st?.recentDeaths) ? st.recentDeaths : []).map(() => shifted),
    lastDeathAt: new Date(shifted).toISOString(),
  });
  await w.startWatchdog(home);
  await w.expectEventually(30000, "health accounting decays backoff and restart state after expiry", () => {
    const s = w.supervisorState(home);
    return s?.backoffAttempt === 0 && s?.restartCount === 0;
  });
});

const A4 = A("A4", "Valid existing bridge adopted without a new boot grace", "lifecycle", async (w) => {
  const home = w.homeA();
  const planted = await w.plantBridge(home, { mode: "healthy" });
  const lock = await waitForOwnedBridge(w, home, 15000);
  w.expect(Number(lock.pid) === planted, `planted bridge should own the lock (lock=${String(lock.pid)} planted=${planted})`);
  await w.startWatchdog(home);
  await waitForLogMarker(w, home, `Adopted existing bridge PID=${planted}`, 15000);

  // Stop the heartbeat IMMEDIATELY after adoption. If adoption re-granted a
  // boot grace, the stale kill would fire ~bootGrace after adoption instead
  // of ~STALE after the heartbeat stopped — judged from the true start.
  const t0 = Date.now();
  w.setControl(home, { live: { heartbeatEnabled: false, ignoreTerm: false } });
  await w.expectEventually(30000, "adopted stale owner is killed and respawned with a stale-heartbeat reason", () => {
    const l = w.lock(home);
    const events = parseDeathEvents(w.watchdogLogLines(home, 20));
    return !!l && Number(l.pid) !== planted && !bridgeAliveWithIdentity(w, home, planted) &&
      events.some((e) => e.reason.startsWith("stale-heartbeat:"));
  });
  const elapsedToKillObservation = Date.now() - t0;
  // Observation latency adds at most one poll cycle; a re-granted boot grace
  // would make this far shorter than STALE.
  w.expect(
    elapsedToKillObservation >= 8 * 1000 - 4000,
    `staleness must be judged from the true process age (~${8}s), not from a fresh grace window (observed ${elapsedToKillObservation}ms)`,
  );
});

const A5 = A("A5", "Duplicate watchdog contender exits 0 without side effects", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid } = await startHealthyBridgeUnderWatchdog(w, home);
  const inodeBefore = w.flockInode(home);
  w.expect(inodeBefore !== null, "flock file must exist once the watchdog owns the singleton");
  const deathsBefore = JSON.stringify(w.supervisorState(home)?.recentDeaths ?? []);

  await w.startWatchdog(home); // contender on the same home
  const raw = await w.watchdogExitCodeWhenAvailable(home);
  await w.expectEventually(15000, "contender watchdog records its exit code", () => raw !== null);
  w.expect(raw === "0", `duplicate contender must exit 0 (got ${raw})`);
  w.registry.reapExited();

  w.expect(Number(w.lock(home)?.pid) === pid, "bridge PID must not change when a contender arrives");
  w.expect(JSON.stringify(w.supervisorState(home)?.recentDeaths ?? []) === deathsBefore, "no death may be recorded by the contender");
  w.expect(w.flockInode(home) === inodeBefore, "flock inode must not change");
});

const A6 = A("A6", "Stale validated owner is killed and respawned", "staleFast", async (w) => {
  const home = w.homeA();
  const planted = await w.plantBridge(home, { mode: "healthy" });
  await waitForOwnedBridge(w, home, 15000);
  await w.startWatchdog(home);
  await waitForLogMarker(w, home, `Adopted existing bridge PID=${planted}`, 15000);
  w.setControl(home, { live: { heartbeatEnabled: false, ignoreTerm: false } });
  await w.expectEventually(30000, "stale owner killed and replaced", () => {
    const l = w.lock(home);
    return !!l && Number(l.pid) !== planted && !bridgeAliveWithIdentity(w, home, planted);
  });
  const events = parseDeathEvents(w.watchdogLogLines(home, 30));
  w.expect(events.some((e) => e.reason.startsWith("stale-heartbeat:")), `expected stale-heartbeat death reason (events: ${JSON.stringify(events)})`);
  const replacement = Number(w.lock(home)?.pid);
  w.expect(bridgeAliveWithIdentity(w, home, replacement), "replacement bridge must be alive");
});

const A7 = A("A7", "Fresh bridge is not killed before boot grace ends", "staleFast", async (w) => {
  const home = w.homeA();
  // The fixture never heartbeats after init — stale from birth. Boot grace
  // (1s compressed) must still protect it briefly.
  w.setControl(home, { defaultMode: { mode: "stale" } });
  await w.startWatchdog(home);
  const lock = await waitForOwnedBridge(w, home, 15000);
  const spawnMs = Number(lock.startedAt);
  let firstMissingAt = -1;
  let sawAliveAfterSpawn = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const snap = w.procSnapshot(Number(lock.pid));
    if (snap !== null) {
      sawAliveAfterSpawn = true;
    } else if (sawAliveAfterSpawn) {
      firstMissingAt = Date.now();
      break;
    }
    await w.sleep(40);
  }
  w.expect(sawAliveAfterSpawn, "spawned stale bridge should have been observed alive");
  w.expect(firstMissingAt > 0, "stale bridge should eventually be killed even within boot-grace logic");
  // The SIGKILL lands before the watchdog's death log does — wait for the
  // event instead of racing it.
  await w.expectEventually(8000, "stale-heartbeat death logged", () =>
    parseDeathEvents(w.watchdogLogLines(home, 30)).some((e) => e.reason.startsWith("stale-heartbeat:")),
  );
  const lifetimeMs = firstMissingAt - spawnMs;
  const GRACE_MS = 1 * 1000;
  w.expect(
    lifetimeMs >= GRACE_MS * 0.8,
    `fresh bridge must survive its full boot grace before a stale kill (lifetime ${lifetimeMs}ms < ${GRACE_MS * 0.8}ms)`,
  );
});

const A8 = A("A8", "Suspend-sized gap enters bounded resume handling", "suspendFast", async (w) => {
  const home = w.homeA();
  const { pid } = await startHealthyBridgeUnderWatchdog(w, home);
  const hbBefore = Number(w.lock(home)?.lastHeartbeat ?? 0);
  // SIGSTOP freezes the watchdog but NOT the wall clock — an imperfect stand-in
  // for real suspend/darkwake, which is why this scenario stays advisory.
  w.pauseWatchdog(home);
  await w.sleep(8000);
  w.resumeWatchdog(home);
  await waitForLogMarker(w, home, "Suspend detected", 15000);
  await waitForLogMarker(w, home, "Resume recovery", 15000);
  await w.expectEventually(15000, "bridge preserved with a fresh heartbeat after resume", () => {
    const l = w.lock(home);
    return !!l && Number(l.pid) === pid && Number(l.lastHeartbeat ?? 0) > hbBefore && bridgeAliveWithIdentity(w, home, pid);
  });
});

// ── Command arbitration preservation ────────────────────────────────────────

interface PublishResult { result?: string; seq?: number | null }

function publishCommand(w: WorldApi, home: string, type: string, reason: string): number {
  const res = w.supervisorCli(home, ["publish-command", type, reason]);
  w.expect(res.code === 0, `publish-command ${type} failed: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout) as PublishResult;
  w.expect(typeof parsed.seq === "number", `publish-command returned no seq (${res.stdout})`);
  return parsed.seq as number;
}

const A9 = A("A9", "Restart command acknowledged, applied, restart state reset", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid: oldPid } = await startHealthyBridgeUnderWatchdog(w, home);
  const seq = publishCommand(w, home, "restart", "acceptance-a9");
  // Correction (#1712 draft review #3): acknowledgement proves the command was
  // APPLIED — it does not require the old process to have exited first.
  // 45s (not 25s): a loaded host stretches TERM-exit and the zero-process
  // proof well past 25s (observed mid-suite); a genuinely broken restart
  // still fails the same assertion, only later.
  await w.expectEventually(45000, "restart acknowledged and a replacement bridge is running", () => {
    const l = w.lock(home);
    const st = w.supervisorState(home);
    return !!l && Number(l.pid) !== oldPid && st?.acknowledgedCommandSeq === seq &&
      st?.pendingCommand === null && bridgeAliveWithIdentity(w, home, Number(l.pid));
  });
  const st = w.supervisorState(home);
  w.expect(st?.restartCount === 0, `planned restart resets restart state (got ${String(st?.restartCount)})`);
  w.expect(Array.isArray(st?.recentDeaths) && st.recentDeaths.length === 0, "no unplanned death may be recorded for a planned restart");
  await waitForLogMarker(w, home, "Planned bridge restart: command=restart", 10000);
});

const A10 = A("A10", "Stop terminates the bridge and exits 2 without respawn", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid } = await startHealthyBridgeUnderWatchdog(w, home);
  const res = w.supervisorCli(home, ["set-desired-state", "stopped"]);
  w.expect(res.code === 0, "set-desired-state stopped failed");
  const code = await w.watchdogExitCodeWhenAvailable(home);
  await w.expectEventually(20000, "watchdog must record its durable-stop exit code", () => code !== null);
  w.expect(code === "2", `durable stop must exit 2 (got ${code})`);
  await w.expectEventually(15000, "bridge terminated with no respawn", () =>
    !bridgeAliveWithIdentity(w, home, pid) && w.listLiveBridgesByHome(home).length === 0,
  );
  w.expect(w.supervisorCli(home, ["desired-state"]).stdout.trim() === "stopped", "desired state must remain stopped");
});

const A11 = A("A11", "Durable stop dominates a pending restart deterministically", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid } = await startHealthyBridgeUnderWatchdog(w, home);
  void pid;
  // Create dominance through DURABLE desired state, not by racing two commands
  // through the one-slot queue (draft-review correction #4).
  publishCommand(w, home, "restart", "acceptance-a11-pending");
  const res = w.supervisorCli(home, ["set-desired-state", "stopped"]);
  w.expect(res.code === 0, "set-desired-state stopped failed");
  const code = await w.watchdogExitCodeWhenAvailable(home);
  await w.expectEventually(20000, "watchdog must record its durable-stop exit code", () => code !== null);
  w.expect(code === "2", `stop dominance must end in exit 2 (got ${code})`);
  await w.expectEventually(15000, "no bridge may remain after stop dominance", () => w.listLiveBridgesByHome(home).length === 0);
});

const A12 = A("A12", "Unknown command acked and dropped; later valid command applies", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid } = await startHealthyBridgeUnderWatchdog(w, home);
  const seqUnknown = publishCommand(w, home, "frobnicate", "acceptance-a12-unknown");
  await w.expectEventually(20000, "unknown command acknowledged and dropped", () => {
    const st = w.supervisorState(home);
    return st?.acknowledgedCommandSeq === seqUnknown && st?.pendingCommand === null;
  });
  w.expect(Number(w.lock(home)?.pid) === pid, "unknown command must not touch the running bridge");

  const seqRestart = publishCommand(w, home, "restart", "acceptance-a12-restart");
  // 45s: a planned-restart completion on a loaded host can outstretch 25s
  // (TERM-exit + zero-process proof + boot); a broken apply still fails.
  await w.expectEventually(45000, "legitimate restart published afterwards is applied", () => {
    const l = w.lock(home);
    const st = w.supervisorState(home);
    return !!l && Number(l.pid) !== pid && st?.acknowledgedCommandSeq === seqRestart && bridgeAliveWithIdentity(w, home, Number(l.pid));
  });
});

// ── Identity validation preservation ────────────────────────────────────────

const A13 = A("A13", "Reused-PID lock never signals the unrelated process", "lifecycle", async (w) => {
  const home = w.homeA();
  const sleeper = await w.registry.spawn({ cmd: "sleep", args: ["300"], role: "helper", home });
  const sleeperIdentity = w.registry.get(sleeper)?.startIdentity ?? processStartIdentityOf(sleeper);
  // Seed a well-formed lock whose identity belongs to nobody: the PID is alive
  // but its real start identity differs — the definition of reuse.
  const seededLock = {
    pid: sleeper,
    startedAt: Date.now() - 5000,
    instanceId: "harness-seeded-instance",
    startIdentity: "4194300:98765",
    lastHeartbeat: Date.now(),
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(home, "bridge.lock"), JSON.stringify(seededLock));

  await w.startWatchdog(home);
  await waitForLogMarker(w, home, "Adoption skipped (reused)", 20000);
  await w.expectEventually(25000, "watchdog spawns its own validated bridge instead", () => {
    const l = w.lock(home);
    return !!l && Number(l.pid) !== sleeper && bridgeAliveWithIdentity(w, home, Number(l.pid));
  });
  w.expect(processStartIdentityOf(sleeper) === sleeperIdentity, "the unrelated reused-PID process must remain untouched");
  w.expect(w.procSnapshot(sleeper) !== null, "the unrelated reused-PID process must still be alive");
});

const A14 = A("A14", "Exit-report freshness gate: stale rejected, fresh used", "lifecycle", async (w) => {
  const home = w.homeA();
  // (a) fresh self-report wins: exit:7 past boot grace is adopted.
  await startHealthyBridgeUnderWatchdog(w, home);
  await crashCycle(w, home, 7, 250);
  await w.expectEventually(15000, "fresh self-reported exit code adopted", () => {
    const events = parseDeathEvents(w.watchdogLogLines(home, 40));
    return events.some((e) => e.reason.endsWith("exit=7"));
  });

  // (b) a report OLDER than the spawn is rejected: pre-seed lastExitCode=9
  // with an aged lastExitAt, then SIGKILL the bridge — the death must read
  // `unknown`, never 9. The fixture is frozen around the preseed so no
  // concurrent heartbeat write can drop the seeded fields.
  const p2 = Number(w.lock(home)?.pid);
  w.signalBridgeProcess(home, p2, "SIGSTOP");
  await w.sleep(250);
  const lock = w.lock(home)!;
  w.writeLock(home, { ...lock, lastExitCode: 9, lastExitAt: Date.now() - 60_000 });
  w.signalBridgeProcess(home, p2, "SIGKILL");
  await w.expectEventually(30000, "stale preseeded report rejected as unknown", () => {
    const events = parseDeathEvents(w.watchdogLogLines(home, 40));
    return events.some((e) => e.pid === String(p2)) && events.some((e) => e.reason.endsWith("exit=unknown"));
  });
});

const A15 = A("A15", "SIGHUP ignored; SIGTERM hands off with bridge preserved (exit 3)", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid } = await startHealthyBridgeUnderWatchdog(w, home);
  w.signalWatchdogProcess(home, "SIGHUP");
  await w.sleep(1200);
  w.expect(w.watchdogPidOf(home) !== null, "watchdog must ignore SIGHUP and stay alive");
  w.expect(bridgeAliveWithIdentity(w, home, pid), "bridge unaffected by SIGHUP");

  w.signalWatchdogProcess(home, "SIGTERM");
  const code = await w.watchdogExitCodeWhenAvailable(home);
  await w.expectEventually(20000, "watchdog must record its handoff exit code", () => code !== null);
  w.expect(code === "3", `running handoff must exit 3 (got ${code})`);
  w.expect(bridgeAliveWithIdentity(w, home, pid), "bridge must survive the watchdog handoff");
});

const A16 = A("A16", "Recorded spawned PID is the Node bridge, not a wrapper", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid } = await startHealthyBridgeUnderWatchdog(w, home);
  const snap = w.procSnapshot(pid);
  w.expect(snap !== null && snap.comm === "node", `spawned process comm must be node (got ${snap?.comm})`);
  w.expect(snap?.cmdline !== null && (snap?.cmdline ?? "").includes("abtars.js"), "cmdline must reference abtars.js");
  w.expect(!(snap?.cmdline ?? "").includes("bash"), "no shell wrapper may own the recorded PID");
  const entries = w.fixtureRegistryEntries(home);
  w.expect(entries.some((e) => e.pid === pid), "fixture registry must contain the same PID the lock records");
});

const A17 = A("A17", "No zombies across five rapid crash cycles", "crashLoopFast", async (w) => {
  const home = w.homeA();
  await startHealthyBridgeUnderWatchdog(w, home);
  for (let i = 0; i < 5; i++) {
    await crashCycle(w, home, i % 2 === 0 ? 1 : 2, 110);
  }
  let zombieSeen = false;
  let overConcurrency = false;
  await w.expectEventually(45000, "five crash cycles complete", () => {
    const l = w.lock(home);
    if (l) {
      const snap = w.procSnapshot(Number(l.pid));
      if (snap?.state === "Z") zombieSeen = true;
    }
    for (const entry of w.fixtureRegistryEntries(home)) {
      const snap = w.procSnapshot(entry.pid);
      if (snap?.state === "Z") zombieSeen = true;
    }
    const liveCount = w.listLiveBridgesByHome(home).length;
    if (liveCount > 1) overConcurrency = true;
    const deaths = w.supervisorState(home)?.recentDeaths;
    return Array.isArray(deaths) && deaths.length >= 5;
  });
  w.expect(!zombieSeen, "zombie state observed during continuous sampling");
  w.expect(!overConcurrency, "more than one live bridge observed during the crash loop");
  w.expect(w.listLiveBridgesByHome(home).every((p) => w.procSnapshot(p)?.state !== "Z"), "cleanup sweep found no zombies");
});

const A18 = A("A18", "Watchdog never invokes doctor or service management (canaries)", "lifecycle", async (w) => {
  const home = w.homeA();
  const canaryDir = join(w.artifactsDir(), "canary-bin");
  const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
  mkdirSync(canaryDir, { recursive: true });
  for (const name of ["doctor", "launchctl", "systemctl", "service"]) {
    const p = join(canaryDir, name);
    writeFileSync(p, "#!/bin/sh\necho \"$0 $*\" >> \"$CANARY_HITS\"\nexit 0\n");
    chmodSync(p, 0o755);
  }
  const hitsFile = join(w.artifactsDir(), "canary-hits.log");
  const env = {
    PATH: `${canaryDir}:${process.env.PATH ?? ""}`,
    CANARY_HITS: hitsFile,
  };
  w.setControl(home, { defaultMode: { mode: "healthy" } });
  await w.startWatchdog(home, env);
  const owned = await waitForOwnedBridge(w, home, 20000);
  const pid = Number(owned.pid);
  const seq = publishCommand(w, home, "restart", "acceptance-a18");
  // 45s: same loaded-host restart-completion headroom as A9/A12.
  await w.expectEventually(45000, "planned restart applied under canary PATH", () => {
    const l = w.lock(home);
    const st = w.supervisorState(home);
    return !!l && Number(l.pid) !== pid && st?.acknowledgedCommandSeq === seq;
  });
  w.supervisorCli(home, ["set-desired-state", "stopped"]);
  const code = await w.watchdogExitCodeWhenAvailable(home);
  await w.expectEventually(20000, "durable stop completes", () => code === "2");
  w.expect(!existsSync(hitsFile) || statSync(hitsFile).size === 0, "a forbidden command canary was invoked");
  for (const f of readdirSync(home, { recursive: true })) {
    const name = String(f);
    w.expect(!name.endsWith(".plist") && !name.endsWith(".service"), `no service-manager unit may be created (found ${name})`);
  }
  // The watchdog is a dumb respawner: it must not grow log files while
  // respawning (draft §A18 — absence is what regrows).
  w.expect(!existsSync(join(home, "bridge.log")), "no bridge.log may be created by the watchdog");
  w.expect((statSync(join(home, "bridge.lock")).mode & 0o777) === 0o600, "bridge.lock permissions must remain 0600");
});

const A19 = A("A19", "Released stale flock does not block startup; inode never unlinked", "lifecycle", async (w) => {
  const home = w.homeA();
  await startHealthyBridgeUnderWatchdog(w, home);
  const inode1 = w.flockInode(home);
  w.expect(inode1 !== null, "flock file created by first watchdog");
  await w.stopWatchdogGracefully(home);
  const inode2 = w.flockInode(home);
  const wd2 = await w.startWatchdog(home);
  void wd2;
  await w.expectEventually(25000, "second watchdog takes ownership over the released flock", () => {
    const ownerPid = w.watchdogPidOf(home);
    const lock = w.lock(home);
    return ownerPid !== null && Number(lock?.watchdogPid ?? 0) === ownerPid;
  });
  const inode3 = w.flockInode(home);
  w.expect(inode1 === inode2 && inode2 === inode3, `flock inode must never be unlinked/recreated (${inode1}, ${inode2}, ${inode3})`);
});

// ── Forward safety ──────────────────────────────────────────────────────────

const A20 = A("A20", "Planned-restart fence never signals harness-owned transients", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid: oldPid } = await startHealthyBridgeUnderWatchdog(w, home);
  // Freeze arbitration to set up the fence race-free.
  w.pauseWatchdog(home);
  const transient = await w.plantBridge(home, { mode: "transient" });
  const seq = publishCommand(w, home, "restart", "acceptance-a20-fence");
  w.resumeWatchdog(home);

  // #1711's final spawn proof excludes only the freshly-authorized predecessor.
  // The harness-owned exact-target transient is a separate blocker, so the
  // proof must veto the replacement while it remains alive. This is distinct
  // from #1717's original regression (the terminated predecessor itself
  // withholding the replacement), which A9 covers directly.
  await waitForLogMarker(w, home, "Spawn withheld: occupied 1", 15000);
  const transientOk = await sampleDuring(w, 1000, () => bridgeAliveWithIdentity(w, home, transient));
  w.expect(
    transientOk.length > 0 && transientOk.every(Boolean),
    "harness-owned transient must remain alive while the fence vetoes the duplicate spawn",
  );

  // Harness cleanup is deliberately explicit: the watchdog must not signal an
  // unowned process during the fence. Once the extra blocker is gone, the
  // existing #1711 planned-replacement proof can complete the command.
  w.registry.signal(transient, "SIGKILL");
  w.registry.reapExited();

  await w.expectEventually(30000, "fence completes: restart applied", () => {
    const l = w.lock(home);
    const st = w.supervisorState(home);
    return !!l && Number(l.pid) !== oldPid && st?.acknowledgedCommandSeq === seq && bridgeAliveWithIdentity(w, home, Number(l.pid));
  });
  const newPid = Number(w.lock(home)?.pid);
  await w.expectEventually(10000, "exactly one owned bridge remains", () =>
    JSON.stringify(w.listLiveBridgesByHome(home)) === JSON.stringify([newPid]),
  );
});

const A21 = A("A21", "Forced future-enumeration failure: no signal, no duplicate", "lifecycle", async (w) => {
  const home = w.homeA();
  const survivor = await w.plantBridge(home, { mode: "healthy" });
  await waitForOwnedBridge(w, home, 15000);
  // Two injection layers for the future enumeration adapter:
  // (1) a failing `ps` stub prepended to PATH — inert today (the watchdog
  //     never invokes ps), authoritative once enumeration lands;
  // (2) a fault marker file the adapter must honor.
  const psStubDir = join(w.artifactsDir(), "ps-stub");
  const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
  mkdirSync(psStubDir, { recursive: true });
  const stub = join(psStubDir, "ps");
  writeFileSync(stub, "#!/bin/sh\nexit 3\n");
  chmodSync(stub, 0o755);
  writeFileSync(join(w.artifactsDir(), "enumeration-fault.injected"), "enumeration forced to fail\n");
  await w.startWatchdog(home, { PATH: `${psStubDir}:${process.env.PATH ?? ""}` });
  await waitForLogMarker(w, home, `Adopted existing bridge PID=${survivor}`, 20000);
  const samples = await sampleDuring(w, 4 * 1000, () =>
    w.listLiveBridgesByHome(home).length === 1 &&
    bridgeAliveWithIdentity(w, home, survivor) &&
    processStartIdentityOf(survivor) === (w.registry.get(survivor)?.startIdentity ?? ""),
  );
  w.expect(samples.length > 0 && samples.every(Boolean), "survivor must be neither signalled nor duplicated while enumeration is unavailable");
});

const A22 = A("A22", "Five distinct death events inside one interval stay reconstructible", "crashLoopFast", async (w) => {
  const home = w.homeA();
  await startHealthyBridgeUnderWatchdog(w, home);
  for (const code of [11, 12, 13, 14, 15]) {
    await crashCycle(w, home, code, 130);
  }
  await w.expectEventually(30000, "five deaths recorded in supervisor state", () => {
    const deaths = w.supervisorState(home)?.recentDeaths;
    return Array.isArray(deaths) && deaths.length >= 5;
  });
  const events = parseDeathEvents(w.watchdogLogLines(home, 200));
  const reasons = new Set(events.map((e) => e.reason));
  for (const code of [11, 12, 13, 14, 15]) {
    w.expect(reasons.has(`process-gone:exit=${code}`), `distinct event exit=${code} must remain reconstructible (reasons: ${[...reasons].join("|")})`);
  }
  w.expect(events.length >= 5, `at least five death events expected (got ${events.length})`);
});

/**
 * A23 (draft v2 / D7): the SOLE survivor of an unclean watchdog death is
 * adopted, not contained. Counterweight to B8 — there is no outage-survivor
 * category, and this scenario stops B8's containment from ever becoming an
 * owner-killing path. Passes today by construction.
 */
const A23 = A("A23", "Sole survivor after unclean watchdog death is adopted", "lifecycle", async (w) => {
  const home = w.homeA();
  const owner = await w.plantBridge(home, { mode: "healthy" });
  await waitForOwnedBridge(w, home, 15000);
  await w.startWatchdog(home);
  await waitForLogMarker(w, home, `Adopted existing bridge PID=${owner}`, 20000);

  // Unclean watchdog death: no handoff, no durable stop.
  w.signalWatchdogProcess(home, "SIGKILL");
  await w.expectEventually(10000, "watchdog gone after unclean death", () => w.watchdogPidOf(home) === null);
  w.expect(bridgeAliveWithIdentity(w, home, owner), "the sole bridge must survive the watchdog's death");

  // Restoration adopts the survivor; boot grace stays anchored to the
  // bridge's own startedAt (unchanged PID proves no respawn happened).
  await w.startWatchdog(home);
  await waitForLogMarker(w, home, `Adopted existing bridge PID=${owner}`, 20000);
  const samples = await sampleDuring(w, 3 * 1000, () =>
    Number(w.lock(home)?.pid) === owner &&
    w.listLiveBridgesByHome(home).length === 1 &&
    bridgeAliveWithIdentity(w, home, owner),
  );
  w.expect(samples.length > 0 && samples.every(Boolean), "survivor must remain the sole validated owner after restoration");
});

/**
 * A24 (#1719 counterweight): a replacement that boots past initBridgeLock —
 * writing a FRESH instanceId — and then exits non-zero during the planned
 * transition fence is a genuine owner-generation failure. It must stay fully
 * accountable: logged, recorded, backoff effective. This blocks any future
 * regression to the invalid rule "fence active means suppress every death"
 * (the failure-matrix asymmetry).
 */
const A24 = A("A24", "In-fence crash after a fresh instanceId remains a recorded death", "lifecycle", async (w) => {
  try {
    const home = w.homeA();
    const { pid: oldPid } = await startHealthyBridgeUnderWatchdog(w, home);
    // The REPLACEMENT takes this scheduled mode: initialize ownership (fresh
    // instanceId) and exit non-zero ~150ms later — inside the fence window.
    w.setControl(home, {
      nextSpawns: [{ generation: w.claimNextGeneration(home), mode: "exit", exitCode: 3, delayMs: 150 }],
    });
    publishCommand(w, home, "restart", "acceptance-a24");
    await w.expectEventually(30000, "replacement crash recorded with its own fresh exit code", () => {
      const events = parseDeathEvents(w.watchdogLogLines(home, 80));
      return events.some((e) => e.reason.endsWith("exit=3") && e.pid !== String(oldPid));
    });
    // Death accounting is applied by separate CLI invocations right after the
    // log line lands — wait for the durable state instead of racing it.
    await w.expectEventually(15000, "in-fence crash recorded in supervisor death accounting", () => {
      const s = w.supervisorState(home);
      return Array.isArray(s?.recentDeaths) && (s.recentDeaths as unknown[]).length >= 1 &&
        Number(s?.restartCount) >= 1;
    });
    const st = w.supervisorState(home);
    w.expect(Array.isArray(st?.recentDeaths) && (st.recentDeaths as unknown[]).length === 1,
      `the in-fence crash must be recorded exactly once (got ${JSON.stringify(st?.recentDeaths)})`);
    w.expect(Number(st?.backoffAttempt) >= 1, `backoff must remain effective for an accountable death (got ${String(st?.backoffAttempt)})`);
    // A settled healthy replacement follows the accounted crash.
    await w.expectEventually(30000, "settled healthy replacement after the accounted crash", () => {
      const l = w.lock(home);
      return !!l && Number(l.pid) !== oldPid && bridgeAliveWithIdentity(w, home, Number(l.pid));
    });
  } catch (err) {
    // #1722 diagnosis only: capture failure-time evidence, then rethrow
    // unchanged. No assertion, deadline, or fixture timing is modified here.
    captureFailureDiagnostics(w, "RA24-1722");
    throw err;
  }
});

export const PRESERVED_SCENARIOS: readonly ScenarioDefinition[] = [
  A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12,
  A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24,
];
