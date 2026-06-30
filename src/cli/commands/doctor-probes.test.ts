import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let mockPgrepOutput: string = "";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpDir };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (cmd: string, args?: readonly string[]) => {
      if (cmd === "pgrep" && args?.[0] === "-f" && typeof args[1] === "string" && args[1].includes("abtars.js")) {
        return { status: 0, stdout: mockPgrepOutput, stderr: "", pid: 0, output: [mockPgrepOutput], signal: null };
      }
      return actual.spawnSync(cmd, args);
    },
  };
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "doctor-test-"));
  mkdirSync(join(tmpDir, "logs"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("doctor probeSingleBridge (#1261)", () => {
  it("reports skipped when no bridge is running", async () => {
    mockPgrepOutput = "";
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const probe = result.layers.body.flat().find((r) => r.name === "single-bridge");
    expect(probe).toBeDefined();
    expect(probe?.status).toBe("skipped");
    expect(probe?.detail).toContain("no bridge running");
  });

  it("reports ok when exactly one bridge is running", async () => {
    mockPgrepOutput = "12345\n";
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const probe = result.layers.body.flat().find((r) => r.name === "single-bridge");
    expect(probe?.status).toBe("ok");
    expect(probe?.detail).toBe("pid:12345");
  });

  it("reports failed when multiple bridges are running (orphan detected)", async () => {
    mockPgrepOutput = "12345\n67890\n";
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const probe = result.layers.body.flat().find((r) => r.name === "single-bridge");
    expect(probe?.status).toBe("failed");
    expect(probe?.detail).toContain("2 bridges");
    expect(probe?.detail).toContain("12345");
    expect(probe?.detail).toContain("67890");
  });
});
