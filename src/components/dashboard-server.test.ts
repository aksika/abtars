import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { DashboardConfig, StatusSnapshot } from "./dashboard-config.js";
import { AuthGate } from "./auth-gate.js";
import { DashboardServer } from "./dashboard-server.js";
import type { DashboardServerDeps } from "./dashboard-server.js";
import type { PlatformController } from "./platform-controller.js";
import type { TransportController } from "./transport-controller.js";
import type { MemorySearchController } from "./memory-search-controller.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_TOKEN = "test-secret-token";
const TEST_HTML = "<html><body>Dashboard</body></html>";

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
    transport: { type: "tmux", ready: true, contextPercent: 42 },
    memory: { enabled: false, stats: null },
    heartbeat: { running: false, intervalMs: 60000, taskNames: [] },
  };
}

function mockPlatformController(): PlatformController {
  return {
    handle: vi.fn(async () => ({ status: 200, body: { platform: "telegram", running: true } })),
    getStates: vi.fn(() => ({
      telegram: { configured: true, running: false },
      discord: { configured: false, running: false },
    })),
  } as unknown as PlatformController;
}

function mockTransportController(): TransportController {
  return {
    handle: vi.fn(async () => ({
      status: 200,
      body: { message: "Switched to acp transport", switched: true },
    })),
    getTransportStatus: vi.fn(() => ({
      type: "tmux" as const,
      ready: true,
      contextPercent: 42,
    })),
  } as unknown as TransportController;
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
    platformController: mockPlatformController(),
    transportController: mockTransportController(),
    memorySearchController: mockMemorySearchController(),
    dashboardHtml: TEST_HTML,
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
      expect(res.body).toBe(TEST_HTML);
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
        path: "/api/platforms/telegram/start",
      });

      expect(res.status).toBe(401);
    });

    it("returns 401 for API routes with wrong token", async () => {
      server = new DashboardServer(makeDeps());
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/platforms/telegram/start",
        headers: { Authorization: "Bearer wrong-token" },
      });

      expect(res.status).toBe(401);
    });
  });

  // ── Platform controller routes ────────────────────────────────────

  describe("POST /api/platforms/:platform/:action", () => {
    it("routes to platform controller with auth", async () => {
      const pc = mockPlatformController();
      server = new DashboardServer(makeDeps({ platformController: pc }));
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/platforms/telegram/start",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(res.status).toBe(200);
      expect(pc.handle).toHaveBeenCalledWith("telegram", "start");
    });

    it("routes discord stop to platform controller", async () => {
      const pc = mockPlatformController();
      server = new DashboardServer(makeDeps({ platformController: pc }));
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/platforms/discord/stop",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(res.status).toBe(200);
      expect(pc.handle).toHaveBeenCalledWith("discord", "stop");
    });
  });

  // ── Transport controller routes ───────────────────────────────────

  describe("POST /api/transport/switch", () => {
    it("routes to transport controller with parsed JSON body", async () => {
      const tc = mockTransportController();
      server = new DashboardServer(makeDeps({ transportController: tc }));
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/transport/switch",
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "acp" }),
      });

      expect(res.status).toBe(200);
      expect(tc.handle).toHaveBeenCalledWith("acp");
    });

    it("returns 400 for invalid mode", async () => {
      server = new DashboardServer(makeDeps());
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/transport/switch",
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "invalid" }),
      });

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("Invalid mode");
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
    it("returns 500 when platform controller throws", async () => {
      const pc = mockPlatformController();
      (pc.handle as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("boom"),
      );
      server = new DashboardServer(makeDeps({ platformController: pc }));
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/platforms/telegram/start",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      expect(res.status).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("boom");
    });

    it("returns 500 when transport controller throws", async () => {
      const tc = mockTransportController();
      (tc.handle as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("transport fail"),
      );
      server = new DashboardServer(makeDeps({ transportController: tc }));
      await server.start();
      const port = getPort(server);

      const res = await request(port, {
        method: "POST",
        path: "/api/transport/switch",
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "tmux" }),
      });

      expect(res.status).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("transport fail");
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
    /^\/api\/platforms\/[^/]+\/[^/]+$/,        // POST /api/platforms/:platform/:action
    /^\/api\/transport\/switch$/,              // POST /api/transport/switch
  ];

  function isKnownRoute(path: string): boolean {
    return knownRoutePatterns.some((re) => re.test(path));
  }

  // Arbitrary that generates URL-safe path strings excluding known routes
  const unknownPathArb = fc
    .array(
      fc.stringOf(
        fc.constantFrom(
          ..."abcdefghijklmnopqrstuvwxyz0123456789-_.~".split(""),
        ),
        { minLength: 1, maxLength: 12 },
      ),
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
