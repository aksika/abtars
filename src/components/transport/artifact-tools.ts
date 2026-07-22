/**
 * artifact-tools.ts — Agent tools for S3 artifact store (#929) + inline transfer (#928).
 */

import type { ToolDefinition } from "./tool-registry.js";
import { upload, download } from "../artifact-store.js";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

// ── Inline artifact queue (#928) ──────────────────────────────────────────────

export interface InlineArtifact { name: string; content: string }

const pendingArtifacts = new Map<number, InlineArtifact[]>();

const MAX_FILE_BYTES = 1_000_000; // 1MB raw

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function drainArtifacts(cardId: number): InlineArtifact[] | undefined {
  const arts = pendingArtifacts.get(cardId);
  if (arts) pendingArtifacts.delete(cardId);
  return arts;
}

export const artifactAttachTool: ToolDefinition = {
  name: "artifact_attach",
  description: "Attach a local file to the task result. The file is base64-encoded and sent back to the delegating peer on task completion. Max 1MB per file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file to attach" },
      card_id: { type: "number", description: "Current card ID (from environment)" },
    },
    required: ["path", "card_id"],
  },
  async execute(args): Promise<string> {
    const filePath = stringValue(args["path"]);
    const cardId = parseInt(stringValue(args["card_id"] ?? "0"), 10);
    if (!filePath) return JSON.stringify({ error: "path is required" });
    if (!cardId) return JSON.stringify({ error: "card_id is required" });

    try {
      const stat = statSync(filePath);
      if (stat.size > MAX_FILE_BYTES) {
        return JSON.stringify({ error: `File too large: ${stat.size} bytes (max ${MAX_FILE_BYTES})` });
      }
      const content = readFileSync(filePath).toString("base64");
      const name = basename(filePath);
      const list = pendingArtifacts.get(cardId) ?? [];
      list.push({ name, content });
      pendingArtifacts.set(cardId, list);
      return JSON.stringify({ ok: true, name, size: stat.size, queued: list.length });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export const artifactPushTool: ToolDefinition = {
  name: "artifact_push",
  description: "Upload a local file to the shared artifact store (S3). Returns the artifact URL.",
  parameters: {
    type: "object",
    properties: {
      local_path: { type: "string", description: "Absolute path to local file" },
      remote_path: { type: "string", description: "Remote key/path in the artifact store" },
    },
    required: ["local_path", "remote_path"],
  },
  async execute(args): Promise<string> {
    try {
      const url = await upload(stringValue(args["local_path"]), stringValue(args["remote_path"]));
      return JSON.stringify({ ok: true, url });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export const artifactPullTool: ToolDefinition = {
  name: "artifact_pull",
  description: "Download a file from the shared artifact store (S3) to a local path.",
  parameters: {
    type: "object",
    properties: {
      remote_path: { type: "string", description: "Remote key/path in the artifact store" },
      local_path: { type: "string", description: "Absolute local path to save the file" },
    },
    required: ["remote_path", "local_path"],
  },
  async execute(args): Promise<string> {
    try {
      const localPath = stringValue(args["local_path"]);
      await download(stringValue(args["remote_path"]), localPath);
      return JSON.stringify({ ok: true, path: localPath });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};
