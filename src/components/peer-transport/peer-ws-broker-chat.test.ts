/**
 * peer-ws-broker-chat.test.ts — #1786 lane-1 ephemeral chat transport.
 *
 * sendEphemeralRequest must resolve only from the origin socket, never touch
 * the durable outbox, and fail fast on no-route/busy/timeout/socket-loss.
 */
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
  TEST_HOME = join(tmpdir(), `broker-chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  const { resetPeerWsBroker, getPeerWsBroker } = await import("./peer-ws-broker.js");
  resetPeerWsBroker();
  return getPeerWsBroker();
}

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

function chatPayload() {
  return {
    version: 1,
    session_id: "sess_1",
    messages: [{ role: "user", content: "hello" }],
    deadline_at: Date.now() + 60_000,
  };
}

describe("sendEphemeralRequest (#1786)", () => {
  it("resolves from the origin-socket response and leaves the outbox empty", async () => {
    const broker = await makeBroker();
    const { server, client, serverConn } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

    const pending = broker.sendEphemeralRequest<{ version: number; text: string }>("kp", "peer.chat.v1", chatPayload());
    const frame = await new Promise<any>((resolve) => {
      serverConn.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    expect(frame.type).toBe("request");
    expect(frame.method).toBe("peer.chat.v1");
    serverConn.send(JSON.stringify({ type: "response", id: frame.id, payload: { version: 1, text: "hi" } }));

    await expect(pending).resolves.toEqual({ version: 1, text: "hi" });
    expect(broker._getOutbox("kp")?.length ?? 0).toBe(0);
    server.close();
    client.close();
  });

  it("rejects immediately with no route", async () => {
    const broker = await makeBroker();
    await expect(broker.sendEphemeralRequest("kp", "peer.chat.v1", chatPayload())).rejects.toThrow("unavailable");
  });

  it("refuses non-chat methods", async () => {
    const broker = await makeBroker();
    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    await expect(broker.sendEphemeralRequest("kp", "help.request.v1", {})).rejects.toThrow("non-chat");
    server.close();
    client.close();
  });

  it("rejects a second concurrent chat as busy, then allows after completion", async () => {
    const broker = await makeBroker();
    const { server, client, serverConn } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

    const first = broker.sendEphemeralRequest("kp", "peer.chat.v1", chatPayload());
    await expect(broker.sendEphemeralRequest("kp", "peer.chat.v1", chatPayload())).rejects.toThrow("busy");

    const frame = await new Promise<any>((resolve) => {
      serverConn.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    serverConn.send(JSON.stringify({ type: "response", id: frame.id, payload: { version: 1, text: "done" } }));
    await expect(first).resolves.toEqual({ version: 1, text: "done" });

    // Slot released — a follow-up works.
    const second = broker.sendEphemeralRequest("kp", "peer.chat.v1", chatPayload());
    const frame2 = await new Promise<any>((resolve) => {
      serverConn.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    serverConn.send(JSON.stringify({ type: "response", id: frame2.id, payload: { version: 1, text: "again" } }));
    await expect(second).resolves.toEqual({ version: 1, text: "again" });
    server.close();
    client.close();
  });

  it("rejects on timeout without retrying", async () => {
    const broker = await makeBroker();
    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    await expect(
      broker.sendEphemeralRequest("kp", "peer.chat.v1", chatPayload(), { timeoutMs: 60 }),
    ).rejects.toThrow("timeout");
    // No outbox entry was created by the timed-out chat.
    expect(broker._getOutbox("kp")?.length ?? 0).toBe(0);
    server.close();
    client.close();
  });

  it("rejects pending chat when the origin socket closes", async () => {
    const broker = await makeBroker();
    const { server, client } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    const pending = broker.sendEphemeralRequest("kp", "peer.chat.v1", chatPayload(), { timeoutMs: 5_000 });
    const assertion = expect(pending).rejects.toThrow("unavailable");
    client.close();
    await assertion;
    server.close();
  });

  it("propagates handler errors as rejections", async () => {
    const broker = await makeBroker();
    const { server, client, serverConn } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });
    const pending = broker.sendEphemeralRequest("kp", "peer.chat.v1", chatPayload());
    const frame = await new Promise<any>((resolve) => {
      serverConn.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    serverConn.send(JSON.stringify({ type: "response", id: frame.id, error: { code: "handler_error", message: "boom" } }));
    await expect(pending).rejects.toThrow("boom");
    server.close();
    client.close();
  });

  it("dispatches inbound peer.chat.v1 to the registered handler", async () => {
    const broker = await makeBroker();
    const requestHandler = vi.fn().mockResolvedValue({ version: 1, text: "yo" });
    broker.registerRequestHandler(requestHandler);
    const { server, client, serverConn } = await connectedPair();
    broker.attachSocket({ peer: "kp", direction: "outbound", socket: client });

    const { signWsRequest } = await import("./peer-auth.js");
    const body = JSON.stringify(chatPayload());
    const auth = signWsRequest("kp", "c1", "peer.chat.v1", "/peer.chat.v1", body, selfSigningKey);
    const responsePromise = new Promise<any>((resolve) => {
      serverConn.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    serverConn.send(JSON.stringify({
      type: "request", version: 1, id: "c1", method: "peer.chat.v1", body,
      auth: { peerId: "kp", ...auth },
    }));

    const response = await responsePromise;
    expect(requestHandler).toHaveBeenCalledWith("kp", "peer.chat.v1", expect.objectContaining({ session_id: "sess_1" }), "c1");
    expect(response.payload).toEqual({ version: 1, text: "yo" });
    server.close();
    client.close();
  });
});
