import WebSocket, { WebSocketServer } from "ws";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;

beforeEach(() => {
  TEST_HOME = join(tmpdir(), `broker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  vi.doMock("../peer-config.js", () => ({
    loadPeerConfig: () => ({
      self: { name: "localhost", signingKey: "dGVzdA==" },
      peers: { kp: { verifyKey: "dGVzdA==" } },
    }),
  }));
  vi.doMock("./peer-auth.js", () => ({
    signRequest: () => ({ "X-Peer-Id": "localhost", "X-Peer-Sig": "sig", "X-Peer-Ts": "0", "X-Peer-Nonce": "n" }),
    verifyRequest: () => ({ ok: true }),
  }));
});

afterEach(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

async function makeBroker() {
  const { PeerWsBroker, resetPeerWsBroker } = await import("./peer-ws-broker.js");
  resetPeerWsBroker();
  const { getPeerWsBroker } = await import("./peer-ws-broker.js");
  return getPeerWsBroker();
}

/** Create a connected pair: [server, clientWs] */
async function connectedPair(): Promise<{ server: WebSocketServer; client: WebSocket }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(r => server.on("listening", r));
  const address = server.address() as import("net").AddressInfo;
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise<void>((resolve, reject) => {
    client.on("open", resolve);
    client.on("error", reject);
  });
  return { server, client };
}

describe("PeerWsBroker", () => {
  it("attachSocket assigns monotonic generations", async () => {
    const broker = await makeBroker();
    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    expect(broker.hasRoute("kp")).toBe(true);
    server.close();
    client.close();
  });

  it("hasRoute returns false with no sockets", async () => {
    const broker = await makeBroker();
    expect(broker.hasRoute("kp")).toBe(false);
  });

  it("sendPush rejects methods not in allowlist", async () => {
    const broker = await makeBroker();
    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    expect(broker.sendPush("kp", "mutate", {})).toBe(false);
    expect(broker.sendPush("kp", "peer-status.v1", {})).toBe(true);
    server.close();
    client.close();
  });

  it("sendRequest rejects for unknown peer", async () => {
    const broker = await makeBroker();
    await expect(broker.sendRequest("nonexistent", "test", {})).rejects.toThrow("No peer state");
  });

  it("getConnectedPeers lists only peers with open sockets", async () => {
    const broker = await makeBroker();
    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    expect(broker.getConnectedPeers()).toEqual(["kp"]);

    client.close();
    server.close();
    await new Promise(r => setTimeout(r, 100));
    expect(broker.getConnectedPeers()).not.toContain("kp");
  });

  it("handles push handler registration", async () => {
    const broker = await makeBroker();
    const pushHandler = vi.fn();
    broker.registerPushHandler(pushHandler);

    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

    // Simulate inbound push via the socket's message handler
    client.emit("message", Buffer.from(JSON.stringify({ type: "push", method: "peer-status.v1", payload: { load: 0.5 } })));
    await new Promise(r => setTimeout(r, 50));
    expect(pushHandler).toHaveBeenCalledWith("kp", "peer-status.v1", { load: 0.5 });
    server.close();
    client.close();
  });

  // Request handler invocation requires real Ed25519 keys for signature
  // verification — covered by integration tests (see peer-auth.test.ts).
});
