import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PiInstallationState } from "../../components/pi-installation.js";

const mockResolve = vi.fn<(...args: unknown[]) => PiInstallationState>();

vi.mock("../../components/pi-installation.js", () => ({
  resolvePiInstallation: (...args: unknown[]) => mockResolve(...args),
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

const compatibleState: PiInstallationState = {
  state: "compatible",
  installation: {
    executable: "/usr/local/bin/pi",
    packageRoot: "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
    version: "0.80.7",
    source: "path",
    moduleRoots: {
      ai: "/usr/local/lib/node_modules/@earendil-works/pi-ai",
      tui: "/usr/local/lib/node_modules/@earendil-works/pi-tui",
      agentCore: "/usr/local/lib/node_modules/@earendil-works/pi-agent-core",
    },
  },
};

describe("pi-preflight (#1438)", () => {
  beforeEach(() => {
    mockResolve.mockReset();
  });

  it("passes when Pi is compatible", async () => {
    mockResolve.mockReturnValue(compatibleState);

    const { exitCode, stdout } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Pi");
    expect(stdout).toContain("0.80.7");
  });

  it("passes when Pi is absent", async () => {
    mockResolve.mockReturnValue({ state: "absent" });

    const { exitCode, stdout } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("not installed");
  });

  it("passes (non-blocking) when Pi is below minimum", async () => {
    mockResolve.mockReturnValue({
      state: "below-minimum",
      executable: "/usr/bin/pi",
      packageRoot: "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
      observedVersion: "0.80.5",
      reason: "below minimum",
      remediation: "Update Pi",
    });

    const { exitCode, stdout } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("⚠");
    expect(stdout).toContain("0.80.5");
  });

  it("passes (non-blocking) when Pi installation is invalid", async () => {
    mockResolve.mockReturnValue({
      state: "invalid",
      executable: "/usr/bin/pi",
      observedVersion: "0.80.7",
      reason: "version mismatch",
      remediation: "Reinstall Pi",
    });

    const { exitCode, stdout } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("⚠");
    expect(stdout).toContain("invalid");
  });

  it("passes (non-blocking) when Pi installation is incomplete", async () => {
    mockResolve.mockReturnValue({
      state: "incomplete",
      executable: "/usr/bin/pi",
      observedVersion: "0.80.7",
      reason: "Missing nested packages",
      remediation: "Reinstall Pi",
    });

    const { exitCode, stdout } = await captureOutput(async () => {
      const { preflightPiCompatibility } = await import("./pi-preflight.js");
      return preflightPiCompatibility();
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("⚠");
    expect(stdout).toContain("incomplete");
  });
});
