/**
 * config-validator.ts — lightweight shape validation for JSON config files (#434).
 * No external deps. Logs warnings, never throws. Boot continues with best-effort.
 */

import { logWarn } from "./logger.js";

const TAG = "config";

type FieldType = "string" | "number" | "boolean" | "object" | "array";

export interface FieldSpec {
  path: string;
  type: FieldType;
  required?: boolean;
}

function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function checkType(val: unknown, expected: FieldType): boolean {
  if (expected === "array") return Array.isArray(val);
  if (expected === "object") return val !== null && typeof val === "object" && !Array.isArray(val);
  return typeof val === expected;
}

export function validateShape(config: unknown, specs: FieldSpec[], filename: string): string[] {
  const errors: string[] = [];
  for (const spec of specs) {
    const val = getPath(config, spec.path);
    if (val === undefined || val === null) {
      if (spec.required) errors.push(`${spec.path} is required`);
    } else if (!checkType(val, spec.type)) {
      errors.push(`${spec.path} must be ${spec.type}, got ${Array.isArray(val) ? "array" : typeof val}`);
    }
  }
  if (errors.length > 0) {
    for (const e of errors) logWarn(TAG, `${filename}: ${e}`);
  }
  return errors;
}

// ── Schema specs for each config file ───────────────────────────────────────

export const TRANSPORT_SCHEMA: FieldSpec[] = [
  { path: "agents", type: "object", required: true },
  { path: "providers", type: "object", required: true },
];

export const MODELS_SCHEMA: FieldSpec[] = [
  // models.json is a Record<string, ModelEntry> — just check it's an object
];

export const IRC_SCHEMA: FieldSpec[] = [
  { path: "servers", type: "array", required: true },
];

export const PEERS_SCHEMA: FieldSpec[] = [
  { path: "self", type: "object", required: true },
  { path: "self.name", type: "string", required: true },
  { path: "peers", type: "object", required: true },
];

export const USERS_SCHEMA: FieldSpec[] = [
  { path: "users", type: "array", required: true },
];
