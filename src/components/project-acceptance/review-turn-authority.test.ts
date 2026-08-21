import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ProjectAcceptanceContractV1 } from "./project-contract.js";
import {
  reviewCaseAvailability,
  evaluateReviewTurnContext,
  mapProjectAuthorityRejection,
  ProjectMutationRejectedError,
} from "./review-turn-authority.js";
import type { ReviewCaseAvailability } from "./review-turn-authority.js";
import type { OrcInvocationContextV2 } from "../orc-project/orc-project-contracts.js";

let TEST_HOME: string;
let ProjectReviewStore: typeof import("./project-review-store.js").ProjectReviewStore;
let store: InstanceType<typeof import("./project-review-store.js").ProjectReviewStore>;
let seq = 0;

function uniquePid(): number {
  return 22000 + (++seq);
}

function makeContract(cardId: number): ProjectAcceptanceContractV1 {
  return {
    schema_version: 1,
    id: `pc_${cardId}`,
    digest: `d_${cardId}`,
    project_card_id: cardId,
    goal: "review-turn-authority goal",
    criteria: [{ id: "c1", description: "Works", required: true, evidence_expectation: "synthesis" }],
    required_outputs: [{ id: "o1", description: "Output", kind: "logical", required: true }],
    constraints: [],
    limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
    provenance: { requested_by: "user", authored_by: "orc", created_at: "2026-08-17T00:00:00.000Z" },
  };
}

function setupSupervision(cardId: number, state: string, generation = 1): void {
  store.insertContract(makeContract(cardId));
  store.initializeSupervision(cardId, `pc_${cardId}`, state as never);
  if (generation !== 1) {
    while (store.getSupervision(cardId)!.generation < generation) store.incrementGeneration(cardId);
  }
}

function insertCase(cardId: number, generation = 1, status: "open" | "superseded" = "open"): string {
  const { id } = store.insertReviewCase(cardId, generation, 1, { schema_version: 1, project_card_id: cardId, generation }, `digest_${cardId}_${generation}`);
  if (status !== "open") store.supersedeCase(id);
  return id;
}

describe("reviewCaseAvailability (#1677)", () => {
  beforeEach(async () => {
    TEST_HOME = join(tmpdir(), `ab-review-turn-authority-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    const mod = await import("./project-review-store.js");
    ProjectReviewStore = mod.ProjectReviewStore;
    store = new ProjectReviewStore();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  it("step 1: missing supervision row -> supervision_missing", () => {
    const pid = uniquePid();
    const r = reviewCaseAvailability(store.db, { projectCardId: pid, reviewCaseId: "rc_missing" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("supervision_missing");
  });

  it.each(["accepted", "blocked"] as const)("step 2: terminal supervision (%s) -> project_terminal, not a later code", (state) => {
    const pid = uniquePid();
    setupSupervision(pid, state);
    // even a perfectly open case row cannot pass: step 2 fires before the case is read
    const caseId = insertCase(pid, 1, "open");
    const r = reviewCaseAvailability(store.db, { projectCardId: pid, reviewCaseId: caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("project_terminal");
  });

  it.each(["awaiting_contract", "executing", "repair_planned", "repairing", "needs_input"] as const)(
    "step 3: non-review non-terminal state (%s) -> project_not_reviewable",
    (state) => {
      const pid = uniquePid();
      setupSupervision(pid, state);
      const r = reviewCaseAvailability(store.db, { projectCardId: pid, reviewCaseId: "rc_any" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("project_not_reviewable");
    },
  );

  it("step 4: review state but no case row -> review_case_unknown", () => {
    const pid = uniquePid();
    setupSupervision(pid, "review_ready");
    const r = reviewCaseAvailability(store.db, { projectCardId: pid, reviewCaseId: "rc_nonexistent" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("review_case_unknown");
  });

  it("step 5: case belongs to another project -> review_case_project_mismatch", () => {
    const pid = uniquePid();
    const other = uniquePid();
    setupSupervision(pid, "review_ready");
    const caseId = insertCase(other, 1, "open");
    const r = reviewCaseAvailability(store.db, { projectCardId: pid, reviewCaseId: caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("review_case_project_mismatch");
  });

  it("step 6: case generation differs from supervision -> review_case_generation_mismatch", () => {
    const pid = uniquePid();
    setupSupervision(pid, "review_ready", 1);
    const caseId = insertCase(pid, 2, "open");
    const r = reviewCaseAvailability(store.db, { projectCardId: pid, reviewCaseId: caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("review_case_generation_mismatch");
  });

  it("step 7: closed case -> review_case_not_open", () => {
    const pid = uniquePid();
    setupSupervision(pid, "review_ready", 1);
    const caseId = insertCase(pid, 1, "superseded");
    const r = reviewCaseAvailability(store.db, { projectCardId: pid, reviewCaseId: caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("review_case_not_open");
  });

  it("returns ok with supervision and case facts when every step passes", () => {
    const pid = uniquePid();
    setupSupervision(pid, "reviewing", 1);
    const caseId = insertCase(pid, 1, "open");
    const r = reviewCaseAvailability(store.db, { projectCardId: pid, reviewCaseId: caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.facts.supervision.state).toBe("reviewing");
      expect(r.facts.supervision.generation).toBe(1);
      expect(r.facts.reviewCase.id).toBe(caseId);
      expect(r.facts.reviewCase.status).toBe("open");
    }
  });

  it("is callable inside an open transaction on the same connection (#1677 review finding 1)", () => {
    const pid = uniquePid();
    setupSupervision(pid, "review_ready", 1);
    const caseId = insertCase(pid, 1, "open");
    // A nested transaction would throw "cannot start a transaction within a
    // transaction"; the predicate must perform reads only on the caller's
    // connection and return, not throw.
    const r = store.db.transaction<ReviewCaseAvailability>(() =>
      reviewCaseAvailability(store.db, { projectCardId: pid, reviewCaseId: caseId }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("evaluateReviewTurnContext (#1677)", () => {
  const bound = (overrides?: Partial<OrcInvocationContextV2>): OrcInvocationContextV2 => ({
    version: 2,
    runId: "run_1",
    intentKey: "k",
    intentKind: "project_review",
    projectCardId: 42,
    projectGeneration: 1,
    ownershipGeneration: 1,
    ownerPeer: "local",
    ownerInstanceId: "inst",
    origin: { kind: "local" },
    ...overrides,
  });

  it("step 1: missing bound context -> context_missing", () => {
    const r = evaluateReviewTurnContext(undefined, { projectCardId: 42, reviewCaseId: "rc_1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("context_missing");
  });

  it("step 2: blank review_case_id -> invalid_arguments", () => {
    for (const reviewCaseId of [null, ""]) {
      const r = evaluateReviewTurnContext(bound(), { projectCardId: 42, reviewCaseId });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_arguments");
    }
  });

  it("step 3: null project_card_id -> invalid_arguments", () => {
    const r = evaluateReviewTurnContext(bound(), { projectCardId: null, reviewCaseId: "rc_1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_arguments");
  });

  it("step 4: argument project differs from bound -> project_mismatch", () => {
    const r = evaluateReviewTurnContext(bound(), { projectCardId: 99, reviewCaseId: "rc_1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("project_mismatch");
  });

  it("returns ok with the resolved ids when every step passes", () => {
    const r = evaluateReviewTurnContext(bound(), { projectCardId: 42, reviewCaseId: "rc_1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projectCardId).toBe(42);
      expect(r.reviewCaseId).toBe("rc_1");
    }
  });
});

describe("mapProjectAuthorityRejection (#1677)", () => {
  it.each([
    ["missing_authority", "context_missing"],
    ["project_missing", "supervision_missing"],
    ["project_terminal", "project_terminal"],
    ["generation_mismatch", "project_generation_mismatch"],
    ["run_mismatch", "review_ownership_stale"],
    ["run_failed", "review_ownership_stale"],
  ] as const)("maps %s -> %s", (input, expected) => {
    expect(mapProjectAuthorityRejection(input)).toBe(expected);
  });
});

describe("ProjectMutationRejectedError (#1677)", () => {
  it("carries the typed rejection alongside the byte-identical message", () => {
    const err = new ProjectMutationRejectedError("stale or already-settled review case rc_1", "review_ownership_stale");
    expect(err.name).toBe("ProjectMutationRejectedError");
    expect(err.message).toBe("stale or already-settled review case rc_1");
    expect(err.rejection).toBe("review_ownership_stale");
  });
});