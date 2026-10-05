/**
 * Harness liveness self-tests (#1914): the staleness predicate, scenario
 * lock acquire/conflict/takeover, and end-to-end stale-heartbeat fixture
 * exit through a real World.
 */
import { afterAll, describe, expect, it } from "vitest";
import { rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SuiteBuilder } from "./build.ts";
import { isHeartbeatStale, isHeartbeatRetired, HARNESS_HEARTBEAT_STALE_MS, HARNESS_HEARTBEAT_RETIRED } from "./harness-liveness.ts";
import { ProcessRegistry } from "./process-registry.ts";
import {
  World,
  acceptanceRoot,
  acquireScenarioLock,
  releaseScenarioLock,
  scenarioLockPath,
} from "./world.ts";

const REPO_ROOT = resolve(__dirname, "..", "..");
const PARENT = "wd-acc-locktest";
const touched: Array<() => void> = [];

afterAll(() => {
  for (const fn of touched.reverse()) {
    try {
      fn();
    } catch {
      // Best-effort test hygiene — never mask the suite result
    }
  }
});

describe("staleness predicate", () => {
  it("treats fresh heartbeats as live and old ones as stale", () => {
    const now = Date.now();
    expect(isHeartbeatStale(now - 1000, now, HARNESS_HEARTBEAT_STALE_MS)).toBe(false);
    expect(isHeartbeatStale(now - HARNESS_HEARTBEAT_STALE_MS + 1000, now, HARNESS_HEARTBEAT_STALE_MS)).toBe(false);
    expect(isHeartbeatStale(now - HARNESS_HEARTBEAT_STALE_MS - 1, now, HARNESS_HEARTBEAT_STALE_MS)).toBe(true);
    expect(isHeartbeatRetired(HARNESS_HEARTBEAT_RETIRED)).toBe(true);
    expect(isHeartbeatRetired("live")).toBe(false);
    expect(isHeartbeatRetired("")).toBe(false);
  });
});

describe("scenario lock", () => {
  it("acquires, refuses a live second owner, and releases", () => {
    const owner = acquireScenarioLock(PARENT, "conflict");
    touched.push(() => releaseScenarioLock(PARENT, "conflict", owner));
    expect(() => acquireScenarioLock(PARENT, "conflict")).toThrowError(/already running/);
    releaseScenarioLock(PARENT, "conflict", owner);
    const owner2 = acquireScenarioLock(PARENT, "conflict");
    releaseScenarioLock(PARENT, "conflict", owner2);
  });

  it("takes over dead and torn locks instead of blocking forever", () => {
    const deadPath = scenarioLockPath(PARENT, "dead");
    writeFileSync(deadPath, JSON.stringify({ pid: 4194303, startIdentity: "no-such-process" }));
    const owner = acquireScenarioLock(PARENT, "dead");
    expect(owner.pid).toBe(process.pid);
    releaseScenarioLock(PARENT, "dead", owner);

    const tornPath = scenarioLockPath(PARENT, "torn");
    writeFileSync(tornPath, "not-json{");
    const owner2 = acquireScenarioLock(PARENT, "torn");
    releaseScenarioLock(PARENT, "torn", owner2);
  });

  it("never releases a lock it does not own", () => {
    const owner = acquireScenarioLock(PARENT, "foreign");
    touched.push(() => releaseScenarioLock(PARENT, "foreign", owner));
    releaseScenarioLock(PARENT, "foreign", { pid: -1, startIdentity: "bogus" });
    expect(() => acquireScenarioLock(PARENT, "foreign")).toThrowError(/already running/);
  });
});

describe("stale-heartbeat fixture exit", () => {
  it("a fixture watching a stale heartbeat file exits on its own", async () => {
    const artifacts = resolve(acceptanceRoot(), "wd-acc-locktest-artifacts");
    const builder = new SuiteBuilder(REPO_ROOT, artifacts);
    builder.prepare();
    await builder.prebuild(["lifecycle"]);
    const registry = new ProcessRegistry();
    const world = new World("wd-acc-selftest", "staleexit", registry, builder, "lifecycle");
    touched.push(() => {
      world.releaseLock();
      rmSync(world.root, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
      unlinkSync(world.heartbeatFile);
    });
    // Simulate a crashed run: heartbeat file present but long untouched.
    writeFileSync(world.heartbeatFile, "stale");
    const past = new Date(Date.now() - 3600_000);
    utimesSync(world.heartbeatFile, past, past);
    const home = world.homeA();
    world.setControl(home, { defaultMode: { mode: "healthy" } });
    const pid = await world.plantBridge(home, { mode: "healthy" });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && world.procSnapshot(pid) !== null) {
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(world.procSnapshot(pid)).toBeNull();
    await registry.cleanupAll("selftest end").catch(() => undefined);
  }, 30000);

  it("a fixture whose heartbeat file is retired mid-run exits at once", async () => {
    const artifacts = resolve(acceptanceRoot(), "wd-acc-locktest-artifacts2");
    const builder = new SuiteBuilder(REPO_ROOT, artifacts);
    builder.prepare();
    await builder.prebuild(["lifecycle"]);
    const registry = new ProcessRegistry();
    const world = new World("wd-acc-selftest", "retireexit", registry, builder, "lifecycle");
    touched.push(() => {
      world.releaseLock();
      rmSync(world.root, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
      unlinkSync(world.heartbeatFile);
    });
    // A live toucher holds the file fresh while the fixture boots supervised.
    writeFileSync(world.heartbeatFile, "live");
    const home = world.homeA();
    world.setControl(home, { defaultMode: { mode: "healthy" } });
    const pid = await world.plantBridge(home, { mode: "healthy" });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !world.lock(home)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(world.procSnapshot(pid)).not.toBeNull();
    // Runner teardown retires the file (tombstone, not deletion): the
    // supervised fixture must go.
    writeFileSync(world.heartbeatFile, HARNESS_HEARTBEAT_RETIRED);
    const stop = Date.now() + 10000;
    while (Date.now() < stop && world.procSnapshot(pid) !== null) {
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(world.procSnapshot(pid)).toBeNull();
    await registry.cleanupAll("selftest end").catch(() => undefined);
  }, 30000);

  it("a fixture born into a retired heartbeat exits without side effects", async () => {
    const artifacts = resolve(acceptanceRoot(), "wd-acc-locktest-artifacts3");
    const builder = new SuiteBuilder(REPO_ROOT, artifacts);
    builder.prepare();
    await builder.prebuild(["lifecycle"]);
    const registry = new ProcessRegistry();
    const world = new World("wd-acc-selftest", "bornretired", registry, builder, "lifecycle");
    touched.push(() => {
      world.releaseLock();
      rmSync(world.root, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
      unlinkSync(world.heartbeatFile);
    });
    // Supervision already ended before this fixture boots.
    writeFileSync(world.heartbeatFile, HARNESS_HEARTBEAT_RETIRED);
    const home = world.homeA();
    world.setControl(home, { defaultMode: { mode: "healthy" } });
    const pid = await world.plantBridge(home, { mode: "healthy" });
    const stop = Date.now() + 10000;
    while (Date.now() < stop && world.procSnapshot(pid) !== null) {
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(world.procSnapshot(pid)).toBeNull();
    // Zero footprint: never claimed the lock or a generation slot.
    expect(world.lock(home)).toBeNull();
    expect(world.fixtureRegistryEntries(home)).toHaveLength(0);
    await registry.cleanupAll("selftest end").catch(() => undefined);
  }, 30000);
});
