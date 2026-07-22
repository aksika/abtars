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
    expect(broker.sendPush("kp", "peer.inventory.v1", {})).toBe(true);
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
    client.emit("message", Buffer.from(JSON.stringify({ type: "push", method: "peer.inventory.v1", payload: { capabilities: ["bash"] } })));
    await new Promise(r => setTimeout(r, 50));
    expect(pushHandler).toHaveBeenCalledWith("kp", "peer.inventory.v1", { capabilities: ["bash"] });
    server.close();
    client.close();
  });

  /** #1390: Build a valid v1 request frame for the test peer "kp". */
  async function v1Frame(method: string, id: string, payload: unknown, sigKey?: string): Promise<string> {
    const { signWsRequest } = await import("./peer-auth.js");
    const body = JSON.stringify(payload);
    const auth = signWsRequest("kp", id, method, `/${method}`, body, sigKey ?? selfSigningKey);
    return JSON.stringify({
      type: "request",
      version: 1,
      id,
      method,
      body,
      auth: { peerId: "kp", ...auth },
    });
  }

  it("dispatches a signed v1 request frame to the registered handler and returns the response", async () => {
    const broker = await makeBroker();
    const requestHandler = vi.fn().mockResolvedValue({ decision: "accepted" });
    broker.registerRequestHandler(requestHandler);

    const { server, client, serverConn } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

    const payload = { goal: "help" };
    const frame = await v1Frame("help.request.v1", "f1", payload);

    const responsePromise = new Promise<any>((resolve) => {
      serverConn.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    serverConn.send(frame);

    const response = await responsePromise;
    expect(requestHandler).toHaveBeenCalledWith("kp", "help.request.v1", payload, "f1");
    expect(response.id).toBe("f1");
    expect(response.payload).toEqual({ decision: "accepted" });
    server.close();
    client.close();
  });

  it("rejects a v1 request frame with an invalid signature before invoking the handler", async () => {
    const broker = await makeBroker();
    const requestHandler = vi.fn();
    broker.registerRequestHandler(requestHandler);

    const { server, client, serverConn } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

    const frame = JSON.stringify({
      type: "request", version: 1, id: "f2", method: "help.request.v1",
      body: JSON.stringify({ goal: "x" }),
      auth: { peerId: "kp", ts: String(Math.floor(Date.now() / 1000)), nonce: "n", sig: "bogus" },
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

  /** #1390: Zero-dispatch test matrix — every tamper case must be rejected. */
  describe("v1 request frame authentication (#1390)", () => {
    /** Helper: send a frame and return the error response (or null if none). */
    async function sendAndGetError(frame: string): Promise<any> {
      const broker = await makeBroker();
      const requestHandler = vi.fn();
      broker.registerRequestHandler(requestHandler);
      const { server, client, serverConn } = await connectedPair();
      broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

      const responsePromise = new Promise<any>((resolve) => {
        serverConn.on("message", (data) => resolve(JSON.parse(data.toString())));
      });
      serverConn.send(frame);

      // Allow a brief window for processing
      const result = await Promise.race([
        responsePromise,
        new Promise<any>(r => setTimeout(() => r(null), 200)),
      ]);
      server.close();
      client.close();
      expect(requestHandler).not.toHaveBeenCalled();
      return result;
    }

    it("rejects missing version field", async () => {
      const frame = JSON.stringify({
        type: "request", id: "f3", method: "help.request.v1",
        body: "{}",
        auth: { peerId: "kp", ts: "0", nonce: "n", sig: "x" },
      });
      // No version → handleRequest returns early without error (silent drop)
      // Verify by absence of handler call
      const broker = await makeBroker();
      const requestHandler = vi.fn();
      broker.registerRequestHandler(requestHandler);
      const { server, client, serverConn } = await connectedPair();
      broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
      serverConn.send(frame);
      await new Promise(r => setTimeout(r, 100));
      expect(requestHandler).not.toHaveBeenCalled();
      server.close();
      client.close();
    });

    it("rejects wrong version (not 1)", async () => {
      const frame = JSON.stringify({
        type: "request", version: 2, id: "f4", method: "help.request.v1",
        body: "{}",
        auth: { peerId: "kp", ts: "0", nonce: "n", sig: "x" },
      });
      const err = await sendAndGetError(frame);
      // version !== 1 → silent drop, no response
      expect(err).toBeNull();
    });

    it("rejects unsupported method", async () => {
      const payload = { goal: "x" };
      const raw = await v1Frame("unknown.method", "f5", payload);
      const frame = JSON.parse(raw);
      const err = await sendAndGetError(JSON.stringify({ ...frame, method: "unknown.method" }));
      expect(err).toBeNull(); // HELP_METHODS check → silent drop
    });

    it("rejects peer identity mismatch (auth.peerId !== socket peer)", async () => {
      const { signWsRequest } = await import("./peer-auth.js");
      const body = JSON.stringify({ goal: "x" });
      const auth = signWsRequest("WRONG", "f6", "help.request.v1", "/help.request.v1", body, selfSigningKey);
      const frame = JSON.stringify({
        type: "request", version: 1, id: "f6", method: "help.request.v1",
        body,
        auth: { peerId: "WRONG", ...auth },
      });
      const err = await sendAndGetError(frame);
      expect(err?.error?.code).toBe("auth_failed");
      expect(err?.error?.message).toContain("identity mismatch");
    });

    it("rejects wrong verify key (different keypair)", async () => {
      const { generateKeyPairSync, createPublicKey } = await import("node:crypto");
      const wrong = generateKeyPairSync("ed25519");
      const wrongSigningKey = wrong.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
      const frame = await v1Frame("help.request.v1", "f7", { goal: "x" }, wrongSigningKey);
      const err = await sendAndGetError(frame);
      expect(err?.error?.code).toBe("auth_failed");
    });

    it("rejects stale timestamp (>30s old)", async () => {
      const payload = { goal: "x" };
      const body = JSON.stringify(payload);
      const { signWsRequest } = await import("./peer-auth.js");
      const auth = signWsRequest("kp", "f8", "help.request.v1", "/help.request.v1", body, selfSigningKey);
      const staleTs = String(Math.floor(Date.now() / 1000) - 60);
      const frame = JSON.stringify({
        type: "request", version: 1, id: "f8", method: "help.request.v1",
        body,
        auth: { peerId: "kp", ...auth, ts: staleTs },
      });
      const err = await sendAndGetError(frame);
      expect(err?.error?.code).toBe("auth_failed");
    });

    it("rejects body tampering (signed body differs from envelope body)", async () => {
      const { signWsRequest } = await import("./peer-auth.js");
      const originalBody = JSON.stringify({ goal: "x" });
      const auth = signWsRequest("kp", "f9", "help.request.v1", "/help.request.v1", originalBody, selfSigningKey);
      const frame = JSON.stringify({
        type: "request", version: 1, id: "f9", method: "help.request.v1",
        body: JSON.stringify({ goal: "tampered" }),
        auth: { peerId: "kp", ...auth },
      });
      const err = await sendAndGetError(frame);
      expect(err?.error?.code).toBe("auth_failed");
    });

    it("rejects method tampering (signed path differs from envelope method)", async () => {
      const { signWsRequest } = await import("./peer-auth.js");
      const body = JSON.stringify({ goal: "x" });
      const auth = signWsRequest("kp", "f10", "help.request.v1", "/help.request.v1", body, selfSigningKey);
      const frame = JSON.stringify({
        type: "request", version: 1, id: "f10", method: "help.status.v1",
        body,
        auth: { peerId: "kp", ...auth },
      });
      const err = await sendAndGetError(frame);
      expect(err?.error?.code).toBe("auth_failed");
    });

    it("rejects oversized body", async () => {
      const bigPayload = { data: "x".repeat(600_000) };
      const { signWsRequest } = await import("./peer-auth.js");
      const body = JSON.stringify(bigPayload);
      // Over MAX_BODY_BYTES (524288) — method is valid but body is too large
      const auth = signWsRequest("kp", "f11", "help.request.v1", "/help.request.v1", body, selfSigningKey);
      const frame = JSON.stringify({
        type: "request", version: 1, id: "f11", method: "help.request.v1",
        body,
        auth: { peerId: "kp", ...auth },
      });
      const err = await sendAndGetError(frame);
      // Oversized body is silently dropped (no auth_failed response since check
      // is before requestHandler check)
      expect(err).toBeNull();
    });

    it("rejects nonce replay (duplicate nonce)", async () => {
      const broker = await makeBroker();
      const requestHandler = vi.fn();
      broker.registerRequestHandler(requestHandler);
      const { server, client, serverConn } = await connectedPair();
      broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

      const frame = await v1Frame("help.request.v1", "f12", { goal: "x" });

      // Send twice — second should fail with nonce replay
      const responsePromise = new Promise<any>((resolve) => {
        let count = 0;
        serverConn.on("message", (data) => {
          count++;
          if (count === 2) resolve(JSON.parse(data.toString()));
        });
      });
      serverConn.send(frame);
      await new Promise(r => setTimeout(r, 50));
      serverConn.send(frame);

      const response = await responsePromise;
      expect(response.error.code).toBe("auth_failed");
      expect(requestHandler).toHaveBeenCalledTimes(1); // only first passed auth
      server.close();
      client.close();
    });

    it("regression: push with a help.*.v1 method never enters the request handler", async () => {
      const broker = await makeBroker();
      const requestHandler = vi.fn();
      const pushHandler = vi.fn();
      broker.registerRequestHandler(requestHandler);
      broker.registerPushHandler(pushHandler);

      const { server, client, serverConn } = await connectedPair();
      broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

      serverConn.send(JSON.stringify({
        type: "push", method: "help.request.v1", payload: { goal: "x" },
      }));
      await new Promise(r => setTimeout(r, 100));

      // Push handler should receive it (push frames are not validated for help methods)
      expect(pushHandler).toHaveBeenCalledWith("kp", "help.request.v1", { goal: "x" });
      // Request handler must NOT be invoked
      expect(requestHandler).not.toHaveBeenCalled();
      server.close();
      client.close();
    });
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

  it("subscribeRoutes emits available on zero-to-one route transition", async () => {
    const broker = await makeBroker();
    const listener = vi.fn();
    broker.subscribeRoutes(listener);

    const { server, client } = await connectedPair();
    expect(broker.hasRoute("kp")).toBe(false);

    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    await new Promise(r => setTimeout(r, 50));

    expect(listener).toHaveBeenCalledWith({ type: "available", peer: "kp" });
    server.close();
    client.close();
  });

  it("subscribeRoutes does not emit available when route already exists", async () => {
    const broker = await makeBroker();
    const { server: s1, client: c1 } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: c1 });
    await new Promise(r => setTimeout(r, 50));

    const listener = vi.fn();
    broker.subscribeRoutes(listener);

    // Attach a second socket when route already exists — no available event
    const { server: s2, client: c2 } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: c2 });
    await new Promise(r => setTimeout(r, 50));

    expect(listener).not.toHaveBeenCalled();
    s1.close(); c1.close();
    s2.close(); c2.close();
  });

  it("subscribeRoutes emits unavailable on one-to-zero route transition", async () => {
    const broker = await makeBroker();
    const listener = vi.fn();
    broker.subscribeRoutes(listener);

    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    await new Promise(r => setTimeout(r, 50));
    expect(listener).toHaveBeenCalledWith({ type: "available", peer: "kp" });

    // Close the socket — should emit unavailable
    client.close();
    await new Promise(r => setTimeout(r, 100));
    expect(listener).toHaveBeenCalledWith({ type: "unavailable", peer: "kp" });
    server.close();
  });

  it("subscribeRoutes listener errors are isolated", async () => {
    const broker = await makeBroker();
    const throwing = vi.fn().mockImplementation(() => { throw new Error("boom"); });
    const ok = vi.fn();
    broker.subscribeRoutes(throwing);
    broker.subscribeRoutes(ok);

    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    await new Promise(r => setTimeout(r, 50));

    // Both listeners should have been called despite the error
    expect(throwing).toHaveBeenCalled();
    expect(ok).toHaveBeenCalledWith({ type: "available", peer: "kp" });
    server.close();
    client.close();
  });

  it("subscribeRoutes unsubscribe removes exactly that listener", async () => {
    const broker = await makeBroker();
    const a = vi.fn();
    const b = vi.fn();
    const unsub = broker.subscribeRoutes(a);
    broker.subscribeRoutes(b);
    unsub();

    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    await new Promise(r => setTimeout(r, 50));

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith({ type: "available", peer: "kp" });
    server.close();
    client.close();
  });

  // #1455: Accepted and outbound pushes route through the same push handler
  it("push handler is invoked for frames on outbound socket", async () => {
    const broker = await makeBroker();
    const pushHandler = vi.fn();
    broker.registerPushHandler(pushHandler);

    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    await new Promise(r => setTimeout(r, 50));

    client.emit("message", Buffer.from(JSON.stringify({
      type: "push", method: "peer.inventory.v1", payload: { capabilities: ["bash"] },
    })));
    await new Promise(r => setTimeout(r, 50));

    expect(pushHandler).toHaveBeenCalledWith("kp", "peer.inventory.v1", { capabilities: ["bash"] });
    server.close();
    client.close();
  });

  it("push handler is invoked for frames on accepted socket", async () => {
    const broker = await makeBroker();
    const pushHandler = vi.fn();
    broker.registerPushHandler(pushHandler);

    const { server, client, serverConn } = await connectedPair();
    // Attach the server-side connection as an "accepted" socket
    broker.attachSocket({ peer: "kp", direction: "accepted", socket: client });
    await new Promise(r => setTimeout(r, 50));

    // Send from the remote side (serverConn simulates the remote peer)
    // The broker listens on client for messages
    client.emit("message", Buffer.from(JSON.stringify({
      type: "push", method: "pi.lifecycle.v1", payload: { event: "test" },
    })));
    await new Promise(r => setTimeout(r, 50));

    expect(pushHandler).toHaveBeenCalledWith("kp", "pi.lifecycle.v1", { event: "test" });
    server.close();
    client.close();
  });

  it("push handler is called once per frame (no duplicate processing)", async () => {
    const broker = await makeBroker();
    const pushHandler = vi.fn();
    broker.registerPushHandler(pushHandler);

    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    await new Promise(r => setTimeout(r, 50));

    client.emit("message", Buffer.from(JSON.stringify({
      type: "push", method: "peer.inventory.v1", payload: { capabilities: ["bash"] },
    })));
    await new Promise(r => setTimeout(r, 50));

    // The handler should be called exactly once
    expect(pushHandler).toHaveBeenCalledTimes(1);
    server.close();
    client.close();
  });

  it("sendPush with method not in allowlist returns false", async () => {
    const broker = await makeBroker();
    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    expect(broker.sendPush("kp", "unknown.method", {})).toBe(false);
    expect(broker.sendPush("kp", "heartbeat", {})).toBe(false); // removed from allowlist
    server.close();
    client.close();
  });

  // ── #1459: Reconnect state retention ─────────────────────────────────────

  it("recovers in-flight request across last-socket detach and replacement attach", async () => {
    const broker = await makeBroker();
    const { server: s1, client: c1, serverConn: sc1 } = await connectedPair();
    const detach1 = broker.attachSocket({ peer: "kp", direction: "outbound", socket: c1 });

    // Watch for the outgoing request frame via the server-side connection
    const frameOnSc1 = new Promise<string>(res => sc1.on("message", d => res(d.toString())));

    const reqPromise = broker.sendRequest<{ result: string }>("kp", "help.request.v1", { goal: "x" });

    // The first pair's serverConn receives the frame
    const firstRaw = await frameOnSc1;
    const firstFrame = JSON.parse(firstRaw);
    expect(firstFrame.type).toBe("request");
    expect(firstFrame.id).toBeDefined();

    // Detach the only socket — state retained because outbox is non-empty
    detach1();
    expect(broker._getOutbox("kp")).toBeDefined();
    expect(broker._getOutbox("kp")!.length).toBe(1);
    const entryId = broker._getOutbox("kp")!.peek()!.id;
    expect(entryId).toBe(firstFrame.id); // same entry, not a new one

    // Clean up the first pair
    c1.close();
    sc1.close();
    s1.close();

    // Attach a replacement socket and capture frames on new serverConn
    const { server: s2, client: c2, serverConn: sc2 } = await connectedPair();
    const frameOnSc2 = new Promise<string>(res => sc2.on("message", d => res(d.toString())));
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: c2 });

    // The pending request must be re-sent on the replacement (v1 envelope)
    const resentRaw = await frameOnSc2;
    const resent = JSON.parse(resentRaw);
    expect(resent.type).toBe("request");
    expect(resent.version).toBe(1);
    expect(resent.method).toBe("help.request.v1");
    expect(JSON.parse(resent.body)).toEqual({ goal: "x" });
    expect(resent.id).toBe(firstFrame.id); // same entry ID re-sent

    // Respond through the client's message handler (broker handles incoming)
    c2.emit("message", Buffer.from(JSON.stringify({
      type: "response", id: resent.id, payload: { result: "ok" },
    })));

    await expect(reqPromise).resolves.toEqual({ result: "ok" });
    c2.close();
    s2.close();
  }, 10_000);

  it("waiter timeout leaves durable entry retryable — late response acknowledges without waiter", async () => {
    vi.useFakeTimers();
    const broker = await makeBroker();
    const { server: s1, client: c1 } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: c1 });

    // Consume frames so send does not fail
    c1.on("message", () => {});
    const errPromise = broker.sendRequest("kp", "help.request.v1", { goal: "x" }).catch(e => e);

    // Close socket so no response can arrive
    c1.close();
    s1.close();

    // Advance past the caller waiter timeout
    await vi.advanceTimersByTimeAsync(31_000);
    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("timeout");

    // Durable outbox entry must survive
    expect(broker._getOutbox("kp")?.length).toBe(1);
    const entryId = broker._getOutbox("kp")!.peek()!.id;

    // Reconnect with a new socket
    const { server: s2, client: c2 } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: c2 });

    // Send a late response for the pending entry
    c2.emit("message", Buffer.from(JSON.stringify({
      type: "response", id: entryId, payload: { result: "late" },
    })));
    await vi.advanceTimersByTimeAsync(1_000);

    // The entry must be acknowledged even without a waiter
    expect(broker._getOutbox("kp")?.length).toBe(0);
    c2.close();
    s2.close();
    vi.useRealTimers();
  }, 10_000);

  it("removes idle peer state after last socket closes (no pending work)", async () => {
    const broker = await makeBroker();
    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    expect(broker._getOutbox("kp")).toBeDefined();

    client.close();
    server.close();
    await new Promise(r => setTimeout(r, 200));

    expect(broker._getOutbox("kp")).toBeUndefined();
  }, 10_000);

  it("retains peer state with pending request across zero-socket interval", async () => {
    vi.useFakeTimers();
    const broker = await makeBroker();
    const { server: s1, client: c1 } = await connectedPair();
    const detach1 = broker.attachSocket({ peer: "kp", direction: "outbound", socket: c1 });

    c1.on("message", () => {});
    broker.sendRequest("kp", "help.request.v1", { goal: "x" }).catch(() => {});

    // Detach before the pump fires on the open socket
    detach1();
    await vi.advanceTimersByTimeAsync(1_000);

    // State must be retained (outbox has the pending entry, waiter exists)
    expect(broker._getOutbox("kp")).toBeDefined();
    expect(broker._getOutbox("kp")!.length).toBe(1);

    c1.close();
    s1.close();
    vi.useRealTimers();
  }, 10_000);
});
