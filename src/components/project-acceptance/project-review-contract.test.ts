import { describe, it, expect } from "vitest";
import {
  REVIEW_ACTIONS,
  CRITERION_VERDICTS,
  OUTPUT_DISPOSITIONS,
  CONTRADICTION_DISPOSITIONS,
  REVIEW_PROJECT_PARAMETERS,
  narrowReviewProjectArgs,
} from "./project-review-contract.js";
import { getToolDefinitions, getToolSchemas } from "../transport/tool-registry.js";
import { toAnthropicRequest } from "../transport/anthropic-adapter.js";
import { createPiAgentTools, validatePiSchemaOrThrow } from "../transport/pi-core-tools.js";
import { createPiExecutionSafetyController } from "../transport/pi-core-safety.js";
import { FallbackPolicy } from "../transport/fallback-policy.js";
import { ModelHealthRegistry } from "../transport/model-health-registry.js";
import { buildPolicy } from "../tool-sandbox.js";
import type { PiCoreToolContext } from "../transport/pi-core-tools.js";
import type { ModelCandidate } from "../transport/model-candidates.js";

function reviewToolParams(): Record<string, unknown> {
  const def = getToolDefinitions().find(t => t.name === "review_project");
  expect(def).toBeDefined();
  return def!.parameters as Record<string, unknown>;
}

function makePiContext(): PiCoreToolContext {
  const candidate: ModelCandidate = { model: "test-model", provider: "test-provider", endpoint: "https://api.test/v1", maxContext: 128000, apiKey: "k", source: "primary" };
  const registry = new ModelHealthRegistry();
  const policy = new FallbackPolicy([candidate], registry);
  return {
    executionId: "exec_1",
    userId: "user_1",
    sandboxPolicy: buildPolicy("owner"),
    safety: createPiExecutionSafetyController(policy),
    memoryToolDeps: { current: null },
  };
}

const criteriaSchema = (params: Record<string, unknown>) =>
  (params as { properties: Record<string, unknown> }).properties["criteria"] as Record<string, unknown>;

describe("review_project nested schema preservation (#1620)", () => {
  it("registry schema carries nested enums, items, and required fields", () => {
    const params = reviewToolParams();
    const properties = (params as { properties: Record<string, unknown> }).properties as Record<string, unknown>;
    expect((params as { type: string }).type).toBe("object");

    const action = properties["action"] as { enum?: unknown[] };
    expect(action.enum).toEqual([...REVIEW_ACTIONS]);

    const criteria = properties["criteria"] as Record<string, unknown>;
    expect(criteria.type).toBe("array");
    expect(criteria.items).toBeDefined();
    const criterionItems = criteria.items as { properties: Record<string, unknown>; required: string[] };
    const verdict = criterionItems.properties["verdict"] as { enum?: unknown[] };
    expect(verdict.enum).toEqual([...CRITERION_VERDICTS]);
    expect(criterionItems.required).toEqual(["criterion_id", "verdict", "evidence_ids", "rationale"]);
    expect((criterionItems as { additionalProperties: boolean }).additionalProperties).toBe(false);

    const outputs = properties["outputs"] as Record<string, unknown>;
    const outputItems = outputs.items as { properties: Record<string, unknown>; required: string[] };
    const disposition = outputItems.properties["disposition"] as { enum?: unknown[] };
    expect(disposition.enum).toEqual([...OUTPUT_DISPOSITIONS]);

    const contradictions = properties["contradictions"] as Record<string, unknown>;
    const contradictionItems = contradictions.items as { properties: Record<string, unknown> };
    const cDisposition = contradictionItems.properties["disposition"] as { enum?: unknown[] };
    expect(cDisposition.enum).toEqual([...CONTRADICTION_DISPOSITIONS]);

    const required = params.required as string[];
    for (const field of ["action", "project_card_id", "review_case_id", "criteria", "outputs", "contradictions", "residual_risks", "synthesis"]) {
      expect(required).toContain(field);
    }

    // repair / blocker / input_request stay action-specific but typed
    expect(properties["repair"]).toBeDefined();
    expect(properties["blocker"]).toBeDefined();
    expect(properties["input_request"]).toBeDefined();
  });

  it("getToolSchemas (OpenAI-compatible) preserves the nested contract", () => {
    const schemas = getToolSchemas();
    const fn = schemas.find(s => s.function.name === "review_project");
    expect(fn).toBeDefined();
    const params = fn!.function.parameters as Record<string, unknown>;
    const criteria = criteriaSchema(params);
    const verdict = ((criteria.items as { properties: Record<string, unknown> }).properties["verdict"]) as { enum?: unknown[] };
    expect(verdict.enum).toEqual([...CRITERION_VERDICTS]);
  });

  it("Anthropic adapter preserves input_schema nested enums", () => {
    const tools = [{
      type: "function" as const,
      function: { name: "review_project", description: "x", parameters: REVIEW_PROJECT_PARAMETERS as unknown as Record<string, unknown> },
    }];
    const request = toAnthropicRequest("claude-test", [{ role: "user", content: "hi" }], 1000, tools);
    const anthropicTools = request.tools as Array<{ name: string; input_schema: Record<string, unknown> }>;
    const review = anthropicTools.find(t => t.name === "review_project")!;
    const criteria = criteriaSchema(review.input_schema);
    const verdict = ((criteria.items as { properties: Record<string, unknown> }).properties["verdict"]) as { enum?: unknown[] };
    expect(verdict.enum).toEqual([...CRITERION_VERDICTS]);
  });

  it("Pi adapter preserves nested enums and validates the full schema", () => {
    const tools = createPiAgentTools(makePiContext());
    const review = tools.find(t => t.name === "review_project");
    expect(review).toBeDefined();
    // Pi wraps the registry schema without dropping nested keywords; the
    // parameters object is the adapted registry schema.
    const params = review!.parameters as unknown as Record<string, unknown>;
    const criteria = criteriaSchema(params);
    const verdict = ((criteria.items as { properties: Record<string, unknown> }).properties["verdict"]) as { enum?: unknown[] };
    expect(verdict.enum).toEqual([...CRITERION_VERDICTS]);
  });

  it("Pi schema validation rejects malformed nested array items at registration", () => {
    expect(() => validatePiSchemaOrThrow({ type: "array", items: { type: "array", items: "not-an-object" } })).toThrow("schema_items_invalid");
    expect(() => validatePiSchemaOrThrow({ type: "array", items: { type: "object", properties: { bad: { type: 42 } } } })).toThrow("schema_type_invalid");
    expect(() => validatePiSchemaOrThrow({ type: "array", items: { type: "object" } })).not.toThrow();
  });
});

describe("narrowReviewProjectArgs (#1620)", () => {
  const validRaw = {
    action: "accept",
    project_card_id: 42,
    project_generation: 1,
    review_case_id: "rc_1",
    criteria: [{ criterion_id: "c1", verdict: "satisfied", evidence_ids: ["e1"], rationale: "verified" }],
    outputs: [{ output_id: "o1", disposition: "present", evidence_ids: [] }],
    contradictions: [],
    residual_risks: [],
    synthesis: "Done",
  };

  it("narrows a valid native accept payload into a typed decision", () => {
    const result = narrowReviewProjectArgs({ ...validRaw });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.decision;
    expect(d.schema_version).toBe(1);
    expect(d.action).toBe("accept");
    expect(d.project_card_id).toBe(42);
    expect(d.criteria).toHaveLength(1);
    expect(d.criteria[0]!.verdict).toBe("satisfied");
    expect(d.authored_at).toBeTruthy();
  });

  it("passes enum values through structurally — the semantic validator owns membership (#1620 scenario 5)", () => {
    const result = narrowReviewProjectArgs({
      ...validRaw,
      criteria: [{ criterion_id: "c1", verdict: "delivered", evidence_ids: [], rationale: "x" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decision.criteria[0]!.verdict).toBe("delivered");
  });

  it("rejects structural defects and missing nested arrays", () => {
    const badNested = narrowReviewProjectArgs({
      ...validRaw,
      outputs: { output_id: "o1", disposition: "whatever" },
    });
    expect(badNested.ok).toBe(false);
    if (!badNested.ok) expect(badNested.issues[0]!.path).toBe("$.outputs");

    const missingCriteria = narrowReviewProjectArgs({ ...validRaw, criteria: undefined });
    expect(missingCriteria.ok).toBe(false);
    if (!missingCriteria.ok) expect(missingCriteria.issues.some(i => i.path === "$.criteria")).toBe(true);
  });

  it("builds native repair, blocked, and needs_input payloads without defaults", () => {
    const repair = narrowReviewProjectArgs({
      ...validRaw,
      action: "repair",
      repair: { items: [{ id: "r1", affected_criterion_ids: ["c1"], required_evidence: "observed", strategy: "rework", do_not_repeat: [], capabilities: [], budget: { max_tokens: 5000 } }], rationale: "needs evidence" },
    });
    expect(repair.ok).toBe(true);
    if (repair.ok) expect(repair.decision.repair?.items[0]!.budget.max_tokens).toBe(5000);

    const blocked = narrowReviewProjectArgs({
      ...validRaw,
      action: "blocked",
      blocker: { blocker_class: "peer_failed", affected_criterion_ids: ["c1"], what_was_attempted: "asked peer" },
    });
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.decision.blocker?.blocker_class).toBe("peer_failed");

    const needsInput = narrowReviewProjectArgs({
      ...validRaw,
      action: "needs_input",
      input_request: { question: "Which path?", affected_criterion_ids: ["c1"], expected_response_kind: "text", context: "two options" },
    });
    expect(needsInput.ok).toBe(true);
    if (needsInput.ok) expect(needsInput.decision.input_request?.question).toBe("Which path?");
  });

  it("a malformed action-specific payload fails with issues instead of silent defaults", () => {
    const result = narrowReviewProjectArgs({ ...validRaw, action: "repair", repair: { items: "not-an-array" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some(i => i.path === "$.repair.items")).toBe(true);
  });

  it("tolerates numeric-string ids from wrappers that stringify", () => {
    const result = narrowReviewProjectArgs({ ...validRaw, project_card_id: "42", project_generation: "1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.project_card_id).toBe(42);
      expect(result.decision.project_generation).toBe(1);
    }
  });
});
