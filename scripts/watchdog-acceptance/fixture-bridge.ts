/**
 * Controllable fixture bridge (#1712 Phase 0).
 *
 * Bundled by build.ts into the artifact the harness places at
 * <home>/app/bundle/abtars.js — the exact production watchdog spawn target.
 * It is a deterministic protocol actor, NOT a replacement for full bridge
 * startup: assertions must never infer boot-graph health from it.
 *
 * Protocol boundary:
 * - Owner modes initialize the singleton lock through the PRODUCTION
 *   initBridgeLock and heartbeat through the PRODUCTION updateLastHeartbeat;
 * - The non-owner mode deliberately reproduces the ownership defect by calling
 *   the production field-mutation path against another owner's lock without
 *   initializing its own — including an optional delayed self-reporting exit
 *   whose fresh report outlives the non-owner (the B4 forgery shape);
 * - Exit modes self-report code/time through the bridge-lock mutation boundary
 *   available to any bridge process today. When production centralizes gated
 *   exit recording, this fixture must import that function instead of keeping
 *   a private copy.
 *
 * Control model: the harness atomically replaces <home>/fixture-control.json.
 * Every spawn claims a generation slot under <home>/fixture-generation/ and
 * consumes a matching nextSpawns entry, falling back to defaultMode. Live
 * heartbeat/termination flags are polled at a bounded cadence so the harness
 * can stop heartbeats without restarting the process (direct plants included).
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  initBridgeLock,
  updateLastHeartbeat,
  updateBridgeLockField,
} from "../../src/components/transport/bridge-lock-transport.js";

interface FixtureMode {
  mode: string;
  exitCode?: number;
  delayMs?: number;
  forgedExitCode?: number;
  forgedExitAgeMs?: number;
}

interface LiveExit {
  code: number;
  delayMs?: number;
  staleReport?: boolean;
  seq?: number;
}

interface LiveControl {
  heartbeatEnabled: boolean;
  ignoreTerm: boolean;
  exit?: LiveExit | null;
}

interface ControlFile {
  defaultMode: FixtureMode;
  nextSpawns: Array<{ generation: number } & FixtureMode>;
  heartbeatMs: number;
  live: LiveControl;
}

const home = process.env.ABTARS_HOME ?? join(process.env.HOME ?? "", ".abtars");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readControl(): ControlFile | null {
  try {
    return JSON.parse(readFileSync(join(home, "fixture-control.json"), "utf-8")) as ControlFile;
  } catch {
    return null;
  }
}

/** Atomically claim the next free generation slot (exclusive-create loop). */
function claimGeneration(): number {
  const dir = join(home, "fixture-generation");
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 10000; n++) {
    try {
      closeSync(openSync(join(dir, `${n}.claim`), "wx"));
      return n;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("generation space exhausted");
}

function writeRegistryEntry(generation: number, mode: FixtureMode): void {
  const dir = join(home, "fixture-registry");
  mkdirSync(dir, { recursive: true });
  const entry = { pid: process.pid, generation, mode: mode.mode, startedAt: Date.now() };
  const finalPath = join(dir, `${generation > 0 ? generation : "direct"}-${process.pid}.json`);
  const tmp = `${finalPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry));
  renameSync(tmp, finalPath);
}

async function main(): Promise<void> {
  const directRaw = process.env.ABTARS_FIXTURE_DIRECT;
  const direct: FixtureMode | null = directRaw ? (JSON.parse(directRaw) as FixtureMode) : null;
  const control = readControl();
  const heartbeatMs = control?.heartbeatMs ?? 200;

  const generation = claimGeneration();
  const scheduled = control?.nextSpawns.find((s) => s.generation === generation);
  const mode: FixtureMode = direct ?? scheduled ?? control?.defaultMode ?? { mode: "healthy" };
  writeRegistryEntry(generation, mode);

  // Initial live-control values. A stale-shaped MODE never heartbeats at
  // startup regardless of how it was spawned; the live section may only
  // enable heartbeats for non-stale shapes.
  const staleShaped = mode.mode === "stale" || mode.mode === "stale-ignore-term";
  const termIgnoringShaped = mode.mode === "ignore-term" || mode.mode === "stale-ignore-term";
  let heartbeatEnabled = !staleShaped && (direct ? true : (control?.live.heartbeatEnabled ?? true));
  let ignoreTerm = direct ? termIgnoringShaped : (control?.live.ignoreTerm ?? false);

  if (ignoreTerm) {
    // Empty handlers keep the process alive through SIGTERM/SIGINT.
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
  }

  const ownsLock = !["no-lock", "non-owner", "transient"].includes(mode.mode);
  if (ownsLock) {
    initBridgeLock({
      pid: process.pid,
      startedAt: Date.now(),
      version: "fixture-bridge",
      argv: [process.execPath, "app/bundle/abtars.js"],
      startReason: "watchdog-respawn",
    });
    updateLastHeartbeat();
  }

  const startedAt = Date.now();
  // `exit` modes self-report and leave; a `non-owner` with delayMs self-reports
  // its own code into whatever lock exists before leaving (the B4 forgery
  // shape: the report outlives the non-owner and is fresh when the real owner
  // dies).
  const scheduledExit =
    mode.mode === "exit" || (mode.mode === "non-owner" && mode.delayMs !== undefined);
  const exitAfterMs = scheduledExit ? (mode.delayMs ?? 250) : null;

  let lastLivePoll = 0;
  let reported = false;
  let liveExit: { code: number; at: number; staleReport: boolean } | null = null;

  /**
   * Consume-and-clear protocol: capturing a live-exit command atomically
   * REMOVES it from the control file, so a respawned successor can never
   * execute its predecessor's leftover command. The consumer is always the
   * process that is about to exit, so the brief writer overlap is harmless.
   */
  function clearConsumedExit(): void {
    const p = join(home, "fixture-control.json");
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as ControlFile;
      if (parsed.live.exit === null || parsed.live.exit === undefined) return;
      const cleared: ControlFile = { ...parsed, live: { ...parsed.live, exit: null } };
      const tmp = `${p}.clearing`;
      writeFileSync(tmp, JSON.stringify(cleared));
      renameSync(tmp, p);
    } catch { /* harness rewrote it concurrently — nothing to clear */ }
  }
  while (true) {
    const now = Date.now();

    // Bounded live-control cadence (never tighter than 50ms).
    if (now - lastLivePoll >= 100) {
      lastLivePoll = now;
      const liveControl = readControl()?.live;
      if (liveControl) {
        heartbeatEnabled = !staleShaped && liveControl.heartbeatEnabled;
        // Termination handlers cannot be detached once installed; live
        // ignoreTerm only ever escalates coverage for control-file spawns.
        if (!direct) ignoreTerm = liveControl.ignoreTerm;
        const cmd = liveControl.exit;
        if (cmd && liveExit === null) {
          liveExit = {
            code: cmd.code,
            at: Date.now() + (cmd.delayMs ?? 0),
            staleReport: cmd.staleReport === true,
          };
          clearConsumedExit();
        }
      }
      if (!ownsLock && mode.mode !== "non-owner") heartbeatEnabled = false;
    }

    switch (mode.mode) {
      case "non-owner":
        // Ownership defect: refresh ANOTHER owner's heartbeat without holding
        // the lock ourselves.
        updateLastHeartbeat();
        break;
      default:
        break;
    }
    if (ownsLock && heartbeatEnabled) updateLastHeartbeat();

    const dueScheduled = exitAfterMs !== null && now - startedAt >= exitAfterMs;
    const dueLive = liveExit !== null && now >= liveExit.at;
    if ((dueScheduled || dueLive) && !reported) {
      reported = true;
      const code = dueLive ? liveExit!.code : (mode.exitCode ?? 0);
      updateBridgeLockField("lastExitCode", code);
      updateBridgeLockField("lastExitAt", Date.now());
      process.exit(code);
    }

    await sleep(Math.max(50, Math.min(heartbeatMs, 100)));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`fixture-bridge fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(70);
});
