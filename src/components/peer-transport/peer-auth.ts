/**
 * peer-auth.ts — Ed25519 request signing, gossip, enrollment, and TLS helpers (#1293).
 *
 * Auth model (Option A): one Ed25519 keypair per host.
 * - Request signing: whole-request Ed25519 signature on every inbound/outbound peer route.
 * - TLS: self-signed cert whose key IS the identity key (confidentiality + server identity).
 * - Gossip: Ed25519-signed UDP packets.
 * - Enrollment: HMAC-SHA256 challenge-response using shared tribeToken.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Nonce cache (replay prevention) — #1390 durable store ────────────────────

import { PeerNonceStore } from "./peer-nonce-store.js";

let _nonceStore: PeerNonceStore | null = null;
function getNonceStore(): PeerNonceStore {
  if (!_nonceStore) _nonceStore = new PeerNonceStore();
  return _nonceStore;
}

export function isNonceSeen(nonce: string): boolean {
  return getNonceStore().isSeen(nonce);
}

export function recordNonce(nonce: string): void {
  getNonceStore().record(nonce);
}

// ── Key helpers ───────────────────────────────────────────────────────────────

/** Import a base64 PKCS8 DER private key into a KeyObject. */
function importPrivKey(signingKey: string): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" });
}

/** Import a base64 SPKI DER public key into a KeyObject. */
function importPubKey(verifyKey: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: Buffer.from(verifyKey, "base64"), format: "der", type: "spki" });
}

/** Ed25519 sign: returns base64-encoded signature. */
function edSign(signingKey: string, message: string): string {
  // Ed25519 uses null algorithm (prehash-free)
  return cryptoSign(null, Buffer.from(message, "utf-8"), importPrivKey(signingKey)).toString("base64");
}

/** Ed25519 verify: returns true if signature is valid. */
function edVerify(verifyKey: string, message: string, sigBase64: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(message, "utf-8"), importPubKey(verifyKey), Buffer.from(sigBase64, "base64"));
  } catch {
    return false;
  }
}

// ── Request signing ───────────────────────────────────────────────────────────

/** Timestamp window (seconds). Used inline in verifyRequest/verifyWsRequest. */
const TS_WINDOW_SEC = 30;

/**
 * Sign an outbound request. Returns headers to attach.
 *
 * Canonical string:
 *   "abtars-req-v1\n" + method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + hex(sha256(body))
 */
export function signRequest(
  method: string,
  path: string,
  body: string,
  signingKey: string,
  selfName: string,
): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body, "utf-8").digest("hex");
  const canonical = `abtars-req-v1\n${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
  const sig = edSign(signingKey, canonical);
  return {
    "X-Peer-Id": selfName,
    "X-Peer-Ts": ts,
    "X-Peer-Nonce": nonce,
    "X-Peer-Sig": sig,
  };
}

export interface VerifyRequestResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify an inbound request's Ed25519 signature.
 */
export function verifyRequest(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  body: string,
  verifyKey: string,
): VerifyRequestResult {
  // Normalize to lowercase for compatibility with Node.js HTTP (which lowercases headers)
  const h: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;

  const peerId = h["x-peer-id"];
  const tsHeader = h["x-peer-ts"];
  const nonce = h["x-peer-nonce"];
  const sig = h["x-peer-sig"];

  if (
    typeof peerId !== "string" ||
    typeof tsHeader !== "string" ||
    typeof nonce !== "string" ||
    typeof sig !== "string"
  ) {
    return { ok: false, reason: "missing_headers" };
  }

  const ts = parseInt(tsHeader, 10);
  if (isNaN(ts)) return { ok: false, reason: "invalid_ts" };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > TS_WINDOW_SEC) return { ok: false, reason: "stale_ts" };

  if (isNonceSeen(nonce)) return { ok: false, reason: "nonce_replay" };

  const bodyHash = createHash("sha256").update(body, "utf-8").digest("hex");
  const canonical = `abtars-req-v1\n${method}\n${path}\n${tsHeader}\n${nonce}\n${bodyHash}`;

  if (!edVerify(verifyKey, canonical, sig)) return { ok: false, reason: "bad_sig" };

  recordNonce(nonce);
  return { ok: true };
}

// ── #1390: WSS request domain (binds peerId + requestId) ─────────────────────

/**
 * Sign a WSS request frame. Uses the WS domain which binds peerId and requestId:
 *
 * Canonical string:
 *   "abtars-ws-req-v1\n" + peerId + "\n" + requestId + "\n" + method + "\n" +
 *   canonicalPath + "\n" + ts + "\n" + nonce + "\n" + hex(sha256(body))
 */
export function signWsRequest(
  peerId: string,
  requestId: string,
  method: string,
  canonicalPath: string,
  body: string,
  signingKey: string,
): { ts: string; nonce: string; sig: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body, "utf-8").digest("hex");
  const canonical = `abtars-ws-req-v1\n${peerId}\n${requestId}\n${method}\n${canonicalPath}\n${ts}\n${nonce}\n${bodyHash}`;
  const sig = edSign(signingKey, canonical);
  return { ts, nonce, sig };
}

export interface VerifyWsRequestFields {
  peerId: string;
  requestId: string;
  ts: string;
  nonce: string;
  sig: string;
}

/**
 * Verify a WSS request frame's Ed25519 signature. Uses the durable
 * PeerNonceStore for restart-proof replay protection.
 */
export function verifyWsRequest(
  fields: VerifyWsRequestFields,
  method: string,
  canonicalPath: string,
  body: string,
  verifyKey: string,
): VerifyRequestResult {
  const { peerId, requestId, ts: tsStr, nonce, sig } = fields;

  if (!peerId || !requestId || !tsStr || !nonce || !sig) {
    return { ok: false, reason: "missing_fields" };
  }

  const ts = parseInt(tsStr, 10);
  if (isNaN(ts)) return { ok: false, reason: "invalid_ts" };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > TS_WINDOW_SEC) return { ok: false, reason: "stale_ts" };

  const store = getNonceStore();
  if (store.isSeen(nonce)) return { ok: false, reason: "nonce_replay" };

  const bodyHash = createHash("sha256").update(body, "utf-8").digest("hex");
  const canonical = `abtars-ws-req-v1\n${peerId}\n${requestId}\n${method}\n${canonicalPath}\n${tsStr}\n${nonce}\n${bodyHash}`;

  if (!edVerify(verifyKey, canonical, sig)) return { ok: false, reason: "bad_sig" };

  store.record(nonce);
  return { ok: true };
}

// ── Tribe HMAC ────────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256 for tribe enrollment authentication.
 * Returns lowercase hex digest.
 */
export function macTribe(tribeToken: string, ...parts: string[]): string {
  return createHmac("sha256", Buffer.from(tribeToken, "base64"))
    .update(parts.join(""))
    .digest("hex");
}

// ── Enrollment signatures ─────────────────────────────────────────────────────

/**
 * Sign enrollment message (initiator).
 * canonical: "abtars-enroll-v1\n" + pubKey_i + "\n" + nonce_r + "\n" + name
 */
export function signEnroll(signingKey: string, pubKeyI: string, nonceR: string, name: string): string {
  const canonical = `abtars-enroll-v1\n${pubKeyI}\n${nonceR}\n${name}`;
  return edSign(signingKey, canonical);
}

/** Verify enrollment signature (responder verifies initiator). */
export function verifyEnroll(selfSig: string, verifyKey: string, pubKeyI: string, nonceR: string, name: string): boolean {
  const canonical = `abtars-enroll-v1\n${pubKeyI}\n${nonceR}\n${name}`;
  return edVerify(verifyKey, canonical, selfSig);
}

/**
 * Sign acknowledgment (responder).
 * canonical: "abtars-enroll-v1\n" + "ack\n" + name_r + "\n" + pubKey_r + "\n" + nonce_r
 */
export function signAck(signingKey: string, nameR: string, pubKeyR: string, nonceR: string): string {
  const canonical = `abtars-enroll-v1\nack\n${nameR}\n${pubKeyR}\n${nonceR}`;
  return edSign(signingKey, canonical);
}

/** Verify acknowledgment signature (initiator verifies responder). */
export function verifyAck(ackSig: string, verifyKey: string, nameR: string, pubKeyR: string, nonceR: string): boolean {
  const canonical = `abtars-enroll-v1\nack\n${nameR}\n${pubKeyR}\n${nonceR}`;
  return edVerify(verifyKey, canonical, ackSig);
}

// ── TLS cert generation ───────────────────────────────────────────────────────

export interface TlsCertResult {
  key: string;   // PEM — PKCS8 private key
  cert: string;  // PEM — self-signed X.509 cert
}

/**
 * Generate a self-signed Ed25519 TLS cert from the identity signing key.
 * The private key used in the cert IS the identity key — same keypair.
 */
export function generateTlsCert(signingKey: string, cn: string): TlsCertResult {
  const tmpDir = join(tmpdir(), `abtars-tls-${randomBytes(8).toString("hex")}`);
  mkdirSync(tmpDir, { recursive: true });

  const keyPemPath = join(tmpDir, "key.pem");
  const certPath = join(tmpDir, "cert.pem");

  try {
    // Export private key as PKCS8 PEM
    const privKeyObj = importPrivKey(signingKey);
    const keyPem = privKeyObj.export({ type: "pkcs8", format: "pem" }) as string;
    writeFileSync(keyPemPath, keyPem, { mode: 0o600 });

    // Generate self-signed cert using the identity key
    const safeCn = cn.replace(/[^A-Za-z0-9_\-.]/g, "_").slice(0, 64);
    execSync(
      `openssl req -x509 -key "${keyPemPath}" -out "${certPath}" -days 3650 -nodes -subj "/CN=${safeCn}"`,
      { stdio: "pipe" },
    );

    const key = readFileSync(keyPemPath, "utf-8");
    const cert = readFileSync(certPath, "utf-8");
    return { key, cert };
  } finally {
    try { unlinkSync(keyPemPath); } catch { /* best effort */ }
    try { unlinkSync(certPath); } catch { /* best effort */ }
    try { require("node:fs").rmdirSync(tmpDir); } catch { /* best effort */ }
  }
}

/**
 * Verify that the presented TLS cert's SPKI public key matches the enrolled verifyKey.
 * cert: PEM string. verifyKey: base64 SPKI DER.
 */
export function verifyServerCert(cert: string, verifyKey: string): boolean {
  try {
    const keyObj = createPublicKey({ key: cert, format: "pem" });
    const certSpki = (keyObj.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
    // Timing-safe comparison
    const expected = Buffer.from(verifyKey, "base64");
    const actual = Buffer.from(certSpki, "base64");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
