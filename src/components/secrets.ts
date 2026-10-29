/**
 * secrets.ts — Read/write secrets from ~/.abtars/secret/ directory (#597, #598).
 * One file per secret. Supports plaintext (legacy) and encrypted (ENC: prefix).
 *
 * #1216: the AES-256-GCM crypto (encrypt/decrypt + constants) is delegated to
 * utils/crypto.ts. This module is the persistence + policy layer:
 *   - directory ensure, per-process value cache
 *   - plaintext vs ENC: routing
 *   - cached derived key (loadKey + deriveKey, both from utils/crypto.ts)
 *   - public API: readSecret / readSecretResult / writeSecret / initSecretsKey / clearSecretCache
 *
 * #1354: credential-store policy invariants. The store is the authoritative
 * persistent location for API keys and equivalent provider credentials:
 *   - secret names are validated (no traversal, no path separators)
 *   - symlinks, wrong ownership, and unsafe modes fail closed — never followed
 *   - owned regular files/dirs are narrowed to 0600 / 0700 automatically
 *   - writes are atomic (tmp → fsync → rename) with owner-only modes
 *   - errors never carry credential values
 *
 * Wire-format must remain byte-identical to the previous implementation so
 * existing ENC: files on KP/Molty decrypt unchanged. Verified in secrets.test.ts.
 */
import { readFileSync, mkdirSync, lstatSync, chmodSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { abtarsHome } from "../paths.js";
import { loadKey, deriveKey, encrypt, decrypt } from "../utils/crypto.js";
import { atomicWriteSync } from "./atomic-write.js";

/** Backward-compatible snapshot for callers/tests that need the current root at import time. */
export const SECRETS_DIR = resolve(abtarsHome(), "secret");
/** Resolve the active secret root at call time (important for CLI/test homes). */
export function secretDirPath(): string { return resolve(abtarsHome(), "secret"); }
const cache = new Map<string, string>();
let cacheRoot = secretDirPath();

function syncSecretRoot(): void {
  const current = secretDirPath();
  if (current !== cacheRoot) {
    cacheRoot = current;
    cache.clear();
    cachedKey = null;
    cachedKeyPath = null;
  }
}

/** Env-var shaped secret name: OPENAI_API_KEY, HA_TOKEN, ... (#1354 R1). */
export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Suffixes that mark an assignment as a credential (#1354 R1.2). */
export const SECRET_ENV_SUFFIXES = ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_API_ID"] as const;

/** True when the name is a valid environment-variable secret name. */
export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** True when an env-var name is credential-shaped per #1354 R1.2. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_RE.test(name) && SECRET_ENV_SUFFIXES.some(s => name.endsWith(s));
}

/**
 * Resolve a secret file path beneath the secret root, refusing traversal.
 * Throws (with a value-free message) on any name that could escape the root.
 */
export function secretFilePath(name: string): string {
  if (!name || name.length === 0) throw new Error("Secret name is empty");
  if (name === "." || name === "..") throw new Error("Invalid secret name");
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("Invalid secret name — must be a plain file name");
  }
  const dir = secretDirPath();
  const p = resolve(dir, name);
  const root = dir.endsWith(sep) ? dir : dir + sep;
  if (p !== dir && !p.startsWith(root)) {
    throw new Error("Secret name escapes the secret directory");
  }
  return p;
}

export type FileSafety =
  | { safe: true }
  | { safe: false; reason: string };

/** Inspect a path under the secret root without following symlinks. */
function inspectSecretFile(path: string): FileSafety {
  let st;
  try { st = lstatSync(path); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { safe: false, reason: "missing" };
    return { safe: false, reason: "not accessible" };
  }
  if (st.isSymbolicLink()) return { safe: false, reason: "symbolic link — refusing to follow" };
  if (!st.isFile()) return { safe: false, reason: "not a regular file" };
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    return { safe: false, reason: "wrong ownership" };
  }
  return { safe: true };
}

/** Inspect the secret directory itself without following symlinks. */
function inspectSecretDir(): FileSafety {
  let st;
  const dir = secretDirPath();
  try { st = lstatSync(dir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { safe: false, reason: "missing" };
    return { safe: false, reason: "not accessible" };
  }
  if (st.isSymbolicLink()) return { safe: false, reason: "symbolic link — refusing to follow" };
  if (!st.isDirectory()) return { safe: false, reason: "not a directory" };
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    return { safe: false, reason: "wrong ownership" };
  }
  return { safe: true };
}

/** Is the secret store present and safe to write into? (never follows symlinks) */
export function secretStoreSafe(): FileSafety {
  const inspected = inspectSecretDir();
  return !inspected.safe && inspected.reason === "missing" ? { safe: true } : inspected;
}

/**
 * Create the secret directory (0700) when absent, or narrow an owned
 * directory that is WIDER than 0700 down to 0700. More-restrictive modes
 * (e.g. 0500) are never widened. Fails closed on symlinks / wrong ownership.
 */
export function ensureSecretDir(): FileSafety {
  const before = inspectSecretDir();
  if (!before.safe && before.reason !== "missing") return before;
  if (!before.safe) {
    try { mkdirSync(secretDirPath(), { recursive: true, mode: 0o700 }); }
    catch { return { safe: false, reason: "could not create secret directory" }; }
  }
  const insp = inspectSecretDir();
  if (!insp.safe) return insp;
  try {
    const st = lstatSync(secretDirPath());
    if ((st.mode & 0o077) !== 0) chmodSync(secretDirPath(), 0o700);
  } catch { return { safe: false, reason: "permission narrowing failed" }; }
  return { safe: true };
}

/** Narrow an owned regular secret file to 0600. Returns false on failure. */
function narrowSecretFileMode(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
    if ((st.mode & 0o077) !== 0) chmodSync(path, 0o600);
    const after = lstatSync(path);
    return after.isFile() && !after.isSymbolicLink() && (after.mode & 0o077) === 0;
  } catch { return false; }
}

/** Ensure the secret dir exists. Called once at import (mirrors legacy behavior). */
ensureSecretDir();

// Lazy-init: derived key cached for process lifetime
let cachedKey: Buffer | null = null;
let cachedKeyPath: string | null = null;

function getSecretsKey(): Buffer | null {
  syncSecretRoot();
  const keyPath = join(abtarsHome(), "config", "abtars.key");
  if (cachedKey && cachedKeyPath === keyPath) return cachedKey;
  cachedKey = null;
  cachedKeyPath = keyPath;
  const master = loadKey(keyPath);
  if (!master) return null;
  cachedKey = deriveKey(master, "abtars-secrets-v1");
  return cachedKey;
}

/**
 * Policy-owned read outcome: distinguishes an absent/empty entry (`missing`)
 * from an entry that exists but cannot be used (`unreadable` — unsafe file,
 * inaccessible store, missing key, or undecryptable payload). The `value` is
 * never exposed through the `unreadable` variant and no error text carrying
 * file or payload data escapes this result (#1258).
 */
export type SecretReadResult =
  | { status: "available"; value: string }
  | { status: "missing" }
  | { status: "unreadable" };

function readSecretValueResult(name: string, autoEncrypt: boolean): SecretReadResult {
  syncSecretRoot();
  if (!ensureSecretDir().safe) return { status: "unreadable" };
  let path: string;
  try { path = secretFilePath(name); } catch { return { status: "unreadable" }; }
  const inspected = inspectSecretFile(path);
  if (!inspected.safe) {
    return inspected.reason === "missing" ? { status: "missing" } : { status: "unreadable" };
  }
  // #1354: safe automatic narrowing — an owned regular file is narrowed to
  // 0600; anything unsafe was already rejected above.
  if (!narrowSecretFileMode(path)) return { status: "unreadable" };
  // A normal read may have cached a legacy plaintext value during migration
  // conflict comparison. Boot must re-read the payload so it can still
  // upgrade that file to ENC: in this same process.
  if (!autoEncrypt && cache.has(name)) return { status: "available", value: cache.get(name)! };
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return { status: "missing" };
    if (raw.startsWith("ENC:")) {
      const key = getSecretsKey();
      if (!key) return { status: "unreadable" };
      // crypto.decrypt expects the full "ENC:..." string and strips the prefix itself.
      const value = decrypt(raw, key);
      if (value === null) return { status: "unreadable" };
      cache.set(name, value);
      return { status: "available", value };
    }
    if (autoEncrypt) {
      const key = getSecretsKey();
      if (key) {
        try { atomicWriteSync(path, encrypt(raw, key), 0o600); }
        catch { return { status: "unreadable" }; }
      }
    }
    cache.set(name, raw);
    return { status: "available", value: raw };
  } catch { return { status: "unreadable" }; }
}

/** Read a secret from ~/.abtars/secret/<name>. Cached per process. */
export function readSecret(name: string): string | undefined {
  const result = readSecretValueResult(name, false);
  return result.status === "available" ? result.value : undefined;
}

/**
 * Policy-owned three-state read of a secret. Use this when the caller must
 * tell an absent/empty entry apart from an existing but unsafe, unreadable,
 * or undecryptable one (doctor probes, boot diagnostics).
 */
export function readSecretResult(name: string): SecretReadResult {
  return readSecretValueResult(name, false);
}

/**
 * Boot-only loader: reads a safe secret and atomically upgrades a plaintext
 * payload to ENC: when a master key is available. WEB_AUTH deliberately uses
 * `skipEncrypt` because dashboard authentication remains a plaintext .env
 * exception, but callers may also use this for other compatible legacy files.
 */
export function loadSecretForBoot(name: string, opts?: { skipEncrypt?: boolean }): string | undefined {
  const result = readSecretValueResult(name, !opts?.skipEncrypt);
  return result.status === "available" ? result.value : undefined;
}

/** List safe regular files in the store without following symlinks. */
export function listSafeSecretFiles(): string[] {
  if (!ensureSecretDir().safe) return [];
  try {
    return readdirSync(secretDirPath()).filter((name) => {
      let path: string;
      try { path = secretFilePath(name); } catch { return false; }
      return inspectSecretFile(path).safe && narrowSecretFileMode(path);
    });
  } catch { return []; }
}

/** Initialize the secrets encryption key. Call once at boot. */
export function initSecretsKey(): void {
  syncSecretRoot();
  if (cachedKey) return;
  cachedKey = getSecretsKey();
}

/**
 * Write an encrypted secret to ~/.abtars/secret/<name>.
 * Fails closed on invalid names, unsafe store, or unsafe existing objects.
 */
export function writeSecret(name: string, value: string): void {
  syncSecretRoot();
  if (!isValidSecretName(name)) {
    throw new Error(`Invalid secret name — use [A-Z_][A-Z0-9_]* only`);
  }
  const key = getSecretsKey();
  if (!key) throw new Error("Cannot encrypt secret: abtars.key not found. Run abtars install.");
  const dirSafe = ensureSecretDir();
  if (!dirSafe.safe) throw new Error(`Secret store unsafe: ${dirSafe.reason}`);
  const path = secretFilePath(name);
  try {
    const existing = inspectSecretFile(path);
    if (existing.safe || existing.reason !== "missing") {
      if (!existing.safe) throw new Error(`Refusing to overwrite unsafe secret file (${existing.reason})`);
    }
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error("Refusing to overwrite unsafe secret file");
  }
  // crypto.encrypt already prefixes "ENC:" — pass the value directly.
  atomicWriteSync(path, encrypt(value, key), 0o600);
  cache.set(name, value);
}

/**
 * #1354: write a secret using the existing compatible wire format — encrypted
 * when the master key is available, plaintext otherwise (boot auto-encrypts).
 * Used by the boot migration, which must not fail when no key exists yet.
 */
export function writeSecretCompatible(name: string, value: string): void {
  syncSecretRoot();
  if (!isValidSecretName(name)) {
    throw new Error(`Invalid secret name — use [A-Z_][A-Z0-9_]* only`);
  }
  const dirSafe = ensureSecretDir();
  if (!dirSafe.safe) throw new Error(`Secret store unsafe: ${dirSafe.reason}`);
  const path = secretFilePath(name);
  try {
    const existing = inspectSecretFile(path);
    if (existing.safe || existing.reason !== "missing") {
      if (!existing.safe) throw new Error(`Refusing to overwrite unsafe secret file (${existing.reason})`);
    }
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error("Refusing to overwrite unsafe secret file");
  }
  const key = getSecretsKey();
  const payload = key ? encrypt(value, key) : value;
  atomicWriteSync(path, payload, 0o600);
  cache.set(name, value);
}

/**
 * Compare an existing secret against a plaintext candidate WITHOUT exposing
 * the value. `unreadable` covers missing key / undecryptable / unsafe file —
 * callers must treat it as "do not clobber, do not derive". An empty file is
 * not a usable secret and counts as missing.
 */
export function compareSecret(name: string, value: string): "missing" | "equal" | "different" | "unreadable" {
  syncSecretRoot();
  if (!ensureSecretDir().safe) return "unreadable";
  let path: string;
  try { path = secretFilePath(name); } catch { return "unreadable"; }
  const inspected = inspectSecretFile(path);
  if (!inspected.safe && inspected.reason === "missing") return "missing";
  if (!inspected.safe) return "unreadable";
  let raw: string;
  try { raw = readFileSync(path, "utf-8").trim(); } catch { return "unreadable"; }
  if (!raw) return "missing";
  const existing = readSecret(name);
  if (existing === undefined) return "unreadable";
  return existing === value ? "equal" : "different";
}

/** Clear cached secret values (for testing or reload). Does not clear the encryption key. */
export function clearSecretCache(): void { cache.clear(); }
