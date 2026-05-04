/**
 * Minimal JWT-HS256 implementation for peer auth (#393).
 * No external deps — uses Node built-in crypto only.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtPayload {
  iss: string;  // sender name
  aud: string;  // receiver name
  iat: number;  // issued-at (seconds)
  exp: number;  // expiry (seconds)
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlEncode(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64url");
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, "base64url").toString("utf-8");
}

const HEADER = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/**
 * Sign a JWT with HS256.
 */
export function signJwt(payload: JwtPayload, secret: string): string {
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sigInput = `${HEADER}.${payloadB64}`;
  const sig = base64url(createHmac("sha256", secret).update(sigInput).digest());
  return `${sigInput}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; reason: string };

/**
 * Verify a JWT-HS256 token. Returns the payload if valid.
 *
 * @param token     Raw JWT string
 * @param secret    Shared secret for this peer
 * @param selfName  Our own name (checked against `aud`)
 * @param clockSkewSec  Tolerance for clock drift (default 5s)
 */
export function verifyJwt(
  token: string,
  secret: string,
  selfName: string,
  clockSkewSec = 5,
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  const [headerB64, payloadB64, sigB64] = parts;

  // Verify signature (timing-safe)
  const sigInput = `${headerB64}.${payloadB64}`;
  const expected = createHmac("sha256", secret).update(sigInput).digest();
  const actual = Buffer.from(sigB64!, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad_signature" };
  }

  // Decode payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64!));
  } catch {
    return { ok: false, reason: "malformed_payload" };
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return { ok: false, reason: "expired" };

  // Check iat not too far in future (clock skew)
  if (payload.iat > now + clockSkewSec) return { ok: false, reason: "iat_future" };

  // Check audience
  if (payload.aud !== selfName) return { ok: false, reason: "wrong_aud" };

  return { ok: true, payload };
}
