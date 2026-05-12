/**
 * mcp-tool.ts — Generic MCP tool (#471 v2).
 * Single tool that routes to any mcporter server/tool. Daemon starts on-demand.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logInfo, logWarn } from "../logger.js";
import type { ToolDefinition } from "./tool-registry.js";

const execFileAsync = promisify(execFile);
const TAG = "mcp";
let daemonStarted = false;

async function ensureDaemon(): Promise<void> {
  if (daemonStarted) return;
  try {
    await execFileAsync("mcporter", ["daemon", "start"], { timeout: 10_000 });
    daemonStarted = true;
    logInfo(TAG, "mcporter daemon started (on-demand)");
  } catch {
    logWarn(TAG, "mcporter daemon start failed — calls may still work if already running");
    daemonStarted = true; // don't retry every call
  }
}

export const mcpTool: ToolDefinition = {
  name: "mcp",
  description: "Call an MCP server tool via mcporter. Available servers shown by /mcp command. Use when you need JIRA, presentations, or other MCP-connected services.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "Server name (e.g. 'pptx', 'atlassian')" },
      tool: { type: "string", description: "Tool name (e.g. 'jira_search', 'create_presentation')" },
      args: { type: "string", description: "Tool arguments as JSON string (e.g. '{\"query\": \"assignee = me\"}')" },
    },
    required: ["server", "tool"],
  },
  async execute(params) {
    await ensureDaemon();
    const { server, tool, args } = params as { server: string; tool: string; args?: string };
    const cliArgs = ["call", `${server}.${tool}`];
    if (args) {
      try {
        const parsed = JSON.parse(args) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) cliArgs.push(`${k}=${v}`);
      } catch {
        cliArgs.push(args); // pass raw if not JSON
      }
    }
    try {
      const { stdout } = await execFileAsync("mcporter", cliArgs, { timeout: 30_000, encoding: "utf-8" });
      return stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `mcp call failed: ${msg}` });
    }
  },
};
