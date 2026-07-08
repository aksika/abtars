/**
 * secrets.ts — Read/write secrets from ~/.abtars/secrets/ directory (#597, #598).
 * One file per secret. Supports plaintext (legacy) and encrypted (ENC: prefix).
 * Encryption uses abtars's own abtars.key via crypto.ts — no abmind dependency.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv } from "node:crypto";
import { abtarsHome } from "../paths.js";
import { loadKey, deriveKey } from "../utils/crypto.js";

const SECRETS_DIR = join(abtarsHome(), "secret");
const cache = new Map<string, string>();
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = 0x01;

// Ensure secrets dir exists on first import
if (!existsSync(SECRETS_DIR)) {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
}

// Lazy-init: derived key cached for process lifetime
let cachedKey: Buffer | null = null;

function getSecretsKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  const master = loadKey(join(abtarsHome(), "config", "abtars.key"));
  if (!master) return null;
  cachedKey = deriveKey(master, "abtars-secrets-v1");
  return cachedKey;
}

function decryptSecret(blob: string, key: Buffer): string | null {
  try {
    const buf = Buffer.from(blob, "base64");
    const version = buf[0];
    if (version !== VERSION) return null;
    const iv = buf.subarray(1, 1 + IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ciphertext = buf.subarray(1 + IV_LEN, buf.length - TAG_LEN);
    const { createDecipheriv } = require("node:crypto");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
  } catch { return null; }
}

function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([Buffer.from([VERSION]), iv, encrypted, tag]);
  return blob.toString("base64");
}

/** Read a secret from ~/.abtars/secrets/<name>. Cached per process. */
export function readSecret(name: string): string | undefined {
  if (cache.has(name)) return cache.get(name);
  try {
    const raw = readFileSync(join(SECRETS_DIR, name), "utf-8").trim();
    if (!raw) return undefined;
    if (raw.startsWith("ENC:")) {
      const key = getSecretsKey();
      if (!key) return undefined;
      const value = decryptSecret(raw.slice(4), key);
      if (value === null) return undefined;
      cache.set(name, value);
      return value;
    }
    cache.set(name, raw);
    return raw;
  } catch { return undefined; }
}

/** Initialize the secrets encryption key. Call once at boot. */
export function initSecretsKey(): void {
  if (cachedKey) return;
  cachedKey = getSecretsKey();
}

/** Write an encrypted secret to ~/.abtars/secrets/<name>. */
export function writeSecret(name: string, value: string): void {
  const key = getSecretsKey();
  if (!key) throw new Error("Cannot encrypt secret: abtars.key not found. Run abtars install.");
  const encrypted = "ENC:" + encryptSecret(value, key);
  writeFileSync(join(SECRETS_DIR, name), encrypted, { mode: 0o600 });
  cache.set(name, value);
}

/** Clear cached secret values (for testing or reload). Does not clear the encryption key. */
export function clearSecretCache(): void { cache.clear(); }
