import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { PeerEnrollmentHandler } from "./peer-enrollment-handler.js";
import type { PeerEnrollmentDeps } from "./peer-enrollment-handler.js";
import { deriveVerifyKey, clearPeerConfigCache } from "./peer-config.js";
import { macTribe, signEnroll, signAck, verifyAck } from "./peer-transport/peer-auth.js";

const originalHome = process.env.HOME;
const originalAbtarsHome = process.env.ABTARS_HOME;

function newKey() {
  const pair = generateKeyPairSync("ed25519");
  const signingKey = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return { signingKey, verifyKey: deriveVerifyKey(signingKey) };
}

/** Fake WebSocket: named listeners, send/close recording, OPEN semantics.
 *  `OPEN` is an instance constant, mirroring the real ws class. */
class FakeWs {
  OPEN = 1;
  readyState = 1;
  sends: string[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  private listeners = new Map<string, Array<(arg: unknown) => void>>();

  on(ev: string, cb: (arg: unknown) => void): this {
    this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), cb]);
    return this;
  }

  removeListener(ev: string, cb: (arg: unknown) => void): this {
    this.listeners.set(ev, (this.listeners.get(ev) ?? []).filter(c => c !== cb));
    return this;
  }

  emit(ev: string, arg?: unknown): void {
    for (const cb of this.listeners.get(ev) ?? []) cb(arg);
  }

  send(data: string): void {
    this.sends.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.emit("close");
  }
}

function makeReq(ip = "127.0.0.1", port = "8080") {
  return { socket: { remoteAddress: ip }, headers: { "x-peer-port": port } } as any;
}

const FIXED_MS = 1_720_000_000_000;
const FIXED_NONCE = Buffer.alloc(16, 7);

describe("PeerEnrollmentHandler", () => {
  let tmpDir: string;
  let selfKey: { signingKey: string; verifyKey: string };
  let initKey: { signingKey: string; verifyKey: string };
  let tribeToken: string;
  let peersPath: string;
  let registered: Array<{ name: string; ws: FakeWs }>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "enroll-test-"));
    process.env.HOME = tmpDir;
    process.env.ABTARS_HOME = join(tmpDir, ".abtars");
    mkdirSync(join(tmpDir, ".abtars", "config"), { recursive: true });
    mkdirSync(join(tmpDir, ".abtars", "logs"), { recursive: true });
    clearPeerConfigCache();
    selfKey = newKey();
    initKey = newKey();
    tribeToken = Buffer.from("tribe-secret-token").toString("base64");
    peersPath = join(tmpDir, ".abtars", "config", "peers.json");
    registered = [];
    writeFileSync(peersPath, JSON.stringify({
      self: { name: "responder", signingKey: selfKey.signingKey, tribeToken },
      peers: {},
      maxHops: 12,
      timeoutMs: 60000,
    }, null, 2));
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAbtarsHome === undefined) delete process.env.ABTARS_HOME;
    else process.env.ABTARS_HOME = originalAbtarsHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<PeerEnrollmentDeps> = {}): PeerEnrollmentDeps {
    return {
      registerPeerWs: (name, ws) => { registered.push({ name, ws: ws as FakeWs }); },
      now: () => FIXED_MS,
      randomBytes: (n: number) => { expect(n).toBe(16); return FIXED_NONCE; },
      readPeersJson: () => existsSync(peersPath) ? JSON.parse(readFileSync(peersPath, "utf-8")) : {},
      writePeersJson: (raw) => writeFileSync(peersPath, JSON.stringify(raw, null, 2)),
      ...overrides,
    };
  }

  const nowSec = Math.floor(FIXED_MS / 1000);
  const nonceR = FIXED_NONCE.toString("hex");

  function knockFrame(ts = nowSec, pubKeyI = initKey.verifyKey, nonceI = "nonce_i_1") {
    return JSON.stringify({ pubKey_i: pubKeyI, nonce_i: nonceI, ts });
  }

  function enrollFrame(opts: { mac_i?: string; name?: string; nonce_r?: string; ts?: number; selfSig?: string } = {}) {
    return JSON.stringify({
      mac_i: opts.mac_i ?? macTribe(tribeToken, initKey.verifyKey + nonceR),
      name: opts.name ?? "peer1",
      nonce_r: opts.nonce_r ?? nonceR,
      ts: opts.ts ?? nowSec,
      selfSig: opts.selfSig ?? signEnroll(initKey.signingKey, initKey.verifyKey, nonceR, "peer1"),
    });
  }

  /** Drive one full valid enrollment through a fresh handler + socket. */
  async function runValidEnrollment(overrides: Partial<PeerEnrollmentDeps> = {}): Promise<FakeWs> {
    const handler = new PeerEnrollmentHandler(makeDeps(overrides));
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", knockFrame());
    ws.emit("message", enrollFrame());
    return ws;
  }

  it("accepts a valid knock and sends the MAC challenge with a fresh responder nonce", async () => {
    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", knockFrame());

    expect(ws.closes).toEqual([]);
    expect(ws.sends).toHaveLength(1);
    const challenge = JSON.parse(ws.sends[0]!);
    expect(challenge).toEqual({
      pubKey_r: selfKey.verifyKey,
      nonce_r: nonceR,
      ts: nowSec,
      mac_r: macTribe(tribeToken, selfKey.verifyKey + "nonce_i_1"),
    });
  });

  it("persists trust-1 and promotes exactly once, with listener handoff before the ack", async () => {
    const ws = await runValidEnrollment();

    // Ack sent after promotion
    expect(ws.closes).toEqual([]);
    expect(ws.sends).toHaveLength(2);
    const ack = JSON.parse(ws.sends[1]!);
    expect(ack.name_r).toBe("responder");
    expect(ack.pubKey_r).toBe(selfKey.verifyKey);
    expect(verifyAck(ack.ackSig, selfKey.verifyKey, "responder", selfKey.verifyKey, nonceR)).toBe(true);

    // Promotion before acknowledgement
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe("peer1");
    expect(registered[0]!.ws).toBe(ws);

    // Trust-1 persistence with host/port
    const raw = JSON.parse(readFileSync(peersPath, "utf-8"));
    expect(raw.peers.peer1).toEqual({ host: "127.0.0.1", port: 8080, verifyKey: initKey.verifyKey, trust: 1 });
  });

  it("rejects a duplicate enroll frame after promotion without repeating side effects", async () => {
    const ws = await runValidEnrollment();
    ws.emit("message", enrollFrame());
    ws.emit("message", "garbage");

    expect(ws.sends).toHaveLength(2); // no extra ack
    expect(registered).toHaveLength(1); // no second promotion
    const raw = JSON.parse(readFileSync(peersPath, "utf-8"));
    expect(Object.keys(raw.peers)).toEqual(["peer1"]);
  });

  it("rejects stale knock timestamps without any challenge", async () => {
    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", knockFrame(nowSec - 60));

    expect(ws.closes).toEqual([{ code: 1008, reason: "stale ts" }]);
    expect(ws.sends).toEqual([]);
    expect(registered).toEqual([]);
  });

  it("rejects malformed frames with a terminal close", async () => {
    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", "not json");

    expect(ws.closes).toEqual([{ code: 1011, reason: "enrollment error" }]);
    expect(ws.sends).toEqual([]);
  });

  it("rejects an enroll with a nonce mismatch", async () => {
    const ws = await runValidEnrollment();
    const handler2 = new PeerEnrollmentHandler(makeDeps());
    const ws2 = new FakeWs();
    await handler2.accept(ws2 as any, makeReq());
    ws2.emit("message", knockFrame());
    ws2.emit("message", enrollFrame({ nonce_r: "wrong" }));
    expect(ws2.closes).toEqual([{ code: 1008, reason: "nonce mismatch" }]);
    void ws;
  });

  it("rejects an enroll with a bad tribe MAC without persistence or promotion", async () => {
    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", knockFrame());
    ws.emit("message", enrollFrame({ mac_i: "deadbeef" }));

    expect(ws.closes).toEqual([{ code: 1008, reason: "mac mismatch" }]);
    expect(registered).toEqual([]);
    expect(JSON.parse(readFileSync(peersPath, "utf-8")).peers).toEqual({});
  });

  it("rejects an enroll with an invalid self-signature", async () => {
    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", knockFrame());
    ws.emit("message", enrollFrame({ selfSig: "bad-sig" }));

    expect(ws.closes).toEqual([{ code: 1008, reason: "bad selfSig" }]);
    expect(registered).toEqual([]);
    expect(JSON.parse(readFileSync(peersPath, "utf-8")).peers).toEqual({});
  });

  it("rejects a pinned-key change (existing peer with a different verifyKey)", async () => {
    const other = newKey();
    writeFileSync(peersPath, JSON.stringify({
      self: { name: "responder", signingKey: selfKey.signingKey, tribeToken },
      peers: { peer1: { host: "old", port: 1, verifyKey: other.verifyKey, trust: 2 } },
      maxHops: 12,
      timeoutMs: 60000,
    }, null, 2));

    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", knockFrame());
    ws.emit("message", enrollFrame());

    expect(ws.closes).toEqual([{ code: 1008, reason: "key changed — operator action required" }]);
    expect(registered).toEqual([]);
    // Persistence untouched
    expect(JSON.parse(readFileSync(peersPath, "utf-8")).peers.peer1.verifyKey).toBe(other.verifyKey);
  });

  it("rejects a frame that skips the knock (protocol order)", async () => {
    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", enrollFrame());

    // First frame in awaiting_knock is treated as a knock with missing
    // required fields (pubKey_i present but nonce_i/ts absent).
    expect(ws.closes).toEqual([{ code: 1008, reason: "invalid knock" }]);
    expect(registered).toEqual([]);
  });

  it("close and error transitions are terminal (no persistence after)", async () => {
    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", knockFrame());
    ws.emit("close");

    // A late enroll frame must not persist or promote.
    ws.emit("message", enrollFrame());
    expect(registered).toEqual([]);
    expect(JSON.parse(readFileSync(peersPath, "utf-8")).peers).toEqual({});
    expect(ws.sends).toHaveLength(1); // only the challenge
  });

  it("error transitions are terminal", async () => {
    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", knockFrame());
    ws.emit("error");
    ws.emit("message", enrollFrame());
    expect(registered).toEqual([]);
    expect(JSON.parse(readFileSync(peersPath, "utf-8")).peers).toEqual({});
  });

  it("rate-limits repeated attempts from the same IP inside the window", async () => {
    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();
    await handler.accept(ws1 as any, makeReq("10.0.0.5"));
    await handler.accept(ws2 as any, makeReq("10.0.0.5"));

    expect(ws1.closes).toEqual([]);
    expect(ws2.closes).toEqual([{ code: 1008, reason: "rate limited" }]);
    expect(ws2.sends).toEqual([]);
  });

  it("allows a different IP inside the window", async () => {
    const handler = new PeerEnrollmentHandler(makeDeps());
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();
    await handler.accept(ws1 as any, makeReq("10.0.0.5"));
    await handler.accept(ws2 as any, makeReq("10.0.0.6"));
    ws1.emit("message", knockFrame());
    ws2.emit("message", knockFrame());
    expect(ws1.sends).toHaveLength(1);
    expect(ws2.sends).toHaveLength(1);
  });

  it("uses production defaults (config bootstrap + peers.json persistence) when deps are minimal", async () => {
    const registeredProd: Array<{ name: string }> = [];
    const handler = new PeerEnrollmentHandler({
      registerPeerWs: (name) => { registeredProd.push({ name }); },
      now: () => FIXED_MS,
      randomBytes: (n: number) => Buffer.alloc(n, 7),
    });
    const ws = new FakeWs();
    await handler.accept(ws as any, makeReq());
    ws.emit("message", knockFrame());
    ws.emit("message", enrollFrame());

    // Production default persistence wrote into abtarsHome (HOME=tmp).
    const raw = JSON.parse(readFileSync(join(tmpDir, ".abtars", "config", "peers.json"), "utf-8"));
    expect(raw.peers.peer1.verifyKey).toBe(initKey.verifyKey);
    expect(raw.peers.peer1.trust).toBe(1);
    expect(registeredProd).toHaveLength(1);
  });
});

describe("enrollment acknowledgement shape", () => {
  it("acks with a responder signature verifiable by the initiator's key material", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "enroll-ack-"));
    process.env.HOME = tmpDir;
    process.env.ABTARS_HOME = join(tmpDir, ".abtars");
    mkdirSync(join(tmpDir, ".abtars", "config"), { recursive: true });
    try {
      const selfKey = newKey();
      const initKey = newKey();
      const tribeToken = Buffer.from("t2").toString("base64");
      const peersPath = join(tmpDir, ".abtars", "config", "peers.json");
      writeFileSync(peersPath, JSON.stringify({
        self: { name: "responder", signingKey: selfKey.signingKey, tribeToken },
        peers: {},
        maxHops: 12,
        timeoutMs: 60000,
      }, null, 2));

      const sends: string[] = [];
      const ws = new FakeWs();
      ws.send = (d: string) => { sends.push(d); };
      const handler = new PeerEnrollmentHandler({
        registerPeerWs: () => {},
        now: () => FIXED_MS,
        randomBytes: (n: number) => Buffer.alloc(n, 7),
        readPeersJson: () => JSON.parse(readFileSync(peersPath, "utf-8")),
        writePeersJson: (raw) => writeFileSync(peersPath, JSON.stringify(raw, null, 2)),
      });
      const nowSec = Math.floor(FIXED_MS / 1000);
      const nonceR = Buffer.alloc(16, 7).toString("hex");
      await handler.accept(ws as any, makeReq());
      ws.emit("message", JSON.stringify({ pubKey_i: initKey.verifyKey, nonce_i: "n1", ts: nowSec }));
      ws.emit("message", JSON.stringify({
        mac_i: macTribe(tribeToken, initKey.verifyKey + nonceR),
        name: "peerA",
        nonce_r: nonceR,
        ts: nowSec,
        selfSig: signEnroll(initKey.signingKey, initKey.verifyKey, nonceR, "peerA"),
      }));

      expect(sends).toHaveLength(2);
      const ack = JSON.parse(sends[1]!);
      // The initiator verifies the ack with the responder's advertised pubkey.
      expect(verifyAck(ack.ackSig, ack.pubKey_r, ack.name_r, ack.pubKey_r, nonceR)).toBe(true);
    } finally {
      process.env.HOME = originalHome;
      if (originalAbtarsHome === undefined) delete process.env.ABTARS_HOME;
      else process.env.ABTARS_HOME = originalAbtarsHome;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("signAck wire shape", () => {
  it("ack canonical form matches the initiator-side verifier", () => {
    const k = newKey();
    const nonce = "n123";
    const ackSig = signAck(k.signingKey, "responder", k.verifyKey, nonce);
    expect(verifyAck(ackSig, k.verifyKey, "responder", k.verifyKey, nonce)).toBe(true);
  });
});
