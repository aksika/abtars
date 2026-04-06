/**
 * Tool registry for DirectApiTransport.
 * Phase 1: execute_bash only — the universal tool.
 */

import { execFile } from "node:child_process";

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, string>): Promise<string>;
};

const BASH_TIMEOUT_MS = 300_000; // 5 min

const bashTool: ToolDefinition = {
  name: "execute_bash",
  description: "Execute a bash command on the system. Use this for file operations, running scripts, calling agentbridge-* CLI tools, git, and any other shell commands.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute" },
    },
    required: ["command"],
  },
  async execute(args): Promise<string> {
    const cmd = args["command"];
    if (!cmd) return JSON.stringify({ error: "No command provided" });

    return new Promise((resolve) => {
      execFile("bash", ["-c", cmd], { timeout: BASH_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const result: Record<string, unknown> = {};
        if (stdout) result["stdout"] = stdout.slice(0, 50_000);
        if (stderr) result["stderr"] = stderr.slice(0, 10_000);
        if (err) result["exit_code"] = (err as NodeJS.ErrnoException & { code?: number }).code ?? 1;
        else result["exit_code"] = 0;
        resolve(JSON.stringify(result));
      });
    });
  },
};

export function getToolDefinitions(): ToolDefinition[] {
  return [bashTool];
}

export function getToolSchemas(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return getToolDefinitions().map(t => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function executeToolCall(name: string, args: Record<string, string>): Promise<string> {
  const tool = getToolDefinitions().find(t => t.name === name);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  return tool.execute(args);
}
