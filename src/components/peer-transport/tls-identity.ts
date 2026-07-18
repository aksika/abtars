import { existsSync, readFileSync, writeFileSync, chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomBytes, createPrivateKey, createPublicKey, X509Certificate, timingSafeEqual } from "node:crypto";

// ── Typed error codes ───────────────────────────────────────────────────────

export type TlsIdentityErrorCode =
  | "missing_pair"
  | "incomplete_pair"
  | "identity_binding_mismatch"
  | "certificate_expired"
  | "certificate_not_yet_valid"
  | "signing_key_unavailable"
  | "symlink_rejected"
  | "bad_permissions"
  | "unparseable_cert"
  | "unparseable_key"
  | "generation_failed"
  | "lock_failed"
  | "publication_failed"
  | "internal_error";

const ERROR_MESSAGES: Record<TlsIdentityErrorCode, string> = {
  missing_pair: "identity.crt and identity.tls.key pair not found",
  incomplete_pair: "only one of identity.crt / identity.tls.key exists",
  identity_binding_mismatch: "certificate public key does not match Ed25519 signing key",
  certificate_expired: "certificate is expired",
  certificate_not_yet_valid: "certificate is not yet valid",
  signing_key_unavailable: "Ed25519 signing key is not available from peer identity",
  symlink_rejected: "identity file is a symlink (not a regular file)",
  bad_permissions: "private key file has unsafe permissions (must be 600)",
  unparseable_cert: "identity.crt could not be parsed as X.509 PEM",
  unparseable_key: "identity.tls.key could not be parsed as private key PEM",
  generation_failed: "TLS identity generation failed (openssl may be missing)",
  lock_failed: "could not acquire exclusive lock for TLS generation",
  publication_failed: "failed to publish generated TLS pair to canonical names",
  internal_error: "unexpected error during TLS identity validation",
};

// ── TlsIdentityError ────────────────────────────────────────────────────────

export class TlsIdentityError extends Error {
  code: TlsIdentityErrorCode;

  constructor(code: TlsIdentityErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "TlsIdentityError";
    this.code = code;
  }
}

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface ValidatedTlsIdentity {
  key: string;       // PEM private key
  cert: string;      // PEM certificate
  verifyKey: string; // base64 SPKI DER from identity signing key
  certificateNotBefore: Date;
  certificateNotAfter: Date;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function deriveVerifyKey(signingKey: string): string {
  const priv = createPrivateKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" });
  const pubKey = createPublicKey(priv);
  return (pubKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

/** Parse a PEM string into an X509Certificate, throwing on failure. */
function parseCert(certPem: string): X509Certificate {
  return new X509Certificate(certPem);
}

/** Parse a PEM private key into a KeyObject, throwing on failure. */
function parsePrivateKey(keyPem: string): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({ key: keyPem, format: "pem" });
}

/** Extract SPKI DER base64 from a PEM certificate. */
function extractSpkiFromCert(cert: X509Certificate): string {
  const pubKey = cert.publicKey;
  return (pubKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

/** Extract SPKI DER base64 from a PEM private key. */
function extractSpkiFromKey(keyPem: string): string {
  const keyObj = createPrivateKey({ key: keyPem, format: "pem" });
  const pubKey = createPublicKey(keyObj);
  return (pubKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

/**
 * Validate file is a regular file, not a symlink.
 * Throws TlsIdentityError on violation.
 */
function requireRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new TlsIdentityError("symlink_rejected", `${path} is a symlink`);
  if (!stat.isFile()) throw new TlsIdentityError("internal_error", `${path} is not a regular file`);
}

/**
 * Validate private key file permissions (must be 600).
 * Throws TlsIdentityError on violation.
 */
function requireSafeMode(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new TlsIdentityError("symlink_rejected", `${path} is a symlink`);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) throw new TlsIdentityError("bad_permissions", `${path} mode is ${mode.toString(8)} (must be 600)`);
}

// ── Primary validation ──────────────────────────────────────────────────────

/**
 * Read-only validation of an existing TLS identity pair.
 * Throws TlsIdentityError on any failure with a typed error code.
 *
 * @param configDir  — path to ~/.abtars/config/
 * @param signingKey — base64 PKCS8 DER Ed25519 private key from peer identity
 * @returns ValidatedTlsIdentity on success
 */
export function validateAgentApiTlsIdentity(
  configDir: string,
  signingKey: string,
): ValidatedTlsIdentity {
  const certPath = join(configDir, "identity.crt");
  const keyPath = join(configDir, "identity.tls.key");

  const certExists = existsSync(certPath);
  const keyExists = existsSync(keyPath);

  if (!certExists && !keyExists) throw new TlsIdentityError("missing_pair");
  if (!certExists || !keyExists) throw new TlsIdentityError("incomplete_pair");

  // Reject symlinks
  requireRegularFile(certPath);
  requireRegularFile(keyPath);

  // Enforce 600 permissions on private key
  requireSafeMode(keyPath);

  if (!signingKey) throw new TlsIdentityError("signing_key_unavailable");

  // Read and parse
  let certPem: string;
  let keyPem: string;
  try {
    certPem = readFileSync(certPath, "utf-8");
  } catch (err) {
    throw new TlsIdentityError("unparseable_cert", `cannot read identity.crt: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    keyPem = readFileSync(keyPath, "utf-8");
  } catch (err) {
    throw new TlsIdentityError("unparseable_key", `cannot read identity.tls.key: ${err instanceof Error ? err.message : String(err)}`);
  }

  let cert: X509Certificate;
  try {
    cert = parseCert(certPem);
  } catch (err) {
    throw new TlsIdentityError("unparseable_cert", `cannot parse identity.crt: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    parsePrivateKey(keyPem);
  } catch (err) {
    throw new TlsIdentityError("unparseable_key", `cannot parse identity.tls.key: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Validate validity window (with 60s clock-skew tolerance)
  const now = Date.now();
  const notBefore = new Date(cert.validFrom);
  const notAfter = new Date(cert.validTo);
  const skewMs = 60_000;

  if (now < notBefore.getTime() - skewMs) {
    throw new TlsIdentityError("certificate_not_yet_valid", `cert valid from ${cert.validFrom}`);
  }
  if (now > notAfter.getTime() + skewMs) {
    throw new TlsIdentityError("certificate_expired", `cert expired ${cert.validTo}`);
  }

  // SPKI binding: cert's public key must match derived verifyKey from identity
  const expectedVerifyKey = deriveVerifyKey(signingKey);
  const certSpki = extractSpkiFromCert(cert);
  const keySpki = extractSpkiFromKey(keyPem);

  const expectedBuf = Buffer.from(expectedVerifyKey, "base64");
  const certSpkiBuf = Buffer.from(certSpki, "base64");
  const keySpkiBuf = Buffer.from(keySpki, "base64");

  if (expectedBuf.length !== certSpkiBuf.length || !timingSafeEqual(expectedBuf, certSpkiBuf)) {
    throw new TlsIdentityError("identity_binding_mismatch", "certificate public key does not match identity signing key");
  }
  if (expectedBuf.length !== keySpkiBuf.length || !timingSafeEqual(expectedBuf, keySpkiBuf)) {
    throw new TlsIdentityError("identity_binding_mismatch", "private key does not match identity signing key");
  }

  return {
    key: keyPem,
    cert: certPem,
    verifyKey: expectedVerifyKey,
    certificateNotBefore: notBefore,
    certificateNotAfter: notAfter,
  };
}

// ── Acquisition lock ────────────────────────────────────────────────────────
// Simple exclusive file-based lock (best-effort on POSIX).

function acquireLock(lockPath: string): () => void {
  // Use mkdir as atomic operation (POSIX)
  try {
    mkdirSync(lockPath, { recursive: false });
  } catch {
    throw new TlsIdentityError("lock_failed", `lock directory ${lockPath} already exists`);
  }
  return () => {
    try { rmdirSync(lockPath); } catch { /* best effort */ }
  };
}

// ── Safe generation + publication ───────────────────────────────────────────

/**
 * Validate the existing TLS identity pair, or safely generate one when both
 * files are absent (or the pair is incomplete). Corrupt/mismatched pairs are
 * NOT regenerated — they cause a typed error.
 *
 * Generation uses temp files on the same filesystem, validates the temp pair,
 * renames atomically, validates the canonical pair, and cleans up.
 *
 * @param configDir  — path to ~/.abtars/config/
 * @param signingKey — base64 PKCS8 DER Ed25519 private key from peer identity
 * @param name       — CN for the self-signed certificate (defaults to hostname)
 * @returns ValidatedTlsIdentity on success
 */
export function ensureAgentApiTlsIdentity(
  configDir: string,
  signingKey: string,
  name?: string,
): ValidatedTlsIdentity {
  if (!signingKey) throw new TlsIdentityError("signing_key_unavailable");

  const certPath = join(configDir, "identity.crt");
  const keyPath = join(configDir, "identity.tls.key");
  const certExists = existsSync(certPath);
  const keyExists = existsSync(keyPath);

  // Case 1: both files exist — validate only
  if (certExists && keyExists) {
    return validateAgentApiTlsIdentity(configDir, signingKey);
  }

  // Case 2: one exists but not the other — incomplete pair (treat as missing)
  // Generate both fresh.
  if (certExists !== keyExists) {
    // Remove the orphan
    try { unlinkSync(certPath); } catch { /* best effort */ }
    try { unlinkSync(keyPath); } catch { /* best effort */ }
  }

  // Case 3: both missing — generate new pair
  const cn = (name ?? hostname()).replace(/[^A-Za-z0-9_\-.]/g, "_").slice(0, 64);

  // Acquire exclusive lock
  const lockPath = join(configDir, "identity.tls.lock");
  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = acquireLock(lockPath);
  } catch (err) {
    if (err instanceof TlsIdentityError) throw err;
    throw new TlsIdentityError("lock_failed", String(err));
  }

  try {
    // Re-check canonical state after lock acquisition
    if (existsSync(certPath) && existsSync(keyPath)) {
      // Another process produced a valid pair
      return validateAgentApiTlsIdentity(configDir, signingKey);
    }

    // Generate into temp files on same filesystem
    const tmpDir = join(configDir, `.identity.tls.tmp-${randomBytes(8).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });

    const tmpKeyPath = join(tmpDir, "identity.tls.key");
    const tmpCertPath = join(tmpDir, "identity.crt");

    try {
      // Export the identity key as PEM
      const privKeyObj = createPrivateKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" });
      const keyPem = privKeyObj.export({ type: "pkcs8", format: "pem" }) as string;
      writeFileSync(tmpKeyPath, keyPem, { mode: 0o600 });

      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      const safeCn = cn.replace(/[^A-Za-z0-9_\-.]/g, "_").slice(0, 64);
      execSync(
        `openssl req -x509 -key "${tmpKeyPath}" -out "${tmpCertPath}" -days 3650 -nodes -subj "/CN=${safeCn}"`,
        { stdio: "pipe" },
      );

      // Validate the temp pair before publishing
      try {
        validateFilesystemPair(tmpCertPath, tmpKeyPath, signingKey);
      } catch (err) {
        throw new TlsIdentityError("generation_failed", `generated pair validation failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Publish: rename temp → canonical
      try {
        renameSync(tmpKeyPath, keyPath);
        renameSync(tmpCertPath, certPath);
        chmodSync(keyPath, 0o600);
      } catch (err) {
        throw new TlsIdentityError("publication_failed", `rename failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Validate the canonical pair
      return validateAgentApiTlsIdentity(configDir, signingKey);
    } finally {
      // Clean temp files
      try { unlinkSync(tmpKeyPath); } catch { /* best effort */ }
      try { unlinkSync(tmpCertPath); } catch { /* best effort */ }
      try { rmdirSync(tmpDir); } catch { /* best effort */ }
    }
  } finally {
    releaseLock?.();
  }
}

/**
 * Validate a pair on the filesystem at the given paths (used for temp validation).
 */
function validateFilesystemPair(certPath: string, keyPath: string, signingKey: string): void {
  const expectedVerifyKey = deriveVerifyKey(signingKey);

  const certPem = readFileSync(certPath, "utf-8");
  const keyPem = readFileSync(keyPath, "utf-8");

  const cert = parseCert(certPem);
  parsePrivateKey(keyPem);

  const now = Date.now();
  if (now < new Date(cert.validFrom).getTime() - 60_000) {
    throw new TlsIdentityError("certificate_not_yet_valid");
  }
  if (now > new Date(cert.validTo).getTime() + 60_000) {
    throw new TlsIdentityError("certificate_expired");
  }

  const certSpki = extractSpkiFromCert(cert);
  const keySpki = extractSpkiFromKey(keyPem);

  const expectedBuf = Buffer.from(expectedVerifyKey, "base64");
  const certSpkiBuf = Buffer.from(certSpki, "base64");
  const keySpkiBuf = Buffer.from(keySpki, "base64");

  if (expectedBuf.length !== certSpkiBuf.length || !timingSafeEqual(expectedBuf, certSpkiBuf)) {
    throw new TlsIdentityError("identity_binding_mismatch");
  }
  if (expectedBuf.length !== keySpkiBuf.length || !timingSafeEqual(expectedBuf, keySpkiBuf)) {
    throw new TlsIdentityError("identity_binding_mismatch");
  }
}
