import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs.existsSync so socket check passes (we control the startup flow).
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));

// Mock pi-installation so we control resolvePiInstallation and loadPiModule.
vi.mock("../../components/pi-installation.js", () => ({
  resolvePiInstallation: vi.fn(),
  loadPiModule: vi.fn(),
}));

import { resolvePiInstallation, loadPiModule } from "../../components/pi-installation.js";
import { tui } from "./tui.js";

describe("tui startup — pi-tui load failure (#1441)", () => {
  let stderrOutput: string[];

  beforeEach(() => {
    stderrOutput = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrOutput.push(chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.mocked(resolvePiInstallation).mockReset();
    vi.mocked(loadPiModule).mockReset();
  });

  it("returns exit code 1 and prints bounded stderr when pi is absent", async () => {
    vi.mocked(resolvePiInstallation).mockReturnValue({ state: "absent" });

    const exitCode = await tui([]);

    expect(exitCode).toBe(1);
    expect(stderrOutput.some(s => s.includes("not installed"))).toBe(true);
  });

  it("returns exit code 1 and prints bounded stderr when pi is invalid", async () => {
    vi.mocked(resolvePiInstallation).mockReturnValue({
      state: "invalid",
      reason: "version check failed",
      remediation: "reinstall",
    });

    const exitCode = await tui([]);

    expect(exitCode).toBe(1);
    expect(stderrOutput.some(s => s.includes("invalid"))).toBe(true);
  });

  it("returns exit code 1 and prints bounded stderr when pi-tui import fails", async () => {
    vi.mocked(resolvePiInstallation).mockReturnValue({
      state: "compatible",
      installation: {
        executable: "/usr/bin/pi",
        packageRoot: "/usr/lib/pi-coding-agent",
        version: "0.83.0",
        source: "path",
        pinStatus: "at-pin",
        moduleRoots: { ai: "/tmp/pi-ai", tui: "/tmp/pi-tui", agentCore: "/tmp/pi-agent-core" },
      },
    });
    vi.mocked(loadPiModule).mockRejectedValue(new Error("cannot resolve pi-tui: no executable export target found"));

    const exitCode = await tui([]);

    expect(exitCode).toBe(1);
    expect(stderrOutput.some(s => s.includes("pi-tui") || s.includes("TUI") || s.includes("Reinstall"))).toBe(true);
  });

  it("fails clearly when a required pi-coding-agent export is missing (#1612)", async () => {
    vi.mocked(resolvePiInstallation).mockReturnValue({
      state: "compatible",
      installation: {
        executable: "/usr/bin/pi",
        packageRoot: "/usr/lib/pi-coding-agent",
        version: "0.83.0",
        source: "path",
        pinStatus: "at-pin",
        moduleRoots: { ai: "/tmp/pi-ai", tui: "/tmp/pi-tui", agentCore: "/tmp/pi-agent-core" },
      },
    });
    vi.mocked(loadPiModule).mockImplementation(async (_installation, spec) => {
      if (spec.package === "@earendil-works/pi-tui") {
        return {
          ProcessTerminal: class {}, TUI: class {}, Container: class {},
          Editor: class {}, Text: class {}, Markdown: class {},
          Loader: class {}, matchesKey: () => false,
        };
      }
      // coding-agent without UserMessageComponent — must fail pre-ready.
      return { initTheme: () => {}, getMarkdownTheme: () => ({}) };
    });

    const exitCode = await tui([]);

    expect(exitCode).toBe(1);
    expect(stderrOutput.some(s => s.includes("UserMessageComponent"))).toBe(true);
    expect(stderrOutput.some(s => s.includes("Reinstall"))).toBe(true);
  });

  it("does not silently fall back when the coding-agent package root fails to resolve (#1612)", async () => {
    vi.mocked(resolvePiInstallation).mockReturnValue({
      state: "compatible",
      installation: {
        executable: "/usr/bin/pi",
        packageRoot: "/usr/lib/pi-coding-agent",
        version: "0.83.0",
        source: "path",
        pinStatus: "at-pin",
        moduleRoots: { ai: "/tmp/pi-ai", tui: "/tmp/pi-tui", agentCore: "/tmp/pi-agent-core" },
      },
    });
    vi.mocked(loadPiModule).mockRejectedValue(new Error("@earendil-works/pi-coding-agent: no executable export target found"));

    const exitCode = await tui([]);

    expect(exitCode).toBe(1);
    expect(stderrOutput.some(s => s.includes("pi-coding-agent"))).toBe(true);
  });
});
