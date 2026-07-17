/**
 * peer-config.ts — load, validate, and bootstrap ~/.abtars/config/peers.json (#1293).
 *
 * Schema change: identity is now Ed25519 keypair (self.signingKey) + tribe token
 * (self.tribeToken). Per-peer auth is verifyKey (Ed25519 pubkey). Legacy fields
 * token/gossipSecret/certPem/certFingerprint are deleted.
 *
 * Boot bootstrap: if self.signingKey or self.tribeToken are missing, they are
 * generated and persisted automatically (zero-config solo tribe of one).
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, createPrivateKey, createPublicKey } from "node:crypto";
import { abtarsHome } from "../paths.js";
import { logInfo, logWarn } from "./logger.js";
import { validateShape, PEERS_SCHEMA } from "./config-validator.js";

const TAG = "peer-config";

export interface PeerEntry {
  host: string;
  port: number;
  verifyKey: string;                    // Ed25519 public key (base64 SPKI DER) — auth + TLS anchor
  trust?: number;                       // default 0; 1=enrolled, 2=trusted, >=3=owner
  mode?: "signed";                      // require body-sig for relayed content
  allowedTools?: string[];
  allowedRead?: string[];
  allowedWrite?: string[];
  transport?: "http" | "ws-outbound";
}

export interface PeerSelf {
  name: string;
  signingKey: string;                   // Ed25519 private key (base64 PKCS8 DER) — only secret
  tribeToken: string;                   // tribe membership secret (base64, 256-bit random)
}

export interface PeerConfig {
  self: PeerSelf;
  peers: Record<string, PeerEntry>;
  maxHops: number;
  timeoutMs: number;
}

const DEFAULTS: Omit<PeerConfig, "peers" | "self"> = { maxHops: 12, timeoutMs: 60000 };

let _config: PeerConfig | null = null;

/** Generate an Ed25519 private key as base64-encoded PKCS8 DER. */
function generateSigningKey(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
}

/** Derive the Ed25519 public key from a base64 PKCS8 DER private key. Returns base64 SPKI DER. */
export function deriveVerifyKey(signingKey: string): string {
  const priv = createPrivateKey({ key: Buffer.from(signingKey, "base64"), format: "der", type: "pkcs8" });
  const pubKey = createPublicKey(priv);
  return (pubKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

/** Generate a 256-bit random tribe token as base64. */
function generateTribeToken(): string {
  return randomBytes(32).toString("base64");
}

/**
 * Bootstrap: ensure self.signingKey and self.tribeToken exist in peers.json.
 * Generates and persists them if missing. Creates peers.json if it doesn't exist.
 */
export function bootstrapIdentity(): void {
  const p = join(abtarsHome(), "config", "peers.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(p)) {
    try { raw = JSON.parse(readFileSync(p, "utf-8")); } catch { raw = {}; }
  }

  const self = (raw.self && typeof raw.self === "object") ? raw.self as Record<string, unknown> : {};
  let changed = false;

  if (typeof self.signingKey !== "string" || !self.signingKey) {
    self.signingKey = generateSigningKey();
    logInfo(TAG, "Generated new Ed25519 identity keypair");
    changed = true;
  }
  if (typeof self.tribeToken !== "string" || !self.tribeToken) {
    self.tribeToken = generateTribeToken();
    logInfo(TAG, "Generated new tribe token (solo tribe of one)");
    changed = true;
  }

  if (changed) {
    raw.self = self;
    if (!raw.peers) raw.peers = {};
    if (typeof raw.maxHops !== "number") raw.maxHops = DEFAULTS.maxHops;
    if (typeof raw.timeoutMs !== "number") raw.timeoutMs = DEFAULTS.timeoutMs;
    const serialized = JSON.stringify(raw, null, 2) + "\n";
    writeFileSync(p, serialized, { encoding: "utf-8" });
    try { chmodSync(p, 0o600); } catch { /* best effort */ }
  }
}

export function loadPeerConfig(): PeerConfig {
  if (_config) return _config;
  const p = join(abtarsHome(), "config", "peers.json");

  // Ensure identity exists before loading
  bootstrapIdentity();

  if (!existsSync(p)) {
    // Should not happen after bootstrap, but guard defensively
    _config = {
      self: { name: "default", signingKey: generateSigningKey(), tribeToken: generateTribeToken() },
      peers: {},
      ...DEFAULTS,
    };
    return _config;
  }

  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    validateShape(raw, PEERS_SCHEMA, "peers.json");

    const peers: Record<string, PeerEntry> = {};
    if (raw.peers && typeof raw.peers === "object") {
      for (const [name, entry] of Object.entries(raw.peers)) {
        const e = entry as Record<string, unknown>;
        if (typeof e.host === "string" && typeof e.port === "number" && typeof e.verifyKey === "string") {
          peers[name] = {
            host: e.host,
            port: e.port,
            verifyKey: e.verifyKey,
            ...(typeof e.trust === "number" ? { trust: e.trust } : {}),
            ...(e.mode === "signed" ? { mode: "signed" as const } : {}),
            ...(Array.isArray(e.allowedTools) ? { allowedTools: e.allowedTools as string[] } : {}),
            ...(Array.isArray(e.allowedRead) ? { allowedRead: e.allowedRead as string[] } : {}),
            ...(Array.isArray(e.allowedWrite) ? { allowedWrite: e.allowedWrite as string[] } : {}),
            ...(e.transport === "ws-outbound" ? { transport: "ws-outbound" as const } : {}),
          };
        } else {
          logWarn(TAG, `Skipped peer '${name}' — missing host/port/verifyKey`);
        }
      }
    }

    const selfRaw = raw.self as Record<string, unknown>;
    _config = {
      self: {
        name: typeof selfRaw?.name === "string" ? selfRaw.name : "default",
        signingKey: selfRaw?.signingKey as string,
        tribeToken: selfRaw?.tribeToken as string,
      },
      peers,
      maxHops: typeof raw.maxHops === "number" ? raw.maxHops : DEFAULTS.maxHops,
      timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : DEFAULTS.timeoutMs,
    };

    const names = Object.keys(peers);
    if (names.length > 0) logInfo(TAG, `Loaded ${names.length} peer(s): ${names.join(", ")} (self: ${_config.self.name})`);
    return _config;
  } catch (err) {
    logWarn(TAG, `Failed to parse peers.json: ${err instanceof Error ? err.message : String(err)}`);
    _config = {
      self: { name: "default", signingKey: generateSigningKey(), tribeToken: generateTribeToken() },
      peers: {},
      ...DEFAULTS,
    };
    return _config;
  }
}

export function clearPeerConfigCache(): void { _config = null; }
