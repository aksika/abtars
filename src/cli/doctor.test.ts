import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, statSync, readFileSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

const IS_WSL = readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft");
import { tmpdir } from "node:os";

const DOCTOR = join(import.meta.dirname, "../../scripts/doctor.sh");

function setupHome(home: string, manifest: Record<string, unknown> = { installMode: "supervised" }, healthy = false): void {
  const dirs = ["config", "logs", "scripts", "bin", "releases", "skills/core", "skills/custom", "skills/downloaded", "skills/self", "secret", "secret/cookies"];
  for (const d of dirs) mkdirSync(join(home, ".abtars", d), { recursive: true });
  mkdirSync(join(home, ".abmind", "memory"), { recursive: true });
  writeFileSync(join(home, ".abtars", "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(home, ".abtars", "config", "transport.json"), "{}");
  writeFileSync(join(home, ".abtars", "config", "models.json"), "{}");
  writeFileSync(join(home, ".abtars", "config", "users.json"), "[]");
  if (healthy) {
    chmodSync(join(home, ".abtars"), 0o700);
    chmodSync(join(home, ".abtars", "config"), 0o700);
    chmodSync(join(home, ".abtars", "secret"), 0o700);
    chmodSync(join(home, ".abtars", "secret", "cookies"), 0o700);
    chmodSync(join(home, ".abmind", "memory"), 0o700);
    chmodSync(join(home, ".abtars", "config", "transport.json"), 0o600);
    chmodSync(join(home, ".abtars", "config", "models.json"), 0o600);
    chmodSync(join(home, ".abtars", "config", "users.json"), 0o600);
    // Use current PID so doctor sees a live process
    writeFileSync(join(home, ".abtars", "bridge.lock"), JSON.stringify({ pid: process.pid, watchdogPid: process.pid }));
  }
}

function runDoctor(home: string, args = "--fix"): { code: number; output: string } {
  try {
    const output = execSync(`HOME="${home}" ABMIND_HOME="${join(home, ".abmind")}" bash "${DOCTOR}" ${args}`, {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env, HOME: home, ABMIND_HOME: join(home, ".abmind"), PATH: process.env["PATH"] },
    });
    return { code: 0, output };
  } catch (err: any) {
    return { code: err.status ?? 1, output: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe("doctor.sh", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "doctor-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("--fix exits 0 when everything is healthy", () => {
    setupHome(home, { installMode: "supervised" }, true);
    const { code } = runDoctor(home);
    expect(code).toBe(0);
  });

  it.skipIf(IS_WSL)("--fix fixes directory permissions to 700", () => {
    setupHome(home);
    chmodSync(join(home, ".abtars", "secret"), 0o755);
    chmodSync(join(home, ".abtars", "secret", "cookies"), 0o755);
    chmodSync(join(home, ".abmind", "memory"), 0o755);
    const { code, output } = runDoctor(home);
    expect(code).toBe(0);
    expect(output).toContain("permissions");
    expect(statSync(join(home, ".abtars", "secret")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, ".abtars", "secret", "cookies")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, ".abmind", "memory")).mode & 0o777).toBe(0o700);
  });

  it("exits 1 when installMode missing from manifest", () => {
    setupHome(home, {});
    const { code, output } = runDoctor(home);
    expect(code).toBe(1);
    expect(output).toContain("installMode");
  });

  it("exits 1 with invalid installMode", () => {
    setupHome(home, { installMode: "bogus" });
    const { code, output } = runDoctor(home);
    expect(code).toBe(1);
    expect(output).toContain("invalid installMode");
  });

  it("diagnose-only exits 1 when warnings present", () => {
    setupHome(home);
    chmodSync(join(home, ".abtars", "secret"), 0o755);
    const { code, output } = runDoctor(home, "");
    expect(code).toBe(1);
    expect(output).toContain("WARN");
  });

  it.skipIf(IS_WSL)("diagnose-only exits 0 when clean", () => {
    setupHome(home, { installMode: "supervised" }, true);
    const { code } = runDoctor(home, "");
    expect(code).toBe(0);
  });
});
