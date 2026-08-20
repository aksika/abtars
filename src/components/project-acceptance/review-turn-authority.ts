/**
 * review-turn-authority.ts — the typed rejection vocabulary for the Orc review
 * turn (#1677).
 *
 * Every rejection of a review turn carries a typed code at its producer so the
 * tool-failure diagnostic can render the real cause instead of collapsing to
 * `unknown`. Two shared ladders live here:
 *
 * - `reviewCaseAvailability` — the case/generation/status ladder, pure reads on
 *   a caller-supplied connection, safe inside an open transaction. Used by the
 *   tools (outside a transaction) and by the store's in-transaction assertion.
 * - `evaluateReviewTurnContext` — the context/argument ladder that needs the
 *   bound Orc invocation context. Never touches the database.
 *
 * `authorizeActiveProjectWork` / `baseProjectAuthorityCheck` stay owned by the
 * store; they fence durable run/authority facts, not the review-case ladder.
 */

import type { TaskDatabase } from "../tasks/kanban-board.js";
import type { ReviewCaseRow, ProjectAuthorityRejection } from "./project-review-store.js";
import type { OrcInvocationContextV1 } from "../orc-project/orc-project-contracts.js";

// ── Vocabulary ────────────────────────────────────────────────────────────────

/** Case-availability outcomes — produced by `reviewCaseAvailability`. */
export type ReviewCaseUnavailable =
  | "supervision_missing"
  | "project_terminal"
  | "project_not_reviewable"
  | "review_case_unknown"
  | "review_case_project_mismatch"
  | "review_case_generation_mismatch"
  | "review_case_not_open";

/** Everything a review tool can reject with. */
export type ReviewTurnRejection =
  | ReviewCaseUnavailable
  | "context_missing"                 // no bound Orc context
  | "invalid_arguments"               // missing/non-positive project_card_id or review_case_id
  | "project_mismatch"                // arg project != bound project
  | "project_generation_mismatch"     // bound or declared generation != current
  | "review_case_unreadable"          // snapshot unparseable or structurally invalid
  | "review_ownership_stale"          // a supervision/ownership CAS was lost
  | "settlement_lost"                 // durable kanban settlement race
  | "peer_terminal_identity_missing"  // peer root with no unique accepted help identity
  | "peer_terminal_identity_mismatch" // accepted help identity does not match the card's source peer
  | "internal_error";                 // unclassified throw

/**
 * Map a durable project-authority rejection onto the review-turn vocabulary so
 * the store's union (`ProjectAuthorityRejection`) reaches the tool catch with a
 * typed cause instead of collapsing to `internal_error`.
 */
export function mapProjectAuthorityRejection(rejection: ProjectAuthorityRejection): ReviewTurnRejection {
  switch (rejection) {
    case "missing_authority": return "context_missing";
    case "project_missing": return "supervision_missing";
    case "project_terminal": return "project_terminal";
    case "generation_mismatch": return "project_generation_mismatch";
    case "run_mismatch": return "review_ownership_stale";
    case "run_failed": return "review_ownership_stale";
  }
}

// ── Case-availability ladder ──────────────────────────────────────────────────

export interface ReviewCaseFacts {
  supervision: { state: string; generation: number };
  reviewCase: ReviewCaseRow;
}

export type ReviewCaseAvailability =
  | { ok: true; facts: ReviewCaseFacts }
  | { ok: false; code: ReviewCaseUnavailable; detail: string };

interface SupervisionFactsRow {
  state: string;
  generation: number;
}

/**
 * Reads only, on the caller's connection. Safe to call inside an open
 * transaction (the store's assertion path) and outside one (the tools). Never
 * opens a transaction, never writes, never constructs a store.
 *
 * Ladder (exact order):
 * 1. no `project_supervision` row → `supervision_missing`
 * 2. supervision terminal (`accepted`/`blocked`) → `project_terminal`
 * 3. supervision outside `review_ready | review_requested | reviewing` →
 *    `project_not_reviewable`
 * 4. no case row → `review_case_unknown`
 * 5. `case.project_card_id !== projectCardId` → `review_case_project_mismatch`
 * 6. `case.generation !== supervision.generation` → `review_case_generation_mismatch`
 * 7. `case.status !== "open"` → `review_case_not_open`
 *
 * `detail` returns the exact prose the corresponding branch produces today, so
 * the tool envelope stays byte-identical apart from the added `reason` field.
 */
export function reviewCaseAvailability(
  db: TaskDatabase,
  input: { projectCardId: number; reviewCaseId: string },
): ReviewCaseAvailability {
  const supervision = db.prepare(`SELECT state, generation FROM project_supervision WHERE project_card_id = ?`)
    .get(input.projectCardId) as unknown as SupervisionFactsRow | undefined;
  if (!supervision) {
    return { ok: false, code: "supervision_missing", detail: "No project supervision state found. Is this a supervised project?" };
  }
  if (supervision.state === "accepted" || supervision.state === "blocked") {
    return { ok: false, code: "project_terminal", detail: `Project is in state "${supervision.state}", not ready for review` };
  }
  if (supervision.state !== "review_ready" && supervision.state !== "review_requested" && supervision.state !== "reviewing") {
    return { ok: false, code: "project_not_reviewable", detail: `Project is in state "${supervision.state}", not ready for review` };
  }

  const reviewCase = db.prepare(`SELECT * FROM project_review_cases WHERE id = ?`)
    .get(input.reviewCaseId) as unknown as ReviewCaseRow | undefined;
  if (!reviewCase) {
    return { ok: false, code: "review_case_unknown", detail: `Review case "${input.reviewCaseId}" not found` };
  }
  if (reviewCase.project_card_id !== input.projectCardId) {
    return { ok: false, code: "review_case_project_mismatch", detail: `Case "${input.reviewCaseId}" does not belong to project ${input.projectCardId}` };
  }
  if (reviewCase.generation !== supervision.generation) {
    return { ok: false, code: "review_case_generation_mismatch", detail: `Case generation ${reviewCase.generation} does not match supervision generation ${supervision.generation}` };
  }
  if (reviewCase.status !== "open") {
    return { ok: false, code: "review_case_not_open", detail: `Review case "${input.reviewCaseId}" is ${reviewCase.status}, not open` };
  }

  return { ok: true, facts: { supervision, reviewCase } };
}

// ── Tool-only context ladder ──────────────────────────────────────────────────

export type ReviewTurnContext =
  | { ok: true; projectCardId: number; reviewCaseId: string }
  | { ok: false; code: "context_missing" | "invalid_arguments" | "project_mismatch"; detail: string };

/**
 * The checks that need the bound Orc invocation context: bound present,
 * argument presence, project match. Never touches the database.
 *
 * Ladder (exact order):
 * 1. `bound` missing → `context_missing`
 * 2. `reviewCaseId` blank → `invalid_arguments`
 * 3. `projectCardId` null → `invalid_arguments`
 * 4. `projectCardId !== bound.projectCardId` → `project_mismatch`
 *
 * The `context_missing` detail is generic; the tool supplies its own
 * tool-specific prose when it builds the envelope (the two review tools carry
 * different context-missing messages today).
 */
export function evaluateReviewTurnContext(
  bound: OrcInvocationContextV1 | undefined,
  args: { projectCardId: number | null; reviewCaseId: string | null },
): ReviewTurnContext {
  if (!bound) {
    return { ok: false, code: "context_missing", detail: "No active Orc project." };
  }
  if (!args.reviewCaseId || args.reviewCaseId.length === 0) {
    return { ok: false, code: "invalid_arguments", detail: "review_case_id is required." };
  }
  if (args.projectCardId === null) {
    return { ok: false, code: "invalid_arguments", detail: "project_card_id is required and must be a positive integer." };
  }
  if (args.projectCardId !== bound.projectCardId) {
    return { ok: false, code: "project_mismatch", detail: `project_card_id ${args.projectCardId} does not match the bound project ${bound.projectCardId}` };
  }
  return { ok: true, projectCardId: args.projectCardId, reviewCaseId: args.reviewCaseId };
}

// ── Typed store rejection ─────────────────────────────────────────────────────

/**
 * A review mutation rejected by the store after its preflight. Keeps the cause
 * typed so the tool `catch` can classify it instead of collapsing to
 * `internal_error`. The message stays byte-identical to the pre-#1677 prose.
 */
export class ProjectMutationRejectedError extends Error {
  readonly rejection: ReviewTurnRejection;

  constructor(message: string, rejection: ReviewTurnRejection) {
    super(message);
    this.name = "ProjectMutationRejectedError";
    this.rejection = rejection;
  }
}