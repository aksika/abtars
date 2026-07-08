/**
 * peer-config.test.ts — unit tests for #1293 schema + boot bootstrap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to control abtarsHome() to point at a temp dir
const TEST_HOME = join(tmpdir(), `abtars-peer-config-test-${process.pid}`);

vi.mock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
// Logger — suppress output in tests
vi.mock("./logger.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

async function freshImport() {
  // Clear module cache between tests
  vi.resetModules();
  const mod = await import("./peer-config.js");
  mod.clearPeerConfigCache();
  return mod;
}

beforeEach(() => {
  mkdirSync(join(TEST_HOME, "config"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("peer-config bootstrap", () => {
  it("generates signingKey and tribeToken when peers.json is absent", async () => {
    const { loadPeerConfig } = await freshImport();
    const config = loadPeerConfig();
    expect(typeof config.self.signingKey).toBe("string");
    expect(config.self.signingKey.length).toBeGreaterThan(40);
    expect(typeof config.self.tribeToken).toBe("string");
    expect(config.self.tribeToken.length).toBeGreaterThan(20);
  });

  it("persists generated keys to peers.json (chmod 600)", async () => {
    const { loadPeerConfig } = await freshImport();
    loadPeerConfig();
    const p = join(TEST_HOME, "config", "peers.json");
    expect(existsSync(p)).toBe(true);
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    expect(typeof raw.self.signingKey).toBe("string");
    expect(typeof raw.self.tribeToken).toBe("string");
  });

  it("does not regenerate keys on second load", async () => {
    const { loadPeerConfig, clearPeerConfigCache } = await freshImport();
    const a = loadPeerConfig();
    clearPeerConfigCache();
    const b = loadPeerConfig();
    expect(b.self.signingKey).toBe(a.self.signingKey);
    expect(b.self.tribeToken).toBe(a.self.tribeToken);
  });

  it("generates missing tribeToken when signingKey already exists", async () => {
    const p = join(TEST_HOME, "config", "peers.json");
    writeFileSync(p, JSON.stringify({
      self: { name: "KP", signingKey: "existingkey123" },
      peers: {},
    }));
    const { loadPeerConfig } = await freshImport();
    const config = loadPeerConfig();
    expect(config.self.signingKey).toBe("existingkey123");
    expect(typeof config.self.tribeToken).toBe("string");
    expect(config.self.tribeToken.length).toBeGreaterThan(0);
  });
});

describe("peer-config schema", () => {
  it("parses a valid new-schema peers.json", async () => {
    const p = join(TEST_HOME, "config", "peers.json");
    writeFileSync(p, JSON.stringify({
      self: { name: "KP", signingKey: "priv123", tribeToken: "tok123" },
      peers: {
        molty: { host: "100.82.167.127", port: 7100, verifyKey: "pub456", trust: 1 },
      },
      maxHops: 12,
      timeoutMs: 60000,
    }));
    const { loadPeerConfig } = await freshImport();
    const config = loadPeerConfig();
    expect(config.self.name).toBe("KP");
    expect(config.self.signingKey).toBe("priv123");
    expect(config.self.tribeToken).toBe("tok123");
    expect(config.peers["molty"]?.verifyKey).toBe("pub456");
    expect(config.peers["molty"]?.trust).toBe(1);
    expect(config.peers["molty"]?.host).toBe("100.82.167.127");
  });

  it("skips peers missing host/port/verifyKey", async () => {
    const p = join(TEST_HOME, "config", "peers.json");
    writeFileSync(p, JSON.stringify({
      self: { name: "KP", signingKey: "k", tribeToken: "t" },
      peers: {
        bad: { host: "1.2.3.4" }, // missing port + verifyKey
        good: { host: "5.6.7.8", port: 7100, verifyKey: "abc" },
      },
    }));
    const { loadPeerConfig } = await freshImport();
    const config = loadPeerConfig();
    expect(config.peers["bad"]).toBeUndefined();
    expect(config.peers["good"]).toBeDefined();
  });

  it("does not expose token/gossipSecret/certPem fields", async () => {
    const p = join(TEST_HOME, "config", "peers.json");
    writeFileSync(p, JSON.stringify({
      self: { name: "KP", signingKey: "k", tribeToken: "t", gossipSecret: "old" },
      peers: {
        molty: { host: "1.2.3.4", port: 7100, verifyKey: "pub", token: "legacytok", certPem: "pem" },
      },
    }));
    const { loadPeerConfig } = await freshImport();
    const config = loadPeerConfig();
    // Legacy fields must not be carried into the typed config
    expect((config.self as Record<string, unknown>)["gossipSecret"]).toBeUndefined();
    const molty = config.peers["molty"] as Record<string, unknown>;
    expect(molty["token"]).toBeUndefined();
    expect(molty["certPem"]).toBeUndefined();
    expect(molty["certFingerprint"]).toBeUndefined();
  });

  it("parses optional transport ws-outbound", async () => {
    const p = join(TEST_HOME, "config", "peers.json");
    writeFileSync(p, JSON.stringify({
      self: { name: "KP", signingKey: "k", tribeToken: "t" },
      peers: {
        molty: { host: "1.2.3.4", port: 7100, verifyKey: "pub", transport: "ws-outbound" },
      },
    }));
    const { loadPeerConfig } = await freshImport();
    const config = loadPeerConfig();
    expect(config.peers["molty"]?.transport).toBe("ws-outbound");
  });
});

describe("deriveVerifyKey", () => {
  it("derives a stable public key from a generated signing key", async () => {
    const { loadPeerConfig, deriveVerifyKey } = await freshImport();
    const config = loadPeerConfig();
    const pub = deriveVerifyKey(config.self.signingKey);
    expect(typeof pub).toBe("string");
    expect(pub.length).toBeGreaterThan(40);
    // Deterministic — same input gives same output
    expect(deriveVerifyKey(config.self.signingKey)).toBe(pub);
  });
});
