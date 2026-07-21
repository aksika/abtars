import { logError } from "../logger.js";
import type { AgentTool, AgentToolResult } from "./pi-core-types.js";
import type { PiExecutionSafetyController } from "./pi-core-safety.js";
import { getToolDefinitions, executeToolCall } from "./tool-registry.js";
import type { ToolDefinition } from "./tool-registry.js";
import type { SandboxPolicy } from "../tool-sandbox.js";
import { checkTool } from "../tool-sandbox.js";

const TAG = "pi-core-tools";

export interface PiCoreToolContext {
  executionId: string;
  userId: string;
  signal?: AbortSignal;
  sandboxPolicy: SandboxPolicy;
  safety: PiExecutionSafetyController;
  /** Wrap a JSON schema object as a Pi-compatible TypeScript schema (Type.Unsafe). */
  createUnsafeSchema?: (schema: Record<string, unknown>) => Record<string, unknown>;
}

function adaptParameters(params: Record<string, unknown>): Record<string, unknown> {
  const allowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "type" || key === "properties" || key === "required" || key === "description" || key === "additionalProperties" || key === "items") {
      allowed[key] = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = adaptParameters(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) allowed[key] = nested;
    }
  }
  return allowed;
}

function validatePiSchemaOrThrow(schema: Record<string, unknown>): void {
  // Must be parseable as a valid JSON Schema — the registry definitions are
  // trusted, so this is a sanity check that the schema can be represented as
  // a Pi AgentTool parameter schema.
  if (schema == null || typeof schema !== "object") throw new Error("Tool schema must be an object");
}

function definitionToAgentTool(def: ToolDefinition, context: PiCoreToolContext): AgentTool {
  validatePiSchemaOrThrow(def.parameters);

  const adapted = adaptParameters(def.parameters ?? {});
  const parameters = context.createUnsafeSchema
    ? context.createUnsafeSchema(adapted)
    : adapted;

  return {
    name: def.name,
    description: def.description,
    parameters,
    executionMode: "sequential",

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<AgentToolResult> {
      const toolDecision = context.safety.beforeTool(def.name, params);
      if (toolDecision.decision === "skip") {
        return {
          label: `${def.name} (skipped)`,
          content: [{ type: "text", text: "Tool call skipped — batch cancelled" }],
          isError: false,
        };
      }
      if (toolDecision.decision === "error") {
        context.safety.afterTool(def.name, JSON.stringify({ error: toolDecision.reason }));
        return {
          label: `${def.name} (blocked)`,
          content: [{ type: "text", text: toolDecision.reason }],
          isError: true,
        };
      }

      // onToolStart fires from Pi lifecycle event (tool_execution_start), not from wrapper.
      // Do not fire it here — prevents double-count.

      const stringArgs: Record<string, string> = {};
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "string") {
          stringArgs[k] = v;
        } else if (typeof v === "number" || typeof v === "boolean") {
          stringArgs[k] = String(v);
        } else if (v === null) {
          stringArgs[k] = "null";
        } else if (v === undefined) {
          stringArgs[k] = "";
        } else {
          stringArgs[k] = JSON.stringify(v);
        }
      }

      try {
        const result = await executeToolCall(def.name, stringArgs, {
          userId: context.userId,
          signal: signal ?? context.signal,
          sandboxPolicy: context.sandboxPolicy,
        });

        const outcome = context.safety.afterTool(def.name, result);
        if (outcome.decision === "error") {
          return {
            label: `${def.name} (failure)`,
            content: [{ type: "text", text: outcome.reason }],
            isError: true,
          };
        }

        return {
          label: def.name,
          content: [{ type: "text", text: result.slice(0, 2000) }],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(TAG, `Tool ${def.name} execution error: ${msg}`);
        context.safety.afterTool(def.name, JSON.stringify({ error: msg }));
        return {
          label: `${def.name} (error)`,
          content: [{ type: "text", text: "Tool execution failed" }],
          isError: true,
        };
      }
    },
  };
}

export function createPiAgentTools(context: PiCoreToolContext): AgentTool[] {
  const definitions = getToolDefinitions();
  const policy = context.sandboxPolicy;

  const tools: AgentTool[] = [];

  for (const def of definitions) {
    const allowed = checkTool(def.name, policy);
    if (!allowed.allowed) continue;

    try {
      const agentTool = definitionToAgentTool(def, context);
      tools.push(agentTool);
    } catch (err) {
      // Design: malformed schema → fail host setup (throw), not skip silently
      throw new Error(`Tool "${def.name}" schema validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return tools;
}
