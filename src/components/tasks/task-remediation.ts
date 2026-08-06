/**
 * task-remediation.ts — #1588: bounded self-healer remediation on task
 * settings. Autonomous writes are limited to a whitelist with hard ceilings,
 * budget fields are increase-only, every accepted change appends an audit row,
 * and anything credential- or schedule-shaped escalates instead of guessing.
 * Mutations go through task-store readEntry/writeEntry — never a shell-out —
 * so the whitelist, ceilings, and audit are enforced in one place.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { readEntry, writeEntry } from "./task-store.js";
import { logWarn } from "../logger.js";

const TAG = "task-remediation";

export interface RemediationAuditRow {
  readonly at: string;
  readonly taskId: string;
  readonly field: string;
  readonly from?: number;
  readonly to?: number;
  readonly actor: "sha";
  readonly diagnosticCode?: string;
  readonly accepted: boolean;
  readonly reason?: string;
}

/** Autonomous whitelist with hard ceilings. Anything not listed is refused. */
export const REMEDIATION_CEILINGS: Readonly<Record<string, number>> = {
  maxToolRounds: 32,
  "report.minBytes": 4096,
  "orchestration.laneDurationMs": 900000,
};

/** Never adjusted autonomously — always escalate. */
export const FORBIDDEN_FIELDS: readonly string[] = [
  "schedule",
  "enabled",
  "orchestration.maxAgents",
  "chatId",
  "agent",
  "taskFile",
  "delivery",
];

export const REMEDIATION_AUDIT_PATH = (): string => join(abtarsHome(), "tasks", "remediation-audit.jsonl");

export type RemediationResult =
  | { ok: true; message: string }
  | { ok: false; reason: string };

function appendAudit(row: RemediationAuditRow): void {
  try {
    mkdirSync(join(abtarsHome(), "tasks"), { recursive: true });
    appendFileSync(REMEDIATION_AUDIT_PATH(), JSON.stringify(row) + "\n", "utf-8");
  } catch (err) {
    logWarn(TAG, `audit write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * #1588: single task, single field. Budget fields (maxToolRounds,
 * orchestration.laneDurationMs) are increase-only toward success and capped;
 * the report.minBytes threshold may move within its ceiling. Returns the
 * before/after in the audit row.
 */
export function remediateAdjust(taskId: string, field: string, value: number, diagnosticCode?: string): RemediationResult {
  const at = new Date().toISOString();
  const ceiling = REMEDIATION_CEILINGS[field];
  if (ceiling === undefined) {
    appendAudit({ at, taskId, field, actor: "sha", diagnosticCode, accepted: false, reason: "field not whitelisted" });
    return { ok: false, reason: `field "${field}" is not autonomously adjustable` };
  }
  if (!Number.isInteger(value) || value < 1) {
    appendAudit({ at, taskId, field, actor: "sha", diagnosticCode, accepted: false, reason: "value must be a positive integer" });
    return { ok: false, reason: "value must be a positive integer" };
  }
  if (value > ceiling) {
    appendAudit({ at, taskId, field, actor: "sha", diagnosticCode, accepted: false, reason: `value ${value} exceeds ceiling ${ceiling}` });
    return { ok: false, reason: `value ${value} exceeds the hard ceiling of ${ceiling} for "${field}"` };
  }

  const entry = readEntry(taskId);
  if (!entry) {
    appendAudit({ at, taskId, field, actor: "sha", diagnosticCode, accepted: false, reason: "task not found" });
    return { ok: false, reason: `task "${taskId}" not found` };
  }
  if (entry.kind !== "agent") {
    appendAudit({ at, taskId, field, actor: "sha", diagnosticCode, accepted: false, reason: `task is kind ${entry.kind}, not agent` });
    return { ok: false, reason: `"${field}" only applies to agent tasks` };
  }

  const budgetFields = new Set(["maxToolRounds", "orchestration.laneDurationMs"]);
  let from: number | undefined;
  if (field === "maxToolRounds") {
    from = entry.maxToolRounds;
    if (budgetFields.has(field) && from !== undefined && value <= from) {
      appendAudit({ at, taskId, field, from, to: value, actor: "sha", diagnosticCode, accepted: false, reason: "budget decrease refused" });
      return { ok: false, reason: `budget fields are increase-only; ${from} -> ${value} would shrink the budget` };
    }
    const updated = { ...entry, maxToolRounds: value };
    writeEntry(updated);
    appendAudit({ at, taskId, field, from, to: value, actor: "sha", diagnosticCode, accepted: true });
    return { ok: true, message: `adjusted ${taskId} ${field}: ${from ?? "unset"} -> ${value}` };
  }
  if (field === "report.minBytes") {
    if (!entry.report) {
      appendAudit({ at, taskId, field, actor: "sha", diagnosticCode, accepted: false, reason: "task has no report contract" });
      return { ok: false, reason: `"${taskId}" has no report contract` };
    }
    if (value < 100) {
      appendAudit({ at, taskId, field, from: entry.report.minBytes, to: value, actor: "sha", diagnosticCode, accepted: false, reason: "below the 100-byte report floor" });
      return { ok: false, reason: "report.minBytes cannot go below the 100-byte floor" };
    }
    from = entry.report.minBytes;
    const updated = { ...entry, report: { ...entry.report, minBytes: value } };
    writeEntry(updated);
    appendAudit({ at, taskId, field, from, to: value, actor: "sha", diagnosticCode, accepted: true });
    return { ok: true, message: `adjusted ${taskId} ${field}: ${from} -> ${value}` };
  }
  if (field === "orchestration.laneDurationMs") {
    from = entry.orchestration.laneDurationMs;
    if (from !== undefined && value <= from) {
      appendAudit({ at, taskId, field, from, to: value, actor: "sha", diagnosticCode, accepted: false, reason: "budget decrease refused" });
      return { ok: false, reason: `budget fields are increase-only; ${from} -> ${value} would shrink the budget` };
    }
    const updated = { ...entry, orchestration: { maxAgents: entry.orchestration.maxAgents, laneDurationMs: value } };
    writeEntry(updated);
    appendAudit({ at, taskId, field, from, to: value, actor: "sha", diagnosticCode, accepted: true });
    return { ok: true, message: `adjusted ${taskId} ${field}: ${from ?? "unset"} -> ${value}` };
  }
  appendAudit({ at, taskId, field, actor: "sha", diagnosticCode, accepted: false, reason: "field not adjustable" });
  return { ok: false, reason: `field "${field}" is not adjustable` };
}

/**
 * #1588: escalates a concrete human ask (e.g. a fresh auth cookie). Mutates
 * nothing; records the ask in the audit trail and returns the ask for
 * notification to aksika.
 */
export function remediateEscalate(taskId: string, ask: string, diagnosticCode?: string): RemediationResult {
  const boundedAsk = ask.slice(0, 500);
  appendAudit({
    at: new Date().toISOString(),
    taskId,
    field: "escalate",
    actor: "sha",
    diagnosticCode,
    accepted: true,
    reason: boundedAsk,
  });
  return { ok: true, message: `Escalated: "${taskId}" requires human intervention: ${boundedAsk}` };
}

export function readRemediationAudit(): RemediationAuditRow[] {
  const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const p = REMEDIATION_AUDIT_PATH();
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RemediationAuditRow);
  } catch {
    return [];
  }
}
