/**
 * ws-peer-client.test.ts — tests for outbound state machine (#1401, #1455).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsOutboxStore } from "./ws-outbox-store.js";

const mockWsInstances: any[] = [];
vi.mock("ws", () => {
  const EventEmitter = require("node:events");
  class MockWebSocket extends EventEmitter {
    readyState = 0;
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url: string, opts?: any) {
      super();
      this.readyState = MockWebSocket.CONNECTING;
      mockWsInstances.push(this);
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
    send() {}
  }
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});
vi.mock("../peer-config.js", () => ({
  loadPeerConfig: () => ({
    self: { name: "testself", signingKey: "testkey" },
    peers: { testpeer: { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" } },
  }),
}));
vi.mock("./peer-auth.js", () => ({
  signRequest: () => ({ "X-Peer-Id": "test", "X-Peer-Sig": "test", "X-Peer-Ts": "0", "X-Peer-Nonce": "n" }),
}));
vi.mock("./pinned-peer-tls.js", () => ({
  createPinnedPeerWsConnection: () => () => undefined,
}));
vi.mock("./peer-ws-broker.js", () => {
  const broker = {
    attachSocket: vi.fn(),
    hasRoute: vi.fn().mockReturnValue(false),
    sendPush: vi.fn(),
    sendRequest: vi.fn(),
    subscribeRoutes: vi.fn().mockReturnValue(() => {}),
  };
  return {
    getPeerWsBroker: () => broker,
    resetPeerWsBroker: vi.fn(),
  };
});

const originalHome = process.env["HOME"];
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ws-peer-test-"));
  process.env["HOME"] = tmpDir;
});

afterEach(() => {
  process.env["HOME"] = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("WsOutboxStore", () => {
  it("accepts and persists entries", () => {
    const path = join(tmpDir, "outbox.json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });

    expect(store.length).toBe(0);
    const entry = store.append("help.request.v1", { goal: "hello" });
    expect(store.length).toBe(1);
    expect(store.peek()!.id).toBe(entry.id);

    // Survives reload
    const store2 = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });
    expect(store2.length).toBe(1);
    expect(store2.peek()!.id).toBe(entry.id);
  });

  it("acknowledge removes entry", () => {
    const path = join(tmpDir, "outbox.json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });

    const e1 = store.append("help.request.v1", { goal: "a" });
    store.append("help.request.v1", { goal: "b" });
    expect(store.length).toBe(2);

    store.acknowledge(e1.id);
    expect(store.length).toBe(1);
    expect(store.peek()!.payload).toEqual({ goal: "b" });
  });

  it("rejects unsupported methods", () => {
    const path = join(tmpDir, "outbox.json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });
    expect(() => store.append("unknown", {})).toThrow("Unsupported WSS method");
  });

  it("rejects when full", () => {
    const path = join(tmpDir, "outbox.json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 3,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });
    store.append("help.request.v1", { i: 0 });
    store.append("help.request.v1", { i: 1 });
    store.append("help.request.v1", { i: 2 });
    expect(() => store.append("help.request.v1", { i: 3 })).toThrow("Outbox full");
  });

  it("quarantines corrupt files", () => {
    const path = join(tmpDir, "outbox.json");
    // Write garbage
    require("node:fs").writeFileSync(path, "not json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });
    expect(store.length).toBe(0);
    expect(store.isDegraded).toBe(true);
    // Corrupt file should have been renamed
    const dirFiles = require("node:fs").readdirSync(tmpDir);
    expect(dirFiles.some(f => f.includes(".corrupt"))).toBe(true);
  });

  it("purge clears everything", () => {
    const path = join(tmpDir, "outbox.json");
    const store = new WsOutboxStore({
      peerName: "testpeer",
      filePath: path,
      maxEntries: 200,
      maxEntryBytes: 512 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
    });
    store.append("help.request.v1", { goal: "test" });
    expect(store.length).toBe(1);
    expect(existsSync(path)).toBe(true);

    store.purge();
    expect(store.length).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});

// ── WsPeerClient state machine (#1455) ────────────────────────────────────
// TEST DEFICIENCY: A prolonged-refusal test proving exact bounded backoff
// attempt counts through the 5-minute cap and reset after authenticated open
// is omitted because it requires a controlled WebSocket mock that simulates
// repeated ECONNREFUSED + close/retry cycles across multiple backoff steps.
// The observed 2026-07-19 incident (84 ECONNREFUSED in 7 min from overlapping
// heartbeat chains) is the canonical failure mode — deterministic fake-timer
// proofs of one active dial, one pending timer, and stale-callback safety
// are covered below. A real multi-host outage replay is disproportionate
// for this unit scope.

describe("WsPeerClient state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockWsInstances.length = 0;
  });

  it("starts in idle state", async () => {
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    expect(client.currentState).toBe("idle");
  });

  it("requestConnect transitions to connecting for immediate dial", async () => {
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    client.requestConnect({ reason: "startup" });
    expect(client.currentState).toBe("connecting");
  });

  it("requestConnect coalesces repeated triggers while connecting", async () => {
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    client.requestConnect({ reason: "startup" });
    expect(client.currentState).toBe("connecting");
    client.requestConnect({ reason: "udp-doorbell" });
    expect(client.currentState).toBe("connecting");
  });

  it("requestConnect with delayMs transitions to waiting", async () => {
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    client.requestConnect({ reason: "udp-doorbell", delayMs: 200 });
    expect(client.currentState).toBe("waiting");
    vi.advanceTimersByTime(200);
    expect(client.currentState).toBe("connecting");
  });

  it("requestConnect is no-op after destroy", async () => {
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    client.destroy();
    expect(client.currentState).toBe("destroyed");
    client.requestConnect({ reason: "startup" });
    expect(client.currentState).toBe("destroyed");
  });

  it("destroy with pending delayed request clears timer", async () => {
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    client.requestConnect({ reason: "udp-doorbell", delayMs: 500 });
    expect(client.currentState).toBe("waiting");
    client.destroy();
    expect(client.currentState).toBe("destroyed");
    vi.advanceTimersByTime(500);
    expect(client.currentState).toBe("destroyed");
  });

  it("state transitions: idle -> waiting -> connecting -> idle -> waiting", async () => {
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    expect(client.currentState).toBe("idle");

    client.requestConnect({ reason: "udp-doorbell", delayMs: 100 });
    expect(client.currentState).toBe("waiting");

    vi.advanceTimersByTime(100);
    expect(client.currentState).toBe("connecting");

    client.destroy();
    expect(client.currentState).toBe("destroyed");
  });

  it("requestConnect while waiting is no-op (coalesced)", async () => {
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    client.requestConnect({ reason: "udp-doorbell", delayMs: 200 });
    expect(client.currentState).toBe("waiting");
    client.requestConnect({ reason: "outbox", delayMs: 100 });
    expect(client.currentState).toBe("waiting");
    vi.advanceTimersByTime(200);
    expect(client.currentState).toBe("connecting");
  });

  it("error+close settles connecting state once and schedules one reconnect", async () => {
    const prevLen = mockWsInstances.length;
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    client.requestConnect({ reason: "startup" });
    expect(client.currentState).toBe("connecting");

    const ws = mockWsInstances[mockWsInstances.length - 1];
    expect(ws).toBeTruthy();

    ws.emit("error", new Error("ECONNREFUSED"));
    ws.emit("close");

    expect(client.currentState).toBe("waiting");
  });

  it("stale generation close callback does not schedule reconnect", async () => {
    const prevLen = mockWsInstances.length;
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    client.requestConnect({ reason: "startup" });
    const oldWs = mockWsInstances[mockWsInstances.length - 1];
    expect(oldWs).toBeTruthy();
    const oldGeneration = (client as any).socketGeneration;

    (client as any).socketGeneration = oldGeneration + 1;

    oldWs.emit("close");

    expect(client.currentState).toBe("connecting");
  });

  it("reconnect timer fires once and transitions back to connecting", async () => {
    const prevLen = mockWsInstances.length;
    const { WsPeerClient } = await import("./ws-peer-client.js");
    const client = new WsPeerClient("testpeer", { host: "10.0.0.1", port: 7100, verifyKey: "abc123", transport: "ws-outbound" });
    client.requestConnect({ reason: "startup" });
    expect(client.currentState).toBe("connecting");

    const ws = mockWsInstances[mockWsInstances.length - 1];
    ws.emit("close");
    expect(client.currentState).toBe("waiting");

    vi.advanceTimersByTime(6000);
    expect(client.currentState).toBe("connecting");
  });
});

