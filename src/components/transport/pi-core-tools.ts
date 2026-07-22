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
  onToolSuccess?: () => void;
  /** Wrap a JSON schema object as a Pi-compatible TypeScript schema (Type.Unsafe). */
  createUnsafeSchema?: (schema: Record<string, unknown>) => Record<string, unknown>;
}

function adaptParameters(params: Record<string, unknown>): Record<string, unknown> {
  // Pi accepts a public TypeBox schema, but the registry already owns the
  // complete JSON Schema. Preserve every keyword instead of maintaining a
  // lossy whitelist that silently drops enum/oneOf/format constraints.
  return structuredClone(params) as Record<string, unknown>;
}

function validatePiSchemaOrThrow(schema: Record<string, unknown>): void {
  if (schema == null || typeof schema !== "object" || Array.isArray(schema)) throw new Error("schema_not_object");
  if (schema.type !== undefined && typeof schema.type !== "string") throw new Error("schema_type_invalid");
  if (schema.properties !== undefined && (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties))) {
    throw new Error("schema_properties_invalid");
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) {
    throw new Error("schema_required_invalid");
  }
  if (schema.items !== undefined && (typeof schema.items !== "object" || schema.items === null || Array.isArray(schema.items))) {
    throw new Error("schema_items_invalid");
  }
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (properties) {
    for (const child of Object.values(properties)) {
      if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("schema_property_invalid");
      validatePiSchemaOrThrow(child as Record<string, unknown>);
    }
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = schema[keyword];
    if (branches !== undefined) {
      if (!Array.isArray(branches)) throw new Error(`schema_${keyword}_invalid`);
      for (const branch of branches) {
        if (!branch || typeof branch !== "object" || Array.isArray(branch)) throw new Error(`schema_${keyword}_branch_invalid`);
        validatePiSchemaOrThrow(branch as Record<string, unknown>);
      }
    }
  }
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
    label: def.name,
    parameters: parameters as import("typebox").TSchema,
    executionMode: "sequential",

    async execute(
      _toolCallId: string,
      rawParams: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      const params = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
        ? rawParams as Record<string, unknown>
        : {};
      const toolDecision = context.safety.beforeTool(def.name, params);
      if (toolDecision.decision === "skip") {
        return {
          content: [{ type: "text", text: "Tool call skipped — batch cancelled" }],
          details: { skipped: true },
        };
      }
      if (toolDecision.decision === "error") {
        throw new Error(toolDecision.reason);
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

      let outcomeRecorded = false;
      try {
        const result = await executeToolCall(def.name, stringArgs, {
          userId: context.userId,
          signal: signal ?? context.signal,
          sandboxPolicy: context.sandboxPolicy,
        });

        if (def.name === "memory_store") {
          try {
            const parsed = JSON.parse(result) as { stored?: boolean };
            const classification = Number(params["classification"] ?? params["class"] ?? 1);
            if (parsed.stored === true && classification >= 2 && typeof params["translated"] === "string") {
              context.safety.recordClassifiedStoreLiteral(params["translated"]);
            }
          } catch {
            // Store results are still returned normally; only valid success
            // envelopes can create a scrub literal.
          }
        }

        const outcome = context.safety.afterTool(def.name, result);
        outcomeRecorded = true;
        if (outcome.decision === "error") {
          throw new Error(outcome.reason);
        }

        context.onToolSuccess?.();

        return {
          content: [{ type: "text", text: result.slice(0, 2000) }],
          details: { tool: def.name },
        };
      } catch (err) {
        const errorClass = err instanceof Error ? err.name : "unknown";
        logError(TAG, `Tool ${def.name} execution failed (${errorClass})`);
        if (!outcomeRecorded) {
          context.safety.afterTool(def.name, JSON.stringify({ error: errorClass }));
        }
        throw new Error("Tool execution failed");
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
