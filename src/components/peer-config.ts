/**
 * peer-config.ts — load and validate ~/.abtars/config/peers.json (#392).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";
import { logInfo, logWarn } from "./logger.js";

const TAG = "peer-config";

export interface PeerEntry {
  host: string;
  port: number;
  token: string;
  pskSecret?: string;
  mode?: "plain" | "signed";
  verifyKey?: string;
  udpPort?: number;
}

export interface PeerConfig {
  self: { name: string; signingKey?: string; udpPort?: number };
  peers: Record<string, PeerEntry>;
  maxHops: number;
  timeoutMs: number;
}

const DEFAULTS: Omit<PeerConfig, "peers" | "self"> = { maxHops: 12, timeoutMs: 60000 };

let _config: PeerConfig | null = null;

export function loadPeerConfig(): PeerConfig {
  if (_config) return _config;
  const p = join(abtarsHome(), "config", "peers.json");
  if (!existsSync(p)) {
    _config = { self: { name: "default" }, peers: {}, ...DEFAULTS };
    return _config;
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    const peers: Record<string, PeerEntry> = {};
    if (raw.peers && typeof raw.peers === "object") {
      for (const [name, entry] of Object.entries(raw.peers)) {
        const e = entry as Record<string, unknown>;
        if (typeof e.host === "string" && typeof e.port === "number" && typeof e.token === "string") {
          peers[name] = {
            host: e.host, port: e.port, token: e.token,
            ...(typeof e.pskSecret === "string" ? { pskSecret: e.pskSecret } : {}),
            ...(e.mode === "signed" ? { mode: "signed" as const } : {}),
            ...(typeof e.verifyKey === "string" ? { verifyKey: e.verifyKey } : {}),
            ...(typeof e.udpPort === "number" ? { udpPort: e.udpPort } : {}),
          };
        } else {
          logWarn(TAG, `Skipped peer '${name}' — missing host/port/token`);
        }
      }
    }
    _config = {
      self: {
        name: typeof raw.self?.name === "string" ? raw.self.name : "default",
        ...(typeof raw.self?.signingKey === "string" ? { signingKey: raw.self.signingKey } : {}),
        ...(typeof raw.self?.udpPort === "number" ? { udpPort: raw.self.udpPort } : {}),
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
    _config = { self: { name: "default" }, peers: {}, ...DEFAULTS };
    return _config;
  }
}

export function clearPeerConfigCache(): void { _config = null; }
