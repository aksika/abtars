import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpsServer, type Server } from "node:https";
import { WebSocketServer } from "ws";
import { AbtarsSignedWssClient } from "./abmind-signed-wss-client.js";
import { AbmindRequestOutbox } from "./abmind-request-outbox.js";
import type { WssProfile } from "./abmind-endpoint-config.js";

let uid = 0;

interface FakeServerOpts {
  respond?: (frameId: string, inner: { method?: string; requestId?: string }) => { id: string; body: string } | null;
  dropAfterHello?: boolean;
  dropAfterRequest?: boolean;
  port?: number;
}

interface FakeServer {
  port: number;
  server: Server;
  wss: WebSocketServer;
  frames: Array<{ id: string; auth: { nonce: string; ts: string; sig: string }; body: string }>;
  close: () => Promise<void>;
}

async function startFakeServer(root: string, opts: FakeServerOpts = {}): Promise<FakeServer> {
  const keyPath = join(root, "tls-key.pem");
  const certPath = join(root, "tls-cert.pem");
  if (!existsSync(keyPath)) {
    execSync(
      `openssl req -x509 -newkey ed25519 -nodes -keyout ${keyPath} -out ${certPath} -subj /CN=localhost -days 1`,
      { stdio: "ignore" },
    );
    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o600);
  }

  const server: Server = createHttpsServer({
    key: readFileSync(keyPath, "utf-8"),
    cert: readFileSync(certPath, "utf-8"),
    minVersion: "TLSv1.3" as const,
  });
  const wss = new WebSocketServer({ server });
  const frames: FakeServer["frames"] = [];

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({
      type: "challenge", version: 1,
      connectionId: "conn-1", challenge: "c".repeat(64), expiresAt: Date.now() + 30_000,
    }));
    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
      const msg = JSON.parse(data.toString("utf-8")) as Record<string, unknown>;
      if (msg.type === "hello") {
        socket.send(JSON.stringify({ type: "hello_ack", version: 1, peerId: msg.peerId }));
        if (opts.dropAfterHello) socket.close();
        return;
      }
      if (msg.type === "request" && msg.version === 1) {
        frames.push({
          id: msg.id as string,
          auth: msg.auth as { nonce: string; ts: string; sig: string },
          body: msg.body as string,
        });
        const inner = JSON.parse(msg.body as string) as { method?: string; requestId?: string };
        if (opts.dropAfterRequest && inner.method !== "system.negotiate") { socket.close(); return; }
        if (opts.dropAfterHello) return;
        const reply = opts.respond?.(msg.id as string, inner);
        if (reply) socket.send(JSON.stringify({ type: "response", version: 1, id: reply.id, body: reply.body }));
      }
    });
  });

  const port = opts.port ?? await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    server.on("error", reject);
  });
  if (opts.port !== undefined) {
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  }

  return {
    port,
    server,
    wss,
    frames,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function derPin(root: string): string {
  const certPath = join(root, "tls-cert.pem");
  const der = execSync(`openssl x509 -in ${certPath} -outform DER`) as Buffer;
  return createHash("sha256").update(der).digest("hex");
}

function profile(root: string, port: number): WssProfile {
  return {
    url: `wss://127.0.0.1:${port}`,
    peerId: "abtars-test",
    signingKeyFile: join(root, "client-ed25519.pem"),
    serverCertSha256: derPin(root),
  };
}

function genClientKey(root: string): void {
  execSync(`openssl genpkey -algorithm ed25519 -out ${join(root, "client-ed25519.pem")}`, { stdio: "ignore" });
  chmodSync(join(root, "client-ed25519.pem"), 0o600);
}

const FAST = {
  requestTimeoutMs: 60,
  retryBaseMs: 5,
  retryMaxMs: 20,
  retryMaxAttempts: 3,
  reconnectBaseMs: 5,
  reconnectMaxMs: 20,
  reconnectMaxAttempts: 10,
};

function negotiateReply(frameId: string, inner: { method?: string; requestId?: string }) {
  if (inner.method === "system.negotiate") {
    return {
      id: frameId,
      body: JSON.stringify({
        ok: true, requestId: inner.requestId,
        result: { version: 1, methods: ["private.recall"], features: { private_read: "true" } },
      }),
    };
  }
  return {
    id: frameId,
    body: JSON.stringify({ ok: true, requestId: inner.requestId, result: { ok: true } }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

describe("AbtarsSignedWssClient", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), `abtars-wss-${++uid}-`));
    mkdirSync(root, { recursive: true });
    genClientKey(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("negotiates capabilities and routes responses by outer frame ID", async () => {
    const server = await startFakeServer(root, { respond: negotiateReply });
    const client = new AbtarsSignedWssClient(profile(root, server.port), join(root, "outbox.json"));
    try {
      const caps = await client.negotiate();
      expect(caps.version).toBe(1);
      expect(caps.methods).toContain("private.recall");
      expect(server.frames.length).toBe(1);
      expect(server.frames[0]!.id).toMatch(/^f-ctrl-/);
      expect(server.frames[0]!.auth.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(client.routeSnapshot.state).toBe("ready");
      expect(client.routeSnapshot.generation).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("surfaces frame-level errors with the caller's request ID (unauthorized preserved)", async () => {
    const server = await startFakeServer(root, {
      respond: (frameId, inner) => {
        if (inner.method === "system.negotiate") return negotiateReply(frameId, inner);
        return {
          id: frameId,
          body: JSON.stringify({ ok: false, requestId: frameId, error: { code: "unauthorized", message: "Method not allowed" } }),
        };
      },
    });
    const client = new AbtarsSignedWssClient(profile(root, server.port), join(root, "outbox.json"));
    try {
      await client.negotiate();
      await expect(client.callRaw("private.cascadeDelete", { userId: "u", messageIds: [1] }, "k"))
        .rejects.toMatchObject({ code: "unauthorized" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("never settles a caller on an inner request-ID mismatch (outcome_unknown after budget)", async () => {
    const server = await startFakeServer(root, {
      respond: (frameId, inner) => {
        if (inner.method === "system.negotiate") return negotiateReply(frameId, inner);
        return {
          id: frameId,
          body: JSON.stringify({ ok: true, requestId: "different-inner-id", result: { ok: true } }),
        };
      },
    });
    const client = new AbtarsSignedWssClient(profile(root, server.port), join(root, "outbox.json"), {
      ...FAST,
      retryMaxAttempts: 1,
    });
    try {
      await client.negotiate();
      await expect(client.callRaw("system.status", {})).rejects.toMatchObject({ code: "outcome_unknown" });
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("rejects a server whose certificate does not match the pin", async () => {
    const server = await startFakeServer(root);
    const badProfile: WssProfile = {
      ...profile(root, server.port),
      serverCertSha256: "b".repeat(64),
    };
    const client = new AbtarsSignedWssClient(badProfile, join(root, "outbox.json"));
    try {
      await expect(client.negotiate()).rejects.toThrow(/pin/i);
      expect(client.routeSnapshot.state).toBe("unavailable");
      expect(client.routeSnapshot.reasonCode).toBe("pin_mismatch");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects every non-ready route state without durable work or connection attempts", async () => {
    const server = await startFakeServer(root, { respond: negotiateReply });
    const outboxPath = join(root, "outbox.json");
    const client = new AbtarsSignedWssClient(profile(root, server.port), outboxPath);
    try {
      // disconnected (never negotiated): fail closed, no entry, no connect.
      await expect(client.callRaw("system.status", {})).rejects.toMatchObject({ code: "unavailable" });
      expect(existsSync(outboxPath)).toBe(false);
      expect(server.frames.length).toBe(0);

      // Ready route, then dropped: admission stays closed during reconnect.
      await client.negotiate();
      await server.close();
      await waitFor(() => client.routeSnapshot.state !== "ready");
      await expect(client.callRaw("system.status", {})).rejects.toMatchObject({ code: "unavailable" });
      expect(existsSync(outboxPath)).toBe(false);
      expect(client.capabilities).toBeNull();
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("retains the outbox entry across a dropped connection, renegotiates, and re-sends it", async () => {
    const server = await startFakeServer(root, { respond: negotiateReply, dropAfterRequest: true });
    const outboxPath = join(root, "outbox.json");
    const client = new AbtarsSignedWssClient(profile(root, server.port), outboxPath);
    try {
      await client.negotiate();
      const pendingPromise = client.callRaw("system.status", {});
      await new Promise((r) => setTimeout(r, 300));
      const persisted = JSON.parse(readFileSync(outboxPath, "utf-8"));
      expect(persisted.entries.length).toBe(1);
      expect(existsSync(outboxPath)).toBe(true);

      // Restart the listener on the same address; the client reconnects,
      // renegotiates (new generation), then pumps the retained entry with a
      // fresh nonce/timestamp/signature.
      const oldPort = server.port;
      await server.close();
      const server2 = await startFakeServer(root, { respond: negotiateReply, port: oldPort });

      const result = await pendingPromise;
      expect(result).toEqual({ ok: true });

      const after = JSON.parse(readFileSync(outboxPath, "utf-8"));
      expect(after.entries.length).toBe(0);
      // Connection 2 = negotiate (control) + status resend.
      expect(server2.frames.length).toBe(2);
      const firstStatusFrame = server.frames.find(f => f.body.includes("system.status"));
      expect(firstStatusFrame).toBeDefined();
      expect(server2.frames[1]!.id).toBe(firstStatusFrame!.id);
      expect(server2.frames[1]!.auth.nonce).not.toBe(firstStatusFrame!.auth.nonce);
      expect(client.routeSnapshot.state).toBe("ready");
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("never retries a terminal service error and preserves its code", async () => {
    const server = await startFakeServer(root, {
      respond: (frameId, inner) => {
        if (inner.method === "system.negotiate") return negotiateReply(frameId, inner);
        return {
          id: frameId,
          body: JSON.stringify({ ok: false, requestId: inner.requestId, error: { code: "conflict", message: "stale" } }),
        };
      },
    });
    const outboxPath = join(root, "outbox.json");
    const client = new AbtarsSignedWssClient(profile(root, server.port), outboxPath);
    try {
      await client.negotiate();
      await expect(client.callRaw("private.edit", { memoryId: 1, expectedRevision: 2, userId: "u" }, "k"))
        .rejects.toMatchObject({ code: "conflict" });
      expect(JSON.parse(readFileSync(outboxPath, "utf-8")).entries.length).toBe(0);
      const statusFrames = server.frames.filter(f => f.body.includes("private.edit"));
      expect(statusFrames.length).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("exhausts ambiguous work to terminal_unknown and never auto-replays after reconnect", async () => {
    const server = await startFakeServer(root, {
      respond: (frameId, inner) => {
        if (inner.method === "system.negotiate") return negotiateReply(frameId, inner);
        return null; // never answer domain calls
      },
    });
    const outboxPath = join(root, "outbox.json");
    const client = new AbtarsSignedWssClient(profile(root, server.port), outboxPath, {
      ...FAST,
      retryMaxAttempts: 2,
    });
    try {
      await client.negotiate();
      await expect(client.callRaw("system.status", {})).rejects.toMatchObject({ code: "outcome_unknown" });
      const persisted = JSON.parse(readFileSync(outboxPath, "utf-8"));
      expect(persisted.entries.length).toBe(1);
      expect(persisted.entries[0].state).toBe("terminal_unknown");
      expect(client.routeSnapshot.terminalUnknown).toBe(1);
      // Reconnect must not pump the terminal-unknown entry.
      const port = server.port;
      await server.close();
      const server2 = await startFakeServer(root, { port });
      await new Promise((r) => setTimeout(r, 200));
      expect(server2.frames.filter(f => f.body.includes("system.status")).length).toBe(0);
      await server2.close();
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("publishes bounded route snapshots through onRouteChange", async () => {
    const server = await startFakeServer(root, { respond: negotiateReply });
    const client = new AbtarsSignedWssClient(profile(root, server.port), join(root, "outbox.json"));
    const seen: string[] = [];
    const unsubscribe = client.onRouteChange((snapshot) => seen.push(snapshot.state));
    try {
      await client.negotiate();
      expect(seen).toContain("ready");
      await server.close();
      await waitFor(() => client.routeSnapshot.state !== "ready");
      expect(client.routeSnapshot.state).not.toBe("ready");
      expect(seen.length).toBeGreaterThan(0);
      unsubscribe();
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("close settles a pending negotiate with a rejection (no hang)", async () => {
    // A TCP server that accepts but never completes the TLS handshake keeps
    // negotiate in flight until close() rejects it.
    const net = await import("node:net");
    const sink = net.createServer(() => { /* accept and stay silent */ });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const sinkPort = (sink.address() as { port: number }).port;
    const client = new AbtarsSignedWssClient({
      url: `wss://127.0.0.1:${sinkPort}`,
      peerId: "abtars-test",
      signingKeyFile: join(root, "client-ed25519.pem"),
      serverCertSha256: "a".repeat(64),
    }, join(root, "outbox.json"));
    try {
      const negotiated = client.negotiate().catch((e) => e);
      await new Promise((r) => setTimeout(r, 20));
      await client.close();
      await expect(negotiated).resolves.toMatchObject({ message: /closed/i });
    } finally {
      await client.close();
      sink.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        sink.close(() => { clearTimeout(timer); resolve(); });
      });
    }
  }, 20_000);

  it("close resolves pending requests as unavailable", async () => {
    const server = await startFakeServer(root, {
      respond: (frameId, inner) => {
        if (inner.method === "system.negotiate") return negotiateReply(frameId, inner);
        return null;
      },
    });
    const client = new AbtarsSignedWssClient(profile(root, server.port), join(root, "outbox.json"));
    await client.negotiate();
    const pendingPromise = client.callRaw("system.status", {}).catch((err) => err);
    await new Promise((r) => setTimeout(r, 100));
    await client.close();
    const err = await pendingPromise;
    expect((err as Error & { code?: string }).code).toBe("unavailable");
    expect(client.routeSnapshot.state).toBe("closed");
    await server.close();
  });
});

describe("AbmindRequestOutbox", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), `abtars-outbox-${++uid}-`));
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("persists entries and reloads them with a fresh instance", () => {
    const path = join(root, "peer.json");
    const outbox = new AbmindRequestOutbox("peer", path);
    expect(outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {})).toBe(true);
    expect(outbox.length).toBe(1);

    const reloaded = new AbmindRequestOutbox("peer", path);
    expect(reloaded.length).toBe(1);
    expect(reloaded.peekDue(Date.now())?.id).toBe("f-1");

    expect(reloaded.acknowledge("f-1")).toBe(true);
    expect(reloaded.length).toBe(0);
  });

  it("quarantines files belonging to another peer (exact peer binding)", () => {
    const path = join(root, "peer.json");
    const outbox = new AbmindRequestOutbox("peer", path);
    outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {});
    const other = new AbmindRequestOutbox("other", path);
    expect(other.length).toBe(0);
    expect(other.isQuarantined).toBe(true);
  });

  it("tracks attempts and stops at the bounded maximum", () => {
    const outbox = new AbmindRequestOutbox("peer", join(root, "peer.json"), { retryDeadlineMs: 60_000 });
    outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {});
    outbox.markInFlight("f-1");
    for (let i = 1; i <= 5; i++) {
      expect(outbox.markRetryWait("f-1", "timeout", Date.now() + i * 1_000)).toBe(true);
    }
    expect(outbox.isExhausted(outbox.get("f-1")!, Date.now())).toBe(true);
  });

  it("rejects appends beyond the entry limit", () => {
    const outbox = new AbmindRequestOutbox("peer", join(root, "peer.json"));
    for (let i = 0; i < 200; i++) {
      expect(outbox.append(`f-${i}`, "private.recall", `r-${i}`, undefined, "{}", 1, {})).toBe(true);
    }
    expect(outbox.append("f-over", "private.recall", "r-over", undefined, "{}", 1, {})).toBe(false);
    expect(outbox.length).toBe(200);
  });

  it("migrates valid V1 files without refreshing the age-derived deadline", () => {
    const path = join(root, "peer.json");
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(path, JSON.stringify({
      version: 1, peer: "peer",
      entries: [{
        id: "f-old", method: "private.edit", requestId: "r-old", idempotencyKey: "k-old",
        body: "{}", version: 1, payload: {}, createdAt, attempts: 2, lastError: "timeout",
      }],
    }));
    const outbox = new AbmindRequestOutbox("peer", path);
    const entry = outbox.get("f-old")!;
    expect(entry.state).toBe("admitted");
    expect(entry.attempts).toBe(2);
    expect(Date.parse(entry.deadlineAt)).toBe(Date.parse(createdAt) + 15 * 60_000);
    const saved = JSON.parse(readFileSync(path, "utf-8")) as { version: number };
    expect(saved.version).toBe(2);
  });
});
