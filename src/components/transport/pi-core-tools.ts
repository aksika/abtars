import { logError, logWarn } from "../logger.js";
import type { AgentTool } from "./pi-core-types.js";
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
  onToolStart?: (name: string) => void;
  onToolSuccess?: () => void;
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

function definitionToAgentTool(def: ToolDefinition, context: PiCoreToolContext): AgentTool {
  const jsonSchema = def.parameters ?? {};
  const adapted = adaptParameters(jsonSchema);

  // Wrap in Pi-compatible TSchema via createUnsafeSchema if available,
  // otherwise pass the plain JSON schema (may fail Pi's internal TypeBox validation).
  const parameters = context.createUnsafeSchema
    ? context.createUnsafeSchema(adapted)
    : adapted;

  return {
    name: def.name,
    description: def.description,
    parameters,
    executionMode: "sequential",

    async execute(
      args: Record<string, unknown>,
      execContext?: { signal?: AbortSignal },
    ): Promise<string> {
      const toolDecision = context.safety.beforeTool(def.name, args);
      if (toolDecision.decision === "skip") {
        return JSON.stringify({ error: "Skipped — tool batch cancelled", skip: true });
      }
      if (toolDecision.decision === "error") {
        context.safety.afterTool(def.name, JSON.stringify({ error: toolDecision.reason }));
        return JSON.stringify({ error: toolDecision.reason });
      }

      context.onToolStart?.(def.name);

      const stringArgs: Record<string, string> = {};
      for (const [k, v] of Object.entries(args)) {
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
          signal: execContext?.signal ?? context.signal,
          sandboxPolicy: context.sandboxPolicy,
        });

        const outcome = context.safety.afterTool(def.name, result);
        if (outcome.decision === "error") {
          return JSON.stringify({ error: outcome.reason, detail: result });
        }

        context.onToolSuccess?.();
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(TAG, `Tool ${def.name} execution error: ${msg}`);
        context.safety.afterTool(def.name, JSON.stringify({ error: msg }));
        return JSON.stringify({ error: msg });
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
      logWarn(TAG, `Skipping tool "${def.name}" — schema validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return tools;
}
