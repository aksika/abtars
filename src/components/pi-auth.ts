/**
 * pi-auth.ts — Domain-separated Ed25519 signing/verification for Pi API (#1313).
 *
 * Uses the "abtars-pi-v1" domain prefix to prevent cross-protocol use of Pi
 * credentials on peer or host routes.
 *
 * Verification order (called by AgentApiServer):
 *   1. loopback address check
 *   2. /v1/pi/ route prefix
 *   3. body size limit (64 KiB)
 *   4. load registration + check revocation
 *   5. scope check
 *   6. timestamp window (30s)
 *   7. nonce replay cache
 *   8. body hash + signature
 *   --- nonce recorded after successful signature ---
 *   9. JSON parse and validate
 *   10. rate limit
 *   11. idempotency ledger
 */

import { createHash, randomBytes, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { readPiRegistration, type PiScope, type PiClientRegistration } from "./pi-client-registry.js";

// ── Nonce cache ────────────────────────────────────────────────────────

const nonceCache = new Map<string, number>();
const NONCE_TTL_MS = 60_000;
const MAX_NONCE_CACHE = 10_000;

function pruneNonces(): void {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const [nonce, ts] of nonceCache) {
    if (ts < cutoff) nonceCache.delete(nonce);
  }
}

export function isPiNonceSeen(nonce: string): boolean {
  pruneNonces();
  return nonceCache.has(nonce);
}

export function recordPiNonce(nonce: string): void {
  if (nonceCache.size >= MAX_NONCE_CACHE) {
    nonceCache.clear();
  }
  nonceCache.set(nonce, Date.now());
}

// ── Domain-separated signing ───────────────────────────────────────────

const PI_DOMAIN = "abtars-pi-v1";

function importPrivKey(signingKey: string): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" });
}

function importPubKey(verifyKey: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: Buffer.from(verifyKey, "base64"), format: "der", type: "spki" });
}

function edSign(signingKey: string, message: string): string {
  return cryptoSign(null, Buffer.from(message, "utf-8"), importPrivKey(signingKey)).toString("base64");
}

function edVerify(verifyKey: string, message: string, sigBase64: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(message, "utf-8"), importPubKey(verifyKey), Buffer.from(sigBase64, "base64"));
  } catch {
    return false;
  }
}

// ── Signing helpers ───────────────────────────────────────────────────

export interface PiSignResult {
  clientId: string;
  keyId: string;
  ts: string;
  nonce: string;
  sig: string;
}

/**
 * Build the canonical string for a Pi API request.
 *   abtars-pi-v1\n
 *   <METHOD>\n
 *   <EXACT PATH AND QUERY>\n
 *   <CLIENT ID>\n
 *   <KEY ID>\n
 *   <TIMESTAMP>\n
 *   <NONCE>\n
 *   <SHA256 RAW BODY HEX>
 */
export function piCanonical(
  method: string,
  path: string,
  clientId: string,
  keyId: string,
  ts: string,
  nonce: string,
  body: string,
): string {
  const bodyHash = createHash("sha256").update(body, "utf-8").digest("hex");
  return `${PI_DOMAIN}\n${method}\n${path}\n${clientId}\n${keyId}\n${ts}\n${nonce}\n${bodyHash}`;
}

/** Sign a Pi API request. Returns authentication headers. */
export function signPiRequest(
  method: string,
  path: string,
  body: string,
  signingKey: string,
  clientId: string,
  keyId: string,
): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const canonical = piCanonical(method, path, clientId, keyId, ts, nonce, body);
  const sig = edSign(signingKey, canonical);
  return {
    "X-Abtars-Pi-Client": clientId,
    "X-Abtars-Pi-Key-Id": keyId,
    "X-Abtars-Pi-Ts": ts,
    "X-Abtars-Pi-Nonce": nonce,
    "X-Abtars-Pi-Sig": sig,
  };
}

// ── Verification helpers ───────────────────────────────────────────────

export interface PiVerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a Pi API request.
 * Returns { ok: true } with the registration on success.
 * Returns { ok: false, reason } on failure — caller sends uniform 401.
 */
export function verifyPiRequest(
  method: string,
  path: string,
  body: string,
  headers: Record<string, string | string[] | undefined>,
): PiVerifyResult & { registration?: PiClientRegistration } {
  const h: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;

  const clientId = h["x-abtars-pi-client"];
  const keyId = h["x-abtars-pi-key-id"];
  const tsHeader = h["x-abtars-pi-ts"];
  const nonce = h["x-abtars-pi-nonce"];
  const sig = h["x-abtars-pi-sig"];

  if (typeof clientId !== "string" || typeof keyId !== "string" ||
      typeof tsHeader !== "string" || typeof nonce !== "string" || typeof sig !== "string") {
    return { ok: false, reason: "missing_headers" };
  }

  if (clientId !== "pi-local") {
    return { ok: false, reason: "unknown_client" };
  }

  const reg = readPiRegistration();
  if (!reg) return { ok: false, reason: "no_registration" };
  if (reg.revokedAt) return { ok: false, reason: "revoked" };
  if (reg.keyId !== keyId) return { ok: false, reason: "key_mismatch" };

  const ts = parseInt(tsHeader, 10);
  if (isNaN(ts)) return { ok: false, reason: "invalid_ts" };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 30) return { ok: false, reason: "stale_ts" };

  if (isPiNonceSeen(nonce)) return { ok: false, reason: "nonce_replay" };

  const canonical = piCanonical(method, path, clientId, keyId, tsHeader, nonce, body);
  if (!edVerify(reg.verifyKey, canonical, sig)) return { ok: false, reason: "bad_sig" };

  recordPiNonce(nonce);
  return { ok: true, registration: reg };
}

/** Check if a route/method requires a specific scope. */
export function piRouteRequiresScope(url: string, method: string): PiScope | null {
  if (url === "/v1/pi/status" && method === "GET") return "status";
  if (url === "/v1/pi/notify" && method === "POST") return "notify:main";
  if (url === "/v1/pi/tasks" && method === "POST") return "task:create";
  if (url.startsWith("/v1/pi/tasks/") && method === "GET") return "task:read";
  if (url === "/v1/pi/peers" && method === "GET") return "peer:read";
  if (url === "/v1/pi/peers/delegate" && method === "POST") return "peer:delegate";
  return null;
}

/** Check if the loopback address rule is satisfied. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return true;
  const normalized = addr.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/** Max body size for Pi requests (64 KiB). */
export const PI_MAX_BODY_BYTES = 64 * 1024;
