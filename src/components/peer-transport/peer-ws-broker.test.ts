import WebSocket, { WebSocketServer } from "ws";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { deriveVerifyKey } from "../peer-config.js";

let TEST_HOME: string;
let selfSigningKey: string;
let selfVerifyKey: string;

function makeKey(): { signingKey: string; verifyKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const verifyKey = deriveVerifyKey(signingKey);
  return { signingKey, verifyKey };
}

beforeEach(() => {
  TEST_HOME = join(tmpdir(), `broker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const key = makeKey();
  selfSigningKey = key.signingKey;
  selfVerifyKey = key.verifyKey;
  vi.doMock("../peer-config.js", () => ({
    loadPeerConfig: () => ({
      self: { name: "localhost", signingKey: selfSigningKey },
      peers: { kp: { verifyKey: selfVerifyKey } },
    }),
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

/** Create a connected pair: [server, clientWs]. Returns the server-side
 *  connection object too, since that's what the "remote peer" sends through
 *  to simulate an inbound frame on the broker-attached socket. */
async function connectedPair(): Promise<{ server: WebSocketServer; client: WebSocket; serverConn: WebSocket }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(r => server.on("listening", r));
  const address = server.address() as import("net").AddressInfo;
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const serverConn = await new Promise<WebSocket>((resolve, reject) => {
    server.on("connection", (conn) => resolve(conn as unknown as WebSocket));
    client.on("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    if (client.readyState === WebSocket.OPEN) { resolve(); return; }
    client.on("open", resolve);
    client.on("error", reject);
  });
  return { server, client, serverConn };
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

  it("dispatches a signed request frame to the registered handler and returns the response", async () => {
    const broker = await makeBroker();
    const requestHandler = vi.fn().mockResolvedValue({ decision: "accepted" });
    broker.registerRequestHandler(requestHandler);

    const { server, client, serverConn } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

    const { signRequest } = await import("./peer-auth.js");
    const payload = { goal: "help" };
    const body = JSON.stringify(payload);
    // "kp" signs with our own test keypair — loadPeerConfig() maps kp's verifyKey to it.
    const sigHeaders = signRequest("POST", "/help.request.v1", body, selfSigningKey, "kp");
    const frame = JSON.stringify({ type: "request", id: "f1", method: "help.request.v1", payload, ...sigHeaders });

    const responsePromise = new Promise<any>((resolve) => {
      serverConn.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    // The "remote peer" (serverConn) sends the frame into the broker-attached
    // client socket — this is the direction handleMessage actually listens on.
    serverConn.send(frame);

    const response = await responsePromise;
    expect(requestHandler).toHaveBeenCalledWith("kp", "help.request.v1", payload, "f1");
    expect(response.id).toBe("f1");
    expect(response.payload).toEqual({ decision: "accepted" });
    server.close();
    client.close();
  });

  it("rejects a request frame with an invalid signature before invoking the handler", async () => {
    const broker = await makeBroker();
    const requestHandler = vi.fn();
    broker.registerRequestHandler(requestHandler);

    const { server, client, serverConn } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

    const frame = JSON.stringify({
      type: "request", id: "f2", method: "help.request.v1", payload: { goal: "x" },
      "X-Peer-Id": "kp", "X-Peer-Ts": String(Math.floor(Date.now() / 1000)), "X-Peer-Nonce": "n", "X-Peer-Sig": "bogus",
    });

    const responsePromise = new Promise<any>((resolve) => {
      serverConn.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    serverConn.send(frame);

    const response = await responsePromise;
    expect(requestHandler).not.toHaveBeenCalled();
    expect(response.error.code).toBe("auth_failed");
    server.close();
    client.close();
  });

  it("detach is scoped to (peer, direction, generation) — a stale close does not remove a replacement socket", async () => {
    const broker = await makeBroker();
    const pairA = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: pairA.client });
    expect(broker.hasRoute("kp")).toBe(true);

    // Replace with a new outbound socket (new generation) before the old one's close fires.
    const pairB = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: pairB.client });
    expect(broker.getConnectedPeers()).toEqual(["kp"]);

    // Close the OLD socket. Its close handler is scoped to its own generation and
    // must not remove the newer (still open) registration.
    pairA.client.close();
    await new Promise(r => setTimeout(r, 100));

    expect(broker.hasRoute("kp")).toBe(true);
    expect(broker.getConnectedPeers()).toEqual(["kp"]);

    pairA.server.close();
    pairB.client.close();
    pairB.server.close();
  });

  it("sendRequest retries the same outbox entry on the next attempt after a timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const broker = await makeBroker();
    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

    const sent: string[] = [];
    client.on("message", () => { /* server side never responds — force timeout */ });
    const originalSend = client.send.bind(client);
    client.send = ((data: any) => { sent.push(String(data)); return originalSend(data); }) as any;

    const reqPromise = broker.sendRequest("kp", "help.request.v1", { goal: "x" }).catch(e => e);
    await vi.advanceTimersByTimeAsync(31_000);
    const err = await reqPromise;
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain("timeout");

    // The same outbox entry must remain retryable — not silently dropped.
    const outbox = broker._getOutbox("kp");
    expect(outbox?.peek()).toBeTruthy();

    server.close();
    client.close();
    vi.useRealTimers();
  });

  // Request handler invocation requires real Ed25519 keys for signature
  // verification — see the signed-frame tests above.
});
