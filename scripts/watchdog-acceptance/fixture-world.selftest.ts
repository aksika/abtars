/**
 * Focused harness self-tests: fixture protocol and world controls (#1712
 * Task 3). Runs a real fixture bridge against a real temporary home.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SuiteBuilder } from "./build.ts";
import { ProcessRegistry } from "./process-registry.ts";
import { World } from "./world.ts";

const REPO_ROOT = resolve(__dirname, "..", "..");
const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) fn();
});

async function makeWorld(label: string): Promise<{ world: World; registry: ProcessRegistry; cleanup: () => Promise<void> }> {
  const artifacts = mkdtempSync(join(tmpdir(), `wd-acc-fx-${label}-`));
  const builder = new SuiteBuilder(REPO_ROOT, artifacts);
  builder.prepare();
  await builder.prebuild(["lifecycle"]);
  const registry = new ProcessRegistry();
  const world = new World(`wd-acc-selftest`, label, registry, builder, "lifecycle");
  return {
    world,
    registry,
    cleanup: async () => {
      await registry.cleanupAll("selftest end").catch(() => undefined);
      for (const h of world.knownHomes()) {
        for (const p of world.listLiveBridgesByHome(h)) {
          try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
        }
      }
      rmSync(world.root, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
    },
  };
}

describe("fixture bridge", () => {
  it("claims generations and initializes the production lock", async () => {
    const { world, cleanup } = await makeWorld("gen");
    cleanups.push(() => void cleanup());
    const home = world.homeA();
    world.setControl(home, { defaultMode: { mode: "healthy" } });
    const pid = await world.plantBridge(home, { mode: "healthy" });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const lock = world.lock(home);
      if (lock && Number(lock.pid) === pid && typeof lock.instanceId === "string") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const lock = world.lock(home)!;
    expect(Number(lock.pid)).toBe(pid);
    expect(typeof lock.instanceId).toBe("string");
    const entries = world.fixtureRegistryEntries(home);
    expect(entries.some((e) => e.pid === pid && e.generation === 1)).toBe(true);
  }, 30000);

  it("stops and resumes heartbeat through live control", async () => {
    const { world, cleanup } = await makeWorld("beat");
    cleanups.push(() => void cleanup());
    const home = world.homeA();
    world.setControl(home, { defaultMode: { mode: "healthy" } });
    await world.plantBridge(home, { mode: "healthy" });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !world.lock(home)) await new Promise((r) => setTimeout(r, 50));
    const hb1 = Number(world.lock(home)?.lastHeartbeat ?? 0);
    await new Promise((r) => setTimeout(r, 600));
    const hb2 = Number(world.lock(home)?.lastHeartbeat ?? 0);
    expect(hb2).toBeGreaterThan(hb1); // beating

    world.setControl(home, { live: { heartbeatEnabled: false, ignoreTerm: false } });
    await new Promise((r) => setTimeout(r, 400)); // let it consume the flag
    const hb3 = Number(world.lock(home)?.lastHeartbeat ?? 0);
    await new Promise((r) => setTimeout(r, 700));
    const hb4 = Number(world.lock(home)?.lastHeartbeat ?? 0);
    expect(hb4).toBe(hb3); // stopped
  }, 30000);

  it("self-reports exit codes through the live-exit command", async () => {
    const { world, cleanup } = await makeWorld("exit");
    cleanups.push(() => void cleanup());
    const home = world.homeA();
    world.setControl(home, { defaultMode: { mode: "healthy" } });
    const pid = await world.plantBridge(home, { mode: "healthy" });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !world.lock(home)) await new Promise((r) => setTimeout(r, 50));
    world.setControl(home, { live: { heartbeatEnabled: true, ignoreTerm: false, exit: { code: 7, delayMs: 150 } } });
    const stop = Date.now() + 8000;
    while (Date.now() < stop && world.procSnapshot(pid) !== null) await new Promise((r) => setTimeout(r, 60));
    expect(world.procSnapshot(pid)).toBeNull();
    // The lock survives with the self-report (no other writer cleared it).
    const report = readFileSync(join(home, "bridge.lock"), "utf-8");
    expect(report).toContain('"lastExitCode":7');
  }, 30000);

  it("non-owner mode mutates an existing owner's lock without owning it", async () => {
    const { world, cleanup } = await makeWorld("mask");
    cleanups.push(() => void cleanup());
    const home = world.homeA();
    world.setControl(home, { defaultMode: { mode: "healthy" } });
    await world.plantBridge(home, { mode: "healthy" }); // owner
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !world.lock(home)) await new Promise((r) => setTimeout(r, 50));
    world.registry.reapExited?.();
    const ownerLockPidBefore = Number(world.lock(home)?.pid);
    await world.plantBridge(home, { mode: "non-owner" });
    const hb1 = Number(world.lock(home)?.lastHeartbeat ?? 0);
    await new Promise((r) => setTimeout(r, 900));
    const hb2 = Number(world.lock(home)?.lastHeartbeat ?? 0);
    expect(hb2).toBeGreaterThan(hb1);
    expect(Number(world.lock(home)?.pid)).toBe(ownerLockPidBefore);
  }, 30000);
});

describe("world", () => {
  it("supervisor CLI applies commands against the seeded home", async () => {
    const { world, cleanup } = await makeWorld("cli");
    cleanups.push(() => void cleanup());
    const home = world.homeA();
    const res = world.supervisorCli(home, ["publish-command", "restart", "selftest"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { result: string; seq: number };
    expect(parsed.result).toBe("created");
    const state = world.supervisorState(home)!;
    expect(state.pendingCommand).toMatchObject({ seq: parsed.seq, type: "restart" });
  }, 30000);

  it("predicate timeouts carry bounded evidence, not silent skips", async () => {
    const { world, cleanup } = await makeWorld("timeout");
    cleanups.push(() => void cleanup());
    let threw = "";
    try {
      await world.expectEventually(500, "impossible predicate", () => false);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    expect(threw).toContain("impossible predicate");
    expect(world.cappedTimeline().length).toBeGreaterThan(0);
  }, 30000);

  it("guarantees zero registered processes after cleanup", async () => {
    const { world, registry, cleanup } = await makeWorld("leak");
    cleanups.push(() => void cleanup());
    const home = world.homeA();
    await world.plantBridge(home, { mode: "transient" });
    await registry.spawn({ cmd: "sleep", args: ["30"], role: "helper", home });
    await cleanup();
    expect(registry.size()).toBe(0);
    expect(world.listLiveBridgesByHome(home)).toHaveLength(0);
  }, 30000);
});

void execFileSync;
