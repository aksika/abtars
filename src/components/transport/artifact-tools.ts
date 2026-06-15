/**
 * artifact-tools.ts — Agent tools for S3 artifact store (#929).
 */

import type { ToolDefinition } from "./tool-registry.js";
import { upload, download } from "../artifact-store.js";

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
      const url = await upload(args["local_path"] ?? "", args["remote_path"] ?? "");
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
      await download(args["remote_path"] ?? "", args["local_path"] ?? "");
      return JSON.stringify({ ok: true, path: args["local_path"] });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};
