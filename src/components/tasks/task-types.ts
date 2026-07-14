/**
 * task-types.ts — task entry model, validation, and normalization.
 *
 * Owns `CronEntry` (moved out of src/cli/abtars-task.ts per #1321) so the tasks
 * component is the single owner of task data shapes. The CLI, checker, store,
 * queue, dashboard/status, and commands import from here — never from the CLI.
 *
 * #1321 adds the allowlisted in-process `system` executor with one action,
 * `sleep-cycle`. A system entry is data, not code: it cannot carry a command,
 * path, arguments, environment, or arbitrary payload. Validation at the store
 * boundary guarantees a malformed system entry is quarantined/skipped and never
 * falls through to agent/script/orc execution.
 */

import { randomBytes } from "node:crypto";
import { CronExpressionParser } from "cron-parser";

// ── Executors + system actions ──────────────────────────────────────────────

export type TaskExecutor = "agent" | "script" | "orc" | "system";

/** Allowlisted in-process actions. #1321 ships exactly one. #1322 adds hardware-sleep. */
export type SystemTaskAction = "sleep-cycle" | "hardware-sleep";

/** Compile-time allowlist of valid system actions. */
export const SYSTEM_ACTIONS: readonly SystemTaskAction[] = ["sleep-cycle", "hardware-sleep"];

/**
 * Command-like fields that are forbidden on a `system` entry. A system task is
 * an allowlisted bridge operation — task JSON may not supply its own code.
 */
const SYSTEM_FORBIDDEN_FIELDS = [
  "command", "args", "taskFile", "agent", "agentMessage",
  "agentFollowUp", "skill", "env", "environment",
] as const;

// ── CronEntry ───────────────────────────────────────────────────────────────

/**
 * A single scheduled task entry. Persisted in ~/.abtars/tasks/tasks.json.
 *
 * `executor` selects the routing path:
 *   - "agent"  → Spin session dispatch (default when omitted, for back-compat)
 *   - "script" → shell spawn
 *   - "orc"    → Orc project dispatch
 *   - "system" → allowlisted in-process action (#1321); `action` is required
 *
 * For non-system entries `message` is the executable payload (agent goal /
 * script command / reminder text) and is required. For `system` entries
 * `message` is display-only metadata and is never executed.
 */
export interface CronEntry {
  id: string;
  title?: string;
  fireAt: number;
  message: string;
  chatId: number;
  type: "reminder" | "task";
  executor?: TaskExecutor;
  /** Required for `executor: "system"`. Ignored otherwise. */
  action?: SystemTaskAction;
  /** #1322 — Hardware-sleep action-specific fields. Ignored for non-system entries. */
  idleMinutes?: number;
  retryMinutes?: number;
  latestLocalTime?: string;
  expectedWakeTime?: string;
  schedule?: string;
  /** hours: max delay after fireAt before skipping to next. 0 = no catch-up. */
  catchUp?: number;
  priority?: "high" | "medium" | "low";
  taskFile?: string;
  targetUserId?: string;
  agent?: string;
  deliveryMethod?: "inline" | "report";
  deliveryMode?: "silent" | "deliver" | "announce";
  maxToolRounds?: number;
  paused?: boolean;
  maxRunsPerDay?: number;
  consecutiveFails?: number;
  agentFollowUp?: boolean;
  agentMessage?: string;
  fired: boolean;
  createdAt: number;
  lastRanAt?: number;
  retryAfter?: number;
  _prevFireAt?: number;
  _retrying?: boolean;
  history?: { ts: number; exitCode?: number }[];
}

/** Type guard: entry routes through the allowlisted in-process system executor. */
export function isSystemEntry(entry: CronEntry): entry is CronEntry & { executor: "system"; action: SystemTaskAction } {
  return entry.executor === "system";
}

// ── Normalization + validation ──────────────────────────────────────────────

export type NormalizeResult =
  | { ok: true; entry: CronEntry }
  | { ok: false; error: string; id?: string };

/**
 * Normalize a raw JSON entry against the task model.
 *
 * Templates omit runtime bookkeeping fields; this supplies them deterministically
 * before the entry can be checked or queued:
 *   - recurring entries without `fireAt` derive it from `schedule`
 *   - all entries default `fired=false` and `createdAt=now` when absent
 *
 * Validation then enforces executor-specific shape so an invalid entry is
 * rejected closed rather than silently routed as an agent task. Returns a safe
 * diagnostic on failure; the store quarantines/skips the offending entry.
 */
export function normalize(raw: unknown, now: number = Date.now()): NormalizeResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "entry is not an object" };
  }
  const e = raw as Record<string, unknown>;
  const id = typeof e["id"] === "string" ? (e["id"] as string) : undefined;

  // ── id ──
  if (!id || !id.trim()) {
    return { ok: false, error: "missing/empty id", id };
  }

  // ── type ──
  const type = e["type"];
  if (type !== "reminder" && type !== "task") {
    return { ok: false, error: `invalid type "${String(type)}" (expected reminder|task)`, id };
  }

  // ── executor (default agent for back-compat) ──
  const executorRaw = e["executor"];
  const executor: TaskExecutor =
    executorRaw === "script" || executorRaw === "orc" || executorRaw === "system"
      ? executorRaw
      : "agent";

  // ── schedule / fireAt ──
  const schedule = typeof e["schedule"] === "string" ? (e["schedule"] as string) : undefined;
  let fireAt = typeof e["fireAt"] === "number" ? (e["fireAt"] as number) : NaN;

  if (schedule) {
    try {
      CronExpressionParser.parse(schedule); // validate expression shape
    } catch {
      return { ok: false, error: `invalid schedule "${schedule}"`, id };
    }
    if (!Number.isFinite(fireAt)) {
      try {
        fireAt = CronExpressionParser.parse(schedule).next().getTime();
      } catch {
        return { ok: false, error: `cannot derive fireAt from schedule "${schedule}"`, id };
      }
    }
  } else if (!Number.isFinite(fireAt)) {
    return { ok: false, error: "missing fireAt and no schedule to derive it from", id };
  }

  // ── fired / createdAt defaults for template entries ──
  const fired = e["fired"] === true;
  const createdAt = typeof e["createdAt"] === "number" ? (e["createdAt"] as number) : now;

  // ── executor-specific validation ──
  if (executor === "system") {
    const result = validateSystemEntry(e, id);
    if (!result.ok) return result;
    const action = result.action;

    // System entries are allowlisted bridge ops — reject any command-like field.
    for (const field of SYSTEM_FORBIDDEN_FIELDS) {
      if (e[field] !== undefined) {
        return { ok: false, error: `system entry must not carry "${field}"`, id };
      }
    }

    // #1322 — Validate hardware-sleep action-specific fields.
    if (action === "hardware-sleep") {
      const idle = e["idleMinutes"];
      if (idle !== undefined && (typeof idle !== "number" || !Number.isInteger(idle) || idle < 1 || idle > 240)) {
        return { ok: false, error: `hardware-sleep idleMinutes must be an integer 1-240`, id };
      }
      const retry = e["retryMinutes"];
      if (retry !== undefined && (typeof retry !== "number" || !Number.isInteger(retry) || retry < 1 || retry > 60)) {
        return { ok: false, error: `hardware-sleep retryMinutes must be an integer 1-60`, id };
      }
      if (e["latestLocalTime"] !== undefined && !/^\d{2}:\d{2}$/.test(e["latestLocalTime"] as string)) {
        return { ok: false, error: `hardware-sleep latestLocalTime must be HH:mm format`, id };
      }
      if (e["expectedWakeTime"] !== undefined && !/^\d{2}:\d{2}$/.test(e["expectedWakeTime"] as string)) {
        return { ok: false, error: `hardware-sleep expectedWakeTime must be HH:mm format`, id };
      }
    }

    // Build the normalized system entry. message is display-only and optional.
    const chatId = typeof e["chatId"] === "number" ? (e["chatId"] as number) : 0;
    const message = typeof e["message"] === "string" ? (e["message"] as string) : "";
    return {
      ok: true,
      entry: {
        ...stripBookkeeping(e),
        id, type, executor: "system", action,
        fireAt, fired, createdAt, schedule,
        chatId, message,
      },
    };
  }

  // ── non-system entries: message + chatId required ──
  const message = typeof e["message"] === "string" ? (e["message"] as string) : "";
  if (!message) {
    return { ok: false, error: `--message is required for ${executor} entries`, id };
  }
  if (typeof e["chatId"] !== "number" || !Number.isFinite(e["chatId"] as number)) {
    return { ok: false, error: `--chat-id is required for ${executor} entries`, id };
  }

  return {
    ok: true,
    entry: {
      ...stripBookkeeping(e),
      id, type, executor,
      fireAt, fired, createdAt, schedule,
      message, chatId: e["chatId"] as number,
    },
  };
}

/** Validate a system entry's action against the allowlist. */
function validateSystemEntry(e: Record<string, unknown>, id: string):
  | { ok: true; action: SystemTaskAction }
  | { ok: false; error: string; id?: string } {
  const action = e["action"];
  if (typeof action !== "string") {
    return { ok: false, error: "system entry requires --action", id };
  }
  if (!SYSTEM_ACTIONS.includes(action as SystemTaskAction)) {
    return { ok: false, error: `unknown system action "${action}" (allowlist: ${SYSTEM_ACTIONS.join(", ")})`, id };
  }
  return { ok: true, action: action as SystemTaskAction };
}

/**
 * Carry forward optional, user-editable fields from the raw entry. Bookkeeping
 * fields (fired/createdAt/fireAt) are always set explicitly by normalize().
 */
function stripBookkeeping(e: Record<string, unknown>): Partial<CronEntry> {
  const out: Partial<CronEntry> = {};
  const carry: (keyof CronEntry)[] = [
    "title", "catchUp", "priority", "taskFile", "targetUserId", "agent",
    "deliveryMethod", "deliveryMode", "maxToolRounds", "paused", "maxRunsPerDay",
    "consecutiveFails", "agentFollowUp", "agentMessage", "lastRanAt", "retryAfter",
    "_prevFireAt", "_retrying", "history",
    "idleMinutes", "retryMinutes", "latestLocalTime", "expectedWakeTime",
  ];
  for (const k of carry) {
    if (e[k as string] !== undefined) {
      // @ts-expect-error — indexed assignment of validated optional fields
      out[k] = e[k as string];
    }
  }
  return out;
}

// ── ID generation (shared with CLI) ─────────────────────────────────────────

/** Generate a short random hex ID for a new entry. */
export function newTaskId(): string {
  return randomBytes(3).toString("hex");
}
