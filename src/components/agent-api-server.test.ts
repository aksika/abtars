import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentApiServer } from "./agent-api-server.js";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    server = new AgentApiServer(makeConfig());
    await server.start();
    await server.stop();
  });

  it("getTrafficLog returns empty array initially", () => {
    server = new AgentApiServer(makeConfig());
    expect(server.getTrafficLog()).toEqual([]);
  });

  it("IP check allows localhost even when not in allowedIps", async () => {
    server = new AgentApiServer(makeConfig({ allowedIps: ["10.0.0.1"] }));
    await server.start();
    const addr = (server as any).server.address();
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/models`);
    // localhost is always allowed (hardcoded bypass)
    expect(res.status).not.toBe(403);
  });

  it("returns 404 for unknown routes", async () => {
    server = new AgentApiServer(makeConfig());
    await server.start();
    const addr = (server as any).server.address();
    const res = await fetch(`http://127.0.0.1:${addr.port}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
