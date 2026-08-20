import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { kanbanEnqueue, requireTaskDatabase } from "../tasks/kanban-board.js";
import { ProjectReviewStore } from "./project-review-store.js";
import { ContributionStore } from "../peer-help/contribution-store.js";
import { PeerHelpStore } from "../peer-help/store.js";
import {
  parseContributionEvent,
  contributionEventDigest,
  type PeerContributionEventV1,
} from "../peer-help/contract.js";
import {
  INVALID_CONTRACT_PROPOSALS_EXHAUSTED,
  REVIEW_REQUEST_ABANDONED,
} from "./project-review-contract.js";
import { ProjectMutationRejectedError } from "./review-turn-authority.js";

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

const noopNerve = { fire: () => {} };

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
  // #1680: the escaped receiver card had its notes replaced with non-JSON
  // text. The fixture recreates that exact shape BEFORE acceptance so the
  // settlement proves it derives the terminal event from the durable help
  // ledger, never from card notes.
  const cardId = kanbanEnqueue("peer project", "peer", undefined, {
    type: "O",
    sourcePeer: "kp",
    notes: "{not-json",
  });
  const store = new ProjectReviewStore();
  store.initializeSupervision(cardId, `contract_${cardId}`, "awaiting_contract");
  // Migrate the receiver help ledger so the durable identity lookup has a home.
  new PeerHelpStore(requireTaskDatabase(), noopKanban as never, noopNerve as never);
  return { cardId, store };
}

function seedAcceptedContribution(cardId: number, requestId: string, contributionRef: string): void {
  // Requester-side ledger (what the requester will reduce).
  const contributions = new ContributionStore(requireTaskDatabase(), noopKanban as never);
  const reserve = contributions.reserve("kp", requestId, `hash_${requestId}`, null, null, null);
  expect(reserve.status).toBe("new");
  contributions.adoptContributionRef("kp", requestId, contributionRef);
  expect(contributions.transitionToAccepted("kp", requestId)).toBe(true);

  // Receiver-side accepted help identity keyed by the local card (what the
  // settlement resolver reads). #1680: the correlation authority.
  requireTaskDatabase().prepare(`
    INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, contribution_ref, local_card_id, response_json, created_at, updated_at)
    VALUES ('kp', ?, ?, 'accepted', ?, ?, '{}', datetime('now'), datetime('now'))
  `).run(requestId, `hash_${requestId}`, contributionRef, cardId);
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
    seedAcceptedContribution(cardId, requestId, contributionRef);

    const { getOrcTools } = await import("../transport/orc-tools.js");
    const defineTool = getOrcTools().find(t => t.name === "define_project_contract");
    expect(defineTool).toBeDefined();
    const args = {
      goal: "Build the feature",
      project_card_id: String(cardId),
      criteria: JSON.stringify([{ id: "c1" }]), // structurally invalid — fails normalization
      required_outputs: JSON.stringify([{ id: "o1", description: "Output", kind: "logical", required: true }]),
    };
    // #1644: contract authoring requires the bound Orc invocation context.
    const context = { userId: "test", orcContext: { version: 1, runId: `or_${cardId}_1`, intentKey: `contract:${cardId}:1`, projectCardId: cardId, projectGeneration: 1, ownershipGeneration: 1, ownerPeer: "local", ownerInstanceId: "test", origin: { kind: "local" } } } as never;
    const first = await defineTool!.execute(args as never, context);
    expect(first).toContain("[err] Invalid contract");
    const second = await defineTool!.execute(args as never, context);
    expect(second).toContain("[err] Invalid contract");
    const third = await defineTool!.execute(args as never, context);
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
    seedAcceptedContribution(cardId, requestId, contributionRef);

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
    seedAcceptedContribution(cardId, "req_dup", "ref_dup");
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

  it("#1680 accepted settlement on a peer card with overwritten non-JSON notes commits one supervision/card transition and one correlated outbox row", () => {
    const requestId = "req_accept";
    const contributionRef = "ref_accept";
    const { cardId, store } = setup(requestId, contributionRef);
    seedAcceptedContribution(cardId, requestId, contributionRef);

    // The review/card transition runs inside the same transaction as the
    // outbox insert; the notes are corrupt and must be irrelevant.
    store.settleAcceptance(
      cardId,
      `case_accept_${cardId}`,
      { action: "accept", synthesis: "peer finished" },
      "peer finished",
      { kind: "completed", summary: "peer finished" },
      `rd_settle_accept_${cardId}`,
    );

    const supervision = store.getSupervision(cardId);
    expect(supervision?.state).toBe("accepted");
    const card = requireTaskDatabase().prepare("SELECT status FROM kanban_board WHERE id = ?").get(cardId) as { status: string };
    expect(card.status).toBe("done");

    const pending = store.getPendingAcceptanceOutbox(100);
    const rows = pending.filter(r => r.project_card_id === cardId);
    expect(rows).toHaveLength(1);
    const raw = JSON.parse(rows[0]!.payload_json) as any;
    expect(raw.kind).toBe("completed");
    expect(raw.request_id).toBe(requestId);
    expect(raw.contribution_ref).toBe(contributionRef);
    expect(raw.acceptance_id).toContain("rd_settle_accept");
  });

  it("#1680 fail-closed: peer settlement with no accepted help identity rolls back decision, supervision, card, and outbox", () => {
    const { cardId, store } = setup("req_missing", "ref_missing");

    let thrown: unknown;
    try {
      store.settleBlocked(cardId, `case_missing_${cardId}`, { action: "blocked", reason: "r" }, "block_class");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProjectMutationRejectedError);
    expect((thrown as ProjectMutationRejectedError).rejection).toBe("peer_terminal_identity_missing");

    const supervision = store.getSupervision(cardId);
    expect(supervision?.state).toBe("awaiting_contract"); // not terminal
    const card = requireTaskDatabase().prepare("SELECT status FROM kanban_board WHERE id = ?").get(cardId) as { status: string };
    expect(card.status).toBe("queued"); // not terminal
    expect(store.getPendingAcceptanceOutbox(100).filter(r => r.project_card_id === cardId)).toHaveLength(0);
    expect(store.hasDecisionForCase(`case_missing_${cardId}`)).toBe(false);
  });

  it("#1680 fail-closed: a mismatched accepted identity rejects with peer_terminal_identity_mismatch", () => {
    const { cardId, store } = setup("req_mismatch", "ref_mismatch");
    // Seed an accepted row whose origin peer differs from the card's source_peer.
    requireTaskDatabase().prepare(`
      INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, contribution_ref, local_card_id, response_json, created_at, updated_at)
      VALUES ('molty', 'req_mismatch', 'h', 'accepted', 'ref_mismatch', ?, '{}', datetime('now'), datetime('now'))
    `).run(cardId);

    let thrown: unknown;
    try {
      store.settleBlocked(cardId, `case_mismatch_${cardId}`, { action: "blocked", reason: "r" }, "block_class");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProjectMutationRejectedError);
    expect((thrown as ProjectMutationRejectedError).rejection).toBe("peer_terminal_identity_mismatch");

    const supervision = store.getSupervision(cardId);
    expect(supervision?.state).toBe("awaiting_contract");
    expect(store.getPendingAcceptanceOutbox(100).filter(r => r.project_card_id === cardId)).toHaveLength(0);
  });

  it("#1680 fail-closed: duplicate accepted identities reject as missing (no unique mapping)", () => {
    const { cardId, store } = setup("req_dup2", "ref_dup2");
    requireTaskDatabase().prepare(`
      INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, contribution_ref, local_card_id, response_json, created_at, updated_at)
      VALUES ('kp', 'req_dup2', 'h', 'accepted', 'ref_dup2', ?, '{}', datetime('now'), datetime('now'))
    `).run(cardId);
    requireTaskDatabase().prepare(`
      INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, contribution_ref, local_card_id, response_json, created_at, updated_at)
      VALUES ('kp', 'req_dup2b', 'h', 'accepted', 'ref_dup2b', ?, '{}', datetime('now'), datetime('now'))
    `).run(cardId);

    let thrown: unknown;
    try {
      store.settleBlocked(cardId, `case_dup2_${cardId}`, { action: "blocked", reason: "r" }, "block_class");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProjectMutationRejectedError);
    expect((thrown as ProjectMutationRejectedError).rejection).toBe("peer_terminal_identity_missing");
    expect(store.getPendingAcceptanceOutbox(100).filter(r => r.project_card_id === cardId)).toHaveLength(0);
  });
});
