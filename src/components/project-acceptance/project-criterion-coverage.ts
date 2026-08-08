import { createHash } from "node:crypto";
import { ProjectReviewStore } from "./project-review-store.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { kanbanGetChildren, requireTaskDatabase } from "../tasks/kanban-board.js";
import {
  validateContract,
  findUncoveredCriteria,
  criterionPolicyView,
  type ContractCriterionMapping,
  type ProjectAcceptanceContract,
  type CriterionExecutionOwner,
} from "./project-contract.js";

/**
 * #1604: the only coverage read-model. Gathers the root contract, the child
 * cards, and their contracts, and reduces them to one fail-closed coverage
 * result. `findUncoveredCriteria` stays the only coverage algorithm.
 *
 * #1605: the read-model classifies every root criterion as `mapped`,
 * `orc_owned`, or `gap`. Only delegated criteria participate in coverage;
 * Orc-owned criteria are satisfied by the Orc's review, never by a Worker.
 */

export interface CriterionCoverage {
  criterionId: string;
  required: boolean;
  executionOwner: CriterionExecutionOwner;
  state: "mapped" | "orc_owned" | "gap";
  mappedContractIds: readonly string[];
}

export interface CoverageRead {
  readonly criterionIds: readonly string[];
  readonly criteria: readonly CriterionCoverage[];
  readonly mappings: readonly ContractCriterionMapping[];
  readonly uncovered: readonly string[];
}

export type CoverageResult =
  | { readonly kind: "no_project_contract" }
  | { readonly kind: "undeterminable"; readonly reason: string }
  | { readonly kind: "read"; readonly read: CoverageRead };

function parseRootContract(contractRow: { contract_json: string } | undefined): ProjectAcceptanceContract | undefined {
  if (!contractRow) return undefined;
  try {
    const parsed = JSON.parse(contractRow.contract_json) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed["criteria"])) return undefined;
    const validated = validateContract(parsed);
    if (!validated.ok) return undefined;
    return validated.contract;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function childSupportsRootCriteria(childContractJson: string): readonly string[] | undefined {
  try {
    const parsed = JSON.parse(childContractJson) as unknown;
    if (!isRecord(parsed)) return undefined;
    const raw = parsed["supports_root_criteria"];
    if (!Array.isArray(raw)) return [];
    return raw.filter((value): value is string => typeof value === "string");
  } catch {
    return undefined;
  }
}

/**
 * Fail-closed coverage evaluation:
 * - no `project_contracts` row for the root card → `no_project_contract`
 * - root `contract_json` unparseable, unsupported version, or invalid → `undeterminable`
 * - a child's `contract_json` unparseable → `undeterminable` (never "skip and
 *   treat as unmapped" — an unreadable child could be silently hiding a gap)
 * - child with no contract row → not a mapping source, NOT undeterminable (an
 *   unsupervised sibling is legitimate)
 * - otherwise → `read` with per-criterion states and `uncovered` = delegated
 *   gaps only
 */
export function readProjectCriterionCoverage(rootCardId: number): CoverageResult {
  const reviewStore = new ProjectReviewStore();
  const rootContractRow = reviewStore.getContractByProjectCardId(rootCardId);
  if (!rootContractRow) return { kind: "no_project_contract" };

  const rootContract = parseRootContract(rootContractRow);
  if (!rootContract) {
    return { kind: "undeterminable", reason: `root contract for project #${rootCardId} is missing, unparseable, or has an unsupported schema version` };
  }

  const supStore = new WorkerSupervisionStore();
  const mappings: ContractCriterionMapping[] = [];
  for (const child of kanbanGetChildren(rootCardId)) {
    const contractRow = supStore.getContractByCardId(child.id);
    if (!contractRow) continue; // unsupervised sibling — not a mapping source
    const supports = childSupportsRootCriteria(contractRow.contract_json);
    if (supports === undefined) {
      return { kind: "undeterminable", reason: `child contract for card #${child.id} under project #${rootCardId} is unparseable` };
    }
    if (supports.length > 0) {
      mappings.push({ child_contract_id: contractRow.id, supports_root_criteria: supports });
    }
  }

  // #1604: peer contributions are mapping sources too — a completed remote
  // contribution declares the root criteria it supports and is accepted as
  // evidence by the review case. Without this, a contribution-only project
  // would be gated as uncovered and never reach review.
  const contributionRows = peerContributionRootCriteria(rootCardId);
  if (contributionRows === undefined) {
    return { kind: "undeterminable", reason: `peer contributions for project #${rootCardId} are unreadable` };
  }
  for (const row of contributionRows) {
    if (row.rootCriteria.length > 0) {
      mappings.push({ child_contract_id: `peer:${row.peer}:${row.requestId}`, supports_root_criteria: row.rootCriteria });
    }
  }

  // #1605: filter mappings to delegated ids only — a mapping referencing an
  // Orc-owned criterion is a bad delegation reference and cannot cover it.
  const delegatedIds = new Set(criterionPolicyView(rootContract).filter(c => c.execution_owner === "delegated").map(c => c.id));
  const legalMappings = mappings.map(m => ({
    child_contract_id: m.child_contract_id,
    supports_root_criteria: m.supports_root_criteria.filter(id => delegatedIds.has(id)),
  }));

  const uncovered = findUncoveredCriteria(rootContract, legalMappings);

  // Per-criterion classification (design §3): orc_owned → no mapping lookup;
  // delegated with ≥1 mapping → mapped; delegated with none → gap.
  const mappedBy = new Map<string, string[]>();
  for (const m of legalMappings) {
    for (const rcId of m.supports_root_criteria) {
      const list = mappedBy.get(rcId) ?? [];
      list.push(m.child_contract_id);
      mappedBy.set(rcId, list);
    }
  }
  const criteria = criterionPolicyView(rootContract).map(c => {
    if (c.execution_owner === "orc") {
      return {
        criterionId: c.id,
        required: c.required,
        executionOwner: c.execution_owner,
        state: "orc_owned" as const,
        mappedContractIds: [],
      };
    }
    const mapped = mappedBy.get(c.id) ?? [];
    return {
      criterionId: c.id,
      required: c.required,
      executionOwner: c.execution_owner,
      state: (mapped.length > 0 ? "mapped" : "gap") as "mapped" | "gap",
      mappedContractIds: mapped,
    };
  });

  return {
    kind: "read",
    read: {
      criterionIds: criterionPolicyView(rootContract).map(c => c.id),
      criteria,
      mappings: legalMappings,
      uncovered,
    },
  };
}

/**
 * #1604: completed peer contributions mapped to a project, each with the root
 * criteria it declares. `undefined` means the contributions table exists but
 * could not be read (fail-closed — never "skip and treat as covered"). A
 * missing table means no contributions were ever recorded — empty list.
 */
function peerContributionRootCriteria(projectCardId: number): Array<{ peer: string; requestId: string; rootCriteria: readonly string[] }> | undefined {
  try {
    const db = requireTaskDatabase();
    const tableExists = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'peer_contributions'`,
    ).get();
    if (!tableExists) return [];
    const rows = db.prepare(
      `SELECT peer, request_id, root_criteria_json FROM peer_contributions
        WHERE project_card_id = ? AND state = 'completed' AND root_criteria_json IS NOT NULL`,
    ).all(projectCardId) as Array<{ peer: string; request_id: string; root_criteria_json: string }>;
    return rows.map(row => {
      let rootCriteria: readonly string[] = [];
      try {
        const parsed = JSON.parse(row.root_criteria_json) as unknown;
        if (Array.isArray(parsed)) rootCriteria = parsed.filter((v): v is string => typeof v === "string");
      } catch { rootCriteria = []; }
      return { peer: row.peer, requestId: row.request_id, rootCriteria };
    });
  } catch {
    return undefined;
  }
}

/**
 * #1605: legal root criterion ids for admission errors — DELEGATED ids only.
 * Orc-owned criteria are not mapping targets. `undefined` means the root
 * card has no project contract (the admission predicate is not applicable).
 */
export function rootCriterionIds(rootCardId: number): readonly string[] | undefined {
  const reviewStore = new ProjectReviewStore();
  const contractRow = reviewStore.getContractByProjectCardId(rootCardId);
  const rootContract = parseRootContract(contractRow);
  if (!rootContract) return undefined;
  const delegated = criterionPolicyView(rootContract)
    .filter(c => c.execution_owner === "delegated")
    .map(c => c.id);
  return delegated;
}

/**
 * Stable identity of "what we already asked the Orc about". The child card ids
 * plus the uncovered root criteria, each sorted, joined, and hashed — so an
 * unchanged child set with the same gap produces the same signature and is
 * never dispatched a second coverage round.
 */
export function coverageSignature(childCardIds: readonly number[], uncovered: readonly string[]): string {
  const sortedCards = [...childCardIds].sort((a, b) => a - b).join(",");
  const sortedUncovered = [...uncovered].sort().join(",");
  return createHash("sha1").update(`${sortedCards}|${sortedUncovered}`).digest("hex").slice(0, 16);
}
