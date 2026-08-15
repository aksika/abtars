import { logWarn } from "../logger.js";
import type { AgentTool, AgentToolResult } from "./pi-core-types.js";
import type { PiExecutionSafetyController } from "./pi-core-safety.js";
import { getToolDefinitions, executeToolCall, checkToolAvailability } from "./tool-registry.js";
import type { ToolDefinition } from "./tool-registry.js";
import type { SandboxPolicy } from "../tool-sandbox.js";
import { checkTool } from "../tool-sandbox.js";
import { PiCoreToolExecutionError, parseToolResultToDiagnostic, buildUnknownDiagnostic } from "./tool-failure-diagnostic.js";
import type { ToolFailureDiagnosticV1 } from "./tool-failure-diagnostic.js";
import type { ToolExecutionScope } from "../tasks/task-package.js";

const TAG = "pi-core-tools";

export interface PiCoreToolContext {
  executionId: string;
  userId: string;
  signal?: AbortSignal;
  sandboxPolicy: SandboxPolicy;
  safety: PiExecutionSafetyController;
  onToolSuccess?: () => void;
  onToolFailure?: (diagnostic: ToolFailureDiagnosticV1) => void;
  /** Wrap a JSON schema object as a Pi-compatible TypeScript schema (Type.Unsafe). */
  createUnsafeSchema?: (schema: Record<string, unknown>) => Record<string, unknown>;
  /** #1502 Task 10: task-local execution scope. */
  executionScope?: ToolExecutionScope;
  /** #1480: Orc invocation context for durable project ownership fencing. */
  orcContext?: import("../orc-project/orc-project-contracts.js").OrcInvocationContextV1;
  /** #1552: trusted session type supplied by Spin; absent types fail closed. */
  sessionType?: import("../spin-types.js").SessionType;
  /** #1552: late-bound memory-tool dependencies (runtime + quota holder). */
  memoryToolDeps?: import("../memory-store-quota.js").MemoryToolDependenciesHolder;
  /** #1629: trusted tool authorization mode (from Spin via the transport). */
  authorizationMode?: import("../action-gate.js").ToolAuthorizationMode;
}

function adaptParameters(params: Record<string, unknown>): Record<string, unknown> {
  // Pi accepts a public TypeBox schema, but the registry already owns the
  // complete JSON Schema. Preserve every keyword instead of maintaining a
  // lossy whitelist that silently drops enum/oneOf/format constraints.
  return structuredClone(params) as Record<string, unknown>;
}

export function validatePiSchemaOrThrow(schema: Record<string, unknown>): void {
  if (schema == null || typeof schema !== "object" || Array.isArray(schema)) throw new Error("schema_not_object");
  if (schema.type !== undefined && typeof schema.type !== "string") throw new Error("schema_type_invalid");
  if (schema.properties !== undefined && (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties))) {
    throw new Error("schema_properties_invalid");
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) {
    throw new Error("schema_required_invalid");
  }
  if (schema.items !== undefined) {
    if (typeof schema.items !== "object" || schema.items === null || Array.isArray(schema.items)) {
      throw new Error("schema_items_invalid");
    }
    // #1620: recurse through array `items` so nested schema constraints
    // (properties, required, enum) are validated at registration instead of
    // reaching a provider with a malformed sub-schema.
    validatePiSchemaOrThrow(schema.items as Record<string, unknown>);
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
        const decisionDiag = buildUnknownDiagnostic(context.executionId, def.name, toolDecision.reason);
        context.onToolFailure?.(decisionDiag);
        throw new PiCoreToolExecutionError(decisionDiag);
      }

      // onToolStart fires from Pi lifecycle event (tool_execution_start), not from wrapper.
      // Do not fire it here — prevents double-count.

      let outcomeRecorded = false;
      let lastDiag: ToolFailureDiagnosticV1 | undefined;
      try {
        const result = await executeToolCall(def.name, params, {
          userId: context.userId,
          executionId: context.executionId,
          signal: signal ?? context.signal,
          sandboxPolicy: context.sandboxPolicy,
          executionScope: context.executionScope,
          orcContext: context.orcContext,
          sessionType: context.sessionType,
          memoryToolDeps: context.memoryToolDeps,
          authorizationMode: context.authorizationMode,
        });

        const diag = parseToolResultToDiagnostic(result, context.executionId, def.name);
        if (diag) {
          lastDiag = diag;
          logWarn(TAG, `Tool ${def.name} failed [${diag.execution_id}]: ${diag.reason}${diag.command_fingerprint ? " fp:" + diag.command_fingerprint : ""}`);
        }

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
          const finalDiag = lastDiag
            ? { ...lastDiag, reason: "repeated_failure" as const, safety_incident: "repeated_failure" as const }
            : buildUnknownDiagnostic(context.executionId, def.name, outcome.reason);
          context.onToolFailure?.(finalDiag);
          throw new PiCoreToolExecutionError(finalDiag);
        }

        // Report fallible outcome to transport AFTER afterTool confirms it's a single failure
        if (lastDiag) context.onToolFailure?.(lastDiag);

        context.onToolSuccess?.();

        return {
          content: [{ type: "text", text: result.slice(0, 2000) }],
          details: { tool: def.name },
        };
      } catch (err) {
        if (err instanceof PiCoreToolExecutionError) throw err;

        const errorClass = err instanceof Error ? err.name : "unknown";
        const errorMsg = err instanceof Error ? err.message : String(err);
        const fallbackDiag = buildUnknownDiagnostic(context.executionId, def.name, errorMsg);
        context.onToolFailure?.(fallbackDiag);
        logWarn(TAG, `Tool ${def.name} execution failed [${context.executionId}] (${errorClass})`);

        if (!outcomeRecorded) {
          context.safety.afterTool(def.name, JSON.stringify({ error: errorClass }));
        }
        throw new PiCoreToolExecutionError(fallbackDiag);
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

    // #1663: the shared contextual availability policy — unattended scheduled
    // executions never receive a send_document schema, so the model cannot
    // plan around a capability it cannot use. The registry execution boundary
    // remains authoritative; this filter only improves model behavior.
    if (!checkToolAvailability(def.name, context).allowed) continue;

    // #1552 R1: memory_store is only ever presented to Main (A) and Dreamy
    // (D). Every other type — including missing/forged types — does not see
    // the tool, so a model cannot even attempt it through the schema.
    if (def.name === "memory_store" && context.sessionType !== "A" && context.sessionType !== "D") continue;
    // #1660: secret_find is Main-only; its execution-time gate is mirrored at
    // presentation so non-Main models never see the schema.
    if (def.name === "secret_find" && context.sessionType !== "A") continue;

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
