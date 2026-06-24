/**
 * crypto.ts — AES-256-GCM encryption for abtars secrets.
 * Shared utility (same logic in abmind). See shared-utilities.md.
 *
 * Key: ~/.abtars/secret/abtars.key (32-byte hex, passphrase-derived via scrypt).
 * Purpose derivation: HKDF(master, "abtars-secrets-v1") for file encryption.
 */

import { createDecipheriv, createCipheriv, randomBytes, hkdfSync, scryptSync, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const PURPOSE = "abtars-secrets-v1";

let _cachedKey: Buffer | null = null;

/** Load master key from file. Returns null if file doesn't exist. */
export function loadKey(keyPath: string): Buffer | null {
  try {
    if (!existsSync(keyPath)) return null;
    const hex = readFileSync(keyPath, "utf-8").trim();
    if (hex.length !== 64) return null;
    return Buffer.from(hex, "hex");
  } catch { return null; }
}

/** Derive purpose-specific key from master via HKDF. */
export function deriveKey(master: Buffer, purpose: string = PURPOSE): Buffer {
  return Buffer.from(hkdfSync("sha256", master, "", purpose, 32));
}

/** Derive master key from passphrase + username (same algorithm as abmind). */
export function deriveFromPassphrase(passphrase: string, username: string): Buffer {
  const salt = createHash("sha256").update("abtars:" + username).digest().subarray(0, 16);
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

/** Encrypt plaintext. Returns "ENC:" + base64(version + iv + ciphertext + tag). */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf-8"), c.final()]);
  return "ENC:" + Buffer.concat([Buffer.from([0x01]), iv, enc, c.getAuthTag()]).toString("base64");
}

/** Decrypt "ENC:..." string. Returns plaintext or null on failure. */
export function decrypt(raw: string, key: Buffer): string | null {
  try {
    const buf = Buffer.from(raw.slice(4), "base64");
    const iv = buf.subarray(1, 1 + IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ct = buf.subarray(1 + IV_LEN, buf.length - TAG_LEN);
    const d = createDecipheriv(ALGO, key, iv);
    d.setAuthTag(tag);
    return d.update(ct, undefined, "utf-8") + d.final("utf-8");
  } catch { return null; }
}

/** Write key to file (hex, mode 600). Creates parent dir if needed. */
export function writeKeyFile(keyPath: string, master: Buffer): void {
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, master.toString("hex"), { mode: 0o600 });
}

const VERIFY_PLAINTEXT = "abtars-verify";

/** Create key.verify file next to the key (encrypt known plaintext). */
export function writeKeyVerify(keyPath: string, key: Buffer): void {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(VERIFY_PLAINTEXT, "utf-8"), cipher.final()]);
  const blob = Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64");
  writeFileSync(join(dirname(keyPath), "key.verify"), blob, { mode: 0o600 });
}

/** Validate a key against key.verify. Returns true if key is correct or no verify file exists. */
export function validateKey(keyPath: string, key: Buffer): boolean {
  const verifyPath = join(dirname(keyPath), "key.verify");
  if (!existsSync(verifyPath)) return true; // no verify file = skip validation
  try {
    const blob = readFileSync(verifyPath, "utf-8").trim();
    const buf = Buffer.from(blob, "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
    const d = createDecipheriv(ALGO, key, iv);
    d.setAuthTag(tag);
    const result = d.update(ct, undefined, "utf-8") + d.final("utf-8");
    return result === VERIFY_PLAINTEXT;
  } catch { return false; }
}
