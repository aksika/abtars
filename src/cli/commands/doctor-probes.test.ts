import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

let tmpDir: string;
let mockPgrepOutput: string = "";
let mockSpawn: Array<{ cmd: string; behavior: () => any }> = [];

// Captured by the vi.mock factories below via closure (stable across resetModules).
const homedirRef = vi.hoisted(() => ({ current: "" }));
const pgrepRef = vi.hoisted(() => ({ current: "" }));
const spawnRef = vi.hoisted(() => ({ current: [] as Array<{ cmd: string; behavior: () => any }> }));
const origSpawnRef = vi.hoisted(() => ({ current: null as any }));

// #1662: the mind probe's endpoint boundary (resolver + factory) is mocked so
// every runAllProbes() call stays hermetic — no real abmind package discovery,
// daemon negotiation, or WSS network attempt. The mock factories re-register
// per resetModules(), so the captured module references (and their error
// classes) are always the fresh instances the probe sees.
const mindEndpointRef = vi.hoisted(() => ({ current: null as any }));
const mindFactoryRef = vi.hoisted(() => ({ current: null as any }));
const phaseMemoryRef = vi.hoisted(() => ({ current: null as any }));

vi.mock("../../boot/phase-memory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../boot/phase-memory.js")>();
  phaseMemoryRef.current = actual;
  return {
    ...actual,
    createMemoryRuntimeFromEndpoint: (endpoint: unknown, home: string) => mindFactoryRef.current(endpoint, home),
  };
});

vi.mock("../../components/abmind-endpoint-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/abmind-endpoint-config.js")>();
  return {
    ...actual,
    resolveAbmindEndpoint: (configDir: string) => mindEndpointRef.current(configDir),
  };
});

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
      const match = spawnRef.current.find((s) => s.cmd === cmd);
      if (match) return match.behavior();
      if (cmd === "pgrep" && args?.[0] === "-f" && typeof args[1] === "string" && args[1].includes("abtars.js")) {
        return { status: 0, stdout: pgrepRef.current, stderr: "", pid: 0, output: [pgrepRef.current], signal: null };
      }
      // Hermetic: never spawn the real `pi` binary (slow launcher — #1476
      // raised its probe timeout to 15s, which can stall this file's tests
      // past vitest's 5s default under parallel load).
      if (args?.[0] === "--version") {
        return { status: 0, stdout: "0.83.0\n", stderr: "", pid: 0, output: ["0.83.0\n"], signal: null, error: null };
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
  spawnRef.current = [];
  // #1662 defaults: absent-config local default endpoint, and the factory
  // rejects as if no abmind package were installed — deterministic, no real
  // daemon interaction for unrelated probes. Individual tests override. The
  // error class is resolved lazily so it is the fresh post-reset instance.
  mindEndpointRef.current = () => ({ mode: "local", source: "default" });
  mindFactoryRef.current = async () => { throw new phaseMemoryRef.current.AbmindModuleMissingError(); };
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env["ABTARS_HOME"];
});

describe("doctor probeBridge (#1261/#1711 R2)", () => {
  const children: Array<import("node:child_process").ChildProcess> = [];

  async function spawnBridgeChild(): Promise<number> {
    const { spawn } = await import("node:child_process");
    mkdirSync(join(tmpDir, "app", "bundle"), { recursive: true });
    writeFileSync(join(tmpDir, "app", "bundle", "abtars.js"), 'setInterval(() => {}, 10_000);\n');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(tmpDir, "app", "bundle", "abtars.js")], {
        stdio: "ignore",
        cwd: tmpDir,
      });
      children.push(child);
      child.on("spawn", () => resolve(child.pid!));
      child.on("error", reject);
    });
  }

  async function killAll(): Promise<void> {
    for (const c of children.splice(0)) {
      try { c.kill("SIGKILL"); } catch { /* gone */ }
      await new Promise<void>((resolve) => {
        if (c.exitCode !== null || c.signalCode !== null) return resolve();
        c.once("exit", () => resolve());
      });
    }
  }

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
    const pid = await spawnBridgeChild();
    try {
      const { runAllProbes } = await import("./doctor-probes.js");
      const result = await runAllProbes();
      const probe = result.layers.body.flat().find((r) => r.name === "bridge");
      expect(probe?.status).toBe("ok");
      expect(probe?.detail).toBe(`pid:${pid}`);
    } finally {
      await killAll();
    }
  });

  it("reports failed when multiple bridges are running (orphan detected)", async () => {
    const pidA = await spawnBridgeChild();
    const pidB = await spawnBridgeChild();
    try {
      const { runAllProbes } = await import("./doctor-probes.js");
      const result = await runAllProbes();
      const probe = result.layers.body.flat().find((r) => r.name === "bridge");
      expect(probe?.status).toBe("failed");
      expect(probe?.detail).toContain("2 bridges");
      expect(probe?.detail).toContain(String(pidA));
      expect(probe?.detail).toContain(String(pidB));
    } finally {
      await killAll();
    }
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

  describe("pi probe (#1476)", () => {
    function writePiExecutor(command: string): void {
      writeFileSync(join(tmpDir, "config", "pi-executor.json"), JSON.stringify({ command }));
    }

    it("warns (not fails) when pi is slow to start — timeout is transient", async () => {
      const fakePi = join(tmpDir, "fake-pi");
      writeFileSync(fakePi, "#!/bin/sh\necho 0.83.0\n");
      chmodSync(fakePi, 0o755);
      writePiExecutor(fakePi);
      spawnRef.current.push({
        cmd: fakePi,
        behavior: () => ({ status: null, stdout: "", stderr: "", pid: 0, output: [], signal: null, error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) }),
      });
      const { runAllProbes } = await import("./doctor-probes.js");
      const result = await runAllProbes();
      const pi = result.layers.brain.find((r) => r.name === "pi");
      expect(pi?.status).toBe("warning");
      expect(pi?.detail).toContain("slow");
    });

    it("reports ok when pi responds with a version", async () => {
      const fakePi = join(tmpDir, "fake-pi");
      writeFileSync(fakePi, "#!/bin/sh\necho 0.83.0\n");
      chmodSync(fakePi, 0o755);
      writePiExecutor(fakePi);
      spawnRef.current.push({
        cmd: fakePi,
        behavior: () => ({ status: 0, stdout: "0.83.0\n", stderr: "", pid: 0, output: ["0.83.0\n"], signal: null, error: null }),
      });
      const { runAllProbes } = await import("./doctor-probes.js");
      const result = await runAllProbes();
      const pi = result.layers.brain.find((r) => r.name === "pi");
      expect(pi?.status).toBe("ok");
      expect(pi?.detail).toContain("0.83.0");
    });
  });

  describe("dashboard probe port resolution", () => {
    it("uses WEB_PORT from process env when set there (operator override wins over .env)", async () => {
      writeFileSync(join(tmpDir, "config", ".env"), "ENABLE_DASHBOARD=true\nWEB_PORT=3000\n");
      process.env["WEB_PORT"] = "4567";
      const { runAllProbes } = await import("./doctor-probes.js");
      const result = await runAllProbes();
      const dash = result.layers.body.find((r) => r.name === "dashboard");
      // Nothing listens on :4567 in the test sandbox — the probe must have
      // probed THAT port (not the .env/default 3000).
      expect(dash?.status).toBe("failed");
      expect(dash?.detail).toContain("4567");
      delete process.env["WEB_PORT"];
    });

    it("falls back to .env WEB_PORT (configurable, not always 3000)", async () => {
      writeFileSync(join(tmpDir, "config", ".env"), "ENABLE_DASHBOARD=true\nWEB_PORT=8081\n");
      const { runAllProbes } = await import("./doctor-probes.js");
      const result = await runAllProbes();
      const dash = result.layers.body.find((r) => r.name === "dashboard");
      expect(dash?.detail).toContain("8081");
    });
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
  }, 15_000);

  it("probes have evidence level", async () => {
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const all = Object.values(result.layers).flat();
    for (const p of all) {
      expect(p.evidence).toBeDefined();
      expect(["configuration", "filesystem", "executable", "reachable", "runtime", "authenticated"]).toContain(p.evidence);
    }
  }, 15_000);
});

describe("doctor platform probes use effective credentials (#1258)", () => {
  const ORIG_FETCH = globalThis.fetch;

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    delete process.env["TELEGRAM_BOT_TOKEN"];
    delete process.env["DISCORD_BOT_TOKEN"];
    vi.useRealTimers();
  });

  function fakeResponse(status: number): Response {
    return { ok: status >= 200 && status < 300, status } as unknown as Response;
  }

  function installSecretsKey(): void {
    writeFileSync(join(tmpDir, "config", "abtars.key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  }

  function writePlaintextSecret(name: string, value: string): void {
    mkdirSync(join(tmpDir, "secret"), { recursive: true });
    writeFileSync(join(tmpDir, "secret", name), value, { mode: 0o600 });
  }

  async function writeEncryptedSecret(name: string, value: string): Promise<void> {
    installSecretsKey();
    const { writeSecret, clearSecretCache } = await import("../../components/secrets.js");
    writeSecret(name, value);
    // Drop the value cache so the doctor read must decrypt from disk.
    clearSecretCache();
  }

  function platformsProbe(result: { layers: { body: Array<{ name: string; status: string; evidence: string; detail: string; remediation?: string }> } }): { name: string; status: string; evidence: string; detail: string; remediation?: string } {
    const probe = result.layers.body.find(r => r.name === "platforms");
    if (!probe) throw new Error("platforms probe missing");
    return probe;
  }

  it("discovers and verifies an encrypted Telegram secret from the secret store", async () => {
    installSecretsKey();
    await writeEncryptedSecret("TELEGRAM_BOT_TOKEN", "encrypted-tg-fixture");
    fetchMock.mockResolvedValue(fakeResponse(200));

    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const p = platformsProbe(result);

    expect(p.status).toBe("ok");
    expect(p.evidence).toBe("reachable");
    expect(p.detail).toContain("telegram: ok");
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/^https:\/\/api\.telegram\.org\/bot/);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/getMe");
  });

  it("reads a legacy plaintext secret file from the store", async () => {
    writePlaintextSecret("TELEGRAM_BOT_TOKEN", "legacy-plaintext-tg-fixture");
    fetchMock.mockResolvedValue(fakeResponse(200));

    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    expect(platformsProbe(result).status).toBe("ok");
  });

  it("a process-env override wins over the stored secret value", async () => {
    writePlaintextSecret("TELEGRAM_BOT_TOKEN", "stored-tg-value");
    process.env["TELEGRAM_BOT_TOKEN"] = "override-tg-value";
    // 200 only when the request carries the override — a stored-value request
    // would get 401 and fail the probe.
    fetchMock.mockImplementation((url: unknown) =>
      Promise.resolve(String(url).includes("override-tg-value") ? fakeResponse(200) : fakeResponse(401)));

    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    expect(platformsProbe(result).status).toBe("ok");
  });

  it("verifies Discord through the bot authorization header", async () => {
    await writeEncryptedSecret("DISCORD_BOT_TOKEN", "discord-encrypted-fixture");
    // 200 only when the authorization header is Bot-formatted — a missing or
    // malformed header would get 401.
    fetchMock.mockImplementation((_url: unknown, opts: unknown) =>
      Promise.resolve((opts as { headers?: Record<string, string> }).headers?.["Authorization"]?.startsWith("Bot ")
        ? fakeResponse(200)
        : fakeResponse(401)));

    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const p = platformsProbe(result);
    expect(p.status).toBe("ok");
    expect(p.detail).toContain("discord: ok");
  });

  it("ignores credential-shaped .env assignments and stale token aliases", async () => {
    writeFileSync(join(tmpDir, "config", ".env"), [
      "TELEGRAM_BOT_TOKEN=env-should-never-configure",
      "DISCORD_BOT_TOKEN=env-should-never-configure-2",
      "TELEGRAM_TOKEN=stale-alias",
      "DISCORD_TOKEN=stale-alias-2",
    ].join("\n"));

    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const p = platformsProbe(result);
    expect(p.status).toBe("skipped");
    expect(p.detail).toBe("no platform configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports no platform configured [configuration] — never [reachable] — when no credential exists", async () => {
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const p = platformsProbe(result);
    expect(p.status).toBe("skipped");
    expect(p.evidence).toBe("configuration");

    const { renderHuman } = await import("./doctor-render.js");
    const human = renderHuman(result);
    const platformLine = human.split("\n").find(l => l.includes("platforms")) ?? "";
    expect(platformLine).toContain("~ platforms — no platform configured [configuration]");
    expect(platformLine).not.toContain("[reachable]");
  });

  it("an undecryptable canonical secret fails with value-free remediation instead of a config skip", async () => {
    installSecretsKey();
    writePlaintextSecret("TELEGRAM_BOT_TOKEN", "ENC:" + Buffer.from("undecryptable-tg-sentinel").toString("base64"));

    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const p = platformsProbe(result);
    expect(p.status).toBe("failed");
    expect(p.evidence).toBe("filesystem");
    expect(p.detail).toContain("telegram: failed");
    expect(p.detail).toContain("credential unreadable");
    expect(p.remediation).toContain("~/.abtars/secret/TELEGRAM_BOT_TOKEN");
    expect(JSON.stringify(p)).not.toContain("undecryptable-tg-sentinel");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an authoritative 401 rejection fails with invalid token and exits non-zero", async () => {
    await writeEncryptedSecret("TELEGRAM_BOT_TOKEN", "invalid-tg-fixture");
    fetchMock.mockResolvedValue(fakeResponse(401));

    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const p = platformsProbe(result);
    expect(p.status).toBe("failed");
    expect(p.evidence).toBe("reachable");
    expect(p.detail).toContain("invalid token");
    const { computeExitCode } = await import("./doctor-render.js");
    expect(computeExitCode(result)).toBe(1);
  });

  it("telegram 404 counts as an invalid token (credential is part of the getMe route)", async () => {
    await writeEncryptedSecret("TELEGRAM_BOT_TOKEN", "notfound-tg-fixture");
    fetchMock.mockResolvedValue(fakeResponse(404));

    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const p = platformsProbe(result);
    expect(p.status).toBe("failed");
    expect(p.detail).toContain("invalid token");
  });

  it("network failures warn as unreachable and never leak a credential from the provider error", async () => {
    await writeEncryptedSecret("TELEGRAM_BOT_TOKEN", "network-tg-fixture");
    // The provider error itself carries the credential in its message — it
    // must be sanitized before any doctor output.
    fetchMock.mockRejectedValue(new TypeError("fetch failed: https://api.telegram.org/botnetwork-tg-fixture/getMe"));

    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const p = platformsProbe(result);
    expect(p.status).toBe("warning");
    expect(p.evidence).toBe("reachable");
    expect(p.detail).toContain("unreachable");
    expect(JSON.stringify(p)).not.toContain("network-tg-fixture");
  });

  it("enforces the 15-second bound with fake time and leaves no pending timer after abort or success", async () => {
    await writeEncryptedSecret("TELEGRAM_BOT_TOKEN", "timeout-tg-fixture");
    fetchMock.mockImplementation((_url: unknown, opts: unknown) =>
      new Promise((_resolve, reject) => {
        (opts as { signal: AbortSignal }).signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
      }));

    vi.useFakeTimers();
    const { runAllProbes } = await import("./doctor-probes.js");

    const abortedRun = runAllProbes();
    await vi.advanceTimersByTimeAsync(15000);
    const abortedResult = await abortedRun;
    expect(platformsProbe(abortedResult).status).toBe("warning");
    expect(platformsProbe(abortedResult).detail).toContain("unreachable");
    expect(vi.getTimerCount()).toBe(0);

    fetchMock.mockResolvedValue(fakeResponse(200));
    const okResult = await runAllProbes();
    expect(platformsProbe(okResult).status).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("mixes filesystem and reachable outcomes, keeping per-platform detail as the source of truth", async () => {
    installSecretsKey();
    writePlaintextSecret("TELEGRAM_BOT_TOKEN", "ENC:" + Buffer.from("mixed-tg-sentinel").toString("base64"));
    await writeEncryptedSecret("DISCORD_BOT_TOKEN", "mixed-discord-fixture");
    fetchMock.mockResolvedValue(fakeResponse(200));

    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const p = platformsProbe(result);
    expect(p.status).toBe("failed");
    expect(p.evidence).toBe("reachable");
    expect(p.detail).toContain("telegram: failed (credential unreadable)");
    expect(p.detail).toContain("discord: ok");
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});

describe("doctor mind probe is endpoint health, not package availability (#1662)", () => {
  type MindResult = { status: string; evidence: string; detail: string; remediation?: string };

  async function mindProbe(): Promise<MindResult> {
    const { runAllProbes } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const probe = result.layers.soul.find(r => r.name === "mind");
    if (!probe) throw new Error("mind probe missing");
    return probe;
  }

  function recallRuntime(overrides: Record<string, unknown> = {}): any {
    const supports = (capability: string) => capability === "recall";
    return { supports, ...overrides };
  }

  function fakeLocalClient(): { close: ReturnType<typeof vi.fn> } {
    return { close: vi.fn().mockResolvedValue(undefined) };
  }

  it("a rejected endpoint factory renders mind as failed with no green line (escaped regression)", async () => {
    mindFactoryRef.current = async () => { throw new phaseMemoryRef.current.MemoryEndpointUnavailableError("endpoint_unavailable", "fixture"); };
    const { runAllProbes, } = await import("./doctor-probes.js");
    const result = await runAllProbes();
    const mind = result.layers.soul.find(r => r.name === "mind")!;

    expect(mind.status).toBe("failed");
    expect(mind.evidence).toBe("reachable");
    expect(mind.detail).toBe("abmind endpoint unavailable");

    const { renderHuman } = await import("./doctor-render.js");
    const human = renderHuman(result);
    const mindLine = human.split("\n").find(l => l.includes("mind")) ?? "";
    expect(mindLine).toContain("✗ mind");
    expect(mindLine).not.toContain("✓ mind");
    expect(mindLine).toContain("[reachable]");
  });

  it("a negotiated recall-capable local endpoint reports endpoint readiness and closes the client once", async () => {
    const client = fakeLocalClient();
    mindFactoryRef.current = async () => ({
      mode: "local",
      client,
      runtime: recallRuntime(),
      abmindModule: null,
    });

    const mind = await mindProbe();
    expect(mind.status).toBe("ok");
    expect(mind.evidence).toBe("runtime");
    expect(mind.detail).toBe("abmind endpoint ready (local)");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("negotiation without the recall capability maps to runtime incompatibility and still closes", async () => {
    const client = fakeLocalClient();
    mindFactoryRef.current = async () => ({
      mode: "local",
      client,
      runtime: recallRuntime({ supports: () => false }),
      abmindModule: null,
    });

    const mind = await mindProbe();
    expect(mind.status).toBe("failed");
    expect(mind.evidence).toBe("runtime");
    expect(mind.detail).toBe("abmind endpoint incompatible");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("MEMORY=none skips without resolving the endpoint, importing, or connecting", async () => {
    process.env["MEMORY"] = "none";
    const resolveSpy = vi.fn();
    mindEndpointRef.current = resolveSpy;
    const factorySpy = vi.fn();
    mindFactoryRef.current = factorySpy;

    try {
      const mind = await mindProbe();
      expect(mind.status).toBe("skipped");
      expect(mind.evidence).toBe("configuration");
      expect(mind.detail).toBe("memory disabled");
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(factorySpy).not.toHaveBeenCalled();
    } finally {
      delete process.env["MEMORY"];
    }
  });

  it("MEMORY from the .env file disables the probe while process.env wins over it", async () => {
    // .env-only: memory disabled → skipped.
    writeFileSync(join(tmpDir, "config", ".env"), "MEMORY=none\n");
    const factorySpy = vi.fn();
    mindFactoryRef.current = factorySpy;
    expect((await mindProbe()).status).toBe("skipped");

    // process.env override: memory expected → probe proceeds (no skip).
    process.env["MEMORY"] = "abmind";
    const mind = await mindProbe();
    expect(mind.status).not.toBe("skipped");
    expect(factorySpy).toHaveBeenCalled();
    delete process.env["MEMORY"];
  });

  it("invalid endpoint configuration maps to a bounded configuration failure", async () => {
    // Fresh post-reset import — the same class instance the probe's instanceof sees.
    const { AbmindEndpointConfigError } = await import("../../components/abmind-endpoint-config.js");
    mindEndpointRef.current = () => {
      throw new AbmindEndpointConfigError(
        "credentials_unsafe",
        "/home/user/.abtars/config/abmind.json is a symlink",
      );
    };
    const factorySpy = vi.fn();
    mindFactoryRef.current = factorySpy;

    const mind = await mindProbe();
    expect(mind.status).toBe("failed");
    expect(mind.evidence).toBe("configuration");
    expect(mind.detail).toBe("abmind endpoint config rejected (credentials_unsafe)");
    expect(factorySpy).not.toHaveBeenCalled();
    // The raw reason (credential paths) must never escape into output.
    expect(JSON.stringify(mind)).not.toContain("symlink");
    expect(JSON.stringify(mind)).not.toContain("/home/user");
  });

  it("a missing local abmind package maps to an executable failure, not a skip", async () => {
    mindFactoryRef.current = async () => { throw new phaseMemoryRef.current.AbmindModuleMissingError(); };

    const mind = await mindProbe();
    expect(mind.status).toBe("failed");
    expect(mind.evidence).toBe("executable");
    expect(mind.detail).toBe("abmind package unavailable");
  });

  it("a wss descriptor rides the shared factory path without a local module and reports wss readiness", async () => {
    const wssEndpoint = {
      mode: "wss",
      source: "explicit",
      profileName: "primary",
      profile: {
        url: "wss://memory.example.invalid/ws",
        peerId: "abtars-test",
        signingKeyFile: "/tmp/key.pem",
        serverCertSha256: "a".repeat(64),
      },
    };
    mindEndpointRef.current = () => wssEndpoint;
    const client = fakeLocalClient();
    const factorySpy = vi.fn().mockResolvedValue({
      mode: "wss",
      client,
      runtime: recallRuntime(),
      abmindModule: null,
    });
    mindFactoryRef.current = factorySpy;

    const mind = await mindProbe();
    expect(mind.status).toBe("ok");
    expect(mind.evidence).toBe("runtime");
    expect(mind.detail).toBe("abmind endpoint ready (wss)");
    expect(factorySpy).toHaveBeenCalledWith(wssEndpoint, tmpDir);
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
