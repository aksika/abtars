import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentApiServer } from "./agent-api-server.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValidatedTlsIdentity } from "./peer-transport/tls-identity.js";

const originalHome = process.env.HOME;

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      port: 0,
      allowedIps: ["127.0.0.1"],
      token: "test-token",
      agentCodename: "test-agent",
      ...overrides,
    },
    cliPath: "kiro-cli",
    workingDir: "/tmp",
    memory: null,
  };
}

// Generate a minimal self-signed TLS identity for testing
function makeTestTls(configDir: string): ValidatedTlsIdentity {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");

  const { privateKey: privKeyObj } = generateKeyPairSync("ed25519");
  const keyPem = privKeyObj.export({ type: "pkcs8", format: "pem" }) as string;
  writeFileSync(join(configDir, "identity.tls.key"), keyPem, { mode: 0o600 });
  execSync(
    `openssl req -x509 -key "${join(configDir, "identity.tls.key")}" -out "${join(configDir, "identity.crt")}" -days 3650 -nodes -subj "/CN=test"`,
    { stdio: "pipe" },
  );
  return {
    key: keyPem,
    cert: require("node:fs").readFileSync(join(configDir, "identity.crt"), "utf-8") as string,
    verifyKey: "test",
    certificateNotBefore: new Date("2020-01-01"),
    certificateNotAfter: new Date("2035-01-01"),
  };
}

describe("AgentApiServer", () => {
  let tmpDir: string;
  let server: AgentApiServer;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agentapi-test-"));
    process.env.HOME = tmpDir;
    mkdirSync(join(tmpDir, ".abtars", "logs"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    try { await server?.stop(); } catch { /* ok */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts and stops without error", async () => {
    server = new AgentApiServer({ ...makeConfig(), tls: makeTestTls(tmpDir) });
    await server.start();
    await server.stop();
  });

  it("getTrafficLog returns empty array initially", () => {
    server = new AgentApiServer({ ...makeConfig(), tls: makeTestTls(tmpDir) });
    expect(server.getTrafficLog()).toEqual([]);
  });

  it("IP check allows localhost even when not in allowedIps", async () => {
    const origReject = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    try {
      server = new AgentApiServer({ ...makeConfig({ allowedIps: ["10.0.0.1"] }), tls: makeTestTls(tmpDir) });
      await server.start();
      const addr = (server as any).server.address();
      const res = await fetch(`https://127.0.0.1:${addr.port}/v1/models`);
      expect(res.status).not.toBe(403);
    } finally {
      process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = origReject;
    }
  });

  it("returns 404 for unknown routes", async () => {
    const origReject = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    try {
      server = new AgentApiServer({ ...makeConfig(), tls: makeTestTls(tmpDir) });
      await server.start();
      const addr = (server as any).server.address();
      const res = await fetch(`https://127.0.0.1:${addr.port}/nonexistent`);
      expect(res.status).toBe(404);
    } finally {
      process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = origReject;
    }
  });
});
