
import { CronExpressionParser } from "cron-parser";

const HH_MM_RE = /^\d{1,2}:\d{2}$/;

function isValidHHmm(value: string): boolean {
  if (!HH_MM_RE.test(value)) return false;
  const [h, m] = value.split(":").map(Number);
  return h! >= 0 && h! <= 23 && m! >= 0 && m! <= 59;
}

function parseMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h! * 60 + m!;
}

export type Delivery = "report" | "announce" | "silent";

/** #1516: Upper bound on scheduled agent orchestration (1 Orc + up to 3 Workers). */
export const MAX_SCHEDULED_AGENTS = 4;

export interface TaskOrchestration {
  /** Normalized total agent budget, 1..MAX_SCHEDULED_AGENTS — includes the Orc. */
  maxAgents: number;
  /** #1588: per-lane hard duration budget (ms) the Orc must not under-author. */
  laneDurationMs?: number;
}

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

export interface ReportContract {
  artifact: string;
  requiredSections: string[];
  minBytes: number;
  requires: {
    files: string[];
    executables: string[];
    tools: string[];
  };
}

/** #1432: Exact conversation address a scheduled interactive skill binds to. */
export interface ConversationTarget {
  userId: string;
  platform: string;
  chatId: string;
  threadId?: string;
}

/** #1432: Session lifecycle contract for scheduled agent definitions — missing defaults to oneshot. */
export type AgentInteraction =
  | { mode: "oneshot" }
  | { mode: "skill"; skill: string; target: ConversationTarget };

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
      agent: "task" | "professor" | "browsie" | "coding" | "dreamy";
      interaction: AgentInteraction;
      maxToolRounds?: number;
      report?: ReportContract;
      orchestration: TaskOrchestration;
    })
  | (TaskBase & {
      kind: "script";
      command: string;
      followUp?: { prompt: string; agent?: string };
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

/**
 * #1569: the complete set of top-level fields a task entry may carry, per kind.
 *
 * A key outside this set is a definition error, never something to ignore.
 * #1432 removed `targetUserId` from the contract but left the leftover key
 * silently dropped, so a task whose only expression of "interactive lesson for
 * this user" was `targetUserId` normalized to a plain oneshot announce and ran
 * with different semantics than its author wrote — with no error, warning, or
 * log line. Rejecting unrecognized keys makes a stale definition quarantine
 * loudly on first load instead of degrading in silence.
 *
 * This also covers what a per-kind denylist would: a field belonging to another
 * kind (`agent` on a script, `command` on a system entry) is unrecognized here,
 * as is a typo. Adding a field to the contract means adding it here.
 */
const COMMON_FIELDS = [
  "id", "kind", "schedule", "at", "enabled", "priority",
  "chatId", "delivery", "catchUpHours", "maxRunsPerDay",
] as const;

const KIND_FIELDS: Readonly<Record<TaskKind, readonly string[]>> = {
  reminder: ["text"],
  agent: ["prompt", "taskFile", "agent", "orchestration", "interaction", "report", "maxToolRounds"],
  script: ["command", "followUp"],
  system: ["action", "options"],
};

function isTaskKind(value: string): value is TaskKind {
  return Object.prototype.hasOwnProperty.call(KIND_FIELDS, value);
}

/** #1569: top-level keys the entry carries that its kind does not define. */
function unknownFields(e: Record<string, unknown>, kind: TaskKind): string[] {
  const allowed = new Set<string>([...COMMON_FIELDS, ...KIND_FIELDS[kind]]);
  return Object.keys(e).filter(key => !allowed.has(key));
}

export type NormalizeResult =
  | { ok: true; entry: ScheduledTask }
  | { ok: false; error: string; id?: string };

function parsePriority(raw: unknown): "high" | "medium" | "low" {
  if (raw === "high" || raw === "low") return raw;
  return "medium";
}

/** #1516: Normalize `orchestration` for agent tasks — hard default of one agent. */
export function normalizeOrchestration(raw: unknown):
  | { ok: true; value: TaskOrchestration }
  | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: { maxAgents: 1 } };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "agent orchestration must be an object" };
  }
  const maxAgents = (raw as Record<string, unknown>).maxAgents;
  if (maxAgents === undefined) return { ok: true, value: { maxAgents: 1 } };
  if (typeof maxAgents !== "number" || !Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > MAX_SCHEDULED_AGENTS) {
    return { ok: false, error: `agent orchestration.maxAgents must be an integer from 1 to ${MAX_SCHEDULED_AGENTS}` };
  }
  const laneDurationMs = (raw as Record<string, unknown>).laneDurationMs;
  if (laneDurationMs !== undefined) {
    if (typeof laneDurationMs !== "number" || !Number.isInteger(laneDurationMs) || laneDurationMs < 1) {
      return { ok: false, error: "agent orchestration.laneDurationMs must be a positive integer (ms)" };
    }
    return { ok: true, value: { maxAgents, laneDurationMs } };
  }
  return { ok: true, value: { maxAgents } };
}

export function normalize(raw: unknown): NormalizeResult {
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

  // #1569: reject a definition carrying fields its kind does not define, before
  // any field-by-field normalization can silently drop one. An unknown kind
  // falls through to the switch's own error below.
  if (isTaskKind(kind)) {
    const unknown = unknownFields(e, kind);
    if (unknown.length > 0) {
      return { ok: false, error: `unknown field(s) for kind "${kind}": ${unknown.join(", ")}`, id };
    }
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
  if (delivery !== "report" && delivery !== "announce" && delivery !== "silent") {
    return { ok: false, error: `invalid delivery "${String(delivery)}" (expected report|announce|silent)`, id };
  }

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
      if (typeof agentRaw !== "string" || !["task", "professor", "browsie", "coding", "dreamy"].includes(agentRaw)) {
        return { ok: false, error: `agent is required for agent kind and must be one of: task, professor, browsie, coding, dreamy`, id };
      }
      const agent = agentRaw as "task" | "professor" | "browsie" | "coding" | "dreamy";
      const orchestrationResult = normalizeOrchestration(e["orchestration"]);
      if (!orchestrationResult.ok) {
        return { ok: false, error: orchestrationResult.error, id };
      }
      // #1432: interaction selects the session lifecycle. Missing defaults to
      // oneshot — a new optional field must never quarantine the whole task.
      const interactionRaw = e["interaction"];
      const reportRaw = e["report"];
      let interaction: AgentInteraction;
      if (typeof interactionRaw !== "object" || interactionRaw === null) {
        interaction = { mode: "oneshot" };
      } else {
        const interactionEntry = interactionRaw as Record<string, unknown>;
        const mode = interactionEntry["mode"];
        if (mode === "oneshot") {
          interaction = { mode: "oneshot" };
        } else if (mode === "skill") {
          if (base.delivery !== "announce") {
            return { ok: false, error: `interaction.mode=skill requires delivery=announce`, id };
          }
          if (orchestrationResult.value.maxAgents !== 1) {
            return { ok: false, error: `interaction.mode=skill requires orchestration.maxAgents=1`, id };
          }
          if (reportRaw !== undefined) {
            return { ok: false, error: `interaction.mode=skill forbids a report contract`, id };
          }
          const skill = typeof interactionEntry["skill"] === "string" ? interactionEntry["skill"].trim() : "";
          if (!skill || !SKILL_IDENTIFIER_RE.test(skill)) {
            return { ok: false, error: `interaction.mode=skill requires a valid skill identifier`, id };
          }
          const targetRaw = interactionEntry["target"];
          if (typeof targetRaw !== "object" || targetRaw === null) {
            return { ok: false, error: `interaction.mode=skill requires an exact target`, id };
          }
          const t = targetRaw as Record<string, unknown>;
          const userId = typeof t["userId"] === "string" ? t["userId"].trim() : "";
          const platform = typeof t["platform"] === "string" ? t["platform"].trim() : "";
          const chatId = typeof t["chatId"] === "string" ? t["chatId"].trim() : "";
          const threadId = typeof t["threadId"] === "string" ? t["threadId"] : undefined;
          if (!userId || !platform || !chatId) {
            return { ok: false, error: `interaction.mode=skill target requires userId, platform, and chatId`, id };
          }
          if (prompt === undefined && taskFile === undefined) {
            return { ok: false, error: `interaction.mode=skill requires at least one of prompt or taskFile`, id };
          }
          interaction = { mode: "skill", skill, target: { userId, platform, chatId, ...(threadId !== undefined ? { threadId } : {}) } };
        } else {
          return { ok: false, error: `interaction.mode must be "oneshot" or "skill"`, id };
        }
      }
      const maxToolRounds = typeof e["maxToolRounds"] === "number" ? e["maxToolRounds"] as number : undefined;
      let report: ReportContract | undefined;
      if (base.delivery === "report") {
        if (typeof reportRaw !== "object" || reportRaw === null) {
          return { ok: false, error: `report contract is required for delivery=report`, id };
        } else {
          const r = reportRaw as Record<string, unknown>;
          const artifact = typeof r["artifact"] === "string" ? r["artifact"] : "";
          const requiredSections = Array.isArray(r["requiredSections"]) ? r["requiredSections"].filter((s: unknown) => typeof s === "string" && s.length > 0) : [];
          const minBytes = typeof r["minBytes"] === "number" ? r["minBytes"] : 0;
          if (!artifact || typeof artifact !== "string" || (!artifact.startsWith("/") && !artifact.startsWith("~/"))) {
            return { ok: false, error: `report.artifact must be an absolute or ~/ path`, id };
          }
          if (requiredSections.length === 0) {
            return { ok: false, error: `report.requiredSections must be a non-empty array of Markdown headings`, id };
          }
          if (!Number.isInteger(minBytes) || minBytes < 100) {
            return { ok: false, error: `report.minBytes must be an integer >= 100`, id };
          }
          const requiresRaw = typeof r["requires"] === "object" && r["requires"] !== null ? r["requires"] as Record<string, unknown> : {};
          const filesArr = Array.isArray(requiresRaw["files"]) ? requiresRaw["files"].filter((x: unknown) => typeof x === "string" && x.length > 0) : [];
          const executablesArr = Array.isArray(requiresRaw["executables"]) ? requiresRaw["executables"].filter((x: unknown) => typeof x === "string" && x.length > 0) : [];
          const toolsArr = Array.isArray(requiresRaw["tools"]) ? requiresRaw["tools"].filter((x: unknown) => typeof x === "string" && x.length > 0) : [];
          report = { artifact, requiredSections, minBytes, requires: { files: filesArr, executables: executablesArr, tools: toolsArr } };
        }
      } else if (reportRaw !== undefined) {
        return { ok: false, error: `report contract is only valid for delivery=report tasks`, id };
      }
      return {
        ok: true,
        entry: { ...base, kind: "agent", prompt, taskFile, agent, interaction, maxToolRounds, report, orchestration: orchestrationResult.value },
      };
    }
    case "script": {
      const command = typeof e["command"] === "string" ? e["command"] : "";
      if (!command) return { ok: false, error: "command is required for script", id };
      const followUpRaw = e["followUp"];
      const followUp = followUpRaw && typeof followUpRaw === "object" ? followUpRaw as { prompt: string; agent?: string } : undefined;
      return { ok: true, entry: { ...base, kind: "script", command, followUp } };
    }
    case "system": {
      const action = e["action"];
      if (typeof action !== "string" || !SYSTEM_ACTIONS.includes(action as SystemTaskAction)) {
        return { ok: false, error: `unknown system action "${String(action)}"`, id };
      }
      if (delivery !== "silent") return { ok: false, error: "system delivery must be silent", id };
      if (action === "hardware-sleep") {
        const opts = e["options"] && typeof e["options"] === "object"
          ? (e["options"] as Record<string, unknown>) : {};
        const idle = opts["idleMinutes"];
        if (idle !== undefined && (typeof idle !== "number" || !Number.isInteger(idle) || idle < 1 || idle > 240)) {
          return { ok: false, error: "hardware-sleep idleMinutes must be 1-240", id };
        }
        const retry = opts["retryMinutes"];
        if (retry !== undefined && (typeof retry !== "number" || !Number.isInteger(retry) || retry < 1 || retry > 60)) {
          return { ok: false, error: "hardware-sleep retryMinutes must be 1-60", id };
        }
        const latest = opts["latestLocalTime"];
        if (latest !== undefined && (typeof latest !== "string" || !isValidHHmm(latest))) {
          return { ok: false, error: "hardware-sleep latestLocalTime must be HH:mm (00:00-23:59)", id };
        }
        const wake = opts["expectedWakeTime"];
        if (wake !== undefined && (typeof wake !== "string" || !isValidHHmm(wake))) {
          return { ok: false, error: "hardware-sleep expectedWakeTime must be HH:mm (00:00-23:59)", id };
        }
        if (latest && wake && parseMinutes(latest) >= parseMinutes(wake)) {
          return { ok: false, error: "hardware-sleep latestLocalTime must be before expectedWakeTime", id };
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

/** #1432: skill identifiers in scheduled definitions are validated identifiers, not paths. */
const SKILL_IDENTIFIER_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

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
    case "system": return "System";
  }
}
