import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const MAX_AGE_SECONDS = 30;
const DELIMITER = "|";

export interface SignResult {
  tag: string; // [sig:timestamp:base64signature]
}

export function signMessage(privateKeyBase64: string, nick: string, channel: string, text: string): SignResult {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${nick}${DELIMITER}${channel}${DELIMITER}${ts}${DELIMITER}${text}`;
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
  const sig = sign(null, Buffer.from(payload, "utf-8"), key);
  return { tag: `[sig:${ts}:${sig.toString("base64")}]` };
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  text: string; // text with sig tag stripped
}

export function verifyMessage(publicKeyBase64: string, nick: string, channel: string, rawText: string): VerifyResult {
  const match = rawText.match(/\[sig:(\d+):([A-Za-z0-9+/=]+)\]$/);
  if (!match) return { valid: false, reason: "no-signature", text: rawText };

  const ts = parseInt(match[1]!, 10);
  const sigBytes = Buffer.from(match[2]!, "base64");
  const text = rawText.slice(0, match.index!).trimEnd();

  // Replay check
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_AGE_SECONDS) {
    return { valid: false, reason: "expired", text };
  }

  const payload = `${nick}${DELIMITER}${channel}${DELIMITER}${ts}${DELIMITER}${text}`;
  const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
  const ok = verify(null, Buffer.from(payload, "utf-8"), key, sigBytes);
  if (!ok) return { valid: false, reason: "bad-signature", text };
  return { valid: true, text };
}

export function stripSigTag(text: string): string {
  return text.replace(/\s*\[sig:\d+:[A-Za-z0-9+/=]+\]$/, "");
}
