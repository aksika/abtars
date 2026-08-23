/**
 * Known-deficiency scenarios B1-B10 (#1712 Phase 0).
 *
 * Each scenario asserts the FINAL desired behavior. On today's baseline every
 * one of them is expected to fail for its declared reason — a setup or harness
 * failure is NOT an acceptable known-fail. The manifest records the owning
 * #1711 problem for each.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScenarioFailure } from "../world.ts";
import type { ScenarioDefinition, WorldApi } from "../contracts.ts";
import {
  bridgeAliveWithIdentity,
  crashCycle,
  parseDeathEvents,
  waitForOwnedBridge,
} from "./helpers.ts";

const B = (
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

function corruptLock(home: string): void {
  // Torn JSON: exactly the shape a crashed writer leaves behind.
  writeFileSync(join(home, "bridge.lock"), '{"pid": 12345, "startedAt":');
}

/**
 * B1 (#1711 P7): corrupt lock plus a live tracked bridge must reach a bounded,
 * recorded ownership decision keeping at most one bridge. Today `corrupt` is
 * missing from the watchdog's definitive-status case list, so validation
 * retries exhaust into "transient" and the cycle defers forever without any
 * decision.
 */
const B1 = B("B1", "Corrupt lock reaches a bounded ownership decision", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid: owner } = await startHealthyBridgeUnderWatchdog(w, home);
  corruptLock(home);
  const deathsBefore = JSON.stringify(w.supervisorState(home)?.recentDeaths ?? []);
  let decisionObserved = false;
  try {
    await w.expectEventually(15000, "bounded ownership decision reached after lock corruption", () => {
      const events = parseDeathEvents(w.watchdogLogLines(home, 30));
      const l = w.lock(home);
      const st = w.supervisorState(home);
      decisionObserved =
        events.length > 0 ||
        JSON.stringify(st?.recentDeaths ?? []) !== deathsBefore ||
        (!!l && Number(l.pid) !== owner);
      return decisionObserved;
    });
  } catch {
    throw new ScenarioFailure(
      "B1 final-form failure: a corrupt lock defers the watchdog indefinitely — no bounded, recorded ownership decision was reached",
      "assertion",
    );
  }
  // The invariant part of the final form holds even when the decision exists.
  w.expect(w.listLiveBridgesByHome(home).length <= 1, "a bounded decision must preserve at most one bridge");
});

/**
 * B2 (#1711 P3): starting a watchdog against a corrupt lock with a live
 * same-home bridge must never create a second bridge. Today adoption is
 * skipped and a duplicate bridge is spawned.
 */
const B2 = B("B2", "Corrupt-lock startup never duplicates the live bridge", "lifecycle", async (w) => {
  const home = w.homeA();
  const planted = await w.plantBridge(home, { mode: "healthy" });
  await waitForOwnedBridge(w, home, 15000);
  // Freeze the fixture so no in-flight heartbeat atomic-write can restore a
  // valid lock behind the corruption. Resumed afterwards, its mutation path
  // swallows the unparseable lock — exactly the defect premise.
  w.registry.signalPidOnly(planted, "SIGSTOP");
  await w.sleep(250);
  corruptLock(home);
  await w.startWatchdog(home);
  w.registry.signalPidOnly(planted, "SIGCONT");
  await w.sleep(6000); // several poll cycles: give any duplication a chance to happen
  const live = w.listLiveBridgesByHome(home);
  w.expect(
    live.length <= 1,
    `B2 final-form failure: watchdog startup duplicated the live same-home bridge (pids ${live.join(",")})`,
  );
  w.expect(bridgeAliveWithIdentity(w, home, planted), "the original live bridge should remain alive");
});

/**
 * B3 (#1711 P1): non-owner heartbeat writes must not keep a stale owner
 * looking healthy. Today updateLastHeartbeat through the shared field-mutation
 * path refreshes the owner's timestamp from any process.
 */
const B3 = B("B3", "Non-owner heartbeat writes cannot mask a stale owner", "staleFast", async (w) => {
  const home = w.homeA();
  const owner = await w.plantBridge(home, { mode: "healthy" });
  await waitForOwnedBridge(w, home, 15000);
  await w.startWatchdog(home);
  await w.expectEventually(20000, "watchdog adopts the planted owner", () =>
    w.watchdogLogLines(home, 50).some((l) => l.includes(`Adopted existing bridge PID=${owner}`)),
  );
  // Owner goes stale on purpose; the non-owner keeps refreshing the shared field.
  w.setControl(home, { live: { heartbeatEnabled: false, ignoreTerm: false } });
  const nonOwner = await w.plantBridge(home, { mode: "non-owner" });
  void nonOwner;
  const hb1 = Number(w.lock(home)?.lastHeartbeat ?? 0);
  await w.sleep(2000);
  const hb2 = Number(w.lock(home)?.lastHeartbeat ?? 0);
  w.expect(hb2 > hb1, "test validity: non-owner writes must be actively refreshing the lock for this scenario to exercise the defect");
  try {
    await w.expectEventually(30000, "stale owner killed despite foreign heartbeats", () => {
      const events = parseDeathEvents(w.watchdogLogLines(home, 40));
      return !bridgeAliveWithIdentity(w, home, owner) && events.some((e) => e.reason.startsWith("stale-heartbeat:"));
    });
  } catch {
    throw new ScenarioFailure(
      "B3 final-form failure: non-owner heartbeat writes keep the stale owner looking healthy indefinitely",
      "assertion",
    );
  }
});

/**
 * B4 (#1711 P1): a non-owner exit self-report must not become the owner's
 * death code. The watchdog is paused while the real owner exits 0, a forger
 * plants exitCode=42, then arbitration resumes and reads the forged value.
 */
const B4 = B("B4", "Non-owner exit self-report cannot forge the owner's death code", "lifecycle", async (w) => {
  const home = w.homeA();
  const owner = await w.plantBridge(home, { mode: "healthy" });
  await waitForOwnedBridge(w, home, 15000);
  await w.startWatchdog(home);
  await w.expectEventually(20000, "watchdog adopts the planted owner", () =>
    w.watchdogLogLines(home, 50).some((l) => l.includes(`Adopted existing bridge PID=${owner}`)),
  );
  w.pauseWatchdog(home);
  const forger = await w.plantBridge(home, { mode: "forge-exit", forgedExitCode: 42 });
  void forger;
  // Owner exits cleanly with its OWN self-report of 0.
  const { execFileSync } = await import("node:child_process");
  execFileSync("kill", ["-TERM", String(owner)]);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && bridgeAliveWithIdentity(w, home, owner)) await w.sleep(60);
  w.expect(!bridgeAliveWithIdentity(w, home, owner), "owner should have exited before arbitration resumes");
  w.resumeWatchdog(home);
  try {
    await w.expectEventually(25000, "owner death recorded with its true exit code 0", () => {
      const events = parseDeathEvents(w.watchdogLogLines(home, 40));
      return events.some((e) => e.reason.includes("exit=0"));
    });
    const events = parseDeathEvents(w.watchdogLogLines(home, 40));
    const ownerEvent = events.find((e) => e.pid === String(owner)) ?? events[events.length - 1];
    if (ownerEvent === undefined || !ownerEvent.reason.includes("exit=0")) {
      throw new ScenarioFailure(`B4 final-form failure: owner's death code came from a non-owner report (${ownerEvent?.reason})`, "assertion");
    }
  } catch (err) {
    if (err instanceof ScenarioFailure) throw err;
    if (err instanceof Error && err.message.includes("deadline exceeded")) {
      throw new ScenarioFailure("B4 final-form failure: owner's true exit code was not what arbitration recorded", "assertion");
    }
    throw err;
  }
});

/**
 * B5 (#1711 P2): another application home's bridge is out of scope for doctor
 * diagnosis and containment. Uses the REAL bundled doctor CLI.
 */
const B5 = B("B5", "Doctor scope excludes bridges from other homes", "lifecycle", async (w) => {
  const homeA = w.homeA();
  await startHealthyBridgeUnderWatchdog(w, homeA);
  const homeB = w.homeB();
  const foreignBridge = await w.plantBridge(homeB, { mode: "healthy" });
  await waitForOwnedBridge(w, homeB, 15000);

  const diag = w.runDoctor(["doctor", "--json"], { ABTARS_HOME: homeA });
  const parsed = JSON.parse(diag.stdout) as { probes?: Array<{ name?: string; detail?: string }> };
  const bridgeProbe = (parsed.probes ?? []).find((p) => p.name === "bridge");
  w.expect(bridgeProbe !== undefined, "doctor --json must include a bridge probe");
  const detail = bridgeProbe?.detail ?? "";
  w.expect(
    !detail.includes(String(foreignBridge)),
    `B5 final-form failure: doctor diagnosis includes the other-home bridge PID ${foreignBridge} (detail: "${detail}")`,
  );

  // Containment boundary: whatever doctor fixes, it must not touch the foreign home.
  const fixRes = w.runDoctor(["doctor", "--fix", "--json"], { ABTARS_HOME: homeA });
  void fixRes;
  w.expect(bridgeAliveWithIdentity(w, homeB, foreignBridge), "B5 final-form failure: containment touched a bridge outside this home");
});

/**
 * B6 (#1711): a stable unowned same-home extra is contained while the
 * validated owner remains untouched. Today the watchdog has no enumeration
 * and leaves the extra alone forever.
 */
const B6 = B("B6", "Unowned same-home extra is contained", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid: owner } = await startHealthyBridgeUnderWatchdog(w, home);
  const extra = await w.plantBridge(home, { mode: "no-lock" });
  try {
    await w.expectEventually(30000, "unowned extra contained while owner preserved", () =>
      !bridgeAliveWithIdentity(w, home, extra) && bridgeAliveWithIdentity(w, home, owner),
    );
  } catch {
    throw new ScenarioFailure("B6 final-form failure: stable unowned same-home extra was not contained", "assertion");
  }
});

/** B7 (#1711): a SIGTERM-ignoring extra requires escalation to contain. */
const B7 = B("B7", "SIGTERM-ignoring extra is contained without harming the owner", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid: owner } = await startHealthyBridgeUnderWatchdog(w, home);
  const extra = await w.plantBridge(home, { mode: "ignore-term" });
  try {
    await w.expectEventually(30000, "TERM-ignoring extra contained while owner preserved", () =>
      !bridgeAliveWithIdentity(w, home, extra) && bridgeAliveWithIdentity(w, home, owner),
    );
  } catch {
    throw new ScenarioFailure("B7 final-form failure: SIGTERM-ignoring same-home extra was not contained", "assertion");
  }
});

/**
 * B8 (#1711 P5): after watchdog loss and restoration, startup reconciliation
 * removes the survivor instead of adopting it. A crash marker distinguishes
 * outage-restoration from ordinary restarts for future implementations; the
 * current implementation has no such distinction and simply adopts.
 */
const B8 = B("B8", "Outage survivor removed at startup before normal adoption", "lifecycle", async (w) => {
  const home = w.homeA();
  const survivor = await w.plantBridge(home, { mode: "healthy" });
  await waitForOwnedBridge(w, home, 15000);
  await w.startWatchdog(home);
  await w.expectEventually(20000, "watchdog adopts the survivor (pre-outage normal behavior)", () =>
    w.watchdogLogLines(home, 50).some((l) => l.includes(`Adopted existing bridge PID=${survivor}`)),
  );
  // Outage: the watchdog dies abruptly (no handoff, no durable stop).
  w.signalWatchdogProcess(home, "SIGKILL");
  await w.expectEventually(10000, "watchdog process gone after simulated outage", () => w.watchdogPidOf(home) === null);
  w.expect(bridgeAliveWithIdentity(w, home, survivor), "bridge survives the watchdog outage");

  writeFileSync(join(w.artifactsDir(), "watchdog-outage.marker"), "unclean watchdog termination\n");
  await w.startWatchdog(home); // restoration
  try {
    await w.expectEventually(25000, "startup reconciliation removes the survivor and establishes a fresh owner", () =>
      !bridgeAliveWithIdentity(w, home, survivor),
    );
  } catch {
    throw new ScenarioFailure(
      "B8 final-form failure: restored watchdog adopted the outage survivor instead of reconciling it away",
      "assertion",
    );
  }
});

/**
 * B9 (#1711 P7 / #1709): healthy steady state emits no lines; unchanged fault
 * repetition is throttled to once per fault interval while distinct events
 * stay unthrottled (that half is proven by A22 sharing this parser).
 */
const B9 = B("B9", "Fault repetition throttled; healthy state silent", "crashLoopFast", async (w) => {
  const home = w.homeA();

  // Part 1 — healthy silence across many poll cycles.
  await startHealthyBridgeUnderWatchdog(w, home);
  await w.sleep(6000);
  w.expect(w.watchdogLogLines(home, 200).length === 0, "healthy steady state must emit no watchdog log lines");

  // Part 2 — unchanged fault repetition rate.
  for (let i = 0; i < 5; i++) {
    await crashCycle(w, home, 3, 110);
  }
  await w.expectEventually(20000, "five identical-fault deaths recorded", () => {
    const deaths = w.supervisorState(home)?.recentDeaths;
    return Array.isArray(deaths) && deaths.length >= 5;
  });
  const events = parseDeathEvents(w.watchdogLogLines(home, 200)).filter((e) => e.reason.endsWith("exit=3"));
  // Final form: at most ONE line per fault interval for an unchanged fault.
  // With compressed backoff (~120ms) five identical lines land inside roughly
  // one second — far above any sane single-interval allowance.
  w.expect(
    events.length <= 1,
    `B9 final-form failure: unchanged fault repeated ${events.length}x within one fault interval (no throttle exists)`,
  );
});

/**
 * B10 (#1711 P4): additive supervisor-output metadata must not put a healthy
 * owner into permanent transient/defer. A temporary CLI shim appends one
 * additive line to validate-bridge output — exactly the future metadata path.
 * Today the positional parser rejects the extra field, validation retries
 * exhaust, and supervision defers forever (the stale kill below never fires).
 */
const B10 = B("B10", "Additive supervisor metadata keeps supervision live", "lifecycle", async (w) => {
  const home = w.homeA();
  // Install the shim BEFORE the watchdog starts: the real CLI moves aside and
  // the production resolution path picks up the shim instead.
  const bundleDir = join(home, "app", "bundle");
  const { renameSync, writeFileSync: wf, chmodSync } = await import("node:fs");
  renameSync(join(bundleDir, "abtars-supervisor-state.js"), join(bundleDir, "abtars-supervisor-state.real.js"));
  const shimPath = join(bundleDir, "abtars-supervisor-state.js");
  wf(
    shimPath,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const real = new URL("./abtars-supervisor-state.real.js", import.meta.url).pathname;
const res = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { stdio: ["ignore", "pipe", "inherit"] });
let out = res.stdout ? res.stdout.toString() : "";
if (process.argv[2] === "validate-bridge") out += "__META__ additive-validation-metadata\\n";
process.stdout.write(out);
process.exit(res.status ?? 0);
`,
  );
  chmodSync(shimPath, 0o755);

  const { pid: owner } = await startHealthyBridgeUnderWatchdog(w, home);
  // Test-validity precondition: the defer loop must be engaged.
  await w.expectEventually(20000, "shimmed validation drives the watchdog into deferred cycles", () =>
    w.watchdogLogLines(home, 50).some((l) => l.includes("Validation transient after 3 attempts")),
  );
  // Supervision must remain LIVE: a stale healthy owner must still be replaced.
  w.setControl(home, { live: { heartbeatEnabled: false, ignoreTerm: false } });
  try {
    await w.expectEventually(40000, "stale owner replaced despite additive metadata", () => !bridgeAliveWithIdentity(w, home, owner));
  } catch {
    throw new Error(
      "B10 final-form failure: additive supervisor-output metadata put healthy supervision into permanent transient/defer",
    );
  }
});

export const DEFICIENCY_SCENARIOS: readonly ScenarioDefinition[] = [
  B1, B2, B3, B4, B5, B6, B7, B8, B9, B10,
];
