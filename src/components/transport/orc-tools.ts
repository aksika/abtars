/**
 * orc-tools.ts — Orc-specific tools for spawning/managing workers (#1005).
 *
 * #1480: Project tools resolve authority from the per-execution invocation
 * context. There is no process-global project fallback.
 */

import type { ToolDefinition, ToolExecutionContext } from "./tool-registry.js";
import { logInfo } from "../logger.js";
import { logSwarmTrace } from "../swarm-trace.js";
import { nerve } from "../nerve.js";
import { REVIEW_PROJECT_PARAMETERS, INVALID_CONTRACT_PROPOSALS_EXHAUSTED } from "../project-acceptance/project-review-contract.js";

const TAG = "orc-tools";

function resolveCardId(args: Record<string, unknown>, context?: ToolExecutionContext): number | null {
  const bound = context?.orcContext;
  if (!bound) return null;
  if (args.project_card_id !== undefined && Number(args.project_card_id) !== bound.projectCardId) return null;
  return bound.projectCardId;
}

/**
 * #1301 — true when the Orc is currently processing a peer-originated card.
 *
 * Relay tools (peer_session/peer_doorbell/peer_ask_help) call this to refuse: a
 * peer must never be able to make us call a THIRD peer under our identity
 * (relay/identity-confusion). Keys off the active card's `source` — not the
 * session — so it stays correct for the shared singleton Orc (owner-initiated
 * delegation on an owner card is still allowed).
 *
 * #1480: When orcContext is available, uses its immutable origin instead.
 */
export async function isActiveCardPeerSourced(context?: ToolExecutionContext): Promise<boolean> {
  if (!context?.orcContext) return false;
  const { authorizePeerEgress } = await import("../orc-project/orc-project-context.js");
  const result = authorizePeerEgress({ orcContext: context.orcContext });
  return !result.allowed;
}

// ── spawn_worker ─────────────────────────────────────────────────────────────

type ParsedJsonArray = {
  provided: boolean;
  value: unknown[];
  error?: string;
};

function parseJsonArray(raw: unknown, field: string): ParsedJsonArray {
  if (raw === undefined) return { provided: false, value: [] };
  if (typeof raw !== "string") {
    return { provided: true, value: [], error: `${field} must be a JSON array` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { provided: true, value: [], error: `${field} must be a JSON array` };
    return { provided: true, value: parsed };
  } catch {
    return { provided: true, value: [], error: `${field} must be a valid JSON array` };
  }
}

const SUPERVISED_SPAWN_GUIDANCE =
  "[err] supervised spawn requires ≥1 criterion in criteria (JSON array of {id, description}); omit supervised fields for an unsupervised spawn";

/** #1588: a lane that fetches live web pages carries a 300s minimum budget. */
export const MIN_BROWSING_LANE_MS = 300_000;
const BROWSING_LANE_RE = /\b(brows|web|url|http|fetch|page|website)\b/i;

function browsingShape(...texts: string[]): boolean {
  return texts.some((t) => BROWSING_LANE_RE.test(t));
}

/**
 * #1588: clamp a browsing-shaped lane's max_duration_ms up to the 300s floor
 * so the contract is realistic before authoring. Pure — testable without a
 * live project.
 */
export function clampBrowsingLaneDuration(
  goal: string,
  title: string | undefined,
  declaresArtifacts: boolean,
  maxDurationMs: number | undefined,
): number | undefined {
  if (!declaresArtifacts) return maxDurationMs;
  if (!browsingShape(goal, title ?? "")) return maxDurationMs;
  if (maxDurationMs === undefined || maxDurationMs < MIN_BROWSING_LANE_MS) {
    return MIN_BROWSING_LANE_MS;
  }
  return maxDurationMs;
}

const spawnWorkerTool: ToolDefinition = {
  name: "spawn_worker",
  description: "Spawn a worker to execute a task in parallel. Workers run independently and report results. For supervised dispatch (Agent Swarm), provide structured criteria, artifacts, and checks.",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "What the worker should accomplish (detailed instruction)" },
      title: { type: "string", description: "Short label for the worker card (optional)" },
      priority: { type: "string", description: "CRITICAL | HIGH | MEDIUM | LOW", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
      project_card_id: { type: "number", description: "Explicit supervised project card ID" },
      criteria: { type: "string", description: "JSON array of {id, description} acceptance criteria (supervised)" },
      expected_artifacts: { type: "string", description: "JSON array of {id, kind, ref, required, criterion_ids} expected artifacts (supervised)" },
      verification_commands: { type: "string", description: "JSON array of {id, argv, cwd, timeout_ms, criterion_ids} verification commands (supervised)" },
      required_capabilities: { type: "string", description: "JSON array of required capability strings (supervised)" },
      supports_root_criteria: { type: "string", description: "JSON array of DELEGATED root project criterion IDs this worker supports. Required for supervised spawns under a project contract with delegated criteria; Orc-owned criteria are not legal mapping targets. Ids must match exactly and are case-sensitive (#1363, #1604, #1605)" },
      max_duration_ms: { type: "number", description: "Maximum execution duration in milliseconds (positive integer)" },
      max_tokens: { type: "number", description: "Maximum token budget for this worker (positive integer; requires supervised criteria and is required when project is capped)" },
      workspace_alias: { type: "string", description: "#1638: configured Pi workspace alias. Present routes this worker to the Pi executor (coding); absent routes to Spin." },
    },
    required: ["goal"],
  },
  async execute(args: Record<string, string>, context): Promise<string> {
    const projectCardId = resolveCardId(args, context);
    if (!projectCardId) return "[err] No active Orc project. spawn_worker only works during orchestration.";

    // #1363 Task 7: refuse spawn during review/repair/input turns
    const { ProjectReviewStore } = await import("../project-acceptance/project-review-store.js");
    const reviewStore = new ProjectReviewStore();
    const sup = reviewStore.getSupervision(projectCardId);
    if (sup && (sup.state === "review_requested" || sup.state === "reviewing" || sup.state === "repair_planned" || sup.state === "repairing" || sup.state === "needs_input")) {
      return `[err] Cannot spawn workers while project is in state "${sup.state}". Finalize review or wait for repair to complete.`;
    }

    const goal = args.goal;
    if (!goal) return "[err] goal is required";
    const { spin } = await import("../spin.js");
    const { kanbanGetCard } = await import("../tasks/kanban-board.js");
    const projectCard = kanbanGetCard(projectCardId);
    const criteria = parseJsonArray(args.criteria, "criteria");
    const artifacts = parseJsonArray(args.expected_artifacts, "expected_artifacts");
    const commands = parseJsonArray(args.verification_commands, "verification_commands");
    const caps = parseJsonArray(args.required_capabilities, "required_capabilities");
    const supportsRootCriteria = parseJsonArray(args.supports_root_criteria, "supports_root_criteria");
    const criteriaRaw = criteria.value;
    const artifactsRaw = artifacts.value;
    const commandsRaw = commands.value;
    const capsRaw = caps.value as string[];
    const supportsRootCriteriaRaw = supportsRootCriteria.value as string[];
    // A duration is an execution limit, not supervision structure. Token
    // limits remain contract-bound because capped projects reserve them from
    // the durable supervised attempt.
    const hasStructuredData = criteria.provided || artifacts.provided || commands.provided || caps.provided || supportsRootCriteria.provided
      || args.max_tokens !== undefined;
    // A project supervision row makes the root a supervised mutation domain.
    // A duration-only legacy spawn has no immutable attempt lineage and would
    // otherwise bypass the #1644 fence after terminal settlement.
    if (sup && !hasStructuredData) {
      return "[err] supervised projects require structured worker criteria; duration-only workers cannot be spawned under a project contract";
    }
    if (hasStructuredData && (criteria.error || criteriaRaw.length === 0)) return SUPERVISED_SPAWN_GUIDANCE;
    const parseError = [criteria, artifacts, commands, caps, supportsRootCriteria].find(parsed => parsed.error)?.error;
    if (parseError) return `[err] ${parseError}`;
    if (projectCard?.max_tokens != null && args.max_tokens === undefined) {
      return "[err] max_tokens is required when spawning a worker under a capped project";
    }
    // #1588: a browsing-shaped lane that declares artifacts is never
    // dispatched with a 2-minute budget — clamp max_duration_ms up to the
    // 300s floor so the contract is realistic before authoring.
    const requestedMs = args.max_duration_ms !== undefined ? Number(args.max_duration_ms) : undefined;
    if (requestedMs !== undefined && (!Number.isInteger(requestedMs) || requestedMs <= 0)) {
      return "[err] max_duration_ms must be a positive integer";
    }
    const maxDurationMs = clampBrowsingLaneDuration(goal, args.title, artifactsRaw.length > 0, requestedMs);
    if (maxDurationMs !== undefined && requestedMs !== maxDurationMs) {
      logInfo(TAG, `spawn_worker browsing lane: clamped max_duration_ms ${requestedMs ?? "unset"} -> ${maxDurationMs} (${goal.slice(0, 60)})`);
    }
    const contract = hasStructuredData ? {
      schema_version: 1 as const,
      id: "",
      digest: "",
      goal,
      criteria: criteriaRaw as Array<{ id: string; description: string }>,
      expected_artifacts: artifactsRaw as Array<{ id: string; kind: "file" | "directory" | "report" | "logical"; ref: string; required: boolean; criterion_ids: string[] }>,
      verification_commands: commandsRaw as Array<{ id: string; argv: string[]; cwd?: string; timeout_ms: number; criterion_ids: string[] }>,
      required_capabilities: capsRaw,
      supports_root_criteria: supportsRootCriteriaRaw.length > 0 ? supportsRootCriteriaRaw : undefined,
      workspace_alias: args.workspace_alias?.trim() || undefined,
      limits: {
        ...(maxDurationMs !== undefined ? { max_duration_ms: maxDurationMs } : {}),
        ...(args.max_tokens !== undefined ? { max_tokens: Number(args.max_tokens) } : {}),
      },
      provenance: { root_card_id: 0, card_id: 0, authored_by: "orc", created_at: "" },
    } : undefined;
    // #1604 R3: surface the required-mapping rejection as actionable tool
    // output before any card is created — same [err] shape as every other
    // guard in this tool.
    if (hasStructuredData) {
      const { validateWorkerRootCriteria } = await import("../worker-supervision-service.js") as typeof import("../worker-supervision-service.js");
      const mappingError = validateWorkerRootCriteria(projectCardId, "(pending)", supportsRootCriteriaRaw);
      if (mappingError) return `[err] ${mappingError}`;
    }
    let cardId: number;
    try {
      // #1644: the bound Orc invocation context is the only spawn authority —
      // tool arguments can never choose or override root ID, generation, or
      // run ID. createChild re-checks the durable root inside its transaction.
      const authority = context?.orcContext && hasStructuredData
        ? {
          projectCardId: context.orcContext.projectCardId,
          projectGeneration: context.orcContext.projectGeneration,
          ...(projectCard?.source === "task"
            // `OrcInvocationContextV1.runId` identifies the durable Orc
            // ownership row. Scheduled-project authority instead carries the
            // task-run correlation stored on the root card; using the Orc run
            // ID here would reject every valid scheduled child as run-stale.
            ? { scheduledRunId: projectCard.source_id ?? "" }
            : {}),
        }
        : undefined;
      cardId = spin.spawnChild(projectCardId, {
        goal,
        title: args.title || goal.slice(0, 40),
        source: "agent",
        priority: args.priority as any,
        ...(hasStructuredData ? {} : { timeoutMs: maxDurationMs }),
        contract,
        settlementOwner: "spin",
        authority,
      });
    } catch (err) {
      if (err instanceof Error && (err as Error & { code?: string }).code === "agent_cap_reached") {
        const active = /\bactive=(\d+)/.exec(err.message)?.[1];
        const limit = /\bworker_limit=(\d+)/.exec(err.message)?.[1];
        return `[err] Worker slot limit reached: ${active}/${limit} active workers on this project. Wait for workers to complete before spawning more.`;
      }
      throw err;
    }
    logInfo(TAG, `spawn_worker card:${cardId} parent:${projectCardId} — ${(args.title || goal).slice(0, 60)}${hasStructuredData ? " [supervised]" : ""}`);
    // #1604 R6: one swarm-trace event per supervised spawn carrying the
    // mapped/uncovered ids, riding in `reason` (the trace schema has a fixed
    // field allowlist).
    if (hasStructuredData) {
      try {
        const { readProjectCriterionCoverage } = await import("../project-acceptance/project-criterion-coverage.js");
        const coverage = readProjectCriterionCoverage(projectCardId);
        if (coverage.kind === "read") {
          const mapped = supportsRootCriteriaRaw.length > 0 ? supportsRootCriteriaRaw : [];
          logSwarmTrace({ event: "coverage", project: projectCardId, card: cardId, reason: `mapped=${mapped.join(",") || "-"} uncovered=${coverage.read.uncovered.join(",") || "-"}` });
        }
      } catch { /* trace is best-effort — never fail the spawn on it */ }
    }
    return `+ Worker card #${cardId} created: "${args.title || goal.slice(0, 40)}"${hasStructuredData ? " [supervised]" : ""}`;
  },
};

// ── check_workers ────────────────────────────────────────────────────────────

function supervisionSummary(cardId: number): string {
  try {
    const { WorkerSupervisionService } = require("../worker-supervision-service.js") as typeof import("../worker-supervision-service.js");
    const svc = new WorkerSupervisionService();
    if (!svc.cardHasContract(cardId)) return "";
    const contract = svc.getContractForCard(cardId);
    if (!contract) return "";
    const totalCriteria = contract.criteria.length;
    const attempts = svc["store"].getAttemptsForCard(cardId) as Array<{ status: string; ordinal: number; lifecycle: string; id: string }>;
    const settledAttempts = attempts.filter(a => a.status === "settled" || a.status === "failed").length;
    const latestLifecycle = attempts.length > 0 ? attempts[attempts.length - 1]!.lifecycle : "";
    // #1367: Lease state via view
    let leaseInfo = "";
    try {
      const { ExecutorLeaseStore } = require("../executor-lease-store.js") as typeof import("../executor-lease-store.js");
      const lstore = new ExecutorLeaseStore();
      const view = lstore.getView(String(attempts[attempts.length - 1]?.id ?? ""));
      if (view) {
        const parts: string[] = [];
        parts.push(`${view.semanticState}`);
        parts.push(`eval:${view.evaluationPhase}`);
        parts.push(`alive:${view.livenessAgeSec}s`);
        parts.push(`prog:${view.progressAgeSec}s`);
        if (view.operationLabel) parts.push(`op:${view.operationLabel.slice(0, 30)}`);
        if (view.awaitingInputSince) parts.push(`awaiting_input`);
        if (view.evaluationReason) parts.push(`reason:${view.evaluationReason}`);
        if (view.cancellationReason) parts.push(`cancel:${view.cancellationReason}`);
        if (view.closedAt) parts.push(`closed`);
        leaseInfo = ` lease:${parts.join(" ")}`;
      }
    } catch {}
    // #1365: Retry state
    let retryInfo = "";
    try {
      const { RetryStore } = require("../retry/retry-store.js") as typeof import("../retry/retry-store.js");
      const rstore = new RetryStore();
      const lastAttempt = attempts[attempts.length - 1];
      if (lastAttempt) {
        const decision = rstore.getDecision(lastAttempt.id);
        if (decision) {
          const disp = decision.decision.disposition;
          const reason = decision.decision.reasonCode;
          const remaining = decision.decision.remaining.attemptsRemaining;
          retryInfo = ` retry:${disp} remaining:${remaining} reason:${reason}`;
        }
        const classification = rstore.getClassification(lastAttempt.id);
        if (classification) {
          retryInfo += ` class:${classification.primary}`;
          if (classification.factors.length > 0) retryInfo += ` factors:${classification.factors.join(",")}`;
        }
      }
    } catch {}
    return ` [sup: ${totalCriteria} crit, ${settledAttempts}/${attempts.length} attempts, ${latestLifecycle}${leaseInfo}${retryInfo}]`;
  } catch { return ""; }
}

function projectSupervisionSummary(cardId: number): string {
  try {
    const { ProjectReviewStore, summarizeReviewCase } = require("../project-acceptance/project-review-store.js") as typeof import("../project-acceptance/project-review-store.js");
    const store = new ProjectReviewStore();
    const sup = store.getSupervision(cardId);
    if (!sup) return "";
    let s = `project:${sup.state}`;
    if (sup.generation) s += ` gen:${sup.generation}`;
    if (sup.review_round) s += ` review:${sup.review_round}`;
    if (sup.repair_round) s += ` repair:${sup.repair_round}`;
    if (sup.blocked_reason) s += ` blocked:${sup.blocked_reason.slice(0, 80)}`;
    s += summarizeReviewCase(store.getLatestReviewCase(cardId));
    if (sup.state === "accepted" && sup.accepted_decision_id) {
      s += ` accepted:${sup.accepted_decision_id.slice(0, 12)}`;
      try {
        const card = require("../tasks/kanban-board.js").kanbanGetCard(cardId);
        if (card?.delivered_at) s += ` delivered:${card.delivered_at.slice(0, 10)}`;
      } catch {}
    }
    return ` [${s}]`;
  } catch { return ""; }
}

const checkWorkersTool: ToolDefinition = {
  name: "check_workers",
  description: "Check status of all workers on the current project. Returns their status and results, including project supervision info (#1363) and Worker supervision info (#1366).",
  parameters: {
    type: "object",
    properties: {
      project_card_id: { type: "number", description: "Explicit supervised project card ID" },
    },
    required: [],
  },
  async execute(args: Record<string, string>, context): Promise<string> {
    const cardId = resolveCardId(args, context);
    if (!cardId) return "[err] No active Orc project and no project_card_id provided.";
    const { kanbanGetCard, kanbanGetChildren } = await import("../tasks/kanban-board.js");
    const projectCard = kanbanGetCard(cardId);
    let header = `Project #${cardId}`;
    if (projectCard?.title) header += ` "${projectCard.title.slice(0, 60)}"`;
    const projSup = projectSupervisionSummary(cardId);
    if (projSup) header += projSup;
    const children = kanbanGetChildren(cardId);

    // Check for pending input requests on this project
    let inputNote = "";
    try {
      const { ProjectReviewStore } = await import("../project-acceptance/project-review-store.js");
      const store = new ProjectReviewStore();
      const pendingInputs = store.getPendingInputRequestsForProject(cardId);
      if (pendingInputs.length > 0) {
        inputNote = `\n\n⚠ ${pendingInputs.length} pending input request(s):\n` + pendingInputs.map(r =>
          `  [${r.id}] ${r.question.slice(0, 200)} (response kind: ${r.expected_response_kind})`
        ).join("\n");
      }
    } catch {}

    if (children.length === 0) return `${header}\nNo workers spawned yet.${inputNote}`;
    const lines = children.map(c => {
      const icon = c.status === "done" ? "*" : c.status === "running" ? "~" : c.status === "failed" ? "x" : "+";
      const result = c.result_summary ? ` — ${c.result_summary.slice(0, 100)}` : "";
      const tokens = c.tokens_used ? ` (${c.tokens_used} tok)` : "";
      const source = c.type === "remote" ? (() => { try { return ` [${JSON.parse(c.notes ?? "{}").peer}]`; } catch { return ""; } })() : "";
      const sup = supervisionSummary(c.id);
      return `${icon} #${c.id} ${c.title || "(untitled)"} (${c.status})${tokens}${source}${sup}${result}`;
    });
    // #1638: advisory Pi capacity suffix — enabled/health, global active/max/
    // free, and deduped busy aliases. Never raw canonical paths. Advisory
    // only: admission invariants stay transactionally enforced.
    let piSuffix = "";
    try {
      const { getPiCapacityView } = await import("../pi-capacity-view.js");
      const view = getPiCapacityView();
      if (view.enabled) {
        const busyAliases = [...view.busyAliases].sort().join(",");
        piSuffix = `\npi: enabled healthy=${view.healthy} active=${view.active} max=${view.max} free=${view.free}${busyAliases ? ` busy_aliases=${busyAliases}` : ""}`;
      }
    } catch { /* Pi lane absent — no suffix */ }
    return `${header}\nWorkers (${children.length}):\n${lines.join("\n")}${piSuffix}${inputNote}`;
  },
};

// ── cancel_worker ────────────────────────────────────────────────────────────

const cancelWorkerTool: ToolDefinition = {
  name: "cancel_worker",
  description: "Cancel a running or queued worker. Use when a task is no longer needed (e.g., another worker found the answer first).",
  parameters: {
    type: "object",
    properties: {
      card_id: { type: "string", description: "The card ID of the worker to cancel" },
      project_card_id: { type: "number", description: "Explicit supervised project card ID" },
    },
    required: ["card_id"],
  },
  async execute(args: Record<string, string>, context): Promise<string> {
    const projectCardId = resolveCardId(args, context);
    if (!projectCardId) return "[err] No active Orc project and no project_card_id provided.";
    const cardId = parseInt(args.card_id ?? "", 10);
    if (isNaN(cardId)) return "[err] Invalid card_id.";
    const { kanbanGetCard } = await import("../tasks/kanban-board.js");
    const card = kanbanGetCard(cardId);
    if (!card) return `[err] Card #${cardId} not found.`;
    if (card.parent_id !== projectCardId) return `[err] Card #${cardId} is not a child of this project.`;
    if (card.status === "done" || card.status === "delivered") return `Card #${cardId} already completed.`;
    const project = kanbanGetCard(projectCardId);
    const { WorkerSupervisionStore } = await import("../worker-supervision-store.js");
    const authority = {
      projectCardId,
      projectGeneration: context?.orcContext?.projectGeneration ?? 0,
      ...(project?.source === "task" ? { scheduledRunId: project.source_id ?? "" } : {}),
    };
    const cancelled = new WorkerSupervisionStore().cancelProjectChild(cardId, authority, "cancelled by Orc");
    if (!cancelled) return "[err] project mutation rejected: worker cancellation is stale or no longer live";
    try { nerve.fire("card:failed", cardId); } catch {}
    logInfo(TAG, `cancel_worker card:${cardId} (parent:${projectCardId})`);
    return `x Worker #${cardId} cancelled.`;
  },
};

// ── review_worker_failure (#1365) ────────────────────────────────────────────────

const reviewWorkerFailureTool: ToolDefinition = {
  name: "review_worker_failure",
  description: "Review a failed supervised worker and decide whether to retry, stop, or request input. Use when check_workers shows a retry:orc_review status.",
  parameters: {
    type: "object",
    properties: {
      attempt_id: { type: "string", description: "The attempt ID to review (shown in check_workers output)" },
      action: { type: "string", description: "retry | stop | needs_input", enum: ["retry", "stop", "needs_input"] },
      project_card_id: { type: "number", description: "Explicit supervised project card ID" },
      strategy: { type: "string", description: "If retry: what strategy to change (instruction for the next attempt)" },
      do_not_repeat: { type: "string", description: "JSON array of things not to repeat on the next attempt" },
      preferred_executor: { type: "string", description: "Optional preferred executor ID for the retry" },
      rationale: { type: "string", description: "Rationale for the decision" },
      input_answer: { type: "string", description: "#1638: the answer to a Pi worker's live question. Valid only for an input_requested source with action retry; carried into the retry instruction." },
    },
    required: ["attempt_id", "action"],
  },
  async execute(args: Record<string, string>, context): Promise<string> {
    const projectCardId = resolveCardId(args, context);
    if (!projectCardId) return "[err] No active Orc project.";
    const bound = context?.orcContext;
    if (!bound) return "[err] No active Orc project.";
    const attemptId = args.attempt_id;
    if (!attemptId) return "[err] attempt_id is required";
    const action = args.action;
    if (action !== "retry" && action !== "stop" && action !== "needs_input") return "[err] action must be retry, stop, or needs_input";
    try {
      const { RetryService } = await import("../retry/retry-service.js");
      const { LocalExecutorCatalog } = await import("../retry/local-executor-catalog.js");
      const { providerForAdapter } = await import("../retry/local-executor-catalog.js");
      const { SpinWorkerAdapter } = await import("../spin-worker-adapter.js");
      const { AGENT_EXECUTOR_ID } = await import("../worker-executor-identity.js");
      const { WorkerSupervisionStore } = await import("../worker-supervision-store.js");
      const { kanbanGetCard } = await import("../tasks/kanban-board.js");
      const catalog = new LocalExecutorCatalog({
        spinProvider: providerForAdapter(new SpinWorkerAdapter(), AGENT_EXECUTOR_ID),
      });
      const service = new RetryService({ executorCatalog: catalog });
      // The tool is project-scoped, but retry contracts and attempts are
      // child-card scoped. Resolve that child from the durable attempt and
      // verify its parent before handing it to the retry boundary; passing the
      // root ID here would allow a malformed review to target the wrong
      // contract/card lineage.
      const attempt = new WorkerSupervisionStore().getAttempt(attemptId);
      if (!attempt) return `[err] attempt ${attemptId} not found`;
      const workerCard = kanbanGetCard(attempt.card_id);
      if (!workerCard || workerCard.parent_id !== projectCardId || workerCard.type !== "W") {
        return `[err] attempt ${attemptId} is not a child of project ${projectCardId}`;
      }
      const projectCard = kanbanGetCard(projectCardId);
      const authority = {
        projectCardId: bound.projectCardId,
        projectGeneration: bound.projectGeneration,
        ...(projectCard?.source === "task" ? { scheduledRunId: projectCard.source_id ?? "" } : {}),
      };
      const packet = service.getReviewPacket(attemptId, attempt.card_id);
      if ("error" in packet) return `[err] ${packet.error}`;

      const doNotRepeat: string[] = args.do_not_repeat ? JSON.parse(args.do_not_repeat) : [];
      const response = {
        action: action as "retry" | "stop" | "needs_input",
        strategy: args.strategy,
        doNotRepeat,
        preferredExecutorId: args.preferred_executor,
        rationale: args.rationale,
        // #1638: bounded answer for a live Pi question; validated by the
        // retry service against an input_requested source + retry action.
        inputAnswer: args.input_answer?.slice(0, 4000),
      };

      const result = service.reviewFailure({ attemptId, cardId: attempt.card_id, response, authority });

      if (action === "retry") {
        if (result.kind === "created") {
          return `✓ Retry directive created for attempt ${attemptId}. Target attempt: ${result.targetAttemptId}.`;
        }
        return `[err] ${result.kind}: ${"message" in result ? result.message : "retry allocation failed"}`;
      } else if (action === "stop") {
        return result.kind === "error" ? `✓ Stop recorded for attempt ${attemptId}.` : `[err] stop failed: ${result.kind}`;
      } else {
        return result.kind === "error" ? `✓ Needs-input recorded for attempt ${attemptId}.` : `[err] needs_input failed: ${result.kind}`;
      }
    } catch (err) {
      logInfo(TAG, `review_worker_failure error: ${err}`);
      return `[err] ${String(err)}`;
    }
  },
};

// ── define_project_contract (#1363 Task 1a) ─────────────────────────────────────

const MAX_INVALID_CONTRACT_PROPOSALS = 3;

const defineProjectContractTool: ToolDefinition = {
  name: "define_project_contract",
  description: "Author a root acceptance contract for the current supervised project. Required before any workers can be spawned.",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "Project goal" },
      project_card_id: { type: "number", description: "Explicit supervised project card ID" },
      criteria: { type: "string", description: "JSON array of {id, description, required, execution_owner, evidence_expectation} — required: boolean, execution_owner: delegated|orc, evidence_expectation: observed|artifact|synthesis. Orc-owned criteria must use synthesis evidence; only delegated criteria can be mapped to Workers" },
      required_outputs: { type: "string", description: "JSON array of {id, description, kind, required} — kind: file|directory|report|logical" },
      constraints: { type: "string", description: "JSON array of constraint strings" },
      hard_deadline_at: { type: "string", description: "ISO deadline (optional)" },
      max_tokens: { type: "number", description: "Max tokens (optional)" },
      max_cost: { type: "number", description: "Max cost (optional)" },
    },
    required: ["goal", "criteria", "project_card_id"],
  },
  async execute(args: Record<string, string>, context?: ToolExecutionContext): Promise<string> {
    const cardId = Number(args.project_card_id);
    if (!Number.isSafeInteger(cardId) || cardId < 1) return "[err] project_card_id is required and must be a positive integer.";

    try {
      const { normalizeContract, createContractId } = await import("../project-acceptance/project-contract.js");
      const { ProjectReviewStore, authorizeActiveProjectWork } = await import("../project-acceptance/project-review-store.js");

      const store = new ProjectReviewStore();
      const supervision = store.getSupervision(cardId);

      // #1644: contract authoring is a supervised mutation — the bound Orc
      // invocation context is the only authority; tool arguments cannot
      // choose or override the root ID or generation.
      const bound = context?.orcContext;
      if (!bound) return "[err] No active Orc project. define_project_contract only works during a project contract-authoring turn.";
      if (bound.projectCardId !== cardId) {
        return `[err] project_card_id ${cardId} does not match the bound project ${bound.projectCardId}`;
      }
      if (supervision && bound.projectGeneration !== supervision.generation) {
        return `[err] Bound project generation ${bound.projectGeneration} is stale; current generation is ${supervision.generation}`;
      }

      // Only valid when awaiting_contract or no supervision yet
      if (supervision && supervision.state !== "awaiting_contract") {
        return `[err] Project is in state "${supervision.state}", not awaiting_contract`;
      }

      // Parse inputs
      let criteria: unknown[];
      try { criteria = JSON.parse(args.criteria ?? "[]") as unknown[]; } catch { return "[err] criteria must be valid JSON array"; }
      if (criteria.length === 0) return "[err] At least one criterion is required";

      let outputs: unknown[] = [];
      try { outputs = JSON.parse(args.required_outputs ?? "[]") as unknown[]; } catch { return "[err] required_outputs must be valid JSON array"; }

      let constraints: string[] = [];
      try { constraints = JSON.parse(args.constraints ?? "[]") as string[]; } catch { return "[err] constraints must be valid JSON array"; }

      // Build raw contract object (schema v2 — #1605)
      const now = new Date().toISOString();
      const card = (await import("../tasks/kanban-board.js")).kanbanGetCard(cardId);
      const authority = {
        projectCardId: cardId,
        projectGeneration: bound.projectGeneration,
        ...(card?.source === "task" ? { scheduledRunId: card.source_id ?? "" } : {}),
      };
      const raw: Record<string, unknown> = {
        schema_version: 2,
        id: createContractId(),
        digest: "",
        project_card_id: cardId,
        goal: args.goal ?? "",
        criteria,
        required_outputs: outputs,
        constraints,
        limits: {
          hard_deadline_at: args.hard_deadline_at || undefined,
          max_tokens: args.max_tokens ? Number(args.max_tokens) : undefined,
          max_cost: args.max_cost ? Number(args.max_cost) : undefined,
          max_review_rounds: 10,   // policy, not from Orc
          max_repair_rounds: 5,    // policy, not from Orc
        },
        provenance: {
          requested_by: card?.source ?? "agent",
          authored_by: "orc",
          created_at: now,
        },
      };

      const normalized = normalizeContract(raw);
      if (!normalized.ok) {
        const errs = normalized.errors.map(e => `  [${e.path}] ${e.message}`).join("\n");

        // Track invalid proposals
        if (supervision) {
          const decisionId = `rd_block_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const record = store.recordInvalidContractProposal(
            cardId,
            bound.projectGeneration,
            MAX_INVALID_CONTRACT_PROPOSALS,
            { action: "blocked", reason: "Invalid contract proposals exhausted" },
            INVALID_CONTRACT_PROPOSALS_EXHAUSTED,
            decisionId,
            authority,
          );
          if (record.kind === "blocked") {
            try { nerve.fire("card:failed", cardId); } catch {}
            return `✗ Project blocked after ${record.total} invalid proposals.\n${errs}`;
          }
          if (record.kind === "ignored") return "[err] project mutation rejected: contract authoring authority is stale";
          return `[err] Invalid contract:\n${errs}\n\nAttempt ${record.total}/${MAX_INVALID_CONTRACT_PROPOSALS}. Provide a corrected contract.`;
        }

        return `[err] Invalid contract:\n${errs}\n\nAttempt 1/${MAX_INVALID_CONTRACT_PROPOSALS}. Provide a corrected contract.`;
      }

      // Insert contract + initialize supervision + project budget — all in one
      // transaction that also re-verifies the durable project authority so a
      // stale authoring turn can never write after terminal settlement.
      store.db.transaction(() => {
        const rejection = authorizeActiveProjectWork(store.db, authority);
        if (rejection) {
          throw new Error(`project mutation rejected: ${rejection}`);
        }
        store.insertContract(normalized.contract);
        store.initializeSupervision(cardId, normalized.contract.id, "executing");

        // Project budget limits onto kanban card
        const maxTokens = normalized.contract.limits.max_tokens;
        const maxCost = normalized.contract.limits.max_cost;
        if (maxTokens !== undefined || maxCost !== undefined) {
          const sets: string[] = [];
          const vals: unknown[] = [];
          if (maxTokens !== undefined) { sets.push("max_tokens = ?"); vals.push(maxTokens); }
          if (maxCost !== undefined) { sets.push("max_cost = ?"); vals.push(maxCost); }
          vals.push(cardId);
          store.db.prepare(`UPDATE kanban_board SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        }
      });

      // #1605: echo ownership + requiredness so the Orc's next authoring turn
      // and any spawn use only delegated ids as mapping targets, and knows
      // which criteria are optional vs hard.
      const delegatedIds = normalized.contract.criteria.filter(c => c.execution_owner === "delegated").map(c => c.id);
      const orcOwnedIds = normalized.contract.criteria.filter(c => c.execution_owner === "orc").map(c => c.id);
      const optionalIds = normalized.contract.criteria.filter(c => c.required === false).map(c => c.id);
      const delegatedText = delegatedIds.length > 0 ? delegatedIds.join(", ") : "(none)";
      const orcText = orcOwnedIds.length > 0 ? orcOwnedIds.join(", ") : "(none)";
      const optionalText = optionalIds.length > 0 ? `; optional (required: false) criteria: ${optionalIds.join(", ")}` : "";
      return `✓ Root contract defined (${normalized.contract.id}, digest: ${normalized.contract.digest.slice(0, 12)}…). Delegated criteria: ${delegatedText}; Orc-owned criteria: ${orcText}${optionalText}. Every spawn_worker must pass supports_root_criteria using only delegated ids; Orc-owned criteria are evaluated by you in review_project, never mapped to Workers.`;
    } catch (err) {
      return `[err] define_project_contract error: ${String(err)}`;
    }
  },
};

// ── review_project (#1363, #1620) ─────────────────────────────────────────────

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * #1620: read the immutable open review case for the current supervised
 * project. Side-effect-free: repeated reads never transition state and never
 * consume the invalid-proposal budget. The response is the authoritative,
 * decision-ready projection consumed by review_project.
 */
const getProjectReviewCaseTool: ToolDefinition = {
  name: "get_project_review_case",
  description: "Read the immutable open review case for the current supervised project. Returns the exact project/generation/case ids, every criterion with its compatible evidence ids, required outputs, contradictions, peer claims, review budgets, the legal decision vocabulary, and an empty decision skeleton. Side-effect-free — call it before deciding, then submit exactly one review_project decision.",
  parameters: {
    type: "object",
    properties: {
      project_card_id: { type: "number", description: "Explicit supervised project card ID (must match the active Orc project)" },
      review_case_id: { type: "string", description: "Explicit review case ID from the review dispatch goal" },
    },
    required: ["project_card_id", "review_case_id"],
  },
  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const bound = context?.orcContext;
    if (!bound) return JSON.stringify({ error: "No active Orc project. get_project_review_case only works during a project review turn." });

    const reviewCaseId = stringValue(args.review_case_id);
    if (!reviewCaseId) return JSON.stringify({ error: "review_case_id is required." });
    const explicitProjectId = numberValue(args.project_card_id);
    if (explicitProjectId === null) return JSON.stringify({ error: "project_card_id is required and must be a positive integer." });
    if (explicitProjectId !== bound.projectCardId) {
      return JSON.stringify({ error: `project_card_id ${explicitProjectId} does not match the bound project ${bound.projectCardId}` });
    }

    try {
      const { ProjectReviewStore } = await import("../project-acceptance/project-review-store.js");
      const { projectReviewBrief } = await import("../project-acceptance/project-review-case.js");
      const store = new ProjectReviewStore();

      const supervision = store.getSupervision(explicitProjectId);
      if (!supervision) return JSON.stringify({ error: "No project supervision state found. Is this a supervised project?" });
      if (typeof bound.projectGeneration === "number" && bound.projectGeneration !== supervision.generation) {
        return JSON.stringify({ error: `Bound project generation ${bound.projectGeneration} is stale; current generation is ${supervision.generation}` });
      }
      if (supervision.state !== "review_ready" && supervision.state !== "review_requested" && supervision.state !== "reviewing") {
        return JSON.stringify({ error: `Project is in state "${supervision.state}", not ready for review` });
      }

      const openCase = store.getReviewCase(reviewCaseId);
      if (!openCase) return JSON.stringify({ error: `Review case "${reviewCaseId}" not found` });
      if (openCase.project_card_id !== explicitProjectId) return JSON.stringify({ error: `Case "${reviewCaseId}" does not belong to project ${explicitProjectId}` });
      if (openCase.generation !== supervision.generation) return JSON.stringify({ error: `Case generation ${openCase.generation} does not match supervision generation ${supervision.generation}` });
      if (openCase.status !== "open") return JSON.stringify({ error: `Review case "${reviewCaseId}" is ${openCase.status}, not open` });

      const brief = projectReviewBrief(reviewCaseId, store);
      if (!brief.ok) return JSON.stringify({ error: brief.error });
      return JSON.stringify(brief.brief);
    } catch (err) {
      return JSON.stringify({ error: `get_project_review_case error: ${String(err)}` });
    }
  },
};

const reviewProjectTool: ToolDefinition = {
  name: "review_project",
  description: "Submit a final review decision for the current supervised project. All root criteria must be evaluated. First read the immutable case with get_project_review_case, then submit exactly one decision using its legal_values and compatible evidence ids.",
  parameters: REVIEW_PROJECT_PARAMETERS as unknown as Record<string, unknown>,
  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    try {
      const { narrowReviewProjectArgs } = await import("../project-acceptance/project-review-contract.js");
      const narrowed = narrowReviewProjectArgs(args);
      if (!narrowed.ok) {
        return JSON.stringify({
          outcome: "invalid_payload",
          issues: narrowed.issues,
          message: "review_project payload did not match the declared schema — no decision was created and no state changed",
        });
      }
      const decision = narrowed.decision;

      const projectCardId = decision.project_card_id;
      const projectGeneration = decision.project_generation;

      // #1480: the bound Orc context is the authority for the active project.
      const bound = context?.orcContext;
      if (!bound) return JSON.stringify({ error: "No active Orc project. review_project only works during a project review turn." });
      if (projectCardId !== bound.projectCardId) {
        return JSON.stringify({ error: `project_card_id ${projectCardId} does not match the bound project ${bound.projectCardId}` });
      }

      const { ProjectReviewService } = await import("../project-acceptance/project-review-service.js");
      const { ProjectReviewStore } = await import("../project-acceptance/project-review-store.js");

      const store = new ProjectReviewStore();
      const supervision = store.getSupervision(projectCardId);
      if (!supervision) return JSON.stringify({ error: "No project supervision state found. Is this a supervised project?" });
      if (typeof bound.projectGeneration === "number" && bound.projectGeneration !== supervision.generation) {
        return JSON.stringify({ error: `Bound project generation ${bound.projectGeneration} is stale; current generation is ${supervision.generation}` });
      }
      if (supervision.generation !== projectGeneration) return JSON.stringify({ error: `Project generation mismatch: expected ${supervision.generation}, got ${projectGeneration}` });
      if (supervision.state !== "review_ready" && supervision.state !== "review_requested" && supervision.state !== "reviewing") return JSON.stringify({ error: `Project is in state "${supervision.state}", not ready for review` });

      const openCase = store.getReviewCase(decision.review_case_id);
      if (!openCase) return JSON.stringify({ error: `Review case "${decision.review_case_id}" not found` });
      if (openCase.project_card_id !== projectCardId) return JSON.stringify({ error: `Case "${decision.review_case_id}" does not belong to project ${projectCardId}` });
      if (openCase.generation !== supervision.generation) return JSON.stringify({ error: `Case generation ${openCase.generation} does not match supervision generation ${supervision.generation}` });
      if (openCase.status !== "open") return JSON.stringify({ error: `Review case "${decision.review_case_id}" is ${openCase.status}, not open` });

      const rootCard = store.db.prepare(`SELECT source, source_id FROM kanban_board WHERE id = ?`).get(projectCardId) as { source: string | null; source_id: string | null } | undefined;
      const authority = {
        projectCardId: bound.projectCardId,
        projectGeneration: bound.projectGeneration,
        ...(rootCard?.source === "task" ? { scheduledRunId: rootCard.source_id ?? "" } : {}),
      };

      // Transition from review_requested to reviewing only when ready to
      // process a structurally complete decision — the narrow step above
      // already guarantees structural completeness.
      if (supervision.state === "review_requested") {
        const transitioned = store.stateTransition(projectCardId, ["review_requested"], "reviewing", undefined, { authority });
        if (!transitioned) return JSON.stringify({ error: "project mutation rejected: review ownership is stale" });
      }

      const service = new ProjectReviewService();
      const result = service.processDecision(decision, authority);

      switch (result.kind) {
        case "accepted":
          return JSON.stringify({ outcome: "accepted", decision_id: result.decisionId, summary: result.summary, warnings: result.warnings ?? [] });
        case "repair":
          return JSON.stringify({ outcome: "repair", decision_id: result.decisionId, summary: result.summary, warnings: result.warnings ?? [] });
        case "blocked":
          return JSON.stringify({ outcome: "blocked", decision_id: result.decisionId, summary: result.summary, warnings: result.warnings ?? [] });
        case "needs_input":
          return JSON.stringify({ outcome: "needs_input", decision_id: result.decisionId, summary: result.summary, warnings: result.warnings ?? [] });
        case "blocked_invalid":
          return JSON.stringify({ outcome: "blocked_invalid", decision_id: result.decisionId, summary: result.summary, invalid_proposal_count: result.invalidProposalCount });
        case "invalid":
          return JSON.stringify({
            outcome: "invalid",
            issues: result.issues.map(i => ({ severity: i.severity, tag: i.tag, path: i.path, message: i.message })),
            invalid_proposal_count: result.invalidProposalCount,
            remaining_attempts: result.remainingAttempts,
          });
      }
    } catch (err) {
      return JSON.stringify({ error: `review_project error: ${String(err)}` });
    }
  },
};

// ── Export ────────────────────────────────────────────────────────────────────

export function getOrcTools(): ToolDefinition[] {
  return [defineProjectContractTool, spawnWorkerTool, checkWorkersTool, cancelWorkerTool, reviewWorkerFailureTool, getProjectReviewCaseTool, reviewProjectTool];
}
