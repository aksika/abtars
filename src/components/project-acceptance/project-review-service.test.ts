import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi, type Mock } from "vitest";
import type { ReviewCaseSnapshot } from "./project-review-case.js";
import type { ProjectReviewDecisionV1 } from "./project-review-validator.js";

// #1618: acceptance-outbox drain tests drive a fake broker. Hoisted so the
// module factory can reference it; tests that never call the drain are
// unaffected.
const { testBroker } = vi.hoisted(() => ({
  testBroker: { sendRequest: async (...args: unknown[]) => { throw new Error("no broker configured"); } },
}));
vi.mock("../peer-transport/peer-ws-broker.js", () => ({
  getPeerWsBroker: () => testBroker,
}));

let TEST_HOME: string;
let ProjectReviewStore: typeof import("./project-review-store.js").ProjectReviewStore;


describe("renderAcceptedSynthesis (#1605)", () => {
  let renderAcceptedSynthesis: typeof import("./project-review-service.js").renderAcceptedSynthesis;

  beforeEach(async () => {
    renderAcceptedSynthesis = (await import("./project-review-service.js")).renderAcceptedSynthesis;
  });

  function makeSnapshot(): ReviewCaseSnapshot {
    return {
      schema_version: 1,
      project_card_id: 1,
      generation: 1,
      round: 1,
      created_at: new Date().toISOString(),
      root_contract: {
        id: "pc_1",
        digest: "d",
        goal: "g",
        criteria: [
          { id: "lane1", description: "Lane 1", required: true, execution_owner: "delegated", evidence_expectation: "artifact" },
          { id: "lane3", description: "Lane 3", required: false, execution_owner: "delegated", evidence_expectation: "artifact" },
          { id: "synthesis", description: "Synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
        ],
        required_outputs: [],
        limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      },
      criterion_inputs: [
        { criterion_id: "lane1", description: "Lane 1", required: true, execution_owner: "delegated", evidence_expectation: "artifact", mapped_child_contract_ids: ["pc_child_lane1"], successful_mapped_child_contract_ids: ["pc_child_lane1"], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: ["e1"], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "supported" },
        { criterion_id: "lane3", description: "Lane 3", required: false, execution_owner: "delegated", evidence_expectation: "artifact", mapped_child_contract_ids: [], successful_mapped_child_contract_ids: [], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "gap" },
        { criterion_id: "synthesis", description: "Synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis", mapped_child_contract_ids: [], successful_mapped_child_contract_ids: [], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "orc_owned" },
      ],
      contradiction_candidates: [],
      uncovered_criteria: ["lane3"],
      child_summaries: [],
      peer_contributions: [],
      budgets: { total_cost: undefined, total_tokens: 1000, wall_clock_ms: 60000, review_round: 1, repair_round: 0 },
      evidence_ref_count: 0,
      contradiction_count: 0,
    };
  }

  function makeDecision(synthesis: string): ProjectReviewDecisionV1 {
    return {
      schema_version: 1,
      id: "rd_1",
      project_card_id: 1,
      review_case_id: "rc_1",
      project_generation: 1,
      action: "accept",
      criteria: [
        { criterion_id: "lane1", verdict: "satisfied", evidence_ids: ["e1"], rationale: "ok" },
        { criterion_id: "lane3", verdict: "unsatisfied", evidence_ids: [], rationale: "source feed unreachable" },
        { criterion_id: "synthesis", verdict: "satisfied", evidence_ids: [], rationale: "synthesized from lanes" },
      ],
      outputs: [],
      contradictions: [],
      residual_risks: [],
      synthesis,
      authored_at: new Date().toISOString(),
    };
  }

  it("returns the authored synthesis unchanged when there are no accepted optional gaps", () => {
    const decision = makeDecision("Everything fine");
    decision.criteria[1] = { criterion_id: "lane3", verdict: "satisfied", evidence_ids: [], rationale: "covered by lane1 evidence" };
    const result = renderAcceptedSynthesis(decision, makeSnapshot());
    expect(result).toBe("Everything fine");
  });

  it("appends a canonical Known gaps section in root-contract order for accepted optional gaps", () => {
    const snapshot = makeSnapshot();
    const decision = makeDecision("Report delivered");
    const result = renderAcceptedSynthesis(decision, snapshot);
    expect(result).toContain("Known gaps:");
    expect(result).toContain("- lane3: unsatisfied — source feed unreachable");
    expect(result.indexOf("Report delivered")).toBeLessThan(result.indexOf("Known gaps:"));
  });

  it("bounds the rendered result", () => {
    const snapshot = makeSnapshot();
    const decision = makeDecision("R".repeat(3900));
    decision.criteria[1] = { criterion_id: "lane3", verdict: "inconclusive", evidence_ids: [], rationale: "x".repeat(2000) };
    const result = renderAcceptedSynthesis(decision, snapshot);
    expect(result.length).toBeLessThanOrEqual(4000);
  });

  it("reserves space for the disclosure — a long authored synthesis never drops the Known gaps section", () => {
    const snapshot = makeSnapshot();
    const decision = makeDecision("R".repeat(3950));
    const result = renderAcceptedSynthesis(decision, snapshot);
    expect(result).toContain("Known gaps:");
    expect(result).toContain("- lane3: unsatisfied — source feed unreachable");
    expect(result.length).toBeLessThanOrEqual(4000);
  });

  it("keeps every optional gap ID when rationale text must be compacted", () => {
    const snapshot = makeSnapshot();
    const extraIds = Array.from({ length: 12 }, (_, i) => `gap-${i + 1}`);
    const expanded: ReviewCaseSnapshot = {
      ...snapshot,
      root_contract: {
        ...snapshot.root_contract,
        criteria: [
          ...snapshot.root_contract.criteria,
          ...extraIds.map(id => ({ id, description: id, required: false, execution_owner: "delegated" as const, evidence_expectation: "artifact" as const })),
        ],
      },
      criterion_inputs: [
        ...snapshot.criterion_inputs,
        ...extraIds.map(id => ({
          criterion_id: id,
          description: id,
          required: false,
          execution_owner: "delegated" as const,
          evidence_expectation: "artifact" as const,
          mapped_child_contract_ids: [],
          successful_mapped_child_contract_ids: [],
          unsuccessful_mapped_child_contract_ids: [],
          observed_evidence_ids: [],
          worker_claim_ids: [],
          failed_or_inconclusive_check_ids: [],
          artifact_observation_ids: [],
          retry_lineage_ids: [],
          coverage_hint: "gap" as const,
        })),
      ],
    };
    const decision = makeDecision("Report delivered");
    for (const id of extraIds) {
      decision.criteria.push({ criterion_id: id, verdict: "unsatisfied", evidence_ids: [], rationale: "x".repeat(500) });
    }

    const result = renderAcceptedSynthesis(decision, expanded);
    expect(result.length).toBeLessThanOrEqual(4000);
    for (const id of extraIds) expect(result).toContain(`- ${id}: unsatisfied`);
  });
});


describe("#1618 acceptance outbox drain retry", () => {
  let store: InstanceType<typeof ProjectReviewStore>;
  let broker: { sendRequest: Mock };

  beforeEach(async () => {
    TEST_HOME = join(tmpdir(), `ab-review-drain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    broker = { sendRequest: vi.fn() };
    testBroker.sendRequest = broker.sendRequest;
    const mod = await import("./project-review-store.js");
    ProjectReviewStore = mod.ProjectReviewStore;
    await import("./project-review-service.js");
    store = new ProjectReviewStore();
    // The task database is a module-level singleton shared across tests in this
    // describe; clear durable rows so each test starts from an empty outbox.
    store.db.prepare("DELETE FROM project_acceptance_outbox").run();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  async function drain(): Promise<number> {
    const svcMod = await import("./project-review-service.js");
    return svcMod.drainAcceptanceOutbox();
  }

  it("retains the row on broker failure and marks it sent only after a positive application ACK", async () => {
    const cardId = 91001;
    store.db.prepare(
      `INSERT INTO project_acceptance_outbox (id, project_card_id, peer, payload_json, created_at, updated_at)
       VALUES ('ao_1', ?, 'kp', ?, datetime('now'), datetime('now'))`,
    ).run(cardId, JSON.stringify({ event_id: "accept_1", kind: "completed", request_id: "r1", contribution_ref: "c1" }));

    broker.sendRequest.mockRejectedValueOnce(new Error("network down"));
    expect(await drain()).toBe(0);
    const afterFailure = store.db.prepare("SELECT sent_at, attempts, last_error FROM project_acceptance_outbox WHERE id = 'ao_1'").get() as any;
    expect(afterFailure.sent_at).toBeNull();
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.last_error).toContain("network down");

    // #1680: `undefined` is NOT a success — only literal `{ ok: true }` is.
    broker.sendRequest.mockResolvedValueOnce(undefined);
    expect(await drain()).toBe(0);
    const afterUndefined = store.db.prepare("SELECT sent_at, attempts, last_error FROM project_acceptance_outbox WHERE id = 'ao_1'").get() as any;
    expect(afterUndefined.sent_at).toBeNull();
    expect(afterUndefined.attempts).toBe(2);
    expect(afterUndefined.last_error).toBe("help_event_not_applied");

    broker.sendRequest.mockResolvedValueOnce({ ok: true });
    expect(await drain()).toBe(1);
    const afterSuccess = store.db.prepare("SELECT sent_at FROM project_acceptance_outbox WHERE id = 'ao_1'").get() as any;
    expect(afterSuccess.sent_at).not.toBeNull();
    expect(broker.sendRequest).toHaveBeenCalledWith("kp", "help.event.v1", expect.objectContaining({ kind: "completed" }));
  });

  it("#1680: negative, malformed, and non-object ACKs retain the row and increment attempts", async () => {
    const cases: Array<{ label: string; ack: unknown }> = [
      { label: "ok:false", ack: { ok: false } },
      { label: "non-object", ack: "nope" },
      { label: "null", ack: null },
      { label: "array", ack: [{ ok: true }] },
      { label: "missing ok", ack: { sent: true } },
    ];
    let seq = 0;
    for (const c of cases) {
      const cardId = 91010 + (++seq);
      const id = `ao_case_${cardId}`;
      store.db.prepare(
        `INSERT INTO project_acceptance_outbox (id, project_card_id, peer, payload_json, created_at, updated_at)
         VALUES (?, ?, 'kp', ?, datetime('now'), datetime('now'))`,
      ).run(id, cardId, JSON.stringify({ event_id: `accept_${id}`, kind: "completed" }));

      broker.sendRequest.mockResolvedValueOnce(c.ack);
      expect(await drain()).toBe(0);
      const row = store.db.prepare("SELECT sent_at, attempts, last_error FROM project_acceptance_outbox WHERE id = ?").get(id) as any;
      expect(row.sent_at, `${c.label}: sent_at must stay null`).toBeNull();
      expect(row.attempts, `${c.label}: attempts must increment`).toBe(1);
      expect(row.last_error).toBe("help_event_not_applied");
    }
  });

  it("does not resend a row already marked sent", async () => {
    const cardId = 91002;
    store.db.prepare(
      `INSERT INTO project_acceptance_outbox (id, project_card_id, peer, payload_json, sent_at, created_at, updated_at)
       VALUES ('ao_2', ?, 'kp', ?, datetime('now'), datetime('now'), datetime('now'))`,
    ).run(cardId, JSON.stringify({ event_id: "accept_2", kind: "completed" }));

    broker.sendRequest.mockResolvedValueOnce({ ok: true });
    expect(await drain()).toBe(0);
    expect(broker.sendRequest).not.toHaveBeenCalled();
  });
});
