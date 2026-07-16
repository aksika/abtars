
import { CronExpressionParser } from "cron-parser";

export type Delivery = "report" | "announce" | "silent";

export interface SchedulePolicy {
  schedule?: string;
  at?: string;
  catchUpHours?: number;
  maxRunsPerDay?: number;
}

export type SystemTaskAction = "sleep-cycle" | "hardware-sleep";

export const SYSTEM_ACTIONS: readonly SystemTaskAction[] = ["sleep-cycle", "hardware-sleep"];

interface TaskBase extends SchedulePolicy {
  id: string;
  enabled: boolean;
  priority: "high" | "medium" | "low";
  chatId?: string;
  delivery: Delivery;
}

export type ScheduledTask =
  | (TaskBase & {
      kind: "reminder";
      text: string;
      delivery: "announce";
    })
  | (TaskBase & {
      kind: "agent";
      prompt?: string;
      taskFile?: string;
      agent?: "task" | "professor" | "browsie" | "coding" | "dreamy";
      maxToolRounds?: number;
      targetUserId?: string;
    })
  | (TaskBase & {
      kind: "script";
      command: string;
      followUp?: { prompt: string; agent?: string };
    })
  | (TaskBase & {
      kind: "orc";
      goal: string;
    })
  | (TaskBase & {
      kind: "system";
      action: SystemTaskAction;
      options?: {
        idleMinutes?: number;
        retryMinutes?: number;
        latestLocalTime?: string;
        expectedWakeTime?: string;
      };
      delivery: "silent";
    });

export type TaskKind = ScheduledTask["kind"];

const SYSTEM_FORBIDDEN_FIELDS = [
  "command", "args", "taskFile", "agent", "agentMessage",
  "agentFollowUp", "skill", "env", "environment",
] as const;

export type NormalizeResult =
  | { ok: true; entry: ScheduledTask }
  | { ok: false; error: string; id?: string };

function parsePriority(raw: unknown): "high" | "medium" | "low" {
  if (raw === "high" || raw === "low") return raw;
  return "medium";
}

export function normalize(raw: unknown, _now: number = Date.now()): NormalizeResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "entry is not an object" };
  }
  const e = raw as Record<string, unknown>;
  const id = typeof e["id"] === "string" ? (e["id"] as string) : undefined;
  if (!id || !id.trim()) {
    return { ok: false, error: "missing/empty id", id };
  }

  const kind = e["kind"];
  if (typeof kind !== "string") {
    return { ok: false, error: `missing kind`, id };
  }

  const schedule = typeof e["schedule"] === "string" ? e["schedule"] as string : undefined;
  if (schedule) {
    try { CronExpressionParser.parse(schedule); } catch {
      return { ok: false, error: `invalid schedule "${schedule}"`, id };
    }
  }
  const at = typeof e["at"] === "string" ? e["at"] as string : undefined;
  if (!schedule && !at) {
    return { ok: false, error: "exactly one of schedule or at is required", id };
  }
  if (schedule && at) {
    return { ok: false, error: "only one of schedule or at may be set", id };
  }

  const enabled = e["enabled"] !== false;
  const priority = parsePriority(e["priority"]);
  const chatId = typeof e["chatId"] === "string" ? e["chatId"] : undefined;
  const delivery = e["delivery"];

  const base: TaskBase = {
    id, enabled, priority, chatId,
    delivery: delivery as Delivery,
    schedule, at,
    catchUpHours: typeof e["catchUpHours"] === "number" ? e["catchUpHours"] as number : undefined,
    maxRunsPerDay: typeof e["maxRunsPerDay"] === "number" ? e["maxRunsPerDay"] as number : undefined,
  };

  switch (kind) {
    case "reminder": {
      const text = typeof e["text"] === "string" ? e["text"] : "";
      if (!text) return { ok: false, error: "text is required for reminder", id };
      if (delivery !== "announce") return { ok: false, error: "reminder delivery must be announce", id };
      return { ok: true, entry: { ...base, kind: "reminder", text, delivery: "announce" } };
    }
    case "agent": {
      const taskFile = typeof e["taskFile"] === "string" ? e["taskFile"] : undefined;
      const prompt = typeof e["prompt"] === "string" ? e["prompt"] : undefined;
      const agentRaw = e["agent"];
      const agent = typeof agentRaw === "string" && ["task", "professor", "browsie", "coding", "dreamy"].includes(agentRaw)
        ? agentRaw as "task" | "professor" | "browsie" | "coding" | "dreamy" : undefined;
      const maxToolRounds = typeof e["maxToolRounds"] === "number" ? e["maxToolRounds"] as number : undefined;
      const targetUserId = typeof e["targetUserId"] === "string" ? e["targetUserId"] : undefined;
      return {
        ok: true,
        entry: { ...base, kind: "agent", prompt, taskFile, agent, maxToolRounds, targetUserId },
      };
    }
    case "script": {
      const command = typeof e["command"] === "string" ? e["command"] : "";
      if (!command) return { ok: false, error: "command is required for script", id };
      const followUpRaw = e["followUp"];
      const followUp = followUpRaw && typeof followUpRaw === "object" ? followUpRaw as { prompt: string; agent?: string } : undefined;
      return { ok: true, entry: { ...base, kind: "script", command, followUp } };
    }
    case "orc": {
      const goal = typeof e["goal"] === "string" ? e["goal"] : "";
      if (!goal) return { ok: false, error: "goal is required for orc", id };
      return { ok: true, entry: { ...base, kind: "orc", goal } };
    }
    case "system": {
      const action = e["action"];
      if (typeof action !== "string" || !SYSTEM_ACTIONS.includes(action as SystemTaskAction)) {
        return { ok: false, error: `unknown system action "${String(action)}"`, id };
      }
      if (delivery !== "silent") return { ok: false, error: "system delivery must be silent", id };
      for (const field of SYSTEM_FORBIDDEN_FIELDS) {
        if (e[field] !== undefined) return { ok: false, error: `system entry must not carry "${field}"`, id };
      }
      if (action === "hardware-sleep") {
        const idle = e["options"] && typeof e["options"] === "object"
          ? (e["options"] as Record<string, unknown>)["idleMinutes"] : undefined;
        if (idle !== undefined && (typeof idle !== "number" || !Number.isInteger(idle) || idle < 1 || idle > 240)) {
          return { ok: false, error: "hardware-sleep idleMinutes must be 1-240", id };
        }
        const retry = e["options"] && typeof e["options"] === "object"
          ? (e["options"] as Record<string, unknown>)["retryMinutes"] : undefined;
        if (retry !== undefined && (typeof retry !== "number" || !Number.isInteger(retry) || retry < 1 || retry > 60)) {
          return { ok: false, error: "hardware-sleep retryMinutes must be 1-60", id };
        }
      }
      const sysOptions = (e["options"] && typeof e["options"] === "object")
        ? e["options"] as { idleMinutes?: number; retryMinutes?: number; latestLocalTime?: string; expectedWakeTime?: string }
        : undefined;
      return {
        ok: true,
        entry: { ...base, kind: "system", action: action as SystemTaskAction, options: sysOptions, delivery: "silent" },
      };
    }
    default:
      return { ok: false, error: `unknown kind "${String(kind)}"`, id };
  }
}

export function isSystemEntry(entry: ScheduledTask): entry is ScheduledTask & { kind: "system" } {
  return entry.kind === "system";
}

export function isReminder(entry: ScheduledTask): entry is ScheduledTask & { kind: "reminder" } {
  return entry.kind === "reminder";
}

export function isAgentTask(entry: ScheduledTask): entry is ScheduledTask & { kind: "agent" } {
  return entry.kind === "agent";
}

export function formatTaskLabel(id: string): string {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

const TASK_ID_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id);
}

export function validateTaskId(id: string, entries: ScheduledTask[]): { ok: true; id: string } | { ok: false; error: string } {
  if (!id || !id.trim()) {
    return { ok: false, error: "--id is required" };
  }
  const normalized = id.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (!isValidTaskId(normalized)) {
    return { ok: false, error: `invalid task id "${id}" (normalized: "${normalized}") — use lowercase kebab-case` };
  }
  if (entries.some(e => e.id === normalized)) {
    return { ok: false, error: `duplicate id "${normalized}"` };
  }
  return { ok: true, id: normalized };
}

export function getTaskKindLabel(kind: TaskKind): string {
  switch (kind) {
    case "reminder": return "Reminder";
    case "agent": return "Agent Task";
    case "script": return "Script";
    case "orc": return "Orc Project";
    case "system": return "System";
  }
}
