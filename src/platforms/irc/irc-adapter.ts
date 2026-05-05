import type { PlatformAdapter, InboundMessage, SendOpts } from "../../types/platform.js";
import type { IrcConfig, IrcServerConfig } from "./irc-config.js";
import { createIrcClient, type IrcClient } from "./irc-client.js";
import { signMessage, verifyMessage } from "../../components/digital-signature.js";
import { logInfo, logDebug, logWarn } from "../../components/logger.js";

const TAG = "irc";
const MAX_LINE_PLAIN = 450;
const MAX_LINE_SECURE = 340; // leave room for [sig:ts:base64] suffix

export interface IrcAdapterDeps {
  onMessage: (msg: InboundMessage) => void;
}

export class IrcAdapter implements PlatformAdapter {
  readonly name = "irc" as const;
  readonly capabilities = { voice: false, reactions: false, edit: false, typing: false, threads: false };

  private clients: IrcClient[] = [];
  private config: IrcConfig;
  private deps: IrcAdapterDeps;

  constructor(config: IrcConfig, deps: IrcAdapterDeps) {
    this.config = config;
    this.deps = deps;
  }

  async start(): Promise<void> {
    for (const server of this.config.servers) {
      const channels = Object.keys(server.channels);
      const client = createIrcClient({
        host: server.host,
        port: server.port,
        useTls: server.tls,
        nick: server.nick,
        nickservPassword: server.nickservPassword,
        channels,
        onPrivmsg: (sender, target, text) => this.handlePrivmsg(server, client, sender, target, text),
        onReady: () => logInfo(TAG, `[${server.id}] ready`),
      });
      this.clients.push(client);
    }
  }

  stop(): void {
    for (const c of this.clients) c.quit();
    this.clients = [];
  }

  authorize(_msg: InboundMessage): boolean {
    return true; // Authorization handled in handlePrivmsg
  }

  async sendMessage(channelId: string, text: string, _opts?: SendOpts): Promise<number | undefined> {
    const [serverId, channel] = channelId.split(":", 2);
    const client = this.clients.find((_, i) => this.config.servers[i]?.id === serverId);
    if (!client || !channel) return undefined;

    const server = this.config.servers.find(s => s.id === serverId);
    const channelConfig = server?.channels[channel];
    const isSigned = channelConfig?.mode === "signed";
    const maxLine = isSigned ? MAX_LINE_SECURE : MAX_LINE_PLAIN;

    const lines = this.chunkText(text, maxLine);
    for (const line of lines) {
      if (isSigned && this.config.identity?.privateKey) {
        const { tag } = signMessage(this.config.identity.privateKey, server!.nick, channel, line);
        client.send(channel, `${line} ${tag}`);
      } else {
        client.send(channel, line);
      }
    }
    return undefined;
  }

  chunkResponse(text: string): string[] {
    return this.chunkText(text, MAX_LINE_PLAIN);
  }

  private chunkText(text: string, maxLen: number): string[] {
    const result: string[] = [];
    for (const paragraph of text.split("\n")) {
      if (paragraph.length <= maxLen) {
        if (paragraph.trim()) result.push(paragraph);
      } else {
        let remaining = paragraph;
        while (remaining.length > maxLen) {
          let cut = remaining.lastIndexOf(" ", maxLen);
          if (cut <= 0) cut = maxLen;
          result.push(remaining.slice(0, cut));
          remaining = remaining.slice(cut).trimStart();
        }
        if (remaining.trim()) result.push(remaining);
      }
    }
    return result;
  }

  private handlePrivmsg(server: IrcServerConfig, client: IrcClient, sender: string, target: string, text: string): void {
    // Self-echo filter
    if (sender === client.nick) return;

    // Only handle channel messages
    if (!target.startsWith("#")) return;

    const channelConfig = server.channels[target];
    if (!channelConfig) {
      logDebug(TAG, `[${server.id}] Ignoring message in unconfigured channel ${target}`);
      return;
    }

    if (channelConfig.mode === "signed") {
      // Verify signature
      const pubkey = channelConfig.trustedKeys[sender];
      if (!pubkey) {
        logDebug(TAG, `[${server.id}] Dropped from ${sender} — no trusted key`);
        return;
      }
      const result = verifyMessage(pubkey, sender, target, text);
      if (!result.valid) {
        logWarn(TAG, `[${server.id}] Signature failed from ${sender}: ${result.reason}`);
        return;
      }
      text = result.text;
    } else {
      // Plain mode: sender allowlist
      if (channelConfig.allowFrom.length > 0 && !channelConfig.allowFrom.includes(sender)) {
        logDebug(TAG, `[${server.id}] Dropped from ${sender} (not in allowFrom)`);
        return;
      }
    }

    // Mention gating
    if (channelConfig.requireMention) {
      const nickPattern = new RegExp(`\\b${escapeRegex(server.nick)}\\b[:,]?`, "i");
      if (!nickPattern.test(text)) return;
      text = text.replace(nickPattern, "").trim();
    }

    if (!text) return;

    const channelId = `${server.id}:${target}`;
    const msg: InboundMessage = {
      platform: "irc",
      channelId,
      sessionKey: `${sender}:irc`,
      senderId: sender,
      senderName: sender,
      text,
      timestamp: Date.now(),
      isGroup: true,
      isVoice: false,
    };

    this.deps.onMessage(msg);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
