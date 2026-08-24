/**
 * Containment executor tests (#1711 R6/R7, Phase 2). Real child processes and
 * real lock files in a temp home prove the full authorization chain; every
 * signal path revalidates identity, argv, lock, authority, and fence fresh.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const isDarwin = process.platform === "darwin";

import { processStartIdentity } from "./identity.js";
import { containCandidate, evaluateSpawnProof, readValidatedOwner } from "./reconcile-executor.js";
import type { ChildProcess } from "node:child_process";

interface Home {
  home: string;
  target: string;
  spawnBridgeChild: () => Promise<ChildProcess>;
}

async function makeHome(): Promise<Home> {
  const { spawn } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "abtars-contain-"));
  mkdirSync(join(home, "app", "bundle"), { recursive: true });
  const target = join(home, "app", "bundle", "abtars.js");
  writeFileSync(target, 'setInterval(() => {}, 10_000);\n');

  async function spawnBridgeChild(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [target], { stdio: "ignore" });
      child.on("spawn", () => resolve(child));
      child.on("error", reject);
    });
  }
  return { home, target, spawnBridgeChild };
}

const homes: Home[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) {
    rmSync(h.home, { recursive: true, force: true });
  }
});

async function register(): Promise<Home> {
  const h = await makeHome();
  homes.push(h);
  return h;
}

function waitDead(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on("exit", () => resolve());
  });
}

describe("containCandidate final authorization (#1711 R6)", () => {
  it.runIf(!isDarwin)("refuses while the transition fence is active", async () => {
    const { home } = await register();
    const candidate = await (await register()).spawnBridgeChild();
    try {
      const result = await containCandidate(home, candidate.pid!, processStartIdentity(candidate.pid!), "owner", "planned-restart");
      expect(result).toEqual({ outcome: "unauthorized", why: "transition-fence-active" });
    } finally {
      candidate.kill("SIGKILL");
      await waitDead(candidate);
    }
  }, 10000);

  it.runIf(!isDarwin)("vanishes without a signal when identity no longer matches (PID reuse guard)", async () => {
    const { home } = await register();
    // Identity string that cannot match any live process start time.
    const result = await containCandidate(home, process.pid, `${process.pid}:1`, "liveness", "stable");
    expect(result).toMatchObject({ outcome: "vanished", why: "identity-or-argv-mismatch" });
  }, 10000);

  it.runIf(!isDarwin)("contains an extra under a different validated owner via SIGTERM", async () => {
    const { home, spawnBridgeChild } = await register();
    const owner = await spawnBridgeChild();
    const extra = await spawnBridgeChild();
    try {
      writeFileSync(join(home, "bridge.lock"), JSON.stringify({
        pid: owner.pid,
        instanceId: "owner-instance",
        startIdentity: processStartIdentity(owner.pid!),
        lastHeartbeat: Date.now(),
      }));

      const result = await containCandidate(home, extra.pid!, processStartIdentity(extra.pid!), "owner", "stable");

      expect(result).toEqual({ outcome: "contained", via: "SIGTERM" });
      await waitDead(extra);
      expect(extra.signalCode ?? "SIGTERM").toBe("SIGTERM");
    } finally {
      owner.kill("SIGKILL");
      extra.kill("SIGKILL");
      await Promise.all([waitDead(owner), waitDead(extra)]);
    }
  }, 15000);

  it.runIf(!isDarwin)("refuses when the candidate IS the validated owner (owner protection)", async () => {
    const { home, spawnBridgeChild } = await register();
    const owner = await spawnBridgeChild();
    try {
      writeFileSync(join(home, "bridge.lock"), JSON.stringify({
        pid: owner.pid,
        instanceId: "owner-instance",
        startIdentity: processStartIdentity(owner.pid!),
        lastHeartbeat: Date.now(),
      }));

      const result = await containCandidate(home, owner.pid!, processStartIdentity(owner.pid!), "owner", "stable");

      expect(result).toMatchObject({ outcome: "unauthorized", why: "candidate-is-owner" });
      expect(owner.exitCode).toBeNull();
    } finally {
      owner.kill("SIGKILL");
      await waitDead(owner);
    }
  }, 10000);

  it.runIf(!isDarwin)("refuses liveness containment while the heartbeat still advances/fresh", async () => {
    const { home, spawnBridgeChild } = await register();
    const frozen = await spawnBridgeChild();
    try {
      // No validated owner (instanceId missing), but heartbeat FRESH -> not eligible.
      writeFileSync(join(home, "bridge.lock"), JSON.stringify({
        pid: frozen.pid,
        lastHeartbeat: Date.now(),
      }));

      const result = await containCandidate(home, frozen.pid!, processStartIdentity(frozen.pid!), "liveness", "stable");

      expect(result).toMatchObject({ outcome: "unauthorized", why: "liveness-not-reconfirmed" });
      expect(frozen.exitCode).toBeNull();
    } finally {
      frozen.kill("SIGKILL");
      await waitDead(frozen);
    }
  }, 10000);

  it.runIf(!isDarwin)("contains a frozen-heartbeat unowned process after reconfirmation (B11)", async () => {
    const { home, spawnBridgeChild } = await register();
    const frozen = await spawnBridgeChild();
    try {
      // Readable numeric heartbeat far beyond 2xSTALE, no validated owner.
      writeFileSync(join(home, "bridge.lock"), JSON.stringify({
        pid: frozen.pid,
        lastHeartbeat: Date.now() - 10 * 60 * 1000,
      }));

      const result = await containCandidate(home, frozen.pid!, processStartIdentity(frozen.pid!), "liveness", "stable");

      expect(result).toEqual({ outcome: "contained", via: "SIGTERM" });
      await waitDead(frozen);
    } finally {
      frozen.kill("SIGKILL");
      await waitDead(frozen);
    }
  }, 15000);
});

describe("evaluateSpawnProof — zero-process proof and the planned-replacement exception (#1711 R3, A9/A20)", () => {
  it.runIf(!isDarwin)("is inconclusive for an unusable home", async () => {
    const proof = evaluateSpawnProof("relative/home", null);
    expect(proof).toEqual({ result: "inconclusive" });
  });

  it.runIf(!isDarwin)("counts exact same-home children as occupying", async () => {
    const { home, spawnBridgeChild } = await register();
    const a = await spawnBridgeChild();
    try {
      expect(evaluateSpawnProof(home, null)).toEqual({ result: "occupied", count: 1 });
      expect(evaluateSpawnProof(home, { pid: a.pid!, startIdentity: processStartIdentity(a.pid!) }))
        .toEqual({ result: "empty" }); // only the recorded owner remains
    } finally {
      a.kill("SIGKILL");
      await waitDead(a);
    }
  }, 10000);

  it.runIf(!isDarwin)("a wrong recorded identity does NOT create the exclusion (PID reuse guard)", async () => {
    const { home, spawnBridgeChild } = await register();
    const a = await spawnBridgeChild();
    try {
      // Same PID, different start identity: no exclusion exists.
      expect(evaluateSpawnProof(home, { pid: a.pid!, startIdentity: `${a.pid}:1` }))
        .toEqual({ result: "occupied", count: 1 });
    } finally {
      a.kill("SIGKILL");
      await waitDead(a);
    }
  }, 10000);

  it.runIf(!isDarwin)("any other process vetoes the replacement even with a valid exclusion (A9/A20)", async () => {
    const { home, spawnBridgeChild } = await register();
    const owner = await spawnBridgeChild();   // recorded terminated owner
    const extra = await spawnBridgeChild();   // unknown third party
    try {
      const exclude = { pid: owner.pid!, startIdentity: processStartIdentity(owner.pid!) };
      const proof = evaluateSpawnProof(home, exclude);
      expect(proof).toEqual({ result: "occupied", count: 1 }); // the extra still vetoes
    } finally {
      owner.kill("SIGKILL");
      extra.kill("SIGKILL");
      await Promise.all([waitDead(owner), waitDead(extra)]);
    }
  }, 10000);

  it.runIf(!isDarwin)("empty home proves empty with and without an exclusion", async () => {
    const { home } = await register();
    expect(evaluateSpawnProof(home, null)).toEqual({ result: "empty" });
    expect(evaluateSpawnProof(home, { pid: 999999, startIdentity: "999999:9" })).toEqual({ result: "empty" });
  }, 10000);
});

describe("readValidatedOwner — fresh identity at the command authorization point (#1711 R3)", () => {
  it.runIf(!isDarwin)("returns the validated owner's pid and start identity", async () => {
    const { home, spawnBridgeChild } = await register();
    const owner = await spawnBridgeChild();
    try {
      writeFileSync(join(home, "bridge.lock"), JSON.stringify({
        pid: owner.pid,
        instanceId: "owner-instance",
        startIdentity: processStartIdentity(owner.pid!),
        lastHeartbeat: Date.now(),
      }));

      const ownerResult = readValidatedOwner(home);
      expect(ownerResult).toEqual({ pid: owner.pid, startIdentity: processStartIdentity(owner.pid!) });

      // A lock missing instanceId has NO validated owner -> no exception.
      writeFileSync(join(home, "bridge.lock"), JSON.stringify({
        pid: owner.pid,
        startIdentity: processStartIdentity(owner.pid!),
      }));
      expect(readValidatedOwner(home)).toBeNull();
    } finally {
      owner.kill("SIGKILL");
      await waitDead(owner);
    }
  }, 10000);

  it.runIf(!isDarwin)("returns null without any lock", async () => {
    const { home } = await register();
    expect(readValidatedOwner(home)).toBeNull();
  }, 10000);
});
