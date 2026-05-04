import { readFileSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logWarn } from "../../components/logger.js";

export interface IrcChannelConfig {
  requireMention: boolean;
  allowFrom: string[];
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

export interface IrcConfig {
  servers: IrcServerConfig[];
}

export function loadIrcConfig(): IrcConfig | null {
  const path = join(abtarsHome(), "config", "irc.json");
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); } catch { return null; }
  const parsed = JSON.parse(raw);
  if (!parsed?.servers?.length) return null;

  const servers: IrcServerConfig[] = [];
  for (const s of parsed.servers) {
    if (!s.host || !s.nick || !s.channels) {
      logWarn("irc", `Skipping server "${s.id ?? "?"}" — missing host/nick/channels`);
      continue;
    }
    const channels: Record<string, IrcChannelConfig> = {};
    for (const [name, cfg] of Object.entries(s.channels as Record<string, any>)) {
      channels[name] = {
        requireMention: cfg.requireMention !== false,
        allowFrom: Array.isArray(cfg.allowFrom) ? cfg.allowFrom : [],
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
  return servers.length > 0 ? { servers } : null;
}

function resolveSecret(val: string | undefined): string | undefined {
  if (!val) return undefined;
  if (val.startsWith("$")) return process.env[val.slice(1)] ?? undefined;
  return val;
}
