/**
 * pi-client-registry.ts — Pi client credential file management (#1313).
 *
 * Manages two files:
 *   ~/.abtars/clients/pi/credential.json  (private signing key, mode 0600)
 *   ~/.abtars/config/pi-clients.json       (public verify key + scopes, mode 0600)
 *
 * The private credential is read by the Pi extension on the Pi side.
 * The public registration is loaded by Agent API on every Pi request.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, generateKeyPairSync } from "node:crypto";
import { abtarsHome } from "../paths.js";

export const PI_CREDENTIAL_DIR = join(abtarsHome(), "clients", "pi");
export const PI_CREDENTIAL_PATH = join(PI_CREDENTIAL_DIR, "credential.json");
export const PI_CONFIG_PATH = join(abtarsHome(), "config", "pi-clients.json");

export const FIXED_SCOPES = [
  "status",
  "notify:main",
  "task:create",
  "task:read",
  "peer:read",
  "peer:delegate",
] as const;

export type PiScope = typeof FIXED_SCOPES[number];

export interface PiClientCredential {
  version: 1;
  clientId: "pi-local";
  keyId: string;
  signingKey: string;
  createdAt: string;
}

export interface PiClientRegistration {
  version: 1;
  clientId: "pi-local";
  keyId: string;
  verifyKey: string;
  scopes: readonly PiScope[];
  createdAt: string;
  revokedAt?: string;
}

export interface PiClientState {
  exists: boolean;
  registration: PiClientRegistration | null;
  credential: PiClientCredential | null;
}

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

function keyIdFromPub(pubBase64: string): string {
  return sha256(pubBase64).slice(0, 16);
}

export function generatePiKeypair(): { signingKey: string; verifyKey: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signingKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const verifyKey = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const keyId = keyIdFromPub(verifyKey);
  return { signingKey, verifyKey, keyId };
}

export function createPiCredential(signingKey: string, keyId: string): PiClientCredential {
  return {
    version: 1,
    clientId: "pi-local",
    keyId,
    signingKey,
    createdAt: new Date().toISOString(),
  };
}

export function createPiRegistration(verifyKey: string, keyId: string): PiClientRegistration {
  return {
    version: 1,
    clientId: "pi-local",
    keyId,
    verifyKey,
    scopes: [...FIXED_SCOPES],
    createdAt: new Date().toISOString(),
  };
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Write a private credential file atomically using write-and-rename. */
function writeCredentialAtomic(data: PiClientCredential): void {
  ensureDir(PI_CREDENTIAL_DIR);
  const tmp = join(PI_CREDENTIAL_DIR, `credential.tmp.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, PI_CREDENTIAL_PATH);
}

/** Write a registration file atomically using write-and-rename. */
function writeRegistrationAtomic(data: PiClientRegistration): void {
  ensureDir(join(abtarsHome(), "config"));
  const tmp = join(abtarsHome(), "config", `pi-clients.tmp.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, PI_CONFIG_PATH);
}

/** Read credential; returns null if missing or corrupt. */
export function readPiCredential(): PiClientCredential | null {
  try {
    if (!existsSync(PI_CREDENTIAL_PATH)) return null;
    const raw = readFileSync(PI_CREDENTIAL_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PiClientCredential;
    if (parsed.version !== 1 || parsed.clientId !== "pi-local" || !parsed.signingKey || !parsed.keyId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Read registration; returns null if missing or corrupt. */
export function readPiRegistration(): PiClientRegistration | null {
  try {
    if (!existsSync(PI_CONFIG_PATH)) return null;
    const raw = readFileSync(PI_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PiClientRegistration;
    if (parsed.version !== 1 || parsed.clientId !== "pi-local" || !parsed.verifyKey || !parsed.keyId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Get combined Pi client state. */
export function getPiClientState(): PiClientState {
  return {
    exists: existsSync(PI_CREDENTIAL_PATH),
    credential: readPiCredential(),
    registration: readPiRegistration(),
  };
}

/**
 * Run `abtars pi authorize` — generate keypair, write credential + registration.
 * Returns the credential on success, throws on failure.
 */
export function piAuthorize(): PiClientCredential {
  const { signingKey, verifyKey, keyId } = generatePiKeypair();
  const credential = createPiCredential(signingKey, keyId);
  const registration = createPiRegistration(verifyKey, keyId);

  // Write credential first, then registration. If registration write fails,
  // remove the credential and throw.
  try {
    writeCredentialAtomic(credential);
  } catch (err) {
    throw new Error(`Failed to write credential: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    writeRegistrationAtomic(registration);
  } catch (err) {
    // Rollback: remove credential
    try { writeFileSync(PI_CREDENTIAL_PATH, ""); } catch { /* best effort */ }
    throw new Error(`Failed to write registration: ${err instanceof Error ? err.message : String(err)}`);
  }

  return credential;
}

/**
 * Run `abtars pi revoke` — mark registration as revoked.
 * Throws if no registration exists.
 */
export function piRevoke(): PiClientRegistration {
  const reg = readPiRegistration();
  if (!reg) throw new Error("No Pi client credential found.");
  const updated: PiClientRegistration = { ...reg, revokedAt: new Date().toISOString() };
  writeRegistrationAtomic(updated);
  return updated;
}

/**
 * Run `abtars pi rotate` — generate new keypair, update both files atomically.
 * Returns the new credential.
 */
export function piRotate(): PiClientCredential {
  const { signingKey, verifyKey, keyId } = generatePiKeypair();
  const credential = createPiCredential(signingKey, keyId);
  const registration = createPiRegistration(verifyKey, keyId);

  try {
    writeCredentialAtomic(credential);
  } catch (err) {
    throw new Error(`Failed to write credential: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    writeRegistrationAtomic(registration);
  } catch (err) {
    try { writeFileSync(PI_CREDENTIAL_PATH, ""); } catch { /* best effort */ }
    throw new Error(`Failed to write registration during rotate: ${err instanceof Error ? err.message : String(err)}`);
  }

  return credential;
}

/** Check if Pi client has a valid, non-revoked registration. */
export function isPiClientActive(): boolean {
  const reg = readPiRegistration();
  return reg !== null && !reg.revokedAt;
}
