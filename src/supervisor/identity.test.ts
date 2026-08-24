import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));
// Partial fs mock: readlinkSync stays a delegating spy so the R2.1
// cwd-unreadable arm is testable on Linux (the macOS lsof branch is exercised
// through the child_process mock above).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readlinkSync: vi.fn((p: Parameters<typeof actual.readlinkSync>[0]) => actual.readlinkSync(p)),
  };
});

import {
  processStartIdentity,
  isPidAlive,
  validateBridgePid,
  validateBridgeLock,
  spawnTarget,
  enumerateBridgeProcesses,
  potentialHomeBridgeProcesses,
  type BridgeProcess,
} from "./identity.js";
import { readlinkSync } from "node:fs";

const SELF_PID = process.pid;
const SELF_IDENTITY = processStartIdentity(SELF_PID);

describe("macOS process identity", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true, writable: true });
    execFileSyncMock.mockReset();
  });

  it("rejects a reused system PID by its ps command", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[3] === "lstart=") return "Sat Aug 22 02:00:00 2026\n";
      return "/usr/libexec/AssetCache/AssetCache\n";
    });

    const result = validateBridgePid(SELF_PID, processStartIdentity(SELF_PID), ["abtars.js", "bundle"]);

    expect(result.status).toBe("wrong-command");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });

  it("accepts a live bridge identified by ps", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[3] === "lstart=") return "Sat Aug 22 02:00:00 2026\n";
      return "/opt/homebrew/bin/node /Users/akos/.abtars/app/bundle/abtars.js\n";
    });

    const result = validateBridgePid(SELF_PID, processStartIdentity(SELF_PID), ["abtars.js", "bundle"]);

    expect(result.status).toBe("valid");
    expect(result.safeToSignal).toBe(true);
    expect(result.safeToAdopt).toBe(true);
  });

  it("rejects an uninspectable macOS PID", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    execFileSyncMock.mockImplementation(() => { throw new Error("ps unavailable"); });

    const result = validateBridgePid(SELF_PID, null, ["abtars.js", "bundle"]);

    expect(result.status).toBe("wrong-command");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });
});

describe("processStartIdentity", () => {
  it("returns a string with pid:starttime for a live process", () => {
    const id = processStartIdentity(SELF_PID);
    expect(id).toMatch(/^\d+:\d+$/);
    expect(id.startsWith(`${SELF_PID}:`)).toBe(true);
  });

  it("returns pid:0 for a nonexistent PID", () => {
    const id = processStartIdentity(999_999_999);
    expect(id).toBe("999999999:0");
  });
});

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(SELF_PID)).toBe(true);
  });

  it("returns false for a nonexistent PID", () => {
    expect(isPidAlive(999_999_999)).toBe(false);
  });
});

describe("validateBridgePid", () => {
  it("returns valid for a live process matching identity and needle", () => {
    const result = validateBridgePid(SELF_PID, SELF_IDENTITY, ["node"]);
    expect(result.status).toBe("valid");
    expect(result.safeToSignal).toBe(true);
    expect(result.safeToAdopt).toBe(true);
  });

  it("returns dead for a nonexistent PID", () => {
    const result = validateBridgePid(999_999_999, null, ["node"]);
    expect(result.status).toBe("dead");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });

  it("returns reused for identity mismatch on a live PID", () => {
    const result = validateBridgePid(SELF_PID, "999999999:999", ["node"]);
    expect(result.status).toBe("reused");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });

  it("returns wrong-command when no needle matches", () => {
    const result = validateBridgePid(SELF_PID, SELF_IDENTITY, [
      "this-cmdline-needle-will-never-match-anything",
    ]);
    expect(result.status).toBe("wrong-command");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });

  it("returns valid when expectedIdentity is null (trusts lock)", () => {
    const result = validateBridgePid(SELF_PID, null, ["node"]);
    expect(result.status).toBe("valid");
  });
});

describe("validateBridgeLock", () => {
  const needle = ["node"];

  it("returns corrupt for null lock", () => {
    const result = validateBridgeLock(null, needle);
    expect(result.status).toBe("corrupt");
    expect(result.safeToSignal).toBe(false);
    expect(result.safeToAdopt).toBe(false);
  });

  it("returns corrupt for missing instanceId", () => {
    const result = validateBridgeLock(
      { pid: SELF_PID, startIdentity: SELF_IDENTITY },
      needle,
    );
    expect(result.status).toBe("corrupt");
  });

  it("returns dead for pid=null", () => {
    const result = validateBridgeLock(
      { pid: null, instanceId: "abc", startIdentity: null },
      needle,
    );
    expect(result.status).toBe("dead");
  });

  it("returns dead for pid <= 0", () => {
    const result = validateBridgeLock(
      { pid: 0, instanceId: "abc", startIdentity: null },
      needle,
    );
    expect(result.status).toBe("dead");
  });

  it("returns valid for a complete matching lock", () => {
    const result = validateBridgeLock(
      {
        pid: SELF_PID,
        instanceId: "abc",
        startIdentity: SELF_IDENTITY,
      },
      needle,
    );
    expect(result.status).toBe("valid");
    expect(result.safeToSignal).toBe(true);
    expect(result.safeToAdopt).toBe(true);
  });

  it("returns reused when pid identity does not match", () => {
    const result = validateBridgeLock(
      {
        pid: SELF_PID,
        instanceId: "abc",
        startIdentity: "999999999:999",
      },
      needle,
    );
    expect(result.status).toBe("reused");
  });

  it("returns wrong-command when no needle matches", () => {
    const result = validateBridgeLock(
      {
        pid: SELF_PID,
        instanceId: "abc",
        startIdentity: SELF_IDENTITY,
      },
      ["this-will-never-match"],
    );
    expect(result.status).toBe("wrong-command");
  });
});

describe("spawnTarget — canonical literal identity (#1711 R2)", () => {
  it("composes the canonical absolute target", () => {
    expect(spawnTarget("/home/u/.abtars")).toBe("/home/u/.abtars/app/bundle/abtars.js");
  });

  it("rejects a relative home — it would create an unreachable identity class", () => {
    expect(() => spawnTarget("relative/home")).toThrow(/absolute/);
  });

  it("strips one trailing separator", () => {
    expect(spawnTarget("/home/u/.abtars/")).toBe("/home/u/.abtars/app/bundle/abtars.js");
  });

  it("strips multiple trailing separators", () => {
    expect(spawnTarget("/home/u/.abtars///")).toBe("/home/u/.abtars/app/bundle/abtars.js");
  });

  it("maps differently-spelled homes to ONE identity literal", () => {
    expect(spawnTarget("/home/u/.abtars/")).toBe(spawnTarget("/home/u/.abtars"));
  });

  it("never resolves symlinks — old-release argv stays stable across current repointing (B12)", () => {
    // Pure string composition: /x/app must survive even though app is a
    // symlink to releases/<gen> in the real deployment layout.
    expect(spawnTarget("/srv/with-app-link/app-target-home")).toBe(
      "/srv/with-app-link/app-target-home/app/bundle/abtars.js",
    );
  });
});

describe("identity spelling parity across shell, launcher, TypeScript, and doctor (#1711 R2)", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

  const watchdog = readFileSync(join(repoRoot, "scripts", "abtars-watchdog.sh"), "utf-8");
  const launcher = readFileSync(join(repoRoot, "scripts", "abtars.sh"), "utf-8");

  it("watchdog normalizes ABTARS_HOME before any identity-bearing use", () => {
    expect(watchdog).toMatch(/AB="\$\{ABTARS_HOME:-\$HOME\/\.abtars\}"/);
    expect(watchdog).toMatch(/while \[\[ "\$AB" == \*\/ && "\$AB" != "\/" \]\]; do AB="\$\{AB%\/\}"; done/);
  });

  it("watchdog spawns the canonical absolute literal exactly once", () => {
    const spellings = watchdog.match(/[^\s"']*app\/bundle\/abtars\.js/g) ?? [];
    // Exactly one spawn spelling: $AB/app/bundle/abtars.js
    expect(spellings).toEqual(["$AB/app/bundle/abtars.js"]);
  });

  it("launcher normalizes ABTARS_HOME and uses the same literal", () => {
    expect(launcher).toMatch(/while \[\[ "\$ABTARS_HOME" == \*\/ && "\$ABTARS_HOME" != "\/" \]\]/);
    expect(launcher).toContain('exec node "$ABTARS_HOME/app/bundle/abtars.js"');
  });

  it("TypeScript contract agrees with the shell literal", () => {
    expect(spawnTarget("/home/u/.abtars")).toBe("/home/u/.abtars/app/bundle/abtars.js");
  });
});

describe("enumerateBridgeProcesses on Linux /proc (#1711 R2)", () => {
  const isDarwin = process.platform === "darwin";

  it("returns a fail-closed marker for a relative home instead of throwing", () => {
    const result = enumerateBridgeProcesses("relative/home");
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.reason).toBe("invalid-home");
  });

  it.runIf(!isDarwin)("finds a real same-home bridge child by exact literal argv and separates homes", async () => {
    const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const home = mkdtempSync(join(tmpdir(), "abtars-enum-"));
    try {
      mkdirSync(join(home, "app", "bundle"), { recursive: true });
      const target = join(home, "app", "bundle", "abtars.js");
      writeFileSync(target, 'setInterval(() => {}, 10_000);\n');

      const child = spawn(process.execPath, [target], { stdio: "ignore", cwd: "/tmp" });
      try {
        let found: BridgeProcess | undefined;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const result = enumerateBridgeProcesses(home);
          expect(result.complete).toBe(true);
          if (result.complete) {
            found = result.processes.find((p) => p.pid === child.pid);
            if (found?.exactTarget) break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(found).toBeDefined();
        expect(found!.exactTarget).toBe(true);
        expect(found!.startIdentity).toMatch(new RegExp(`^${child.pid}:\\d+$`));
        expect(found!.argv[0]).toBe(process.execPath);

        // A different home must NOT claim this process — two identity classes.
        const otherHome = `${home}-other`;
        const otherResult = enumerateBridgeProcesses(otherHome);
        expect(otherResult.complete).toBe(true);
        if (otherResult.complete) {
          expect(otherResult.processes.some((p) => p.exactTarget)).toBe(false);
        }

        // A trailing-slash spelling of the SAME home must still find it (R2 normalization).
        const slashed = enumerateBridgeProcesses(`${home}/`);
        expect(slashed.complete).toBe(true);
        if (slashed.complete) {
          expect(slashed.processes.some((p) => p.exactTarget)).toBe(true);
        }
      } finally {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.on("exit", () => resolve()));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);
});

describe("potentialHomeBridgeProcesses — R2.1 legacy relative-argv attribution (#1711 v5)", () => {
  const isDarwin = process.platform === "darwin";

  async function spawnRelativeChild(cwd: string): Promise<{ pid: number }> {
    const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["app/bundle/abtars.js"], { stdio: "ignore", cwd });
      child.on("spawn", () => resolve({ pid: child.pid! }));
      child.on("error", reject);
    });
  }

  function seedHome(dir: string): void {
    mkdirSync(join(dir, "app", "bundle"), { recursive: true });
    writeFileSync(join(dir, "app", "bundle", "abtars.js"), 'setInterval(() => {}, 10_000);\n');
  }

  it.runIf(!isDarwin)("lock-first: a lock-named relative process is THIS home's bridge even when cwd points elsewhere", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "abtars-attrib-a-"));
    const homeB = mkdtempSync(join(tmpdir(), "abtars-attrib-b-"));
    seedHome(homeA);
    seedHome(homeB);
    const rel = await spawnRelativeChild(homeB); // cwd = homeB
    try {
      // homeA's bridge.lock names this PID with a matching start identity.
      writeFileSync(join(homeA, "bridge.lock"), JSON.stringify({
        pid: rel.pid,
        startIdentity: processStartIdentity(rel.pid),
        instanceId: "abc",
      }));

      const scopeA = potentialHomeBridgeProcesses(homeA);
      expect(scopeA.complete).toBe(true);
      if (scopeA.complete) {
        expect(scopeA.blockers.some((p) => p.pid === rel.pid)).toBe(true);
        expect(scopeA.unattributable).toEqual([]);
      }
    } finally {
      await (async () => {
        try { process.kill(rel.pid, "SIGKILL"); } catch { /* already gone */ }
      })();
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  }, 15000);

  it.runIf(!isDarwin)("cwd attribution: a relative process whose cwd is this home blocks; one in another home does not", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "abtars-attrib-c-"));
    const homeB = mkdtempSync(join(tmpdir(), "abtars-attrib-d-"));
    seedHome(homeA);
    seedHome(homeB);
    const inHome = await spawnRelativeChild(homeA);
    const foreign = await spawnRelativeChild(homeB);
    try {
      const scope = potentialHomeBridgeProcesses(homeA);
      expect(scope.complete).toBe(true);
      if (scope.complete) {
        expect(scope.blockers.some((p) => p.pid === inHome.pid)).toBe(true);
        expect(scope.blockers.some((p) => p.pid === foreign.pid)).toBe(false);
        expect(scope.unattributable).toEqual([]);
      }
    } finally {
      for (const p of [inHome.pid, foreign.pid]) {
        try { process.kill(p, "SIGKILL"); } catch { /* already gone */ }
      }
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  }, 15000);

  it.runIf(!isDarwin)("an unreadable cwd yields a LOUD unattributable blocker with pid, argv, and reason (B13)", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "abtars-attrib-e-"));
    seedHome(homeA);
    const rel = await spawnRelativeChild(homeA);
    try {
      const readlinkMock = vi.mocked(readlinkSync);
      readlinkMock.mockImplementationOnce(() => {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      });

      const scope = potentialHomeBridgeProcesses(homeA);
      expect(scope.complete).toBe(true);
      if (scope.complete) {
        expect(scope.blockers.some((p) => p.pid === rel.pid)).toBe(true);
        const u = scope.unattributable.find((x) => x.pid === rel.pid);
        expect(u).toBeDefined();
        expect(u!.argv).toContain("app/bundle/abtars.js");
        expect(u!.reason).toContain("cwd-unreadable");
        expect(u!.startIdentity).toBe(processStartIdentity(rel.pid));
      }
    } finally {
      try { process.kill(rel.pid, "SIGKILL"); } catch { /* already gone */ }
      rmSync(homeA, { recursive: true, force: true });
    }
  }, 15000);

  it("macOS: an lsof failure yields unattributable — never a crash and never a silent pass (B13)", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    const homeA = mkdtempSync(join(tmpdir(), "abtars-attrib-mac-"));
    seedHome(homeA);
    const rel = await spawnRelativeChild(homeA);
    try {
      execFileSyncMock.mockImplementation((cmd: string) => {
        if (cmd === "ps") {
          const lstart = "Mon Aug 24 01:02:03 2026";
          return `${rel.pid} ${lstart} ${process.execPath} app/bundle/abtars.js\n`;
        }
        throw new Error("lsof unavailable");
      });

      const scope = potentialHomeBridgeProcesses(homeA);
      expect(scope.complete).toBe(true);
      if (scope.complete) {
        const u = scope.unattributable.find((x) => x.pid === rel.pid);
        expect(u).toBeDefined();
        expect(u!.reason).toContain("cwd-unreadable");
        expect(scope.blockers.some((p) => p.pid === rel.pid)).toBe(true);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true, writable: true });
      execFileSyncMock.mockReset();
      try { process.kill(rel.pid, "SIGKILL"); } catch { /* already gone */ }
      rmSync(homeA, { recursive: true, force: true });
    }
  }, 15000);

  it("macOS: a readable lsof cwd inside this home attributes the relative process (B13)", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    const homeA = mkdtempSync(join(tmpdir(), "abtars-attrib-mac2-"));
    seedHome(homeA);
    const rel = await spawnRelativeChild(homeA);
    try {
      execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "ps") {
          const lstart = "Mon Aug 24 01:02:03 2026";
          return `${rel.pid} ${lstart} ${process.execPath} app/bundle/abtars.js\n`;
        }
        expect(args).toEqual(["-a", "-p", String(rel.pid), "-d", "cwd", "-Fn"]);
        return `p${rel.pid}\nfcwd\nn${homeA}\n`;
      });

      const scope = potentialHomeBridgeProcesses(homeA);
      expect(scope.complete).toBe(true);
      if (scope.complete) {
        expect(scope.blockers.some((p) => p.pid === rel.pid)).toBe(true);
        expect(scope.unattributable).toEqual([]);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true, writable: true });
      execFileSyncMock.mockReset();
      try { process.kill(rel.pid, "SIGKILL"); } catch { /* already gone */ }
      rmSync(homeA, { recursive: true, force: true });
    }
  }, 15000);
});
