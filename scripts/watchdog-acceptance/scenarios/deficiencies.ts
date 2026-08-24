/**
 * Known-deficiency scenarios B1-B14 (#1712 Phase 0/1 contract, extended by
 * #1719: 24 A + 14 B).
 *
 * Each scenario asserts the FINAL desired behavior described by
 * `abproject/docs/plans/1712-draft-e2e-acceptance-scenarios.md` §4 (v2,
 * aligned with watchdog draft v4). On today's baseline every one of them is
 * expected to fail for its declared reason — a setup or harness failure is
 * NOT an acceptable known-fail. The manifest records the owning #1711
 * problem for each (B14 is owned by #1719 and passes once the planned-fence
 * refusal classifier is implemented).
 */
import { join } from "node:path";
import { getProfileValues } from "../build.ts";
import { ScenarioFailure } from "../world.ts";
import type { ScenarioDefinition, WorldApi } from "../contracts.ts";
import {
  bridgeAliveWithIdentity,
  commandLiveExit,
  lockLooksOwned,
  parseDeathEvents,
  sampleDuring,
  stripLockInstanceId,
  stripLockOwnership,
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

/** Wait until the watchdog log contains the given marker line fragment. */
async function waitForLogMarker(w: WorldApi, home: string, marker: string, deadlineMs: number): Promise<void> {
  await w.expectEventually(deadlineMs, `watchdog log should contain "${marker}"`, () =>
    w.watchdogLogLines(home, 100).some((l) => l.includes(marker)),
  );
}

/**
 * Stable marker of the P7 defer branch (draft v2 §B9/D5): the only place the
 * current watchdog repeats an UNCHANGED state once per poll indefinitely.
 */
const DEFER_MARKER = "Validation transient after 3 attempts";

/**
 * B1 (#1711 P7): corrupt lock plus a live tracked bridge must reach a bounded,
 * RECORDED ownership decision — per draft v2, an `ownership-inconclusive`
 * episode in durable supervisor state, exposed beyond a log line — keeping at
 * most one bridge and never looping indefinitely.
 *
 * Corruption shape (v4/B1 family): valid JSON with instanceId/startIdentity
 * removed, so `validateBridgeLock` classifies `corrupt` while the cached PID
 * stays alive.
 *
 * Today `corrupt` is missing from the watchdog's definitive status set, so
 * validation retries exhaust into `transient`, the cached-PID branch defers
 * forever, and NO episode marker, death record, or replacement ever appears.
 */
const B1 = B("B1", "Corrupt lock reaches a bounded, recorded ownership decision", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid: owner } = await startHealthyBridgeUnderWatchdog(w, home);
  await stripLockOwnership(w, home, owner);
  try {
    await w.expectEventually(15000, "bounded recorded ownership decision (episode or arbitration)", () => {
      // Final form: the durable episode marker (target implementation), or a
      // concrete arbitration outcome. Neither exists today.
      const st = w.supervisorState(home);
      if (st !== null && "ownershipEpisode" in st) return true;
      const events = parseDeathEvents(w.watchdogLogLines(home, 30));
      if (events.length > 0) return true;
      const l = w.lock(home);
      return !!l && Number(l.pid) !== owner;
    });
  } catch {
    throw new ScenarioFailure(
      "B1 final-form failure: a corrupt lock defers the watchdog indefinitely — no bounded, recorded ownership decision was reached",
      "assertion",
    );
  }
  w.expect(w.listLiveBridgesByHome(home).length <= 1, "a bounded decision must preserve at most one bridge");
});

/**
 * B2 (#1711 P3): starting a watchdog against a corrupt lock with a live
 * same-home bridge must never create a second bridge. Today adoption is
 * skipped and a duplicate bridge is spawned.
 *
 * Final form additionally requires the ownership-inconclusive state to be
 * visible through doctor//status, not only in a log line — asserted once the
 * durable field exists; the duplication below is today's declared failure.
 */
const B2 = B("B2", "Corrupt-lock startup never duplicates the live bridge", "lifecycle", async (w) => {
  const home = w.homeA();
  const planted = await w.plantBridge(home, { mode: "healthy" });
  await waitForOwnedBridge(w, home, 15000);
  await stripLockOwnership(w, home, planted);
  await w.startWatchdog(home);
  // The no-duplicate assertion must hold beyond the stale-handling horizon:
  // sample continuously for at least 2×STALE (compressed) plus margin, so a
  // duplication that only becomes possible once the corrupt cycle reaches
  // stale/death handling is still caught.
  const windowMs = 2 * getProfileValues("lifecycle").staleS * 1000 + 5000;
  const samples = await sampleDuring(w, windowMs, () => w.listLiveBridgesByHome(home).length <= 1);
  w.expect(
    samples.length > 0 && samples.every(Boolean),
    `B2 final-form failure: watchdog duplicated the live same-home bridge during the ${Math.round(windowMs / 1000)}s no-duplicate window`,
  );
  w.expect(bridgeAliveWithIdentity(w, home, planted), "the original live bridge should remain alive");
});

/**
 * B3 (#1711 P1): non-owner heartbeat writes must not keep a wedged owner
 * looking healthy. The owner is planted `stale` (initializes once, never
 * heartbeats again); a `non-owner` fixture keeps refreshing the shared field
 * through the production mutation path.
 */
const B3 = B("B3", "Non-owner heartbeat writes cannot mask a wedged owner", "staleFast", async (w) => {
  const home = w.homeA();
  const owner = await w.plantBridge(home, { mode: "stale" });
  await waitForOwnedBridge(w, home, 15000);
  await w.startWatchdog(home);
  await w.expectEventually(20000, "watchdog adopts the wedged owner", () =>
    w.watchdogLogLines(home, 50).some((l) => l.includes(`Adopted existing bridge PID=${owner}`)),
  );
  const nonOwner = await w.plantBridge(home, { mode: "non-owner" });
  void nonOwner;
  const hb1 = Number(w.lock(home)?.lastHeartbeat ?? 0);
  await w.sleep(2000);
  const hb2 = Number(w.lock(home)?.lastHeartbeat ?? 0);
  w.expect(hb2 > hb1, "test validity: non-owner writes must be actively refreshing the lock for this scenario to exercise the defect");
  try {
    await w.expectEventually(30000, "wedged owner killed despite foreign heartbeats", () => {
      const events = parseDeathEvents(w.watchdogLogLines(home, 40));
      return !bridgeAliveWithIdentity(w, home, owner) && events.some((e) => e.reason.startsWith("stale-heartbeat:"));
    });
  } catch {
    throw new ScenarioFailure(
      "B3 final-form failure: non-owner heartbeat writes keep the wedged owner looking healthy indefinitely",
      "assertion",
    );
  }
});

/**
 * B4 (#1711 P1): a non-owner's EXIT must not forge the owner's death record.
 * The non-owner self-reports exit 3 into the owner's lock and leaves; the real
 * owner is then SIGKILLed. Arbitration runs paused/resumed around the swap so
 * the forged report is deterministically the freshest value in the lock.
 */
const B4 = B("B4", "Non-owner exit cannot forge the owner's death record", "lifecycle", async (w) => {
  const home = w.homeA();
  const owner = await w.plantBridge(home, { mode: "healthy" });
  await waitForOwnedBridge(w, home, 15000);
  await w.startWatchdog(home);
  await w.expectEventually(20000, "watchdog adopts the planted owner", () =>
    w.watchdogLogLines(home, 50).some((l) => l.includes(`Adopted existing bridge PID=${owner}`)),
  );

  w.pauseWatchdog(home);
  const forger = await w.plantBridge(home, { mode: "non-owner", exitCode: 3, delayMs: 1200 });
  const forgerDeadline = Date.now() + 8000;
  while (Date.now() < forgerDeadline && bridgeAliveWithIdentity(w, home, forger)) await w.sleep(60);
  w.expect(!bridgeAliveWithIdentity(w, home, forger), "non-owner should have self-reported and exited");
  w.signalBridgeProcess(home, owner, "SIGKILL");
  const ownerDeadline = Date.now() + 8000;
  while (Date.now() < ownerDeadline && bridgeAliveWithIdentity(w, home, owner)) await w.sleep(60);
  w.resumeWatchdog(home);

  try {
    await w.expectEventually(25000, "owner death recorded", () =>
      parseDeathEvents(w.watchdogLogLines(home, 40)).some((e) => e.pid === String(owner)),
    );
    const events = parseDeathEvents(w.watchdogLogLines(home, 40));
    const ownerEvent = events.find((e) => e.pid === String(owner));
    w.expect(
      ownerEvent !== undefined && !ownerEvent.reason.includes("exit=3"),
      `B4 final-form failure: owner's death record was forged by the non-owner's exit (${ownerEvent?.reason})`,
    );
  } catch (err) {
    if (err instanceof ScenarioFailure) throw err;
    throw new ScenarioFailure("B4 final-form failure: owner's true death record was not what arbitration recorded", "assertion");
  }
});

/**
 * B5 (#1711 P2 / D4): another application home's bridge is out of scope for
 * doctor diagnosis and containment. One watchdog only (home A); uses the REAL
 * bundled doctor CLI.
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
 * validated owner remains untouched. The extra is a NON-OWNER — the orphan
 * shape that keeps writing into the owner's lock.
 */
const B6 = B("B6", "Unowned same-home extra is contained", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid: owner } = await startHealthyBridgeUnderWatchdog(w, home);
  const extra = await w.plantBridge(home, { mode: "non-owner" });
  try {
    await w.expectEventually(30000, "unowned extra contained while owner preserved", () =>
      !bridgeAliveWithIdentity(w, home, extra) && bridgeAliveWithIdentity(w, home, owner),
    );
  } catch {
    throw new ScenarioFailure("B6 final-form failure: stable unowned same-home extra was not contained", "assertion");
  }
});

/** B7 (#1711): the actual incident shape — a wedged, SIGTERM-ignoring extra. */
const B7 = B("B7", "Wedged SIGTERM-ignoring extra is contained without harming the owner", "lifecycle", async (w) => {
  const home = w.homeA();
  const { pid: owner } = await startHealthyBridgeUnderWatchdog(w, home);
  const extra = await w.plantBridge(home, { mode: "stale-ignore-term" });
  try {
    await w.expectEventually(30000, "TERM-ignoring wedged extra contained while owner preserved", () =>
      !bridgeAliveWithIdentity(w, home, extra) && bridgeAliveWithIdentity(w, home, owner),
    );
  } catch {
    throw new ScenarioFailure("B7 final-form failure: SIGTERM-ignoring same-home extra was not contained", "assertion");
  }
});

/**
 * B8 (#1711 P5 / D7): owner PLUS EXTRA after watchdog restoration is
 * reconciled — the restored watchdog contains the extra and KEEPS the
 * validated owner. The sole-survivor case is covered separately by A23;
 * there is deliberately no outage-survivor category.
 */
const B8 = B("B8", "Owner plus extra after restoration: extra contained, owner kept", "lifecycle", async (w) => {
  const home = w.homeA();
  const owner = await w.plantBridge(home, { mode: "healthy" });
  await waitForOwnedBridge(w, home, 15000);
  await w.startWatchdog(home);
  await w.expectEventually(20000, "watchdog adopts the owner", () =>
    w.watchdogLogLines(home, 50).some((l) => l.includes(`Adopted existing bridge PID=${owner}`)),
  );

  // Outage: unclean watchdog death; an orphan appears during the outage.
  w.signalWatchdogProcess(home, "SIGKILL");
  await w.expectEventually(10000, "watchdog gone after simulated outage", () => w.watchdogPidOf(home) === null);
  const extra = await w.plantBridge(home, { mode: "non-owner" });

  // Restoration (simulating launchd KeepAlive).
  await w.startWatchdog(home);
  try {
    await w.expectEventually(30000, "restored watchdog contains the extra and keeps the owner", () =>
      !bridgeAliveWithIdentity(w, home, extra) &&
      Number(w.lock(home)?.pid) === owner &&
      JSON.stringify(w.listLiveBridgesByHome(home)) === JSON.stringify([owner]),
    );
  } catch {
    throw new ScenarioFailure(
      "B8 final-form failure: restored watchdog adopted the owner but never reconciled the outage extra away",
      "assertion",
    );
  }
});

/**
 * B9 (#1711 P7, draft v2 D5): transition-only logging. Setup = the B1 world —
 * an UNCHANGED condition held for many ticks. Final form: healthy steady state
 * emits zero lines; the unchanged fault produces ONE transition/episode line
 * and then ZERO repetition lines. Distinct events stay unthrottled (A22 is the
 * mandatory counterweight). Today the defer branch logs once per
 * POLL_INTERVAL forever, which is exactly the measured failure.
 */
const B9 = B("B9", "Unchanged fault produces no repetition log lines", "crashLoopFast", async (w) => {
  const home = w.homeA();

  // Part 1 — healthy steady state emits nothing across many poll cycles.
  await startHealthyBridgeUnderWatchdog(w, home);
  await w.sleep(6000);
  w.expect(w.watchdogLogLines(home, 200).length === 0, "healthy steady state must emit no watchdog log lines");

  // Part 2 — hold the unchanged fault (corrupt ownership, live bridge).
  const owner = Number(w.lock(home)?.pid);
  await stripLockOwnership(w, home, owner);
  await w.sleep(8000); // far more than several POLL_INTERVALs under this profile
  const repetitions = w.watchdogLogLines(home, 200).filter((l) => l.includes(DEFER_MARKER));
  w.expect(
    repetitions.length <= 1,
    `B9 final-form failure: unchanged fault repeated ${repetitions.length}x across polls — transition-only logging requires at most one line, then silence`,
  );
});

/**
 * B10 (#1711 P4): additive supervisor-output metadata must not put a healthy
 * owner into permanent transient/defer. A temporary CLI shim appends one
 * additive field to validate-bridge output — exactly the future metadata path.
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
    w.watchdogLogLines(home, 50).some((l) => l.includes(DEFER_MARKER)),
  );
  // Supervision must remain LIVE: a wedged owner must still be replaced.
  w.setControl(home, { live: { heartbeatEnabled: false, ignoreTerm: false } });
  try {
    await w.expectEventually(40000, "wedged owner replaced despite additive metadata", () => !bridgeAliveWithIdentity(w, home, owner));
  } catch {
    throw new ScenarioFailure(
      "B10 final-form failure: additive supervisor-output metadata put healthy supervision into permanent transient/defer",
      "assertion",
    );
  }
});

/**
 * B11 (#1711 P7 liveness path / D7): the narrow liveness escape. A WEDGED
 * owner holds a lock whose ownership fields are corrupt while a readable
 * numeric `lastHeartbeat` stays frozen. Final form: after successful
 * enumeration, no fence, and age beyond 2×STALE, the wedged process is
 * contained graceful-first and exactly one fresh bridge is spawned only after
 * enumeration proves none remain. Paired with B2, which proves a HEALTHY
 * unprovable process is not signalled.
 *
 * Today the corrupt path defers indefinitely BEFORE stale handling, so the
 * frozen heartbeat is never acted on.
 */
const B11 = B("B11", "Frozen-heartbeat liveness containment under unprovable ownership", "staleFast", async (w) => {
  const home = w.homeA();
  const wedged = await w.plantBridge(home, { mode: "stale" }); // init once, silent forever
  await waitForOwnedBridge(w, home, 15000);
  const frozenHb = Number(w.lock(home)?.lastHeartbeat ?? 0);
  await stripLockOwnership(w, home, wedged);
  await w.startWatchdog(home);
  await w.sleep(3000); // let it settle into its cycle

  const observedHb = Number(w.lock(home)?.lastHeartbeat ?? 0);
  w.expect(observedHb === frozenHb, "test validity: heartbeat must stay frozen under the corrupt lock");

  try {
    await w.expectEventually(30000, "wedged unprovable process contained and replaced by exactly one fresh bridge", () => {
      const live = w.listLiveBridgesByHome(home);
      return !bridgeAliveWithIdentity(w, home, wedged) && live.length === 1 && live[0] !== wedged;
    });
  } catch {
    throw new ScenarioFailure(
      "B11 final-form failure: corrupt lock plus frozen heartbeat defers forever — the liveness escape never contains the wedged process",
      "assertion",
    );
  }
});

/**
 * B12 (#1711 P2 literal-argv identity / D7): an old-release survivor remains
 * in scope across an update fence. The identity predicate is the LITERAL argv
 * target `$ABTARS_HOME/app/bundle/abtars.js` — release-invariant through the
 * stable `app` symlink — so a survivor from r1 is still classified after
 * `current` repoints to r2, contained after the fence clears, and exactly one
 * r2 bridge remains. A resolved-path predicate would make the survivor
 * invisible and recreate the update-triggered orphan hole.
 *
 * Today there is no reconciliation at all, so both processes persist.
 */
const B12 = B("B12", "Old-release survivor remains in scope after an update fence", "lifecycle", async (w) => {
  const home = w.homeWithReleases();
  w.setControl(home, { defaultMode: { mode: "healthy" } });

  // Healthy bridge from r1 that ignores SIGTERM — it survives the update's
  // planned termination, creating the activation overlap.
  const oldRelease = await w.plantBridge(home, { mode: "ignore-term" });
  await waitForOwnedBridge(w, home, 15000);
  w.expect(Number(w.lock(home)?.pid) === oldRelease, "r1 bridge should own the lock");

  await w.startWatchdog(home);
  await waitForLogMarker(w, home, `Adopted existing bridge PID=${oldRelease}`, 20000);

  // Publish the update; the TERM is ignored, so the watchdog acks, resets, and
  // respawns a second bridge — the overlap window. Repoint mid-window.
  const seq = w.supervisorCli(home, ["publish-command", "update", "acceptance-b12"]);
  w.expect(seq.code === 0, "publish-command update failed");
  await waitForLogMarker(w, home, "Planned bridge restart: command=update", 25000);
  w.repointRelease(home, "r2");

  // During the fence neither process may be signalled.
  const fenceSamples: boolean[] = [];
  await w.expectEventually(20000, "overlap resolves into two live processes (old + respawned)", () => {
    const live = w.listLiveBridgesByHome(home);
    const oldAlive = bridgeAliveWithIdentity(w, home, oldRelease);
    fenceSamples.push(oldAlive);
    return live.length >= 2 && oldAlive;
  });
  w.expect(fenceSamples.every(Boolean), "old-release bridge must not be signalled during the transition fence");

  // Post-fence stability window: the old-release survivor is contained and
  // exactly one bridge remains.
  await w.sleep(8000);
  try {
    await w.expectEventually(30000, "old-release survivor contained; exactly one bridge remains", () => {
      const live = w.listLiveBridgesByHome(home);
      return !bridgeAliveWithIdentity(w, home, oldRelease) && live.length === 1;
    });
  } catch {
    const live = w.listLiveBridgesByHome(home);
    throw new ScenarioFailure(
      `B12 final-form failure: old-release survivor ignored after the update fence (${live.length} bridges still alive)`,
      "assertion",
    );
  }
});

/**
 * B13 (#1711 R2.1 attribution / v5): a legacy relative-spelled process
 * (`app/bundle/abtars.js`) must block the spawn LOUDLY — never a silent
 * supervision freeze. The harness runs on Linux, where `/proc/<pid>/cwd`
 * essentially always answers, so the TRUE `unattributable` arm (cwd unreadable)
 * is structurally CI-invisible here; it is unit-tested with a mocked
 * readlink/lsof and gated by the macOS host-smoke precondition. What the
 * harness DOES prove end-to-end:
 *   1. lock-first attribution: a relative process named by bridge.lock (pid +
 *      matching start identity, instanceId stripped so adoption is skipped)
 *      is THIS home's bridge without any cwd read — the spawn is withheld and
 *      the watchdog log names the cause;
 *   2. loudness: the block is logged, the watchdog keeps running, doctor
 *      reports the blocker by PID — never a healthy claim and never silence;
 *   3. other-home precision: a relative process whose cwd is ANOTHER home does
 *      NOT block this home's watchdog from spawning its own bridge.
 *
 * Baseline: no attribution exists, so the duplicate or a silent indefinite
 * hold is the failure mode this scenario guards.
 */
const B13 = B("B13", "Legacy relative-spelled process blocks loudly, never silently", "lifecycle", async (w) => {
  const home = w.homeA();
  const otherHome = w.homeB();

  // Case 1 — other-home precision: a relative fixture living in homeB must not
  // block homeA's watchdog. The watchdog spawns exactly one bridge for homeA.
  const foreign = await w.plantRelativeBridge(otherHome, { mode: "no-lock" }, otherHome);
  await w.startWatchdog(home);
  await waitForOwnedBridge(w, home, 25000);
  const homeABridge = Number(w.lock(home)?.pid);
  w.expect(Number.isFinite(homeABridge) && homeABridge > 0 && homeABridge !== foreign,
    "B13 final-form failure: homeA watchdog did not spawn its own bridge beside a relative process in another home");
  w.expect(bridgeAliveWithIdentity(w, otherHome, foreign),
    "B13 final-form failure: the foreign relative process must never be signalled or adopted");
  await w.stopWatchdogGracefully(home);
  w.signalBridgeProcess(home, homeABridge, "SIGKILL");
  await w.expectEventually(10000, "homeA bridge reaped after scenario cleanup", () =>
    !bridgeAliveWithIdentity(w, home, homeABridge),
  );

  // Case 2 — lock-first attribution + loud block: a relative process in THIS
  // home owns a lock whose pid/startIdentity match but whose instanceId was
  // stripped (corrupt for adoption). The lock alone must attribute it to this
  // home; the spawn must be withheld with a named cause.
  //
  // The fixture is STALE-shaped: it writes the lock exactly once at startup and
  // never heartbeats again, so no in-flight read-merge-write can restore the
  // stripped instanceId (a live heartbeat fixture races the strip and flips
  // the lock back to adoptable). The freeze-strip below is then deterministic.
  const relLock = await w.plantRelativeBridge(home, { mode: "stale" }, home);
  // Wait for THIS fixture's lock specifically: the case-1 bridge's stale lock
  // (dead, possibly a zombie) still sits in the home and would otherwise match
  // a generic owned-lock wait, making the strip hit the wrong lock.
  await w.until(`relative fixture ${relLock} owns the lock`, 15000, () => {
    const l = w.lock(home);
    if (l === null || Number(l.pid) !== relLock) return false;
    const snap = w.procSnapshot(relLock);
    return snap !== null && snap.state !== "Z";
  });
  await stripLockInstanceId(w, home, relLock);

  await w.startWatchdog(home);
  await waitForLogMarker(w, home, "Spawn withheld", 25000);
  w.expect(bridgeAliveWithIdentity(w, home, relLock),
    "B13 final-form failure: the blocked relative process must be left untouched (observe, never signal)");
  await w.sleep(5000);
  const live = w.listLiveBridgesByHome(home);
  w.expect(live.length === 1 && live[0] === relLock,
    `B13 final-form failure: watchdog duplicated the live relative bridge (${live.join(",")})`);
  w.expect(w.watchdogPidOf(home) !== null,
    "B13 final-form failure: the watchdog must keep running (a silent freeze is a defect)");

  // Case 3 — doctor surfaces the blocker by PID: never a healthy claim.
  const diag = w.runDoctor(["doctor", "--json"], { ABTARS_HOME: home });
  const parsed = JSON.parse(diag.stdout) as { layers?: Record<string, Array<{ name?: string; detail?: string; status?: string }>> };
  const bridgeProbe = Object.values(parsed.layers ?? {}).flat().find((p) => p.name === "bridge");
  w.expect(bridgeProbe !== undefined, "doctor --json must include a bridge probe");
  const detail = bridgeProbe?.detail ?? "";
  w.expect(
    bridgeProbe?.status === "warning" && detail.includes(String(relLock)),
    `B13 final-form failure: doctor does not report the relative blocker by PID (status=${bridgeProbe?.status} detail="${detail}")`,
  );
});

/**
 * B14 (#1719): a boot-gate refusal during a planned transition fence is a
 * PLANNED outcome, not an unplanned bridge death. The predecessor ignores
 * SIGTERM and keeps serving; each authorized replacement hits the production
 * duplicate gate and exits without ever writing its own instanceId. Final
 * form: refusals emit no death accounting (no "Bridge died", restartCount /
 * recentDeaths / backoffAttempt untouched), attempts are bounded at three per
 * fence, exactly one stable transition-failed episode names the predecessor
 * PID, the validated predecessor is ADOPTED as the monitored bridge (its PID
 * stays the lock owner and is never re-detected as process-gone), and the
 * abandoned transition is visible through doctor//status — while a later
 * release still lets a final replacement settle and clears the diagnostic
 * latch (no permanent hidden hold).
 *
 * Baseline: the refusal IS recorded as process-gone, so the very first
 * final-form assertion fails.
 */
const B14 = B("B14", "Boot-gate refusal during a fence is not a death; bounded and adopted", "lifecycle", async (w) => {
  const home = w.homeA();
  const pred = await w.plantBridge(home, { mode: "ignore-term" });
  await waitForOwnedBridge(w, home, 15000);
  await w.startWatchdog(home);
  await waitForLogMarker(w, home, `Adopted existing bridge PID=${pred}`, 20000);

  // Schedule THREE replacement modes: each spawned child mirrors the
  // duplicate gate, validates the still-alive owner, and exits 1 without
  // writing an instanceId.
  const firstGeneration = w.claimNextGeneration(home);
  w.setControl(home, {
    nextSpawns: [0, 1, 2].map((n) => ({ generation: firstGeneration + n, mode: "refuse-duplicate" as const })),
  });
  const pub = w.supervisorCli(home, ["publish-command", "restart", "acceptance-b14"]);
  w.expect(pub.code === 0, `publish-command restart failed: ${pub.stderr}`);

  const refusalAttempts = () =>
    w.fixtureRegistryEntries(home).filter((e) => e.mode === "refuse-duplicate").length;
  const logLines = () => w.watchdogLogLines(home, 200);

  // Bound reached: three attempts, one transition-failed episode naming the
  // predecessor PID, adoption of the predecessor as the monitored bridge.
  await w.expectEventually(60000, "three refusal attempts exhausted the budget with one transition-failed episode", () => {
    const lines = logLines();
    return (
      refusalAttempts() === 3 &&
      lines.some((l) => l.includes("Transition failed:") && l.includes(`PID=${pred}`)) &&
      lines.filter((l) => l.includes(`Adopted existing bridge PID=${pred}`)).length >= 2
    );
  });

  // No unplanned accounting anywhere: the refusals never become deaths.
  const deaths = parseDeathEvents(logLines());
  w.expect(deaths.length === 0, `planned refusals must not produce death events (found ${JSON.stringify(deaths)})`);
  const st = w.supervisorState(home);
  const recentDeaths = (st?.recentDeaths as readonly unknown[] | undefined) ?? [];
  w.expect(recentDeaths.length === 0, `recentDeaths must stay empty under pure refusals (got ${JSON.stringify(st?.recentDeaths)})`);
  w.expect(Number(st?.restartCount) === 0, `restartCount must stay 0 under pure refusals (got ${String(st?.restartCount)})`);
  w.expect(Number(st?.backoffAttempt) === 0, `backoffAttempt must stay 0 under pure refusals (got ${String(st?.backoffAttempt)})`);

  // Terminal state (R4.1): the predecessor is adopted — it remains the lock
  // owner, keeps serving, and is NOT re-detected as process-gone on
  // subsequent ticks. Exactly one transition-failed line (no repetition).
  await w.sleep(3000);
  w.expect(Number(w.lock(home)?.pid) === pred, `the validated predecessor must be the monitored bridge after exhaustion (lock pid=${String(w.lock(home)?.pid)})`);
  w.expect(bridgeAliveWithIdentity(w, home, pred), "the adopted predecessor must still be alive");
  w.expect(
    logLines().filter((l) => l.includes("Transition failed:")).length === 1,
    "transition-failed is transition-level logging: unchanged state must not repeat it",
  );

  // The abandoned transition must be reported through doctor//status with the
  // predecessor PID — a healthy bridge plus a failed transition is not a
  // healthy transition (no hidden health claim).
  const diag = w.runDoctor(["doctor", "--json"], { ABTARS_HOME: home });
  const parsed = JSON.parse(diag.stdout) as { layers?: Record<string, Array<{ name?: string; detail?: string; status?: string }>> };
  const watchdogProbe = Object.values(parsed.layers ?? {}).flat().find((p) => p.name === "watchdog");
  w.expect(
    watchdogProbe?.status === "warning" && (watchdogProbe?.detail ?? "").includes(String(pred)) &&
      (watchdogProbe?.detail ?? "").includes("transition-failed"),
    `abandoned transition must be visible in doctor//status (status=${watchdogProbe?.status} detail="${watchdogProbe?.detail}")`,
  );

  // Release the predecessor: a final replacement can now start and settle,
  // which also proves post-fence deaths still count normally and the
  // diagnostic latch clears without leaving a permanent hold.
  commandLiveExit(w, home, { code: 7, delayMs: 50 });
  await w.expectEventually(45000, "final replacement settles after the predecessor is released", () => {
    const l = w.lock(home);
    return !!l && Number(l.pid) !== pred && !bridgeAliveWithIdentity(w, home, pred) &&
      lockLooksOwned(l) && bridgeAliveWithIdentity(w, home, Number(l.pid));
  });
  await w.expectEventually(45000, "diagnostic latch cleared once a different owner settles", () => {
    const d = w.runDoctor(["doctor", "--json"], { ABTARS_HOME: home });
    const parsed2 = JSON.parse(d.stdout) as { layers?: Record<string, Array<{ name?: string; status?: string }>> };
    const probe2 = Object.values(parsed2.layers ?? {}).flat().find((p) => p.name === "watchdog");
    return probe2?.status === "ok";
  });
});

export const DEFICIENCY_SCENARIOS: readonly ScenarioDefinition[] = [
  B1, B2, B3, B4, B5, B6, B7, B8, B9, B10, B11, B12, B13, B14,
];
