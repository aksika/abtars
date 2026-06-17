/**
 * channel-tool.ts — Agent-facing tools for the communication channel (#891).
 */

import type { ToolDefinition } from "./tool-registry.js";
import { channelPost, channelRead, type ChannelMessage } from "../tasks/kanban-channel.js";

function formatMsg(m: ChannelMessage): string {
  const dir = m.directive ? " ⚡" : "";
  return `[${m.from_agent}→${m.to_agent}]${dir} ${m.message} (${m.created_at})`;
}

async function executePost(args: Record<string, string>, ctx?: { userId?: string }): Promise<string> {
  const cardId = parseInt(args.card_id ?? "", 10);
  if (!cardId) return "❌ card_id required";
  if (!args.message) return "❌ message required";
  const from = args.from || ctx?.userId || "agent";
  const to = args.to || "ALL";
  const directive = args.directive === "true" || args.directive === "1";
  const id = channelPost(cardId, from, to, args.message, directive);
  return `✓ Posted #${id} to card:${cardId} [${from}→${to}]`;
}

async function executeRead(args: Record<string, string>): Promise<string> {
  const cardId = parseInt(args.card_id ?? "", 10);
  if (!cardId) return "❌ card_id required";
  const msgs = channelRead(cardId, { since: args.since, from: args.from });
  if (msgs.length === 0) return "No messages.";
  return msgs.map(formatMsg).join("\n");
}

export const channelPostTool: ToolDefinition = {
  name: "channel_post",
  description: "Post a message to the project discussion channel. Keep messages short (<1000 chars). For long plans, write a file and reference the path.",
  parameters: {
    type: "object",
    properties: {
      card_id: { type: "string", description: "Kanban card ID this message belongs to" },
      to: { type: "string", description: "Recipient: ALL (default), Worker-01, ORC, MASTER, or peer:name" },
      message: { type: "string", description: "Short message (max 1000 chars)" },
      directive: { type: "string", description: "Set to 'true' for priority directive (Orc/master only)" },
    },
    required: ["card_id", "message"],
  },
  execute: executePost,
};

export const channelReadTool: ToolDefinition = {
  name: "channel_read",
  description: "Read messages from the project discussion channel.",
  parameters: {
    type: "object",
    properties: {
      card_id: { type: "string", description: "Kanban card ID to read messages from" },
      since: { type: "string", description: "ISO timestamp — only messages after this time" },
      from: { type: "string", description: "Filter by sender name" },
    },
    required: ["card_id"],
  },
  execute: executeRead,
};
