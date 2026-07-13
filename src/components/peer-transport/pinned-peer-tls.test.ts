import { describe, it, expect, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import * as https from "node:https";
import * as tls from "node:tls";
import WebSocket, { WebSocketServer } from "ws";
import { deriveVerifyKey } from "../peer-config.js";
import { generateTlsCert, verifyServerCert } from "./peer-auth.js";
import {
  connectPinnedPeerTls,
  createPinnedPeerHttpsAgent,
  createPinnedPeerWsConnection,
} from "./pinned-peer-tls.js";

function makeKey(): { signingKey: string; verifyKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const verifyKey = deriveVerifyKey(signingKey);
  return { signingKey, verifyKey };
}

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listenTls(key: string, cert: string): Promise<{ server: tls.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = tls.createServer({ key, cert }, () => {});
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      servers.push(server);
      resolve({ server, port: addr.port });
    });
  });
}

async function listenHttps(key: string, cert: string): Promise<{ server: https.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = https.createServer({ key, cert }, (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      servers.push(server);
      resolve({ server, port: addr.port });
    });
  });
}

async function listenWss(key: string, cert: string): Promise<{ server: https.Server; port: number; wss: WebSocketServer; msgCount: { value: number } }> {
  return new Promise((resolve, reject) => {
    const httpsServer = https.createServer({ key, cert });
    const wss = new WebSocketServer({ server: httpsServer });
    const msgCount = { value: 0 };
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        msgCount.value++;
        ws.send(data);
      });
    });
    httpsServer.on("error", reject);
    httpsServer.listen(0, "127.0.0.1", () => {
      const addr = httpsServer.address() as { port: number };
      servers.push(httpsServer);
      resolve({ server: httpsServer, port: addr.port, wss, msgCount });
    });
  });
}

describe("verifyServerCert boundary", () => {
  it("rejects empty string", () => {
    const { verifyKey } = makeKey();
    expect(verifyServerCert("", verifyKey)).toBe(false);
  });

  it("rejects garbage", () => {
    const { verifyKey } = makeKey();
    expect(verifyServerCert("not-a-cert", verifyKey)).toBe(false);
  });

  it("rejects malformed PEM", () => {
    const { verifyKey } = makeKey();
    expect(verifyServerCert("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----", verifyKey)).toBe(false);
  });
});

describe("connectPinnedPeerTls", () => {
  it("matching identity calls onVerified", async () => {
    const { signingKey, verifyKey } = makeKey();
    const { key, cert } = generateTlsCert(signingKey, "test-peer");
    const { port } = await listenTls(key, cert);

    const onVerified = new Promise<void>((resolve, reject) => {
      const socket = connectPinnedPeerTls(
        { host: "127.0.0.1", port, minVersion: "TLSv1.3" },
        { peerName: "test", verifyKey },
        resolve,
      );
      socket.on("error", reject);
    });

    await expect(onVerified).resolves.toBeUndefined();
  });

  it("mismatched identity destroys socket", async () => {
    const { signingKey } = makeKey();
    const { verifyKey: wrongKey } = makeKey();
    const { key, cert } = generateTlsCert(signingKey, "test-peer");
    const { port } = await listenTls(key, cert);

    const onError = new Promise<Error>((resolve) => {
      const socket = connectPinnedPeerTls(
        { host: "127.0.0.1", port, minVersion: "TLSv1.3" },
        { peerName: "test", verifyKey: wrongKey },
        () => {},
      );
      socket.on("error", resolve);
    });

    await expect(onError).resolves.toBeDefined();
  });
});

describe("HTTPS agent", () => {
  it("matching cert succeeds", async () => {
    const { signingKey, verifyKey } = makeKey();
    const { key, cert } = generateTlsCert(signingKey, "server");
    const { port } = await listenHttps(key, cert);

    const agent = createPinnedPeerHttpsAgent({ peerName: "peer", verifyKey });
    const response = await new Promise<string>((resolve, reject) => {
      const req = https.get({ hostname: "127.0.0.1", port, path: "/test", agent }, (res) => {
        let data = "";
        res.on("data", (c: string) => data += c);
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
    });

    expect(response).toBe("ok");
    agent.destroy();
  });

  it("mismatched cert fails", async () => {
    const { signingKey } = makeKey();
    const { verifyKey: wrongKey } = makeKey();
    const { key, cert } = generateTlsCert(signingKey, "server");
    const { port } = await listenHttps(key, cert);

    const agent = createPinnedPeerHttpsAgent({ peerName: "peer", verifyKey: wrongKey });
    const onError = new Promise<Error>((resolve) => {
      const req = https.get({ hostname: "127.0.0.1", port, path: "/test", agent, timeout: 5000 }, () => {});
      req.on("error", resolve);
    });

    await expect(onError).resolves.toBeDefined();
    agent.destroy();
  });
});

describe("WSS connection", () => {
  it("matching cert reaches open and exchanges frame", async () => {
    const { signingKey, verifyKey } = makeKey();
    const { key, cert } = generateTlsCert(signingKey, "server");
    const { port, msgCount } = await listenWss(key, cert);

    const ws = new WebSocket(`wss://127.0.0.1:${port}`, {
      createConnection: createPinnedPeerWsConnection({ peerName: "peer", verifyKey }),
      minVersion: "TLSv1.3",
    } as any);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    const echoPromise = new Promise<string>((resolve) => {
      ws.once("message", (data: Buffer) => resolve(data.toString()));
    });
    ws.send("hello");

    const echo = await echoPromise;
    expect(echo).toBe("hello");
    expect(msgCount.value).toBe(1);

    ws.close();
  });

  it("mismatched cert does not reach open", async () => {
    const { signingKey } = makeKey();
    const { verifyKey: wrongKey } = makeKey();
    const { key, cert } = generateTlsCert(signingKey, "server");
    const { port } = await listenWss(key, cert);

    const ws = new WebSocket(`wss://127.0.0.1:${port}`, {
      createConnection: createPinnedPeerWsConnection({ peerName: "peer", verifyKey: wrongKey }),
      minVersion: "TLSv1.3",
    } as any);

    let opened = false;
    ws.on("open", () => { opened = true; });
    ws.on("error", () => {});

    await new Promise((r) => setTimeout(r, 1500));
    expect(opened).toBe(false);
    ws.close();
  });
});
