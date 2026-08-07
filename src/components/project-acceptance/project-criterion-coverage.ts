import { createHash } from "node:crypto";
import { ProjectReviewStore } from "./project-review-store.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { kanbanGetChildren } from "../tasks/kanban-board.js";
import { findUncoveredCriteria, type ContractCriterionMapping, type ProjectAcceptanceContractV1 } from "./project-contract.js";

/**
 * #1604: the only coverage read-model. Gathers the root contract, the child
 * cards, and their contracts, and reduces them to one fail-closed coverage
 * result. `findUncoveredCriteria` stays the only coverage algorithm.
 */

export interface CoverageRead {
  readonly criterionIds: readonly string[];
  readonly mappings: readonly ContractCriterionMapping[];
  readonly uncovered: readonly string[];
}

export type CoverageResult =
  | { readonly kind: "no_project_contract" }
  | { readonly kind: "undeterminable"; readonly reason: string }
  | { readonly kind: "read"; readonly read: CoverageRead };

function parseRootContract(contractRow: { contract_json: string } | undefined): ProjectAcceptanceContractV1 | undefined {
  if (!contractRow) return undefined;
  try {
    const parsed = JSON.parse(contractRow.contract_json) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed["criteria"])) return undefined;
    return parsed as unknown as ProjectAcceptanceContractV1;
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
 * - root `contract_json` unparseable, or `criteria` not an array → `undeterminable`
 * - a child's `contract_json` unparseable → `undeterminable` (never "skip and
 *   treat as unmapped" — an unreadable child could be silently hiding a gap)
 * - child with no contract row → not a mapping source, NOT undeterminable (an
 *   unsupervised sibling is legitimate)
 * - otherwise → `read` with `uncovered = findUncoveredCriteria(...)`
 */
export function readProjectCriterionCoverage(rootCardId: number): CoverageResult {
  const reviewStore = new ProjectReviewStore();
  const rootContractRow = reviewStore.getContractByProjectCardId(rootCardId);
  if (!rootContractRow) return { kind: "no_project_contract" };

  const rootContract = parseRootContract(rootContractRow);
  if (!rootContract) {
    return { kind: "undeterminable", reason: `root contract for project #${rootCardId} is missing or has no criteria array` };
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

  const uncovered = findUncoveredCriteria(rootContract, mappings);
  return {
    kind: "read",
    read: {
      criterionIds: rootContract.criteria.map(c => c.id),
      mappings,
      uncovered,
    },
  };
}

/**
 * Legal root criterion ids for admission errors. `undefined` means the root
 * card has no project contract (the admission predicate is not applicable).
 */
export function rootCriterionIds(rootCardId: number): readonly string[] | undefined {
  const reviewStore = new ProjectReviewStore();
  const contractRow = reviewStore.getContractByProjectCardId(rootCardId);
  const rootContract = parseRootContract(contractRow);
  if (!rootContract) return undefined;
  return rootContract.criteria.map(c => c.id);
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
