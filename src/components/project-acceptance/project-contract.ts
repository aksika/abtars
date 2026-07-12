import { createHash } from "node:crypto";

export const SUPPORTED_SCHEMA_VERSION = 1;
export const MAX_GOAL_LENGTH = 4000;
export const MAX_CRITERIA_COUNT = 30;
export const MAX_CRITERION_DESC_LENGTH = 500;
export const MAX_OUTPUTS_COUNT = 30;
export const MAX_OUTPUT_DESC_LENGTH = 500;
export const MAX_ARTIFACT_REF_LENGTH = 500;
export const MAX_CONSTRAINTS_COUNT = 20;
export const MAX_CONSTRAINT_LENGTH = 500;
export const MAX_CONTRACT_JSON_BYTES = 100_000;
export const MAX_REVIEW_ROUNDS = 10;
export const MAX_REPAIR_ROUNDS = 5;

export type EvidenceExpectation = "observed" | "artifact" | "synthesis";
export type OutputKind = "file" | "directory" | "report" | "logical";

export interface ProjectCriterion {
  readonly id: string;
  readonly description: string;
  readonly required: true;
  readonly evidence_expectation: EvidenceExpectation;
}

export interface RequiredOutput {
  readonly id: string;
  readonly description: string;
  readonly kind: OutputKind;
  readonly required: boolean;
}

export interface ProjectContractLimits {
  readonly hard_deadline_at?: string;
  readonly max_tokens?: number;
  readonly max_cost?: number;
  readonly max_review_rounds: number;
  readonly max_repair_rounds: number;
}

export interface ProjectContractProvenance {
  readonly requested_by: string;
  readonly authored_by: string;
  readonly created_at: string;
}

export interface ProjectAcceptanceContractV1 {
  readonly schema_version: 1;
  readonly id: string;
  readonly digest: string;
  readonly project_card_id: number;
  readonly goal: string;
  readonly criteria: readonly ProjectCriterion[];
  readonly required_outputs: readonly RequiredOutput[];
  readonly constraints: readonly string[];
  readonly limits: ProjectContractLimits;
  readonly provenance: ProjectContractProvenance;
}

export interface ContractCriterionMapping {
  readonly child_contract_id: string;
  readonly supports_root_criteria: readonly string[];
}

export type ValidationSeverity = "error" | "warn";
export type ValidationTag =
  | "missing_field"
  | "type_error"
  | "too_long"
  | "too_many"
  | "too_few"
  | "out_of_range"
  | "unknown_version"
  | "duplicate_id"
  | "bad_reference"
  | "empty_string"
  | "bad_format";

export interface ValidationIssue {
  readonly severity: ValidationSeverity;
  readonly tag: ValidationTag;
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { ok: true; contract: ProjectAcceptanceContractV1 }
  | { ok: false; errors: readonly ValidationIssue[] };

export type NormalizeResult =
  | { ok: true; contract: ProjectAcceptanceContractV1 }
  | { ok: false; errors: readonly ValidationIssue[] };

function issue(severity: ValidationSeverity, tag: ValidationTag, path: string, message: string): ValidationIssue {
  return { severity, tag, path, message };
}

function error(tag: ValidationTag, path: string, message: string): ValidationIssue {
  return issue("error", tag, path, message);
}

function warn(tag: ValidationTag, path: string, message: string): ValidationIssue {
  return issue("warn", tag, path, message);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function sortedKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = obj[k];
  }
  return out;
}

function stripDigest(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k !== "digest") out[k] = v;
  }
  return out;
}

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") return JSON.stringify(obj);
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const pairs = keys.map(k => JSON.stringify(k) + ":" + canonicalJson(record[k]));
  return "{" + pairs.join(",") + "}";
}

export function computeDigest(contract: Record<string, unknown>): string {
  const withoutDigest = stripDigest(contract);
  const canonical = canonicalJson(sortedKeys(withoutDigest));
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

export function createContractId(prefix = "pc"): string {
  return prefix + "_" + createHash("sha256").update(Math.random().toString()).digest("hex").slice(0, 24);
}

function errCollect<T>(arr: readonly T[], fn: (item: T, index: number) => readonly ValidationIssue[]): readonly ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (let i = 0; i < arr.length; i++) {
    out.push(...fn(arr[i]!, i));
  }
  return out;
}

const VALID_EVIDENCE_EXPECTATIONS: readonly string[] = ["observed", "artifact", "synthesis"];
const VALID_OUTPUT_KINDS: readonly string[] = ["file", "directory", "report", "logical"];

export function validateContract(raw: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: [error("type_error", "$", "contract must be an object")] };
  }

  const obj = raw as Record<string, unknown>;

  if (obj["schema_version"] !== 1) {
    errors.push(error("unknown_version", "$.schema_version", `unsupported schema_version: ${String(obj["schema_version"])}`));
    return { ok: false, errors };
  }

  if (!isNonEmptyString(obj["id"])) {
    errors.push(error("missing_field", "$.id", "contract id is required"));
  }

  if (typeof obj["project_card_id"] !== "number") {
    errors.push(error("type_error", "$.project_card_id", "project_card_id must be a number"));
  }

  if (!isNonEmptyString(obj["goal"])) {
    errors.push(error("missing_field", "$.goal", "goal is required"));
  } else if ((obj["goal"] as string).length > MAX_GOAL_LENGTH) {
    errors.push(error("too_long", "$.goal", `goal exceeds ${MAX_GOAL_LENGTH} characters`));
  }

  // criteria
  if (!Array.isArray(obj["criteria"])) {
    errors.push(error("missing_field", "$.criteria", "criteria is required"));
  } else {
    if (obj["criteria"].length === 0) {
      errors.push(error("too_few", "$.criteria", "at least one criterion is required"));
    }
    if (obj["criteria"].length > MAX_CRITERIA_COUNT) {
      errors.push(error("too_many", "$.criteria", `criteria count exceeds ${MAX_CRITERIA_COUNT}`));
    }
    const ids = new Set<string>();
    errors.push(...errCollect(obj["criteria"] as unknown[], (c, i) => {
      const path = `$.criteria[${i}]`;
      const e: ValidationIssue[] = [];
      if (typeof c !== "object" || c === null) {
        e.push(error("type_error", path, "criterion must be an object"));
        return e;
      }
      const cObj = c as Record<string, unknown>;
      if (!isNonEmptyString(cObj["id"])) {
        e.push(error("missing_field", `${path}.id`, "criterion id is required"));
      } else if (ids.has(cObj["id"] as string)) {
        e.push(error("duplicate_id", `${path}.id`, `duplicate criterion id "${cObj["id"]}"`));
      } else {
        ids.add(cObj["id"] as string);
      }
      if (!isNonEmptyString(cObj["description"])) {
        e.push(error("missing_field", `${path}.description`, "criterion description is required"));
      } else if ((cObj["description"] as string).length > MAX_CRITERION_DESC_LENGTH) {
        e.push(error("too_long", `${path}.description`, `description exceeds ${MAX_CRITERION_DESC_LENGTH} characters`));
      }
      if (cObj["required"] !== true) {
        e.push(error("type_error", `${path}.required`, "project criterion must be required: true"));
      }
      const ee = cObj["evidence_expectation"];
      if (!VALID_EVIDENCE_EXPECTATIONS.includes(ee as string)) {
        e.push(error("type_error", `${path}.evidence_expectation`, `must be one of: ${VALID_EVIDENCE_EXPECTATIONS.join(", ")}`));
      }
      return e;
    }));
  }

  // required_outputs
  if (!Array.isArray(obj["required_outputs"])) {
    errors.push(error("missing_field", "$.required_outputs", "required_outputs is required"));
  } else {
    if (obj["required_outputs"].length > MAX_OUTPUTS_COUNT) {
      errors.push(error("too_many", "$.required_outputs", `outputs count exceeds ${MAX_OUTPUTS_COUNT}`));
    }
    const outputIds = new Set<string>();
    errors.push(...errCollect(obj["required_outputs"] as unknown[], (o, i) => {
      const path = `$.required_outputs[${i}]`;
      const e: ValidationIssue[] = [];
      if (typeof o !== "object" || o === null) {
        e.push(error("type_error", path, "output must be an object"));
        return e;
      }
      const oObj = o as Record<string, unknown>;
      if (!isNonEmptyString(oObj["id"])) {
        e.push(error("missing_field", `${path}.id`, "output id is required"));
      } else if (outputIds.has(oObj["id"] as string)) {
        e.push(error("duplicate_id", `${path}.id`, `duplicate output id "${oObj["id"]}"`));
      } else {
        outputIds.add(oObj["id"] as string);
      }
      if (!isNonEmptyString(oObj["description"])) {
        e.push(error("missing_field", `${path}.description`, "output description is required"));
      } else if ((oObj["description"] as string).length > MAX_OUTPUT_DESC_LENGTH) {
        e.push(error("too_long", `${path}.description`, `description exceeds ${MAX_OUTPUT_DESC_LENGTH} characters`));
      }
      const kind = oObj["kind"];
      if (!VALID_OUTPUT_KINDS.includes(kind as string)) {
        e.push(error("type_error", `${path}.kind`, `invalid kind "${String(kind)}"`));
      }
      if (typeof oObj["required"] !== "boolean") {
        e.push(error("type_error", `${path}.required`, "required must be a boolean"));
      }
      return e;
    }));
  }

  // constraints
  if (obj["constraints"] !== undefined) {
    if (!Array.isArray(obj["constraints"])) {
      errors.push(error("type_error", "$.constraints", "must be an array"));
    } else {
      if (obj["constraints"].length > MAX_CONSTRAINTS_COUNT) {
        errors.push(error("too_many", "$.constraints", `constraints count exceeds ${MAX_CONSTRAINTS_COUNT}`));
      }
      for (let i = 0; i < (obj["constraints"] as unknown[]).length; i++) {
        const c = (obj["constraints"] as unknown[])[i];
        if (!isNonEmptyString(c as string)) {
          errors.push(error("type_error", `$.constraints[${i}]`, "each constraint must be a non-empty string"));
        } else if ((c as string).length > MAX_CONSTRAINT_LENGTH) {
          errors.push(error("too_long", `$.constraints[${i}]`, `constraint exceeds ${MAX_CONSTRAINT_LENGTH} characters`));
        }
      }
    }
  }

  // limits
  if (typeof obj["limits"] !== "object" || obj["limits"] === null) {
    errors.push(error("missing_field", "$.limits", "limits is required"));
  } else {
    const limits = obj["limits"] as Record<string, unknown>;
    if (limits["hard_deadline_at"] !== undefined && !isNonEmptyString(limits["hard_deadline_at"] as string)) {
      errors.push(error("bad_format", "$.limits.hard_deadline_at", "hard_deadline_at must be a valid ISO string"));
    }
    if (limits["max_tokens"] !== undefined && (typeof limits["max_tokens"] !== "number" || !Number.isFinite(limits["max_tokens"] as number))) {
      errors.push(error("type_error", "$.limits.max_tokens", "must be a finite number"));
    }
    if (limits["max_cost"] !== undefined && (typeof limits["max_cost"] !== "number" || !Number.isFinite(limits["max_cost"] as number))) {
      errors.push(error("type_error", "$.limits.max_cost", "must be a finite number"));
    }
    if (typeof limits["max_review_rounds"] !== "number" || !Number.isFinite(limits["max_review_rounds"] as number)) {
      errors.push(error("missing_field", "$.limits.max_review_rounds", "max_review_rounds is required"));
    } else if ((limits["max_review_rounds"] as number) > MAX_REVIEW_ROUNDS) {
      errors.push(warn("out_of_range", "$.limits.max_review_rounds", `max_review_rounds exceeds ${MAX_REVIEW_ROUNDS}`));
    }
    if (typeof limits["max_repair_rounds"] !== "number" || !Number.isFinite(limits["max_repair_rounds"] as number)) {
      errors.push(error("missing_field", "$.limits.max_repair_rounds", "max_repair_rounds is required"));
    } else if ((limits["max_repair_rounds"] as number) > MAX_REPAIR_ROUNDS) {
      errors.push(warn("out_of_range", "$.limits.max_repair_rounds", `max_repair_rounds exceeds ${MAX_REPAIR_ROUNDS}`));
    }
  }

  // provenance
  if (typeof obj["provenance"] !== "object" || obj["provenance"] === null) {
    errors.push(error("missing_field", "$.provenance", "provenance is required"));
  } else {
    const prov = obj["provenance"] as Record<string, unknown>;
    if (!isNonEmptyString(prov["requested_by"])) {
      errors.push(error("missing_field", "$.provenance.requested_by", "requested_by is required"));
    }
    if (!isNonEmptyString(prov["authored_by"])) {
      errors.push(error("missing_field", "$.provenance.authored_by", "authored_by is required"));
    }
    if (!isNonEmptyString(prov["created_at"])) {
      errors.push(error("missing_field", "$.provenance.created_at", "created_at is required"));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const contract = obj as unknown as ProjectAcceptanceContractV1;

  const jsonBytes = Buffer.byteLength(JSON.stringify(contract), "utf-8");
  if (jsonBytes > MAX_CONTRACT_JSON_BYTES) {
    errors.push(error("too_long", "$", `contract JSON exceeds ${MAX_CONTRACT_JSON_BYTES} bytes`));
    return { ok: false, errors };
  }

  return { ok: true, contract };
}

export function normalizeContract(raw: unknown): NormalizeResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: [error("type_error", "$", "contract must be an object")] };
  }

  const obj = raw as Record<string, unknown>;
  const id = isNonEmptyString(obj["id"]) ? (obj["id"] as string) : createContractId();

  const criteriaRaw = Array.isArray(obj["criteria"]) ? (obj["criteria"] as unknown[]) : [];
  const criteria = criteriaRaw.map(c => ({
    id: (c as Record<string, unknown>)["id"] as string,
    description: (c as Record<string, unknown>)["description"] as string,
    required: true as const,
    evidence_expectation: ((c as Record<string, unknown>)["evidence_expectation"] as EvidenceExpectation) ?? "synthesis",
  }));

  const outputsRaw = Array.isArray(obj["required_outputs"]) ? (obj["required_outputs"] as unknown[]) : [];
  const required_outputs = outputsRaw.map(o => ({
    id: (o as Record<string, unknown>)["id"] as string,
    description: (o as Record<string, unknown>)["description"] as string,
    kind: (o as Record<string, unknown>)["kind"] as OutputKind ?? "logical",
    required: (o as Record<string, unknown>)["required"] === true,
  }));

  const constraintsRaw = Array.isArray(obj["constraints"]) ? (obj["constraints"] as string[]) : [];
  const limitsRaw = (typeof obj["limits"] === "object" && obj["limits"] !== null) ? (obj["limits"] as Record<string, unknown>) : {};
  const provenanceRaw = (typeof obj["provenance"] === "object" && obj["provenance"] !== null) ? (obj["provenance"] as Record<string, unknown>) : undefined;

  const built: Record<string, unknown> = {
    schema_version: 1,
    id,
    digest: "",
    project_card_id: typeof obj["project_card_id"] === "number" ? obj["project_card_id"] : 0,
    goal: typeof obj["goal"] === "string" ? obj["goal"] as string : "",
    criteria,
    required_outputs,
    constraints: constraintsRaw,
    limits: {
      hard_deadline_at: limitsRaw["hard_deadline_at"] as string | undefined,
      max_tokens: limitsRaw["max_tokens"] as number | undefined,
      max_cost: limitsRaw["max_cost"] as number | undefined,
      max_review_rounds: (limitsRaw["max_review_rounds"] as number) ?? MAX_REVIEW_ROUNDS,
      max_repair_rounds: (limitsRaw["max_repair_rounds"] as number) ?? MAX_REPAIR_ROUNDS,
    },
    provenance: provenanceRaw
      ? {
          requested_by: typeof provenanceRaw["requested_by"] === "string" ? provenanceRaw["requested_by"] as string : "unknown",
          authored_by: typeof provenanceRaw["authored_by"] === "string" ? provenanceRaw["authored_by"] as string : "unknown",
          created_at: typeof provenanceRaw["created_at"] === "string" ? provenanceRaw["created_at"] as string : new Date().toISOString(),
        }
      : { requested_by: "unknown", authored_by: "unknown", created_at: new Date().toISOString() },
  };

  const digest = computeDigest(built);
  built["digest"] = digest;

  const validated = validateContract(built);
  if (!validated.ok) return validated;

  return { ok: true, contract: built as unknown as ProjectAcceptanceContractV1 };
}

/**
 * Validate a child contract's root criterion mapping.
 * Returns errors for unknown root IDs.
 */
export function validateCriterionMapping(
  rootContract: ProjectAcceptanceContractV1,
  mapping: ContractCriterionMapping,
): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  if (!isNonEmptyString(mapping.child_contract_id)) {
    errors.push(error("missing_field", "$.child_contract_id", "child_contract_id is required"));
  }
  if (!Array.isArray(mapping.supports_root_criteria)) {
    errors.push(error("missing_field", "$.supports_root_criteria", "supports_root_criteria must be an array"));
    return errors;
  }
  const rootIds = new Set(rootContract.criteria.map(c => c.id));
  const seen = new Set<string>();
  for (let i = 0; i < mapping.supports_root_criteria.length; i++) {
    const rcId = mapping.supports_root_criteria[i]!;
    if (!isNonEmptyString(rcId)) {
      errors.push(error("empty_string", `$.supports_root_criteria[${i}]`, "root criterion id must be a non-empty string"));
    } else if (seen.has(rcId)) {
      errors.push(error("duplicate_id", `$.supports_root_criteria[${i}]`, `duplicate root criterion id "${rcId}"`));
    } else {
      seen.add(rcId);
      if (!rootIds.has(rcId)) {
        errors.push(error("bad_reference", `$.supports_root_criteria[${i}]`, `unknown root criterion id "${rcId}"`));
      }
    }
  }
  return errors;
}

/**
 * Find which root criteria have no child contract mapping them.
 * Returns list of uncovered criterion IDs (not errors — they are valid gaps).
 */
export function findUncoveredCriteria(
  rootContract: ProjectAcceptanceContractV1,
  mappings: readonly ContractCriterionMapping[],
): readonly string[] {
  const covered = new Set<string>();
  for (const m of mappings) {
    for (const rcId of m.supports_root_criteria) {
      covered.add(rcId);
    }
  }
  return rootContract.criteria
    .map(c => c.id)
    .filter(id => !covered.has(id));
}
