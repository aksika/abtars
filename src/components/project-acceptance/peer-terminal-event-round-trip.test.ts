import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { kanbanEnqueue, requireTaskDatabase } from "../tasks/kanban-board.js";
import { ProjectReviewStore } from "./project-review-store.js";
import { ContributionStore } from "../peer-help/contribution-store.js";
import {
  parseContributionEvent,
  contributionEventDigest,
  type PeerContributionEventV1,
} from "../peer-help/contract.js";
import {
  INVALID_CONTRACT_PROPOSALS_EXHAUSTED,
  REVIEW_REQUEST_ABANDONED,
} from "./project-review-contract.js";

const TEST_HOME = join(tmpdir(), `ab-peer-terminal-roundtrip-${process.pid}-${Date.now()}`);

vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));

vi.mock("../peer-config.js", () => ({
  loadPeerConfig: () => ({ self: { name: "molty-receiver" }, peers: {} }),
}));

const noopKanban = {
  kanbanGetCard: () => undefined,
  kanbanUpdate: () => {},
  kanbanComplete: () => {},
  kanbanFail: () => {},
};

afterEach(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
});

/**
 * #1630 Task 4: the requester round-trip. A blocked peer-origin root must
 * produce an outbox payload that (a) passes contribution validation and
 * (b) applies on the requester side, moving the contribution from `accepted`
 * to `failed`. This is the test that would have caught the class of defect —
 * it is not mocked away.
 */
function setup(requestId: string, contributionRef: string): { cardId: number; store: ProjectReviewStore } {
  mkdirSync(TEST_HOME, { recursive: true });
  const cardId = kanbanEnqueue("peer project", "peer", undefined, {
    type: "O",
    sourcePeer: "kp",
    notes: JSON.stringify({ request_id: requestId, contribution_ref: contributionRef }),
  });
  const store = new ProjectReviewStore();
  store.initializeSupervision(cardId, `contract_${cardId}`, "awaiting_contract");
  return { cardId, store };
}

function seedAcceptedContribution(requestId: string, contributionRef: string): void {
  const contributions = new ContributionStore(requireTaskDatabase(), noopKanban as never);
  const reserve = contributions.reserve("kp", requestId, `hash_${requestId}`, null, null, null);
  expect(reserve.status).toBe("new");
  contributions.adoptContributionRef("kp", requestId, contributionRef);
  expect(contributions.transitionToAccepted("kp", requestId)).toBe(true);
}

function applyOutboxEvent(cardId: number, requestId: string, contributionRef: string, expectedReasonPart: string): void {
  const store = new ProjectReviewStore();
  const pending = store.getPendingAcceptanceOutbox(100);
  const row = pending.find(r => r.project_card_id === cardId);
  expect(row, "expected an outbox row for the settled project").toBeDefined();
  const raw = JSON.parse(row!.payload_json) as unknown;
  expect(raw).toHaveProperty("acceptance_id");

  const parsed = parseContributionEvent(raw);
  expect(parsed.ok, `outbox payload must be a valid contribution event: ${parsed.ok ? "" : parsed.error}`).toBe(true);
  if (!parsed.ok) return;
  const event = parsed.value as PeerContributionEventV1;
  expect(event.kind).toBe("failed");
  expect(event.request_id).toBe(requestId);
  expect(event.contribution_ref).toBe(contributionRef);
  expect(event.projection!.summary).toContain(expectedReasonPart);

  // Requester side: apply the terminal event to the accepted contribution.
  const contributions = new ContributionStore(requireTaskDatabase(), noopKanban as never);
  const digest = contributionEventDigest(event);
  const result = contributions.applyEvent("kp", event, digest, JSON.stringify(event.projection));
  expect(result).toBe("applied");
  const contribution = contributions.getContribution("kp", requestId);
  expect(contribution?.state).toBe("failed");
}

describe("blocked settlement → requester round trip (#1630)", () => {
  it("invalid-proposals exhaustion path: auto-derived event applies on the requester side", async () => {
    const requestId = "req_invalid_proposals";
    const contributionRef = "ref_invalid_proposals";
    const { cardId } = setup(requestId, contributionRef);
    seedAcceptedContribution(requestId, contributionRef);

    const { getOrcTools } = await import("../transport/orc-tools.js");
    const defineTool = getOrcTools().find(t => t.name === "define_project_contract");
    expect(defineTool).toBeDefined();
    const args = {
      goal: "Build the feature",
      project_card_id: String(cardId),
      criteria: JSON.stringify([{ id: "c1" }]), // structurally invalid — fails normalization
      required_outputs: JSON.stringify([{ id: "o1", description: "Output", kind: "logical", required: true }]),
    };
    const first = await defineTool!.execute(args as never);
    expect(first).toContain("[err] Invalid contract");
    const second = await defineTool!.execute(args as never);
    expect(second).toContain("[err] Invalid contract");
    const third = await defineTool!.execute(args as never);
    expect(third).toContain("blocked");

    const supervision = new ProjectReviewStore().getSupervision(cardId);
    expect(supervision?.state).toBe("blocked");
    expect(supervision?.blocked_reason).toBe(INVALID_CONTRACT_PROPOSALS_EXHAUSTED);

    applyOutboxEvent(cardId, requestId, contributionRef, INVALID_CONTRACT_PROPOSALS_EXHAUSTED);
  });

  it("abandoned-review path: auto-derived event applies on the requester side", () => {
    const requestId = "req_abandoned";
    const contributionRef = "ref_abandoned";
    const { cardId, store } = setup(requestId, contributionRef);
    seedAcceptedContribution(requestId, contributionRef);

    // Exactly the decision payload and constant the reconciler's abandoned
    // review path passes to settleBlocked (reconciler.ts handleReviewState).
    store.settleBlocked(
      cardId,
      `review_case_abandoned_${cardId}`,
      { action: "blocked", reason: "Review request abandoned (attempts/deadline)" },
      REVIEW_REQUEST_ABANDONED,
    );

    const supervision = store.getSupervision(cardId);
    expect(supervision?.state).toBe("blocked");
    expect(supervision?.blocked_reason).toBe(REVIEW_REQUEST_ABANDONED);

    applyOutboxEvent(cardId, requestId, contributionRef, REVIEW_REQUEST_ABANDONED);
  });

  it("local roots settle without an outbox row", () => {
    const cardId = kanbanEnqueue("local project", "agent", undefined, { type: "O" });
    const store = new ProjectReviewStore();
    store.initializeSupervision(cardId, `contract_local_${cardId}`, "awaiting_contract");
    store.settleBlocked(cardId, `case_local_${cardId}`, { action: "blocked", reason: "blocked" }, "local_block");
    expect(store.getPendingAcceptanceOutbox(100).find(r => r.project_card_id === cardId)).toBeUndefined();
  });

  it("outbox UNIQUE(project_card_id) guard keeps exactly one row under a second insert", () => {
    const { cardId, store } = setup("req_dup", "ref_dup");
    store.settleBlocked(cardId, `case_dup_${cardId}`, { action: "blocked", reason: "r" }, "dup_block");
    const pending = store.getPendingAcceptanceOutbox(100);
    expect(pending.filter(r => r.project_card_id === cardId).length).toBe(1);

    // A racing second settlement is impossible (supervision CAS), but a
    // stray duplicate insert must still be swallowed by INSERT OR IGNORE on
    // the UNIQUE(project_card_id) outbox table.
    const existing = pending.find(r => r.project_card_id === cardId)!;
    store.db.prepare(`
      INSERT OR IGNORE INTO project_acceptance_outbox
        (id, project_card_id, peer, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`ao_stray_${cardId}`, cardId, existing.peer, existing.payload_json, new Date().toISOString(), new Date().toISOString());
    expect(store.getPendingAcceptanceOutbox(100).filter(r => r.project_card_id === cardId).length).toBe(1);
  });
});
