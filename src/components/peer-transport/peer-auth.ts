/**
 * peer-auth.ts — Shared auth/TLS helpers for peer transport (#972).
 * Used by both HTTP and WebSocket transports.
 */
import { signJwt } from "../peer-jwt.js";
import { loadPeerConfig, type PeerEntry } from "../peer-config.js";
import type { TlsOptions } from "node:tls";

/** Mint a short-lived JWT for peer authentication. */
export function mintPeerJwt(peerName: string): string {
  const config = loadPeerConfig();
  const entry = config.peers[peerName];
  if (!entry) throw new Error(`Unknown peer: ${peerName}`);
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: config.self.name, aud: peerName, iat: now, exp: now + 60 }, entry.token);
}

/** Sign a JSON body with Ed25519 (returns body with _sig field appended). */
export async function signBody(peerName: string, body: string, signingKey?: string, selfName?: string): Promise<string> {
  if (!signingKey || !selfName) {
    const config = loadPeerConfig();
    signingKey = signingKey ?? config.self.signingKey;
    selfName = selfName ?? config.self.name;
  }
  if (!signingKey) return body;
  const { signMessage } = await import("../digital-signature.js");
  const { tag } = signMessage(signingKey, selfName!, peerName, body);
  const parsed = JSON.parse(body);
  parsed._sig = tag;
  return JSON.stringify(parsed);
}

/** TLS options for connecting to a peer (cert pinning, TLS 1.3 mandatory). */
export function tlsOptions(entry: PeerEntry): TlsOptions {
  if (!entry.certFingerprint && !entry.certPem) {
    throw new Error(`Peer has no TLS cert configured — refusing connection. Set certFingerprint or certPem in peers.json.`);
  }
  return {
    minVersion: "TLSv1.3",
    rejectUnauthorized: true,
    ...(entry.certPem ? { ca: [entry.certPem] } : {}),
    checkServerIdentity: (_host: string, cert: { fingerprint256?: string }) => {
      if (entry.certFingerprint && cert.fingerprint256 !== entry.certFingerprint) {
        return new Error("Cert fingerprint mismatch");
      }
      return undefined;
    },
  } as TlsOptions;
}
