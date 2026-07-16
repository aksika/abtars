import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PiComponentStatus } from "../../components/pi-inspector.js";
import type { SpawnSyncReturns } from "node:child_process";

const mockInspectAll = vi.fn<(...args: unknown[]) => PiComponentStatus[]>();
const mockLoadPiConfig = vi.fn<(...args: unknown[]) => { command?: string } | undefined>();
const mockSpawnSync = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();

vi.mock("../../components/pi-inspector.js", () => ({
  inspectAllPiComponents: (...args: unknown[]) => mockInspectAll(...args),
}));

vi.mock("../../components/pi-executor/config.js", () => ({
  loadPiConfig: (...args: unknown[]) => mockLoadPiConfig(...args),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

async function captureOutput(fn: () => Promise<number>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string) => { out.push(chunk); return true; };
  process.stderr.write = (chunk: string) => { err.push(chunk); return true; };
  try {
    const exitCode = await fn();
    return { exitCode, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe("pi-preflight", () => {
  beforeEach(() => {
    mockInspectAll.mockReset();
    mockLoadPiConfig.mockReset();
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined, stderr: "", stdout: "", pid: 0, output: [], signal: null } as SpawnSyncReturns<string>);
  });

  it("passes clean when all components compatible", async () => {
    mockLoadPiConfig.mockReturnValue({ command: "/usr/bin/pi" });
    mockInspectAll.mockReturnValue([
      { component: "ai", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "tui", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "coding-agent", expected: "0.80.7", observed: "0.80.7", state: "ok", path: "/usr/bin/pi" },
    ]);

    const { exitCode, stdout, stderr } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Pi compatibility check passed");
    expect(stderr).toBe("");
  });

  it("warns but does not block on mismatched coding-agent", async () => {
    mockLoadPiConfig.mockReturnValue({ command: "/usr/bin/pi" });
    mockInspectAll.mockReturnValue([
      { component: "ai", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "tui", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "coding-agent", expected: "0.80.7", observed: "0.80.6", state: "mismatch", path: "/usr/bin/pi", remediation: "npm install -g @earendil-works/pi-coding-agent@0.80.7" },
    ]);

    const { exitCode, stdout, stderr } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("continuing despite coding-agent warning");
    expect(stderr).toContain("⚠ coding-agent: mismatch");
    expect(stderr).toContain("0.80.6");
  });

  it("warns but does not block on missing configured binary", async () => {
    mockLoadPiConfig.mockReturnValue({ command: "/usr/bin/pi" });
    mockInspectAll.mockReturnValue([
      { component: "ai", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "tui", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "coding-agent", expected: "0.80.7", state: "missing", path: "/usr/bin/pi", remediation: "npm install -g @earendil-works/pi-coding-agent@0.80.7" },
    ]);

    const { exitCode, stdout, stderr } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("continuing despite coding-agent warning");
    expect(stderr).toContain("⚠ coding-agent: missing");
  });

  it("warns but does not block on invalid executable", async () => {
    mockLoadPiConfig.mockReturnValue({ command: "/usr/bin/pi" });
    mockInspectAll.mockReturnValue([
      { component: "ai", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "tui", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "coding-agent", expected: "0.80.7", state: "invalid", path: "/usr/bin/pi", remediation: "Install the exact target version" },
    ]);

    const { exitCode, stdout, stderr } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("continuing despite coding-agent warning");
    expect(stderr).toContain("⚠ coding-agent: invalid");
  });

  it("passes silently when no Pi executor configured", async () => {
    mockLoadPiConfig.mockReturnValue(undefined);
    mockInspectAll.mockReturnValue([
      { component: "ai", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "tui", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "coding-agent", expected: "0.80.7", state: "missing", remediation: "Pi executor not configured" },
    ]);

    const { exitCode, stdout, stderr } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Pi compatibility check passed");
    expect(stdout).not.toContain("coding-agent");
    expect(stderr).toBe("");
  });

  it("blocks on shared package refresh failure", async () => {
    mockLoadPiConfig.mockReturnValue({ command: "/usr/bin/pi" });
    mockInspectAll.mockReturnValue([
      { component: "ai", expected: "0.80.7", observed: "0.80.7", state: "ok" },
      { component: "tui", expected: "0.80.7", state: "mismatch", observed: "0.80.6", remediation: "abtars deps update tui" },
      { component: "coding-agent", expected: "0.80.7", observed: "0.80.7", state: "ok", path: "/usr/bin/pi" },
    ]);
    mockSpawnSync.mockReturnValue({ status: 1, error: undefined, stderr: "npm ERR! failed", stdout: "", pid: 0, output: [], signal: null } as SpawnSyncReturns<string>);

    const { exitCode, stdout, stderr } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("✗ Preflight failed — aborting activation");
  });
});
