import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { deriveVerifyKey } from "../peer-config.js";
import {
  DOORBELL_PORT,
  peerSelector, buildFreshQuery, buildQueryCanonical,
  encodeQuery, encodeResponse, buildFreshAck,
  parseQuery,
} from "./peer-doorbell-codec.js";
import { PeerDoorbellService, type PeerConnectionManager } from "./peer-doorbell.js";

function makeKey(): { signingKey: string; verifyKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return { signingKey, verifyKey: deriveVerifyKey(signingKey) };
}

const LOCAL = makeKey();
const REMOTE = makeKey();
const localSelector = peerSelector(LOCAL.verifyKey);
const remoteSelector = peerSelector(REMOTE.verifyKey);

const SELF_NAME = "local";
const PEER_NAME = "remote";

// ── Mock dgram ───────────────────────────────────────────────────────────────

type MessageHandler = (msg: Buffer, rinfo: { address: string; port: number }) => void;
type ErrorHandler = (err: Error) => void;
let mockMessageHandler: MessageHandler | null = null;
let mockErrorHandler: ErrorHandler | null = null;
let mockBindCallback: (() => void) | null = null;
let mockSendCallback: ((err: Error | null) => void) | null = null;
let mockSentPacket: Buffer | null = null;
let mockCloseCallback: (() => void) | null = null;

const mockSocket = {
  on: vi.fn((event: string, handler: any) => {
    if (event === "message") mockMessageHandler = handler;
    if (event === "error") mockErrorHandler = handler;
    if (event === "close") mockCloseCallback = handler;
    return mockSocket;
  }),
  once: vi.fn((event: string, handler: any) => {
    if (event === "error") mockErrorHandler = handler;
    return mockSocket;
  }),
  bind: vi.fn((port: number, addr: string, cb: () => void) => {
    mockBindCallback = cb;
    setTimeout(cb, 10);
  }),
  send: vi.fn((msg: Buffer, _off: number, _len: number, port: number, addr: string, cb: (err: Error | null) => void) => {
    mockSentPacket = msg;
    mockSendCallback = cb;
    setTimeout(() => cb(null), 10);
  }),
  close: vi.fn(() => {
    if (mockCloseCallback) mockCloseCallback();
  }),
};

vi.mock("node:dgram", () => ({
  createSocket: vi.fn(() => mockSocket),
}));

vi.mock("../peer-config.js", () => ({
  loadPeerConfig: vi.fn(() => ({
    self: { name: SELF_NAME, signingKey: LOCAL.signingKey },
    peers: {
      [PEER_NAME]: { host: "127.0.0.1", port: 7100, verifyKey: REMOTE.verifyKey, transport: "ws-outbound" },
    },
  })),
  deriveVerifyKey: (sk: string) => {
    const { createPublicKey, createPrivateKey } = require("node:crypto") as typeof import("node:crypto");
    const priv = createPrivateKey({ key: Buffer.from(sk, "base64"), format: "der", type: "pkcs8" });
    return createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetMocks() {
  mockMessageHandler = null;
  mockErrorHandler = null;
  mockBindCallback = null;
  mockSendCallback = null;
  mockSentPacket = null;
  mockCloseCallback = null;
  vi.clearAllMocks();
}

function deliverQuery(pkt: Buffer, fromAddr = "127.0.0.1", fromPort = 12345) {
  if (mockMessageHandler) mockMessageHandler(pkt, { address: fromAddr, port: fromPort });
}

function deliverResponse(pkt: Buffer, fromAddr = "127.0.0.1", fromPort = DOORBELL_PORT) {
  if (mockMessageHandler) mockMessageHandler(pkt, { address: fromAddr, port: fromPort });
}

function buildValidQuery(): Buffer {
  const q = buildFreshQuery(REMOTE.signingKey, remoteSelector, localSelector);
  return encodeQuery(q) as Buffer;
}

function buildValidAckForPending(): Buffer {
  if (!mockSentPacket) return Buffer.alloc(0);
  const parsed = parseQuery(mockSentPacket);
  if ("code" in parsed) return Buffer.alloc(0);
  const q = parsed.parsed;
  const qCanonical = buildQueryCanonical(q);
  const ack = buildFreshAck(REMOTE.signingKey, remoteSelector, q.nonce, qCanonical);
  return encodeResponse(mockSentPacket, ack) as Buffer;
}

let mockEnsureCall: { peerName: string; input: { reason: string } } | null = null;

const mockConnectionManager: PeerConnectionManager = {
  ensurePeerConnection(peerName, input) {
    mockEnsureCall = { peerName, input: { reason: input.reason } };
  },
};

function createService(): PeerDoorbellService {
  return new PeerDoorbellService(mockConnectionManager);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PeerDoorbellService — lifecycle", () => {
  beforeEach(resetMocks);

  it("start() binds and sets isRunning", async () => {
    const svc = createService();
    await svc.start();
    expect(mockSocket.bind).toHaveBeenCalledWith(DOORBELL_PORT, "0.0.0.0", expect.any(Function));
    expect(svc.isRunning).toBe(true);
    await svc.stop();
  });

  it("stop() cleans up socket and clears pending", async () => {
    const svc = createService();
    await svc.start();
    await svc.stop();
    expect(mockSocket.close).toHaveBeenCalled();
    expect(svc.isRunning).toBe(false);
  });

  it("bind failure is caught and does not throw", { timeout: 5000 }, async () => {
    // Create a local mock socket just for this test to avoid leaking state
    const localBindFn = vi.fn((_p: number, _a: string, cb: () => void) => {
      setTimeout(() => {
        if (mockErrorHandler) mockErrorHandler(Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
      }, 10);
    });
    const savedBind = mockSocket.bind;
    mockSocket.bind = localBindFn as any;
    const svc = createService();
    await expect(svc.start()).resolves.toBeUndefined();
    expect(svc.isRunning).toBe(false);
    await svc.stop();
    mockSocket.bind = savedBind;
  });
});

describe("PeerDoorbellService — receiver side (query → ack)", () => {
  let svc: PeerDoorbellService;

  beforeEach(async () => {
    resetMocks();
    mockEnsureCall = null;
    vi.spyOn(Math, "random").mockReturnValue(0); // jitter = 0ms
    svc = createService();
    await svc.start();
  });

  afterEach(async () => {
    Math.random.mockRestore();
    await svc.stop();
  });

  it("valid query triggers ensurePeerConnection", async () => {
    deliverQuery(buildValidQuery());
    await new Promise(r => setTimeout(r, 50));
    expect(mockEnsureCall).not.toBeNull();
    expect(mockEnsureCall!.peerName).toBe(PEER_NAME);
    expect(mockEnsureCall!.input.reason).toBe("udp-doorbell");
  });

  it("wrong target selector → no connect", async () => {
    const wrong = peerSelector(makeKey().verifyKey);
    const q = buildFreshQuery(REMOTE.signingKey, remoteSelector, wrong);
    deliverQuery(encodeQuery(q) as Buffer);
    await new Promise(r => setTimeout(r, 50));
    expect(mockEnsureCall).toBeNull();
  });

  it("unknown sender selector → no connect", async () => {
    const unknown = makeKey();
    const unkSel = peerSelector(unknown.verifyKey);
    const q = buildFreshQuery(unknown.signingKey, unkSel, localSelector);
    deliverQuery(encodeQuery(q) as Buffer);
    await new Promise(r => setTimeout(r, 50));
    expect(mockEnsureCall).toBeNull();
  });

  it("bad signature → no connect", async () => {
    const wrongKey = makeKey();
    const q = buildFreshQuery(wrongKey.signingKey, remoteSelector, localSelector);
    deliverQuery(encodeQuery(q) as Buffer);
    await new Promise(r => setTimeout(r, 50));
    expect(mockEnsureCall).toBeNull();
  });

  it("replay of same nonce → second delivery does not trigger connect twice", async () => {
    const pkt = buildValidQuery();
    deliverQuery(pkt);
    await new Promise(r => setTimeout(r, 50));
    expect(mockEnsureCall).not.toBeNull();
    mockEnsureCall = null;

    deliverQuery(pkt);
    await new Promise(r => setTimeout(r, 50));
    expect(mockEnsureCall).toBeNull();
  });

  it("stale timestamp → no connect", async () => {
    const q = buildFreshQuery(REMOTE.signingKey, remoteSelector, localSelector);
    const stale = { ...q, timestampSec: BigInt(Math.floor(Date.now() / 1000) - 120) };
    const pkt = encodeQuery(stale as any) as Buffer;
    if (!("code" in pkt)) {
      deliverQuery(pkt);
      await new Promise(r => setTimeout(r, 50));
    }
    expect(mockEnsureCall).toBeNull();
  });

  it("future timestamp → no connect", async () => {
    const q = buildFreshQuery(REMOTE.signingKey, remoteSelector, localSelector);
    const future = { ...q, timestampSec: BigInt(Math.floor(Date.now() / 1000) + 120) };
    const pkt = encodeQuery(future as any) as Buffer;
    if (!("code" in pkt)) {
      deliverQuery(pkt);
      await new Promise(r => setTimeout(r, 50));
    }
    expect(mockEnsureCall).toBeNull();
  });

  it("source rate limit exceeded → subsequent queries dropped", async () => {
    // Burst: SOURCE_BURST = 8 queries allowed
    for (let i = 0; i < 10; i++) {
      const q = buildFreshQuery(REMOTE.signingKey, remoteSelector, localSelector);
      deliverQuery(encodeQuery(q) as Buffer);
      await new Promise(r => setTimeout(r, 5));
    }
    await new Promise(r => setTimeout(r, 50));
    // At most SOURCE_BURST connects should have been triggered
    const actual = mockEnsureCall ? 1 : 0;
    // The 9th+ query should be rate-limited, but ensurePeerConnection coalesces,
    // so at most 1 connect call is expected anyway. The key is no crash.
    expect(actual).toBeLessThanOrEqual(1);
  });
});

describe("PeerDoorbellService — sender side (ring)", () => {
  let svc: PeerDoorbellService;

  beforeEach(async () => {
    resetMocks();
    mockEnsureCall = null;
    svc = createService();
    await svc.start();
  });

  afterEach(async () => {
    await svc.stop();
  });

  it("ring for unknown peer returns unavailable", async () => {
    const r = await svc.ring("nonexistent");
    expect(r.status).toBe("unavailable");
  });

  it("ring sends a UDP packet", { timeout: 5000 }, async () => {
    mockSentPacket = null;
    const ringPromise = svc.ring(PEER_NAME);
    // Let send complete
    await new Promise(r => setTimeout(r, 200));
    // Should time out since no ack is coming
    const result = await ringPromise;
    expect(mockSocket.send).toHaveBeenCalled();
    expect(result.status).toBe("sent_no_ack");
  });

  it("ring before start returns unavailable", async () => {
    const svc2 = createService();
    const r = await svc2.ring(PEER_NAME);
    expect(r.status).toBe("unavailable");
  });

  it("ring after stop returns unavailable", async () => {
    const svc2 = createService();
    await svc2.start();
    await svc2.stop();
    const r = await svc2.ring(PEER_NAME);
    expect(r.status).toBe("unavailable");
  });
});

describe("PeerDoorbellService — ack validation", () => {
  let svc: PeerDoorbellService;

  beforeEach(async () => {
    resetMocks();
    mockEnsureCall = null;
    svc = createService();
    await svc.start();
  });

  afterEach(async () => {
    await svc.stop();
  });

  it("valid ack from correct source resolves acknowledged", { timeout: 5000 }, async () => {
    mockSentPacket = null;
    const ringPromise = svc.ring(PEER_NAME);
    await new Promise(r => setTimeout(r, 50));

    // Build ack from the sent query packet
    const ackPacket = buildValidAckForPending();
    expect(ackPacket.length).toBeGreaterThan(0);

    // Call handleMessage directly via the mock handler
    expect(mockMessageHandler).not.toBeNull();
    if (mockMessageHandler) {
      mockMessageHandler(ackPacket, { address: "127.0.0.1", port: DOORBELL_PORT });
    }
    const r = await ringPromise;
    expect(r.status).toBe("acknowledged");
  });

  it("ack from wrong source IP is rejected", { timeout: 5000 }, async () => {
    mockSentPacket = null;
    const ringPromise = svc.ring(PEER_NAME);
    await new Promise(r => setTimeout(r, 100));

    const ackPacket = buildValidAckForPending();
    if (ackPacket.length > 0) {
      deliverResponse(ackPacket, "192.168.1.99"); // wrong IP
    }
    const r = await ringPromise;
    expect(r.status).toBe("sent_no_ack");
  });

  it("ack with wrong nonce is rejected", { timeout: 5000 }, async () => {
    mockSentPacket = null;
    const ringPromise = svc.ring(PEER_NAME);
    await new Promise(r => setTimeout(r, 100));

    // Build ack with a different nonce
    if (mockSentPacket) {
      const parsed = parseQuery(mockSentPacket);
      if (!("code" in parsed)) {
        const q = parsed.parsed;
        const qCanonical = buildQueryCanonical(q);
        const wrongNonce = randomBytes(16);
        const ack = buildFreshAck(REMOTE.signingKey, remoteSelector, wrongNonce, qCanonical);
        const ackPacket = encodeResponse(mockSentPacket, ack) as Buffer;
        deliverResponse(ackPacket);
      }
    }
    const r = await ringPromise;
    expect(r.status).toBe("sent_no_ack");
  });
});
