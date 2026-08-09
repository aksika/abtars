/**
 * requester-contribution-service.ts — shared requester contribution operation
 * (#1618). Owns request reservation, proxy/ledger creation, transport outcome
 * projection, and replay behavior for BOTH the active-Orc `peer_ask_help` tool
 * and the `/v1/orc/delegate` CLI route. Network I/O never happens inside a
 * database transaction; durable reservation always commits before transport.
 */
import type { PeerHelpRequestV1, PeerHelpResponseV1 } from "./contract.js";
import { canonicalContributionHash } from "./contract.js";
import { ContributionStore } from "./contribution-store.js";
import { getPeerTransport } from "../peer-transport/index.js";
import { requireTaskDatabase, kanbanGetCard, kanbanUpdate, kanbanFail } from "../tasks/kanban-board.js";
import { ProjectReviewStore } from "../project-acceptance/project-review-store.js";
import { requestReconcileForProject } from "../reconciler.js";
import { logInfo, logWarn } from "../logger.js";

const TAG = "requester-contribution";
import { randomUUID } from "node:crypto";

export type ContributionDecision = "accepted" | "declined" | "deferred" | "unknown";

export type ProjectBinding =
  | { kind: "existing"; projectCardId: number | null; rootCriteria: string[] }
  | { kind: "create_cli_project"; title: string; goal: string };

export interface DelegateContributionInput {
  peer: string;
  request: PeerHelpRequestV1;
  binding: ProjectBinding;
  /** Fallback reuse: rebind an existing proxy card to a new peer/request. */
  proxyCardId?: number;
  /** Keep a proxy reusable while an adapter still has fallback candidates. */
  terminalizeNonStarted?: boolean;
}

export interface DelegateContributionResult {
  decision: ContributionDecision;
  projectCardId: number | null;
  proxyCardId: number;
  requestId: string;
  contributionRef: string;
  response?: PeerHelpResponseV1;
  error?: string;
}

export interface AskHelpPort {
  (peer: string, request: PeerHelpRequestV1): Promise<PeerHelpResponseV1>;
}

export interface WakePort {
  (projectCardId: number): void;
}

interface TaskDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

export interface RequesterContributionDeps {
  contributionStore?: ContributionStore;
  taskDb?: TaskDb;
  reviewStore?: { ensureAwaitingContract(projectCardId: number): boolean };
  askHelp?: AskHelpPort;
  wakeProject?: WakePort;
  kanbanUpdate?: (cardId: number, updates: Record<string, unknown>) => void;
  kanbanFail?: (cardId: number, error: string) => void;
}

function cliRootGoal(requestId: string): string {
  return `Delegation project for peer contribution request ${requestId}: supervise the local lifecycle — define the acceptance contract (define_project_contract), await the peer contribution claim, review the returned peer projection locally (it is a claim, never requester-observed evidence), synthesize the final result, and settle this project with review_project. Silent delivery.`;
}

export class RequesterContributionService {
  private readonly contributionStore: ContributionStore;
  private readonly taskDb: TaskDb;
  private readonly reviewStore: { ensureAwaitingContract(projectCardId: number): boolean };
  private readonly askHelp: AskHelpPort;
  private readonly wakeProject: WakePort;
  private readonly kanbanUpdate: (cardId: number, updates: Record<string, unknown>) => void;
  private readonly kanbanFail: (cardId: number, error: string) => void;

  constructor(deps: RequesterContributionDeps = {}) {
    const db = deps.taskDb ?? (requireTaskDatabase() as unknown as TaskDb);
    this.taskDb = db;
    this.contributionStore = deps.contributionStore ?? new ContributionStore(
      db as never,
      {
        kanbanGetCard: (id: number) => kanbanGetCard(id) ?? undefined,
        kanbanUpdate,
        kanbanComplete: () => {},
        kanbanFail: () => {}, // proxy failures are projected via the injected kanbanFail port below
      },
    );
    this.reviewStore = deps.reviewStore ?? new ProjectReviewStore(db as never);
    this.askHelp = deps.askHelp ?? (async (peer, request) => getPeerTransport().askHelp(peer, request));
    this.wakeProject = deps.wakeProject ?? requestReconcileForProject;
    this.kanbanUpdate = deps.kanbanUpdate ?? kanbanUpdate;
    this.kanbanFail = deps.kanbanFail ?? kanbanFail;
  }

  getContributionStore(): ContributionStore {
    return this.contributionStore;
  }

  /**
   * Reserve and send one contribution, then project the immediate outcome.
   * Durable reservation (root/proxy/ledger) commits BEFORE any network I/O.
   * An ambiguous transport result becomes `unknown` with the same request ID —
   * recoverable, never a second request or automatic remote execution.
   */
  async delegate(input: DelegateContributionInput): Promise<DelegateContributionResult> {
    let projectCardId: number | null;
    let rootCriteria: string[];
    let title: string;
    if (input.binding.kind === "create_cli_project") {
      const existingLedger = this.contributionStore.getContribution(input.peer, input.request.request_id);
      if (existingLedger?.project_card_id) {
        // #1618: replay of a CLI delegation reuses the durable root/proxy —
        // never a second root, proxy, or ledger row.
        projectCardId = existingLedger.project_card_id;
      } else {
        projectCardId = this.createCliProject(input.binding, input.request, input.peer);
      }
      rootCriteria = [];
      title = input.binding.title;
    } else {
      projectCardId = input.binding.projectCardId;
      rootCriteria = input.binding.rootCriteria;
      title = `[help:${input.peer}] ${input.request.goal.slice(0, 80)}`;
    }

    const requestHash = canonicalContributionHash(input.request, projectCardId, rootCriteria);
    const priority = (input.request.priority ?? "MEDIUM").toUpperCase();

    const reserve = this.contributionStore.reserveProxy({
      peer: input.peer,
      requestId: input.request.request_id,
      requestHash,
      projectCardId,
      proxyCardId: input.proxyCardId,
      title,
      goal: input.request.goal,
      priority,
      sourcePeer: input.peer,
      notes: {
        peer: input.peer,
        goal: input.request.goal,
        requires: input.request.required_capabilities ?? [],
        root_criteria: rootCriteria,
        executor: input.request.target?.executor ?? "agent",
        request_id: input.request.request_id,
        outcome: "pending",
      },
    });

    if (reserve.status === "conflict") {
      throw new Error(`Request ${input.request.request_id} to ${input.peer} conflicts with an existing contribution with different parameters`);
    }

    const contributionRef = reserve.contributionRef ?? `help_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const proxyCardId = reserve.proxyCardId;
    if (!proxyCardId) throw new Error("Failed to persist help request");

    if (reserve.status === "replay") {
      const existing = this.contributionStore.getContribution(input.peer, input.request.request_id);
      if (existing && existing.state !== "pending") {
        logInfo(TAG, `replay of ${existing.state} request ${input.request.request_id} to ${input.peer} — no resend`);
        const decision: ContributionDecision = existing.state === "accepted" || existing.state === "running" || existing.state === "completed"
          ? "accepted"
          : existing.state === "declined"
            ? "declined"
            : existing.state === "deferred"
              ? "deferred"
              : "unknown";
        return {
          decision,
          projectCardId,
          proxyCardId,
          requestId: input.request.request_id,
          contributionRef: existing.contribution_ref,
          response: existing.projection_json ? JSON.parse(existing.projection_json) as PeerHelpResponseV1 : undefined,
        };
      }
    }

    let response: PeerHelpResponseV1;
    try {
      response = await this.askHelp(input.peer, input.request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `help request ${input.request.request_id} to ${input.peer} failed: ${message}`);
      try {
        this.contributionStore.transitionToNonStarted(input.peer, input.request.request_id, "unknown");
        this.kanbanUpdate(proxyCardId, { notes: JSON.stringify({ outcome: "unknown", request_id: input.request.request_id }) });
      } catch {}
      return {
        decision: "unknown",
        projectCardId,
        proxyCardId,
        requestId: input.request.request_id,
        contributionRef,
        error: message,
      };
    }

    if (response.decision === "accepted") {
      const acceptedRef = response.contribution_ref ?? contributionRef;
      if (!this.contributionStore.adoptContributionRef(input.peer, input.request.request_id, acceptedRef)) {
        throw new Error("Accepted response has a conflicting contribution reference");
      }
      this.contributionStore.transitionToAccepted(input.peer, input.request.request_id);
      const notes: Record<string, unknown> = {
        peer: input.peer,
        goal: input.request.goal,
        requires: input.request.required_capabilities ?? [],
        root_criteria: rootCriteria,
        parent_project_id: projectCardId,
        executor: input.request.target?.executor ?? "agent",
        request_id: input.request.request_id,
        outcome: "accepted",
        contribution_ref: acceptedRef,
      };
      if (response.remote_run_id) notes.remote_run_id = response.remote_run_id;
      if (response.remote_card_id !== undefined) notes.remote_card_id = response.remote_card_id;
      if (response.remote_generation !== undefined) notes.remote_generation = response.remote_generation;
      if (response.remote_session_id) notes.remote_session_id = response.remote_session_id;
      this.kanbanUpdate(proxyCardId, { notes: JSON.stringify(notes) });
      logInfo(TAG, `help accepted by ${input.peer}: ref=${acceptedRef}`);
      return {
        decision: "accepted",
        projectCardId,
        proxyCardId,
        requestId: input.request.request_id,
        contributionRef: acceptedRef,
        response,
      };
    }

    const decision = response.decision as ContributionDecision;
    this.contributionStore.transitionToNonStarted(input.peer, input.request.request_id, decision);
    const notes: Record<string, unknown> = {
      peer: input.peer,
      goal: input.request.goal,
      requires: input.request.required_capabilities ?? [],
      root_criteria: rootCriteria,
      parent_project_id: projectCardId,
      executor: input.request.target?.executor ?? "agent",
      request_id: input.request.request_id,
      outcome: decision,
      contribution_ref: contributionRef,
    };
    this.kanbanUpdate(proxyCardId, { notes: JSON.stringify(notes) });
    if (input.terminalizeNonStarted !== false) {
      this.kanbanFail(proxyCardId, `peer help ${decision}`);
    }
    logInfo(TAG, `help ${decision} by ${input.peer}${response.reason ? `: ${response.reason}` : ""}`);
    return {
      decision,
      projectCardId,
      proxyCardId,
      requestId: input.request.request_id,
      contributionRef,
      response,
    };
  }

  /**
   * #1618: one transaction creates the CLI delegation project — the local
   * supervised O root, its awaiting_contract supervision row, and the running
   * contribution proxy child. The requester ledger row lands with the real
   * peer in the follow-up reserveProxy call inside the same flow. The root is
   * event-woken only after commit.
   */
  private createCliProject(binding: { title: string; goal: string }, request: PeerHelpRequestV1, peer: string): number {
    const rootCardId = this.taskDb.transaction(() => {
      const root = this.taskDb.prepare(
        `INSERT INTO kanban_board (title, source, source_id, priority, status, type, goal, notes, parent_id, delivery_mode)
         VALUES (?, 'cli', ?, 'HIGH', 'queued', 'O', ?, ?, NULL, 'silent')`
      ).run(
        binding.title,
        request.request_id,
        cliRootGoal(request.request_id),
        JSON.stringify({ delegation: true, request_id: request.request_id, peer }),
      );
      const rootId = Number(root.lastInsertRowid);
      if (!rootId) throw new Error("Failed to create delegation project root");

      this.reviewStore.ensureAwaitingContract(rootId);

      const proxy = this.taskDb.prepare(
        `INSERT INTO kanban_board (title, source, source_id, priority, status, type, goal, notes, parent_id, delivery_mode, source_peer)
         VALUES (?, 'peer', ?, 'HIGH', 'running', 'contribution', ?, ?, ?, 'silent', ?)`
      ).run(
        binding.title,
        request.request_id,
        request.goal,
        JSON.stringify({ peer, goal: request.goal, request_id: request.request_id, outcome: "pending" }),
        rootId,
        peer,
      );
      const proxyCardId = Number(proxy.lastInsertRowid);
      if (!proxyCardId) throw new Error("Failed to create contribution proxy");

      const ledger = this.taskDb.prepare(
        `INSERT INTO peer_contributions
          (peer, request_id, request_hash, contribution_ref, project_card_id, proxy_card_id,
           root_criteria_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', datetime('now'), datetime('now'))`
      ).run(
        peer,
        request.request_id,
        canonicalContributionHash(request, rootId, []),
        `help_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        rootId,
        proxyCardId,
      );
      void ledger;
      return rootId;
    });

    this.wakeProject(rootCardId);
    return rootCardId;
  }
}
