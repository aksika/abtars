import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let mockPgrepOutput: string = "";

// Captured by the vi.mock factories below via closure (stable across resetModules).
const homedirRef = vi.hoisted(() => ({ current: "" }));
const pgrepRef = vi.hoisted(() => ({ current: "" }));
const origSpawnRef = vi.hoisted(() => ({ current: null as any }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homedirRef.current };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  origSpawnRef.current = actual.spawnSync;
  return {
    ...actual,
    spawnSync: (cmd: string, args?: readonly string[]) => {
      if (cmd === "pgrep" && args?.[0] === "-f" && typeof args[1] === "string" && args[1].includes("abtars.js")) {
        return { status: 0, stdout: pgrepRef.current, stderr: "", pid: 0, output: [pgrepRef.current], signal: null };
      }
      return origSpawnRef.current(cmd, args);
    },
  };
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "doctor-test-"));
  homedirRef.current = tmpDir;
  mkdirSync(join(tmpDir, "logs"), { recursive: true });
  mkdirSync(join(tmpDir, "config"), { recursive: true });
  mkdirSync(join(tmpDir, "kanban"), { recursive: true });
  process.env["ABTARS_HOME"] = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["ABTARS_HOME"];
});

describe("doctor probeBridge (#1261)", () => {
  it("reports skipped when no bridge is running", async () => {
    pgrepRef.current = "";
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const probe = result.layers.body.flat().find((r) => r.name === "bridge");
    expect(probe).toBeDefined();
    expect(probe?.status).toBe("skipped");
    expect(probe?.detail).toContain("no bridge running");
  });

  it("reports ok when exactly one bridge is running", async () => {
    pgrepRef.current = "12345\n";
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const probe = result.layers.body.flat().find((r) => r.name === "bridge");
    expect(probe?.status).toBe("ok");
    expect(probe?.detail).toBe("pid:12345");
  });

  it("reports failed when multiple bridges are running (orphan detected)", async () => {
    pgrepRef.current = "12345\n67890\n";
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const probe = result.layers.body.flat().find((r) => r.name === "bridge");
    expect(probe?.status).toBe("failed");
    expect(probe?.detail).toContain("2 bridges");
    expect(probe?.detail).toContain("12345");
    expect(probe?.detail).toContain("67890");
  });
});

describe("doctor tribe probes (#1439)", () => {
  function writeConfig(files: { env?: string; peers?: unknown; lock?: unknown }): void {
    if (files.env !== undefined) writeFileSync(join(tmpDir, "config", ".env"), files.env);
    if (files.peers !== undefined) writeFileSync(join(tmpDir, "config", "peers.json"), JSON.stringify(files.peers));
    if (files.lock !== undefined) writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify(files.lock));
  }

  it("tribe layer uses renamed probes: peer-api, peers, identity, routes, doorbell", async () => {
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const names = result.layers.tribe.map((r) => r.name).sort();
    expect(names).toEqual(["doorbell", "identity", "peer-api", "peers", "routes"]);
  });

  it("peer-api/identity/doorbell skipped when agent-api disabled", async () => {
    writeConfig({ env: "ENABLE_AGENT_API=false\n" });
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const byName = Object.fromEntries(result.layers.tribe.map((r) => [r.name, r]));
    expect(byName["peer-api"]?.status).toBe("skipped");
    expect(byName["identity"]?.status).toBe("skipped");
    expect(byName["doorbell"]?.status).toBe("skipped");
  });

  it("doorbell warning (no snapshot) when agent-api enabled but no peers", async () => {
    writeConfig({ env: "ENABLE_AGENT_API=true\n", peers: { self: { signingKey: "x" }, peers: {} } });
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const doorbell = result.layers.tribe.find((r) => r.name === "doorbell");
    expect(doorbell?.status).toBe("skipped");
    expect(doorbell?.detail).toContain("no peers");
  });

  it("doorbell skipped when no peers exist", async () => {
    writeConfig({ env: "ENABLE_AGENT_API=true\n", peers: { self: { signingKey: "x" }, peers: {} } });
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const doorbell = result.layers.tribe.find((r) => r.name === "doorbell");
    expect(doorbell?.status).toBe("skipped");
    expect(doorbell?.detail).toContain("no peers");
  });

  it("peers reports solo skip when no peers configured", async () => {
    writeConfig({ peers: { self: { signingKey: "x" }, peers: {} } });
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const peers = result.layers.tribe.find((r) => r.name === "peers");
    expect(peers?.status).toBe("skipped");
    expect(peers?.detail).toContain("solo");
  });

  it("peers reports enrolled count with valid keys", async () => {
    writeConfig({ peers: { self: { signingKey: "x" }, peers: { kp: { verifyKey: "k1" }, molty: { verifyKey: "k2" } } } });
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const peers = result.layers.tribe.find((r) => r.name === "peers");
    expect(peers?.status).toBe("ok");
    expect(peers?.detail).toContain("2 enrolled");
  });

  it("peers fails when a peer is missing verifyKey", async () => {
    writeConfig({ peers: { self: { signingKey: "x" }, peers: { kp: { verifyKey: "k1" }, molty: {} } } });
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const peers = result.layers.tribe.find((r) => r.name === "peers");
    expect(peers?.status).toBe("failed");
    expect(peers?.detail).toContain("molty");
  });

  it("routes returns warning when no snapshot", async () => {
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const routes = result.layers.tribe.find((r) => r.name === "routes");
    expect(routes?.status).toBe("warning");
    expect(routes?.detail).toContain("no runtime snapshot");
  });

  it("schema version is 2.0", async () => {
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    expect(result.schemaVersion).toBe("2.0");
  });

  it("output has summary field", async () => {
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    expect(result.summary).toBeDefined();
    expect(typeof result.summary.ok).toBe("number");
    expect(typeof result.summary.warning).toBe("number");
    expect(typeof result.summary.failed).toBe("number");
    expect(typeof result.summary.skipped).toBe("number");
  });

  it("output has abtars version info", async () => {
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    expect(result.abtars).toBeDefined();
    expect(typeof result.abtars.version).toBe("string");
  });

  it("probes have evidence level", async () => {
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const all = Object.values(result.layers).flat();
    for (const p of all) {
      expect(p.evidence).toBeDefined();
      expect(["configuration", "filesystem", "executable", "reachable", "runtime", "authenticated"]).toContain(p.evidence);
    }
  });
});
