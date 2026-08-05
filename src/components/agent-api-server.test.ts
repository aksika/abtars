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
    memoryRuntime: null,
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

  /**
   * #1549 — /v1/orc/* and /v1/kanban carry no peer signature and were relying
   * on a comment claiming "localhost only" while start() binds every
   * interface. These assert the guard that now enforces it. The address cases
   * are driven through the real guard rather than a mock because the decision
   * itself is the security invariant.
   */
  describe("requireLoopback guard (#1549)", () => {
    function fakeExchange(remoteAddress: string | undefined) {
      const written: { status?: number; body?: string } = {};
      const req = { socket: { remoteAddress }, method: "POST", url: "/v1/kanban" } as any;
      const res = {
        writeHead(status: number) { written.status = status; return this; },
        end(body?: string) { written.body = body; },
      } as any;
      return { req, res, written };
    }

    beforeEach(() => {
      server = new AgentApiServer({ ...makeConfig(), tls: makeTestTls(tmpDir) });
    });

    it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1", undefined])(
      "admits loopback caller %s",
      (addr) => {
        const { req, res, written } = fakeExchange(addr as string | undefined);
        expect((server as any).requireLoopback(req, res)).toBe(true);
        expect(written.status).toBeUndefined();
      },
    );

    it.each(["100.82.167.127", "192.168.1.50", "10.0.0.1", "::ffff:100.82.167.127"])(
      "rejects non-loopback caller %s with 401 and no handler dispatch",
      (addr) => {
        const { req, res, written } = fakeExchange(addr);
        expect((server as any).requireLoopback(req, res)).toBe(false);
        expect(written.status).toBe(401);
        expect(written.body).toContain("loopback only");
      },
    );

    it("still admits the local CLI path that legitimately posts kanban cards", async () => {
      const origReject = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
      process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
      try {
        await server.start();
        const addr = (server as any).server.address();
        const res = await fetch(`https://127.0.0.1:${addr.port}/v1/kanban`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "task", title: "t", goal: "g" }),
        });
        // The guard must not be what stops a loopback caller. Any other
        // outcome (201 created, 400 validation, 500 no-db) is acceptable here;
        // a 401 would mean the fix broke the only real caller.
        expect(res.status).not.toBe(401);
      } finally {
        process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = origReject;
      }
    });

    /**
     * The cases above prove the guard decides correctly; these prove the two
     * routes actually consult it. A real HTTPS client cannot present a remote
     * source address from a test, so the request is driven through the real
     * route chain in handle() with a synthetic socket instead of a mock guard.
     */
    describe.each([
      ["GET", "/v1/orc/status"],
      ["POST", "/v1/orc/spawn"],
      ["POST", "/v1/kanban"],
    ])("%s %s", (method, url) => {
      it("is refused for a remote caller before any handler runs", () => {
        const written: { status?: number; body?: string } = {};
        let dispatched = false;
        // If the guard is missing, these run and flip the flag.
        (server as any).handleOrcRoute = () => { dispatched = true; };
        (server as any).handleAsync = () => { dispatched = true; };

        const req = {
          url, method,
          headers: {},
          socket: { remoteAddress: "100.82.167.127" },
          on() { return this; },
        } as any;
        const res = {
          writeHead(status: number) { written.status = status; return this; },
          end(body?: string) { written.body = body; },
          headersSent: false,
        } as any;

        (server as any).handle(req, res);

        expect(written.status).toBe(401);
        expect(dispatched).toBe(false);
      });
    });
  });
});
