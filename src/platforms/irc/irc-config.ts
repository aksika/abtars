import { readFileSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logWarn } from "../../components/logger.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";
import { validateShape, IRC_SCHEMA } from "../../components/config-validator.js";

const TAG = "irc_config";

export interface IrcChannelConfig {
  mode: "plain" | "signed";
  requireMention: boolean;
  allowFrom: string[];       // used in plain mode
  allowUnsigned: string[];   // nicks that bypass signature in signed mode (humans)
  trustedKeys: Record<string, string>; // used in signed mode: nick → base64 pubkey
}

export interface IrcServerConfig {
  id: string;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  nickservPassword?: string;
  channels: Record<string, IrcChannelConfig>;
}

export interface IrcIdentity {
  privateKey: string; // base64 DER Ed25519
  publicKey: string;  // base64 DER Ed25519
}

export interface IrcConfig {
  identity?: IrcIdentity;
  servers: IrcServerConfig[];
}

export function loadIrcConfig(): IrcConfig | null {
  const path = join(abtarsHome(), "config", "irc.json");
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch (err) { logAndSwallow(TAG, "read irc.json", err); return null; }
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch (err) {
    logWarn("irc-config", `Invalid JSON in irc.json: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!parsed?.servers?.length) return null;
  validateShape(parsed, IRC_SCHEMA, "irc.json");

  const identity: IrcIdentity | undefined = parsed.identity ? {
    privateKey: resolveSecret(parsed.identity.privateKey) ?? "",
    publicKey: parsed.identity.publicKey ?? "",
  } : undefined;

  const servers: IrcServerConfig[] = [];
  for (const s of parsed.servers) {
    if (!s.host || !s.nick || !s.channels) {
      logWarn("irc", `Skipping server "${s.id ?? "?"}" — missing host/nick/channels`);
      continue;
    }
    const channels: Record<string, IrcChannelConfig> = {};
    for (const [name, cfg] of Object.entries(s.channels as Record<string, any>)) {
      const mode = cfg.mode === "signed" ? "signed" : "plain";
      channels[name] = {
        mode,
        requireMention: cfg.requireMention !== false,
        allowFrom: Array.isArray(cfg.allowFrom) ? cfg.allowFrom : [],
        allowUnsigned: Array.isArray(cfg.allowUnsigned) ? cfg.allowUnsigned : [],
        trustedKeys: (mode === "signed" && cfg.trustedKeys && typeof cfg.trustedKeys === "object") ? cfg.trustedKeys : {},
      };
    }
    servers.push({
      id: s.id ?? s.host,
      host: s.host,
      port: s.port ?? (s.tls ? 6697 : 6667),
      tls: s.tls ?? false,
      nick: s.nick,
      nickservPassword: resolveSecret(s.nickservPassword),
      channels,
    });
  }
  return servers.length > 0 ? { identity, servers } : null;
}

function resolveSecret(val: string | undefined): string | undefined {
  if (!val) return undefined;
  if (val.startsWith("$")) return process.env[val.slice(1)] ?? undefined;
  return val;
}
