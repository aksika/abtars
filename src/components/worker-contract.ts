import { createHash } from "node:crypto";
import type { ExecutorKind } from "./worker-executor-identity.js";

export type CriterionStatus = "passed" | "failed" | "not_run" | "inconclusive";
export type WorkerOutcome = "completed" | "failed" | "cancelled" | "timed_out";

export const SUPPORTED_SCHEMA_VERSION = 1;
export const MAX_GOAL_LENGTH = 4000;
export const MAX_CRITERIA_COUNT = 20;
export const MAX_CRITERION_DESC_LENGTH = 500;
export const MAX_ARTIFACTS_COUNT = 20;
export const MAX_ARTIFACT_REF_LENGTH = 500;
export const MAX_COMMANDS_COUNT = 20;
export const MAX_ARGV_LENGTH = 200;
export const MAX_ARGS_COUNT = 50;
export const MAX_CAPABILITIES_COUNT = 20;
export const MAX_CAPABILITY_LENGTH = 100;
export const MAX_COMMAND_TIMEOUT_MS = 300_000;
export const MAX_CHECK_OUTPUT_LENGTH = 10_000;
export const MAX_EVIDENCE_TOTAL_BYTES = 100_000;
export const MAX_CRITERIA_IDS_PER_ITEM = 10;
export const MAX_WORKER_REPORT_LENGTH = 4000;
export const MAX_WORKER_CLAIMS_COUNT = 30;
export const MAX_WORKER_RISKS_COUNT = 20;
export const MAX_CONTRACT_JSON_BYTES = 50_000;
export const MAX_ENVELOPE_JSON_BYTES = 150_000;
export const MAX_WORKSPACE_ALIAS_LENGTH = 128;

/** #1638: bounded workspace-alias syntax. Rejects path separators, traversal,
 * absolute paths, and NUL/control characters — the alias is a name, never a
 * locator. */
export function isValidWorkspaceAlias(alias: string): boolean {
  if (typeof alias !== "string") return false;
  if (alias.length === 0 || alias.length > MAX_WORKSPACE_ALIAS_LENGTH) return false;
  if (/[\x00-\x1f\x7f/\\]/.test(alias)) return false;
  if (alias.includes("..")) return false;
  if (alias.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(alias)) return false;
  return true;
}

export type ArtifactKind = "file" | "directory" | "report" | "logical";

export interface ContractCriterion {
  readonly id: string;
  readonly description: string;
}

export interface ExpectedArtifact {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly ref: string;
  readonly required: boolean;
  readonly criterion_ids: string[];
}

export interface VerificationCommand {
  readonly id: string;
  readonly argv: string[];
  readonly cwd?: string;
  readonly timeout_ms: number;
  readonly criterion_ids: string[];
}

export interface ContractProvenance {
  readonly root_card_id: number;
  readonly card_id: number;
  readonly authored_by: string;
  readonly created_at: string;
}

export interface RetryContext {
  readonly directive_id: string;
  readonly mode: string;
  readonly instruction: string;
  readonly do_not_repeat: readonly string[];
  readonly prior_evidence_ids: readonly string[];
  readonly failed_criterion_ids: readonly string[];
  readonly unresolved_risks: readonly string[];
}

export interface WorkerContractRevisionV1 {
  readonly revision: number;
  readonly root_contract_id: string;
  readonly parent_contract_id?: string;
  readonly source_attempt_id?: string;
  readonly retry_context?: RetryContext;
}

export interface WorkerAcceptanceContractV1 {
  readonly schema_version: 1;
  readonly id: string;
  readonly digest: string;
  readonly revision_meta?: WorkerContractRevisionV1;
  readonly goal: string;
  readonly criteria: readonly ContractCriterion[];
  readonly expected_artifacts: readonly ExpectedArtifact[];
  readonly verification_commands: readonly VerificationCommand[];
  readonly required_capabilities: readonly string[];
  readonly supports_root_criteria?: readonly string[];
  /** #1638: typed coding marker. Present routes every attempt in this
   * contract lineage to the Pi executor; absent routes to Spin. */
  readonly workspace_alias?: string;
  readonly limits: {
    readonly max_duration_ms?: number;
    readonly max_tokens?: number;
    readonly max_cost?: number;
  };
  readonly provenance: ContractProvenance;
}

export interface VerificationObservation {
  readonly check_id: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly timed_out: boolean;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stdout_excerpt: string;
  readonly stderr_excerpt: string;
}

export interface ArtifactObservation {
  readonly artifact_id: string;
  readonly exists: boolean;
  readonly kind: ArtifactKind;
  readonly ref: string;
  readonly size?: number;
  readonly digest?: string;
  readonly error?: string;
}

export interface WorkerResultEnvelopeV1 {
  readonly schema_version: 1;
  readonly attempt: {
    readonly id: string;
    readonly ordinal: number;
    readonly contract_id: string;
    readonly contract_digest: string;
    readonly executor_kind: ExecutorKind;
    readonly executor_id: string;
    readonly started_at: string;
    readonly finished_at: string;
  };
  readonly outcome: WorkerOutcome;
  readonly criteria: readonly {
    readonly criterion_id: string;
    readonly status: CriterionStatus;
    readonly evidence_ids: readonly string[];
  }[];
  readonly checks: readonly VerificationObservation[];
  readonly artifacts: readonly ArtifactObservation[];
  readonly worker_report: {
    readonly summary: string;
    readonly claims: readonly { readonly criterion_id?: string; readonly text: string }[];
    readonly unresolved_risks: readonly string[];
  };
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly total_tokens?: number;
    readonly cost?: number;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
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
  | "traversal"
  | "shell_string"
  | "empty_string"
  | "bad_format";

export interface ValidationIssue {
  readonly severity: ValidationSeverity;
  readonly tag: ValidationTag;
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { ok: true; contract: WorkerAcceptanceContractV1 }
  | { ok: false; errors: readonly ValidationIssue[] };

export type NormalizeResult =
  | { ok: true; contract: WorkerAcceptanceContractV1 }
  | { ok: false; errors: readonly ValidationIssue[] };

function issue(severity: ValidationSeverity, tag: ValidationTag, path: string, message: string): ValidationIssue {
  return { severity, tag, path, message };
}

function error(tag: ValidationTag, path: string, message: string): ValidationIssue {
  return issue("error", tag, path, message);
}

function isShellString(s: string): boolean {
  return /[;&|`$(){}<>]/.test(s);
}

function hasTraversal(p: string): boolean {
  return p.includes("..") || p.startsWith("/");
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

export function computeEnvelopeDigest(envelope: Record<string, unknown>): string {
  const canonical = canonicalJson(sortedKeys(envelope));
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function errCollect<T>(arr: readonly T[], fn: (item: T, index: number) => readonly ValidationIssue[]): readonly ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (let i = 0; i < arr.length; i++) {
    out.push(...fn(arr[i]!, i));
  }
  return out;
}

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

  if (!isNonEmptyString(obj["goal"])) {
    errors.push(error("missing_field", "$.goal", "goal is required"));
  } else if ((obj["goal"] as string).length > MAX_GOAL_LENGTH) {
    errors.push(error("too_long", "$.goal", `goal exceeds ${MAX_GOAL_LENGTH} characters`));
  }

  const criterionIds = new Set<string>();
  const criteriaIndex = new Map<string, number>();

  if (!Array.isArray(obj["criteria"])) {
    errors.push(error("missing_field", "$.criteria", "criteria is required"));
  } else {
    if (obj["criteria"].length === 0) {
      errors.push(error("too_few", "$.criteria", "at least one criterion is required"));
    }
    if (obj["criteria"].length > MAX_CRITERIA_COUNT) {
      errors.push(error("too_many", "$.criteria", `criteria count exceeds ${MAX_CRITERIA_COUNT}`));
    }
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
      } else if (criterionIds.has(cObj["id"] as string)) {
        e.push(error("duplicate_id", `${path}.id`, `duplicate criterion id "${cObj["id"]}"`));
      } else {
        criterionIds.add(cObj["id"] as string);
        criteriaIndex.set(cObj["id"] as string, i);
      }
      if (!isNonEmptyString(cObj["description"])) {
        e.push(error("missing_field", `${path}.description`, "criterion description is required"));
      } else if ((cObj["description"] as string).length > MAX_CRITERION_DESC_LENGTH) {
        e.push(error("too_long", `${path}.description`, `description exceeds ${MAX_CRITERION_DESC_LENGTH} characters`));
      }
      return e;
    }));
  }

  const artifactRefs = new Set<string>();
  if (obj["expected_artifacts"] !== undefined) {
    if (!Array.isArray(obj["expected_artifacts"])) {
      errors.push(error("type_error", "$.expected_artifacts", "must be an array"));
    } else {
      if (obj["expected_artifacts"].length > MAX_ARTIFACTS_COUNT) {
        errors.push(error("too_many", "$.expected_artifacts", `artifacts count exceeds ${MAX_ARTIFACTS_COUNT}`));
      }
      const artifactIds = new Set<string>();
      errors.push(...errCollect(obj["expected_artifacts"] as unknown[], (a, i) => {
        const path = `$.expected_artifacts[${i}]`;
        const e: ValidationIssue[] = [];
        if (typeof a !== "object" || a === null) {
          e.push(error("type_error", path, "artifact must be an object"));
          return e;
        }
        const aObj = a as Record<string, unknown>;
        if (!isNonEmptyString(aObj["id"])) {
          e.push(error("missing_field", `${path}.id`, "artifact id is required"));
        } else if (artifactIds.has(aObj["id"] as string)) {
          e.push(error("duplicate_id", `${path}.id`, `duplicate artifact id "${aObj["id"]}"`));
        } else {
          artifactIds.add(aObj["id"] as string);
        }
        const kind = aObj["kind"];
        if (kind !== "file" && kind !== "directory" && kind !== "report" && kind !== "logical") {
          e.push(error("type_error", `${path}.kind`, `invalid kind "${String(kind)}"`));
        }
        if (!isNonEmptyString(aObj["ref"])) {
          e.push(error("missing_field", `${path}.ref`, "artifact ref is required"));
        } else {
          if ((aObj["ref"] as string).length > MAX_ARTIFACT_REF_LENGTH) {
            e.push(error("too_long", `${path}.ref`, `ref exceeds ${MAX_ARTIFACT_REF_LENGTH} characters`));
          }
          if (hasTraversal(aObj["ref"] as string)) {
            e.push(error("traversal", `${path}.ref`, "path traversal detected"));
          }
        }
        if (typeof aObj["required"] !== "boolean") {
          e.push(error("type_error", `${path}.required`, "required must be a boolean"));
        }
        if (aObj["criterion_ids"] !== undefined) {
          if (!Array.isArray(aObj["criterion_ids"])) {
            e.push(error("type_error", `${path}.criterion_ids`, "must be an array"));
          } else if (aObj["criterion_ids"].length > MAX_CRITERIA_IDS_PER_ITEM) {
            e.push(error("too_many", `${path}.criterion_ids`, `exceeds ${MAX_CRITERIA_IDS_PER_ITEM} criterion IDs`));
          } else if (criterionIds.size > 0) {
            for (const ref of aObj["criterion_ids"] as string[]) {
              if (!criterionIds.has(ref)) {
                e.push(error("bad_reference", `${path}.criterion_ids`, `unknown criterion id "${ref}"`));
              }
            }
          }
          if (aObj["required"] === true && Array.isArray(aObj["criterion_ids"])) {
            for (const ref of aObj["criterion_ids"] as string[]) {
              if (criterionIds.has(ref)) artifactRefs.add(ref);
            }
          }
        }
        return e;
      }));
    }
  }

  const cmdRefs = new Set<string>();
  if (obj["verification_commands"] !== undefined) {
    if (!Array.isArray(obj["verification_commands"])) {
      errors.push(error("type_error", "$.verification_commands", "must be an array"));
    } else {
      if (obj["verification_commands"].length > MAX_COMMANDS_COUNT) {
        errors.push(error("too_many", "$.verification_commands", `commands count exceeds ${MAX_COMMANDS_COUNT}`));
      }
      const cmdIds = new Set<string>();
      errors.push(...errCollect(obj["verification_commands"] as unknown[], (cmd, i) => {
        const path = `$.verification_commands[${i}]`;
        const e: ValidationIssue[] = [];
        if (typeof cmd !== "object" || cmd === null) {
          e.push(error("type_error", path, "command must be an object"));
          return e;
        }
        const cmdObj = cmd as Record<string, unknown>;
        if (!isNonEmptyString(cmdObj["id"])) {
          e.push(error("missing_field", `${path}.id`, "command id is required"));
        } else if (cmdIds.has(cmdObj["id"] as string)) {
          e.push(error("duplicate_id", `${path}.id`, `duplicate command id "${cmdObj["id"]}"`));
        } else {
          cmdIds.add(cmdObj["id"] as string);
        }
        if (!Array.isArray(cmdObj["argv"])) {
          e.push(error("missing_field", `${path}.argv`, "argv is required"));
        } else {
          if (cmdObj["argv"].length === 0) {
            e.push(error("too_few", `${path}.argv`, "argv must have at least one element"));
          }
          if (cmdObj["argv"].length > MAX_ARGS_COUNT) {
            e.push(error("too_many", `${path}.argv`, `argv exceeds ${MAX_ARGS_COUNT} elements`));
          }
          for (let j = 0; j < (cmdObj["argv"] as unknown[]).length; j++) {
            const arg = (cmdObj["argv"] as unknown[])[j];
            if (!isString(arg)) {
              e.push(error("type_error", `${path}.argv[${j}]`, "each argv element must be a string"));
            } else if (arg.length > MAX_ARGV_LENGTH) {
              e.push(error("too_long", `${path}.argv[${j}]`, `argv element exceeds ${MAX_ARGV_LENGTH} characters`));
            } else if (isShellString(arg)) {
              e.push(error("shell_string", `${path}.argv[${j}]`, "shell metacharacters are not allowed in argv"));
            }
          }
        }
        if (cmdObj["cwd"] !== undefined) {
          if (!isNonEmptyString(cmdObj["cwd"] as string)) {
            e.push(error("type_error", `${path}.cwd`, "cwd must be a non-empty string"));
          } else {
            const cwd = cmdObj["cwd"] as string;
            if (hasTraversal(cwd)) {
              e.push(error("traversal", `${path}.cwd`, "cwd must be a relative path without traversal"));
            }
            if (cwd.startsWith("/")) {
              e.push(error("bad_format", `${path}.cwd`, "cwd must be a relative path, not absolute"));
            }
          }
        }
        const timeoutMs = cmdObj["timeout_ms"];
        if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          e.push(error("type_error", `${path}.timeout_ms`, "timeout_ms must be a positive number"));
        } else if (timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
          e.push(error("out_of_range", `${path}.timeout_ms`, `timeout_ms exceeds ${MAX_COMMAND_TIMEOUT_MS}`));
        }
        if (cmdObj["criterion_ids"] !== undefined) {
          if (!Array.isArray(cmdObj["criterion_ids"])) {
            e.push(error("type_error", `${path}.criterion_ids`, "must be an array"));
          } else if (cmdObj["criterion_ids"].length > MAX_CRITERIA_IDS_PER_ITEM) {
            e.push(error("too_many", `${path}.criterion_ids`, `exceeds ${MAX_CRITERIA_IDS_PER_ITEM} criterion IDs`));
          } else if (criterionIds.size > 0) {
            for (const ref of cmdObj["criterion_ids"] as string[]) {
              if (!criterionIds.has(ref)) {
                e.push(error("bad_reference", `${path}.criterion_ids`, `unknown criterion id "${ref}"`));
              }
            }
          }
          if (Array.isArray(cmdObj["criterion_ids"])) {
            for (const ref of cmdObj["criterion_ids"] as string[]) {
              if (criterionIds.has(ref)) cmdRefs.add(ref);
            }
          }
        }
        return e;
      }));
    }
  }

  if (obj["required_capabilities"] !== undefined) {
    if (!Array.isArray(obj["required_capabilities"])) {
      errors.push(error("type_error", "$.required_capabilities", "must be an array"));
    } else {
      if (obj["required_capabilities"].length > MAX_CAPABILITIES_COUNT) {
        errors.push(error("too_many", "$.required_capabilities", `capabilities count exceeds ${MAX_CAPABILITIES_COUNT}`));
      }
      for (let i = 0; i < obj["required_capabilities"].length; i++) {
        const cap = (obj["required_capabilities"] as unknown[])[i];
        if (!isNonEmptyString(cap as string)) {
          errors.push(error("type_error", `$.required_capabilities[${i}]`, "each capability must be a non-empty string"));
        } else if ((cap as string).length > MAX_CAPABILITY_LENGTH) {
          errors.push(error("too_long", `$.required_capabilities[${i}]`, `capability exceeds ${MAX_CAPABILITY_LENGTH} characters`));
        }
      }
    }
  }

  if (obj["supports_root_criteria"] !== undefined) {
    if (!Array.isArray(obj["supports_root_criteria"])) {
      errors.push(error("type_error", "$.supports_root_criteria", "must be an array"));
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < (obj["supports_root_criteria"] as unknown[]).length; i++) {
        const ref = (obj["supports_root_criteria"] as unknown[])[i];
        if (!isNonEmptyString(ref as string)) {
          errors.push(error("type_error", `$.supports_root_criteria[${i}]`, "each root criterion id must be a non-empty string"));
        } else if (seen.has(ref as string)) {
          errors.push(error("duplicate_id", `$.supports_root_criteria[${i}]`, `duplicate root criterion id "${ref}"`));
        } else {
          seen.add(ref as string);
        }
      }
    }
  }

  // #1638: workspace_alias is a typed bounded identifier when present.
  if (obj["workspace_alias"] !== undefined && typeof obj["workspace_alias"] === "string") {
    const trimmed = (obj["workspace_alias"] as string).trim();
    if (trimmed.length === 0) {
      errors.push(error("bad_format", "$.workspace_alias", "workspace_alias must be non-empty when present"));
    } else if (!isValidWorkspaceAlias(trimmed)) {
      errors.push(error("bad_format", "$.workspace_alias", `invalid workspace_alias "${trimmed}" — bounded alias required (no separators, traversal, or control characters)`));
    }
  }

  if (obj["limits"] !== undefined) {
    if (typeof obj["limits"] !== "object" || obj["limits"] === null) {
      errors.push(error("type_error", "$.limits", "limits must be an object"));
    } else {
      const limits = obj["limits"] as Record<string, unknown>;
      if (limits["max_duration_ms"] !== undefined && (typeof limits["max_duration_ms"] !== "number" || !Number.isInteger(limits["max_duration_ms"] as number) || (limits["max_duration_ms"] as number) <= 0)) {
        errors.push(error("type_error", "$.limits.max_duration_ms", "must be a positive integer"));
      }
      if (limits["max_tokens"] !== undefined && (typeof limits["max_tokens"] !== "number" || !Number.isInteger(limits["max_tokens"] as number) || (limits["max_tokens"] as number) <= 0)) {
        errors.push(error("type_error", "$.limits.max_tokens", "must be a positive integer"));
      }
    }
  }

  if (obj["provenance"] !== undefined) {
    if (typeof obj["provenance"] !== "object" || obj["provenance"] === null) {
      errors.push(error("type_error", "$.provenance", "provenance must be an object"));
    } else {
      const prov = obj["provenance"] as Record<string, unknown>;
      if (typeof prov["root_card_id"] !== "number") {
        errors.push(error("type_error", "$.provenance.root_card_id", "root_card_id must be a number"));
      }
      if (typeof prov["card_id"] !== "number") {
        errors.push(error("type_error", "$.provenance.card_id", "card_id must be a number"));
      }
      if (!isNonEmptyString(prov["authored_by"])) {
        errors.push(error("missing_field", "$.provenance.authored_by", "authored_by is required"));
      }
      if (!isNonEmptyString(prov["created_at"])) {
        errors.push(error("missing_field", "$.provenance.created_at", "created_at is required"));
      }
    }
  } else {
    errors.push(error("missing_field", "$.provenance", "provenance is required for supervised workers"));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const contract = obj as unknown as WorkerAcceptanceContractV1;

  const jsonBytes = Buffer.byteLength(JSON.stringify(contract), "utf-8");
  if (jsonBytes > MAX_CONTRACT_JSON_BYTES) {
    errors.push(error("too_long", "$", `contract JSON exceeds ${MAX_CONTRACT_JSON_BYTES} bytes`));
    return { ok: false, errors };
  }

  // #1588: a declared criterion must have an evidence path — a verification
  // command referencing it or a required expected artifact referencing it.
  // The exact daily-ai defect (one criterion, zero commands, zero artifacts)
  // is rejected here at authoring time, never observed silently at review.
  // Runs last so earlier structural and size diagnostics stay primary.
  if (criterionIds.size > 0) {
    for (const id of criterionIds) {
      if (!cmdRefs.has(id) && !artifactRefs.has(id)) {
        errors.push(error("missing_field", `$.criteria[${criteriaIndex.get(id)}]`,
          `criterion ${id} has no evidence path: add a verification command or a required artifact`));
      }
    }
    if (errors.length > 0) {
      return { ok: false, errors };
    }
  }

  return { ok: true, contract };
}

export function createContractId(): string {
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  return "c_" + randomBytes(12).toString("hex");
}

export function createAttemptId(): string {
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  return "a_" + randomBytes(12).toString("hex");
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
  }));

  const expected_artifacts_raw = Array.isArray(obj["expected_artifacts"]) ? (obj["expected_artifacts"] as unknown[]) : [];
  const expected_artifacts = expected_artifacts_raw.map(a => ({
    id: (a as Record<string, unknown>)["id"] as string,
    kind: (a as Record<string, unknown>)["kind"] as string,
    ref: (a as Record<string, unknown>)["ref"] as string,
    required: (a as Record<string, unknown>)["required"] === true,
    criterion_ids: Array.isArray((a as Record<string, unknown>)["criterion_ids"]) ? (a as Record<string, unknown>)["criterion_ids"] as string[] : [],
  }));

  const verification_commands_raw = Array.isArray(obj["verification_commands"]) ? (obj["verification_commands"] as unknown[]) : [];
  const verification_commands = verification_commands_raw.map(c => ({
    id: (c as Record<string, unknown>)["id"] as string,
    argv: Array.isArray((c as Record<string, unknown>)["argv"]) ? (c as Record<string, unknown>)["argv"] as string[] : [],
    cwd: (c as Record<string, unknown>)["cwd"] as string | undefined,
    timeout_ms: (c as Record<string, unknown>)["timeout_ms"] as number ?? 30_000,
    criterion_ids: Array.isArray((c as Record<string, unknown>)["criterion_ids"]) ? (c as Record<string, unknown>)["criterion_ids"] as string[] : [],
  }));

  const capabilitiesRaw = Array.isArray(obj["required_capabilities"]) ? (obj["required_capabilities"] as string[]) : [];
  const supportsRootCriteriaRaw = Array.isArray(obj["supports_root_criteria"]) ? (obj["supports_root_criteria"] as string[]) : undefined;
  const workspaceAliasRaw = typeof obj["workspace_alias"] === "string" ? (obj["workspace_alias"] as string).trim() : undefined;
  const limitsRaw = (typeof obj["limits"] === "object" && obj["limits"] !== null) ? (obj["limits"] as Record<string, unknown>) : {};
  const provenanceRaw = (typeof obj["provenance"] === "object" && obj["provenance"] !== null) ? (obj["provenance"] as Record<string, unknown>) : undefined;

  const built: Record<string, unknown> = {
    schema_version: 1,
    id,
    digest: "",
    goal: typeof obj["goal"] === "string" ? obj["goal"] as string : "",
    criteria,
    expected_artifacts,
    verification_commands,
    required_capabilities: capabilitiesRaw,
    limits: Object.keys(limitsRaw).length > 0
      ? { max_duration_ms: limitsRaw["max_duration_ms"] as number | undefined, max_tokens: limitsRaw["max_tokens"] as number | undefined }
      : {},
    provenance: provenanceRaw
      ? {
          root_card_id: typeof provenanceRaw["root_card_id"] === "number" ? provenanceRaw["root_card_id"] as number : 0,
          card_id: typeof provenanceRaw["card_id"] === "number" ? provenanceRaw["card_id"] as number : 0,
          authored_by: typeof provenanceRaw["authored_by"] === "string" ? provenanceRaw["authored_by"] as string : "unknown",
          created_at: typeof provenanceRaw["created_at"] === "string" ? provenanceRaw["created_at"] as string : new Date().toISOString(),
        }
      : { root_card_id: 0, card_id: 0, authored_by: "unknown", created_at: new Date().toISOString() },
  };
  if (supportsRootCriteriaRaw !== undefined && supportsRootCriteriaRaw.length > 0) {
    built["supports_root_criteria"] = supportsRootCriteriaRaw;
  }
  // An explicitly present alias — even whitespace-only — must reach the
  // validator so "non-empty when present" is enforced, not silently dropped.
  if (workspaceAliasRaw !== undefined) {
    built["workspace_alias"] = workspaceAliasRaw;
  }

  const digest = computeDigest(built);
  built["digest"] = digest;

  const validated = validateContract(built);
  if (!validated.ok) return validated;

  return { ok: true, contract: built as unknown as WorkerAcceptanceContractV1 };
}

export function validateEnvelope(raw: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: [error("type_error", "$", "envelope must be an object")] };
  }

  const obj = raw as Record<string, unknown>;

  if (obj["schema_version"] !== 1) {
    errors.push(error("unknown_version", "$.schema_version", `unsupported schema_version: ${String(obj["schema_version"])}`));
    return { ok: false, errors };
  }

  const attempt = obj["attempt"];
  if (typeof attempt !== "object" || attempt === null) {
    errors.push(error("missing_field", "$.attempt", "attempt info is required"));
  } else {
    const a = attempt as Record<string, unknown>;
    if (!isNonEmptyString(a["id"])) errors.push(error("missing_field", "$.attempt.id", "attempt id is required"));
    if (typeof a["ordinal"] !== "number") errors.push(error("type_error", "$.attempt.ordinal", "ordinal must be a number"));
    if (!isNonEmptyString(a["contract_id"])) errors.push(error("missing_field", "$.attempt.contract_id", "contract_id is required"));
    if (!isNonEmptyString(a["contract_digest"])) errors.push(error("missing_field", "$.attempt.contract_digest", "contract_digest is required"));
    const ek = a["executor_kind"];
    if (ek !== "agent" && ek !== "pi" && ek !== "remote") errors.push(error("type_error", "$.attempt.executor_kind", 'must be "agent", "pi" or "remote"'));
    if (!isNonEmptyString(a["executor_id"])) errors.push(error("missing_field", "$.attempt.executor_id", "executor_id is required"));
    if (!isNonEmptyString(a["started_at"])) errors.push(error("missing_field", "$.attempt.started_at", "started_at is required"));
    if (!isNonEmptyString(a["finished_at"])) errors.push(error("missing_field", "$.attempt.finished_at", "finished_at is required"));
  }

  const validOutcomes: WorkerOutcome[] = ["completed", "failed", "cancelled", "timed_out"];
  if (!validOutcomes.includes(obj["outcome"] as WorkerOutcome)) {
    errors.push(error("type_error", "$.outcome", `invalid outcome "${String(obj["outcome"])}"`));
  }

  const validStatuses: CriterionStatus[] = ["passed", "failed", "not_run", "inconclusive"];
  const criteriaArr = obj["criteria"];
  if (!Array.isArray(criteriaArr)) {
    errors.push(error("missing_field", "$.criteria", "criteria results are required"));
  } else {
    for (let i = 0; i < criteriaArr.length; i++) {
      const c = criteriaArr[i] as Record<string, unknown> | undefined;
      if (!c || typeof c !== "object") {
        errors.push(error("type_error", `$.criteria[${i}]`, "each criterion result must be an object"));
        continue;
      }
      if (!isNonEmptyString(c["criterion_id"])) {
        errors.push(error("missing_field", `$.criteria[${i}].criterion_id`, "criterion_id is required"));
      }
      if (!validStatuses.includes(c["status"] as CriterionStatus)) {
        errors.push(error("type_error", `$.criteria[${i}].status`, `invalid status "${String(c["status"])}"`));
      }
      if (c["evidence_ids"] !== undefined && (!Array.isArray(c["evidence_ids"]) || !(c["evidence_ids"] as unknown[]).every(isNonEmptyString))) {
        errors.push(error("type_error", `$.criteria[${i}].evidence_ids`, "evidence_ids must be an array of strings"));
      }
    }
  }

  // Build the set of known check and artifact IDs for evidence link validation
  const knownCheckIds = new Set<string>();
  const checksArr = obj["checks"];
  if (!Array.isArray(checksArr)) {
    errors.push(error("missing_field", "$.checks", "checks are required"));
  } else {
    for (let i = 0; i < checksArr.length; i++) {
      const ch = checksArr[i] as Record<string, unknown> | undefined;
      if (!ch || typeof ch !== "object") {
        errors.push(error("type_error", `$.checks[${i}]`, "each check must be an object"));
        continue;
      }
      if (!isNonEmptyString(ch["check_id"])) {
        errors.push(error("missing_field", `$.checks[${i}].check_id`, "check_id is required"));
      } else {
        knownCheckIds.add(ch["check_id"] as string);
      }
      if (!Array.isArray(ch["argv"]) || !(ch["argv"] as unknown[]).every(isString)) {
        errors.push(error("type_error", `$.checks[${i}].argv`, "argv must be an array of strings"));
      }
      if (typeof ch["exit_code"] !== "number" && ch["exit_code"] !== null) {
        errors.push(error("type_error", `$.checks[${i}].exit_code`, "exit_code must be a number or null"));
      }
      if (typeof ch["timed_out"] !== "boolean") {
        errors.push(error("type_error", `$.checks[${i}].timed_out`, "timed_out must be a boolean"));
      }
    }
  }

  const knownArtifactIds = new Set<string>();
  const artifactsArr = obj["artifacts"];
  if (!Array.isArray(artifactsArr)) {
    errors.push(error("missing_field", "$.artifacts", "artifacts are required"));
  } else {
    for (let i = 0; i < artifactsArr.length; i++) {
      const a = artifactsArr[i] as Record<string, unknown> | undefined;
      if (!a || typeof a !== "object") {
        errors.push(error("type_error", `$.artifacts[${i}]`, "each artifact must be an object"));
        continue;
      }
      if (!isNonEmptyString(a["artifact_id"])) {
        errors.push(error("missing_field", `$.artifacts[${i}].artifact_id`, "artifact_id is required"));
      } else {
        knownArtifactIds.add(a["artifact_id"] as string);
      }
      if (typeof a["exists"] !== "boolean") {
        errors.push(error("type_error", `$.artifacts[${i}].exists`, "exists must be a boolean"));
      }
    }
  }

  // Validate evidence_ids reference known check or artifact IDs
  if (criteriaArr && Array.isArray(criteriaArr)) {
    for (let i = 0; i < criteriaArr.length; i++) {
      const c = criteriaArr[i] as Record<string, unknown> | undefined;
      if (!c || !Array.isArray(c["evidence_ids"])) continue;
      for (let j = 0; j < (c["evidence_ids"] as unknown[]).length; j++) {
        const eid = (c["evidence_ids"] as unknown[])[j] as string;
        if (!knownCheckIds.has(eid) && !knownArtifactIds.has(eid)) {
          errors.push(error("bad_reference", `$.criteria[${i}].evidence_ids[${j}]`, `unknown evidence id "${eid}"`));
        }
      }
    }
  }

  const wr = obj["worker_report"];
  if (typeof wr !== "object" || wr === null) {
    errors.push(error("missing_field", "$.worker_report", "worker_report is required"));
  } else {
    const wrObj = wr as Record<string, unknown>;
    if (typeof wrObj["summary"] !== "string") {
      errors.push(error("type_error", "$.worker_report.summary", "summary must be a string"));
    }
    if (!Array.isArray(wrObj["claims"])) {
      errors.push(error("missing_field", "$.worker_report.claims", "claims are required"));
    }
    if (wrObj["unresolved_risks"] !== undefined && !Array.isArray(wrObj["unresolved_risks"])) {
      errors.push(error("type_error", "$.worker_report.unresolved_risks", "unresolved_risks must be an array"));
    }
  }

  // Validate usage if present
  if (obj["usage"] !== undefined) {
    if (typeof obj["usage"] !== "object" || obj["usage"] === null) {
      errors.push(error("type_error", "$.usage", "usage must be an object"));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const jsonBytes = Buffer.byteLength(JSON.stringify(obj), "utf-8");
  if (jsonBytes > MAX_ENVELOPE_JSON_BYTES) {
    errors.push(error("too_long", "$", `envelope JSON exceeds ${MAX_ENVELOPE_JSON_BYTES} bytes`));
    return { ok: false, errors };
  }

  return { ok: true, contract: obj as unknown as WorkerAcceptanceContractV1 };
}

export function findErrorsForPath(errors: readonly ValidationIssue[], pathPrefix: string): ValidationIssue[] {
  return errors.filter(e => e.path.startsWith(pathPrefix));
}

export function redactEnvelope(envelope: WorkerResultEnvelopeV1): WorkerResultEnvelopeV1 {
  const redactedChecks = envelope.checks.map(c => ({
    ...c,
    stdout_excerpt: c.stdout_excerpt.length > 500 ? c.stdout_excerpt.slice(0, 500) + "..." : c.stdout_excerpt,
    stderr_excerpt: c.stderr_excerpt.length > 500 ? c.stderr_excerpt.slice(0, 500) + "..." : c.stderr_excerpt,
  }));
  return {
    ...envelope,
    checks: redactedChecks,
    worker_report: {
      summary: envelope.worker_report.summary.slice(0, 500),
      claims: envelope.worker_report.claims.slice(0, 10),
      unresolved_risks: envelope.worker_report.unresolved_risks.slice(0, 5),
    },
  };
}
