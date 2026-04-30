import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { DashboardConfig, StatusSnapshot } from "./dashboard-config.js";
import { AuthGate } from "../auth-gate.js";
import { DashboardServer } from "./dashboard-server.js";
import type { DashboardServerDeps } from "./dashboard-server.js";
import type { ServiceRegistry } from "../service-registry.js";
import type { MemorySearchController } from "../memory-search-controller.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_TOKEN = "test-secret-token";

function makeConfig(overrides?: Partial<DashboardConfig>): DashboardConfig {
  return {
    webPort: 0, // OS-assigned port for tests
    webHost: "127.0.0.1",
    webAuthToken: TEST_TOKEN,
    webPushIntervalMs: 60000,
    ...overrides,
  };
}

function makeSnapshot(): StatusSnapshot {
  return {
    timestamp: new Date().toISOString(),
    uptimeMs: 1000,
    platforms: {
      telegram: { configured: true, running: false },
      discord: { configured: false, running: false },
    },
    services: {
      telegram: { configured: true, running: false },
      discord: { configured: false, running: false },
    },
    transport: { type: "tmux", ready: true, contextPercent: 42 },
    memory: { enabled: false, stats: null },
    heartbeat: { running: false, intervalMs: 60000, taskNames: [] },
  };
}

function mockRegistry(): ServiceRegistry {
  return {
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(() => ({ ok: true })),
    getStates: vi.fn(() => ({
      telegram: { configured: true, running: false },
      discord: { configured: false, running: false },
    })),
  } as unknown as ServiceRegistry;
}

function mockMemorySearchController(): MemorySearchController {
  return {
    handle: vi.fn(async () => ({
      status: 200,
      body: { results: [], layers: {} },
    })),
  } as unknown as MemorySearchController;
}

function makeDeps(overrides?: Partial<DashboardServerDeps>): DashboardServerDeps {
  return {
    config: makeConfig(),
    authGate: new AuthGate(TEST_TOKEN),
    getStatus: makeSnapshot,
    registry: mockRegistry(),
    memorySearchController: mockMemorySearchController(),
    agentApiConfig: null,
    ...overrides,
  };
}

/** Make an HTTP request to the test server. */
function request(
  port: number,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Get the actual port the server is listening on (for port 0). */
function getPort(server: DashboardServer): number {
  const addr = (server as any).server?.address();
  return typeof addr === "object" ? addr.port : 0;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("DashboardServer", () => {
  let server: DashboardServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  // ── Lifecycle ───────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("starts and stops without error", async () => {
      server = new DashboardServer(makeDeps());
      await server.start();
      const port = getPort(server);
      expect(port).toBeGreaterThan(0);
      await server.stop();
    });

    it("exposes the broadcaster", () => {
      server = new DashboardServer(makeDeps());
      expect(server.broadcaster).toBeDefined();
      expect(server.broadcaster.clientCount).toBe(0);
    });
  });

  // ── GET / ─────────────────────────────────────────────────────────

  describe("GET /", () => {
    it("serves dashboard HTML without authentication", async () => {
      server = new DashboardServer(makeDeps());
      await server.start();
      const port = getPort(server);

      const res = await request(port, { path: "/" });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("Kiro Professor Dashboard");
    });
  });

  // ── 404 for unknown routes ────────────────────────────────────────

  describe("unknown routes", () => {
    it("returns 404 JSON for unknown paths", async () => {
      server = new DashboardServer(makeDeps());
      await server.start();
      const port = getPort(server);

      const res = await request(port, { path: "/nonexistent" });

      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Not found");
    });

    it("returns 404 for GET /api/unknown", async () => {
      server = new DashboardServer(makeDeps());
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        path: "/api/unknown",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(res.status).toBe(404);
    });
  });

  // ── Authentication ────────────────────────────────────────────────

  describe("authentication", () => {
    it("returns 401 for API routes without token", async () => {
      server = new DashboardServer(makeDeps());
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/services/telegram/start",
      });

      expect(res.status).toBe(401);
    });

    it("returns 401 for API routes with wrong token", async () => {
      server = new DashboardServer(makeDeps());
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/services/telegram/start",
        headers: { Authorization: "Bearer wrong-token" },
      });

      expect(res.status).toBe(401);
    });
  });

  // ── Service registry routes ───────────────────────────────────────

  describe("POST /api/services/:name/:action", () => {
    it("routes start to service registry with auth", async () => {
      const reg = mockRegistry();
      server = new DashboardServer(makeDeps({ registry: reg }));
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/services/telegram/start",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(res.status).toBe(200);
      expect(reg.start).toHaveBeenCalledWith("telegram");
    });

    it("routes stop to service registry", async () => {
      const reg = mockRegistry();
      server = new DashboardServer(makeDeps({ registry: reg }));
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/services/discord/stop",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(res.status).toBe(200);
      expect(reg.stop).toHaveBeenCalledWith("discord");
    });
  });

  // ── Memory search routes ──────────────────────────────────────────

  describe("GET /api/memory/search", () => {
    it("routes to memory search controller with query params", async () => {
      const msc = mockMemorySearchController();
      server = new DashboardServer(makeDeps({ memorySearchController: msc }));
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        path: "/api/memory/search?keywords=test&chatId=1",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(res.status).toBe(200);
      expect(msc.handle).toHaveBeenCalledOnce();
    });

    it("returns 409 when memory search controller is null", async () => {
      server = new DashboardServer(makeDeps({ memorySearchController: null }));
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        path: "/api/memory/search?keywords=test&chatId=1",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(res.status).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("memory not enabled");
    });
  });

  // ── Error handling ────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns 500 when service registry throws", async () => {
      const reg = mockRegistry();
      (reg.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("boom"),
      );
      server = new DashboardServer(makeDeps({ registry: reg }));
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/services/telegram/start",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(res.status).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("boom");
    });
  });
});

// Feature: kiro-professor-webui, Property 9: Unknown route returns 404
import fc from "fast-check";

describe("DashboardServer — Property 9: Unknown route returns 404", () => {
  let server: DashboardServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  // Known route patterns that should NOT return 404
  const knownRoutePatterns = [
    /^\/$/,                                    // GET /
    /^\/ws$/,                                  // WebSocket upgrade
    /^\/api\/memory\/search/,                  // GET /api/memory/search
    /^\/api\/platforms\/[^/]+\/[^/]+$/,        // POST /api/services/:name/:action (legacy pattern)
    /^\/api\/services\/[^/]+\/[^/]+$/,        // POST /api/services/:name/:action
  ];

  function isKnownRoute(path: string): boolean {
    return knownRoutePatterns.some((re) => re.test(path));
  }

  // Arbitrary that generates URL-safe path strings excluding known routes
  const unknownPathArb = fc
    .array(
      fc.string({
        unit: fc.constantFrom(
          ..."abcdefghijklmnopqrstuvwxyz0123456789-_.~".split(""),
        ),
        minLength: 1,
        maxLength: 12,
      }),
      { minLength: 1, maxLength: 4 },
    )
    .map((segments) => "/" + segments.join("/"))
    .filter((path) => !isKnownRoute(path));

  // **Validates: Requirements 2.3**
  it("returns 404 for any path not matching a known route", async () => {
    server = new DashboardServer(makeDeps());
    await server.start();
    const port = getPort(server);

    await fc.assert(
      fc.asyncProperty(unknownPathArb, async (path) => {
        const res = await request(port, { path });
        expect(res.status).toBe(404);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("Not found");
      }),
      { numRuns: 50 },
    );
  });
});
