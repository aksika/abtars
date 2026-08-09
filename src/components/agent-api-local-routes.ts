import { ServerResponse } from "http";

/**
 * #1557 — Loopback-only Orc and kanban business handlers, extracted from
 * AgentApiServer.
 *
 * These functions own validation, business dispatch, and response
 * serialization ONLY. Authorization (loopback guard) and body limits are
 * owned by the route dispatcher. Dependencies are explicit inputs so tests
 * can drive them without a live HTTPS server.
 */

const MAX_BODY_BYTES = 6 * 1024 * 1024; // 6 MB (artifacts up to 5MB + overhead)

type CreateCardFn = (input: import("./tasks/kanban-board.js").CreateCardInput) =>
  { cardId: number; status: "queued" } | { error: string };

type DeliveryMode = import("./tasks/task-types.js").DeliveryMode;

export interface AgentApiLocalRouteDeps {
  /** Orc tool provider — defaults to the production orc-tools registry. */
  getOrcTools?: () => Promise<import("./transport/tool-registry.js").ToolDefinition[]>;
  /** Shared card creation (#955) — defaults to the production kanban-board. */
  createDispatchableCard?: CreateCardFn;
  /** #1618 — shared requester contribution service; null means production default. */
  getRequesterContributionService?: () => import("./peer-help/requester-contribution-service.js").RequesterContributionService | null;
  /** Clock for request IDs/timestamps — deterministic in tests. */
  now?: () => Date;
}

async function resolveOrcTools(deps: AgentApiLocalRouteDeps): Promise<import("./transport/tool-registry.js").ToolDefinition[]> {
  if (deps.getOrcTools) return deps.getOrcTools();
  return (await import("./transport/orc-tools.js")).getOrcTools();
}

async function resolveCreateCard(deps: AgentApiLocalRouteDeps): Promise<CreateCardFn> {
  if (deps.createDispatchableCard) return deps.createDispatchableCard;
  const { createDispatchableCard } = await import("./tasks/kanban-board.js");
  return createDispatchableCard;
}

function resolveNow(deps: AgentApiLocalRouteDeps): () => Date {
  return deps.now ?? (() => new Date());
}

function writeOrcError(res: ServerResponse, err: unknown): void {
  res.writeHead(500, { "Content-Type": "application/json" })
    .end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
}

async function runOrcTool(
  toolName: string,
  args: unknown,
  res: ServerResponse,
  deps: AgentApiLocalRouteDeps,
): Promise<void> {
  try {
    const tools = await resolveOrcTools(deps);
    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      writeOrcError(res, new Error(`orc tool '${toolName}' not available`));
      return;
    }
    const result = await tool.execute(args as Record<string, unknown>);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result }));
  } catch (err) {
    // Preserve the historical { ok: false, error } 500 shape for local tools.
    writeOrcError(res, err);
  }
}

export function handleOrcSpawn(
  body: unknown,
  res: ServerResponse,
  deps: AgentApiLocalRouteDeps = {},
): Promise<void> {
  return runOrcTool("spawn_worker", body, res, deps);
}

export function handleOrcStatus(
  res: ServerResponse,
  deps: AgentApiLocalRouteDeps = {},
): Promise<void> {
  return runOrcTool("check_workers", {}, res, deps);
}

export function handleOrcCancel(
  body: unknown,
  res: ServerResponse,
  deps: AgentApiLocalRouteDeps = {},
): Promise<void> {
  return runOrcTool("cancel_worker", body, res, deps);
}

/**
 * #1618 — POST /v1/orc/delegate: the CLI delegate route runs the full
 * requester lifecycle — durable root + supervision + contribution proxy +
 * ledger before any network I/O — via the shared RequesterContributionService.
 */
export async function handleOrcDelegate(
  body: unknown,
  res: ServerResponse,
  deps: AgentApiLocalRouteDeps = {},
): Promise<void> {
  try {
    const typed = (body ?? {}) as { peer?: string; goal?: string; title?: string; request_id?: string; priority?: string };
    if (!typed.peer || !typed.goal) {
      res.writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: false, error: "peer and goal required" }));
      return;
    }
    const now = resolveNow(deps);
    const requestId = typeof typed.request_id === "string" && typed.request_id.length > 0
      ? typed.request_id
      : `orc_${now().getTime()}`;

    const { RequesterContributionService } = await import("./peer-help/requester-contribution-service.js");
    const service = deps.getRequesterContributionService?.() ?? new RequesterContributionService();
    const result = await service.delegate({
      peer: typed.peer,
      request: {
        version: 1,
        request_id: requestId,
        created_at: now().toISOString(),
        expires_at: new Date(now().getTime() + 300_000).toISOString(),
        goal: typed.goal,
        priority: typed.priority as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" ?? "MEDIUM",
        required_capabilities: [],
      },
      binding: { kind: "create_cli_project", title: typed.title ?? `[delegate:${typed.peer}] ${typed.goal.slice(0, 80)}`, goal: typed.goal },
    });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      ok: true,
      decision: result.decision,
      project_card_id: result.projectCardId,
      proxy_card_id: result.proxyCardId,
      request_id: result.requestId,
      contribution_ref: result.contributionRef,
      reason_code: result.response?.reason_code,
      reason: result.response?.reason,
    }));
  } catch (err) {
    writeOrcError(res, err);
  }
}

/** #955 — Kanban card creation (local CLI only, uses shared createDispatchableCard). */
export async function handleKanbanCreate(
  body: unknown,
  res: ServerResponse,
  deps: AgentApiLocalRouteDeps = {},
): Promise<void> {
  try {
    const typed = (body ?? {}) as {
      type?: string; title?: string; goal?: string; source?: string; priority?: string;
      labels?: string; delivery_mode?: string; chat_id?: string;
    };
    const create = await resolveCreateCard(deps);
    const result = create({
      type: typed.type,
      title: typed.title as string,
      goal: typed.goal,
      source: typed.source || "cli",
      priority: typed.priority,
      labels: typed.labels,
      deliveryMode: typed.delivery_mode as DeliveryMode,
      chatId: typed.chat_id,
    });
    if ("error" in result) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: result.error }));
    } else {
      res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, card_id: result.cardId, status: result.status }));
    }
  } catch (err) {
    writeOrcError(res, err);
  }
}

export { MAX_BODY_BYTES };
