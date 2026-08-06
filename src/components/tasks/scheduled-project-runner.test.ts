import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { createExecutionSupervisor } from "../execution-control.js";

let TEST_HOME: string;
let mod: typeof import("./scheduled-project-runner.js");
let kanban: typeof import("./kanban-board.js");
let reviewStoreMod: typeof import("../project-acceptance/project-review-store.js");
let reconciler: typeof import("../reconciler.js");
let stateStore: typeof import("./task-state-store.js");
let nerveBus: typeof import("../nerve.js")["nerve"];
let runStoreMod: typeof import("../orc-project/orc-project-run-store.js");

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `scheduled-project-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("./kanban-board.js");
  reviewStoreMod = await import("../project-acceptance/project-review-store.js");
  reconciler = await import("../reconciler.js");
  stateStore = await import("./task-state-store.js");
  nerveBus = (await import("../nerve.js")).nerve;
  runStoreMod = await import("../orc-project/orc-project-run-store.js");
  mod = await import("./scheduled-project-runner.js");
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function makeControl(ref: string): import("../execution-control.js").ExecutionControl {
  return createExecutionSupervisor({ maxConcurrent: {} }).open({ executionRef: ref, type: "T" });
}

function fakeCoordinator(): Array<{ projectCardId: number; goal: string }> {
  const claims: Array<{ projectCardId: number; goal: string }> = [];
  reconciler.setOrcCoordinator({
    scheduleScheduledProject(projectCardId: number, goal: string) {
      claims.push({ projectCardId, goal });
      // a real claim is durable — the shared driver observes the live row
      try {
        new runStoreMod.OrcProjectRunStore().claimIntent(
          { projectCardId, intentKind: "contract_authoring", originKind: "local", cardSource: "task", sourcePeer: null },
          "test-peer",
          "test-instance",
        );
      } catch { /* best effort — the driver still observes the claim result */ }
      return { kind: "claimed", context: { runId: "or_test", projectCardId } };
    },
  } as never);
  return claims;
}

function makeRequest(overrides: Record<string, unknown> = {}): ReturnType<typeof buildRequest> {
  return buildRequest(overrides);
}

function buildRequest(overrides: Record<string, unknown> = {}): {
  entryId: string;
  runId: string;
  title: string;
  goal: string;
  priority: "medium";
  maxAgents: number;
  deadlineAt: number;
  executionScope: { cwd: string; env: Record<string, string> };
  executionControl: import("../execution-control.js").ExecutionControl;
  delivery: "report";
  chatId: string;
  reportArtifactPath: string;
} {
  const ref = `spr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    entryId: "daily-ai",
    runId: "daily-ai_1",
    title: "Daily Ai",
    goal: "produce the daily briefing",
    priority: "medium",
    maxAgents: 4,
    deadlineAt: Date.now() + 60_000,
    executionScope: { cwd: join(TEST_HOME, "workspace", "daily-ai"), env: { WORKSPACE: join(TEST_HOME, "workspace", "daily-ai") } },
    executionControl: makeControl(ref),
    delivery: "report",
    chatId: "1",
    reportArtifactPath: join(TEST_HOME, "workspace", "daily-ai", "Daily-Briefing-{today}.md"),
    ...overrides,
  } as never;
}

async function seedReservation(entryId = "daily-ai", runId = "daily-ai_1"): Promise<void> {
  const now = Date.now();
  const result = stateStore.reserveRun(entryId, {
    runId,
    groupId: `${entryId}:group:${now}`,
    attempt: 1,
    trigger: "schedule",
    occurrenceAt: now,
    deadlineAt: now + 60_000,
  });
  if (!result.ok) throw new Error("reservation conflict");
}

describe("scheduled-project-runner #1516", () => {
  it("admits one root O card with the durable cap and resolves accepted synthesis", async () => {
    const claims = fakeCoordinator();
    await seedReservation();
    const control = makeControl("spr-accept");
    const request = makeRequest({ executionControl: control });

    const pending = mod.scheduledProjectRunner(request);

    expect(claims).toHaveLength(1);
    expect(claims[0]!.goal).toContain("Agent budget: 4 total agents (1 Orc + up to 3");
    expect(claims[0]!.goal).toContain("sole writer");
    expect(claims[0]!.goal).toContain("Daily-Briefing");
    expect(claims[0]!.goal).toContain("[TASK]\nproduce the daily briefing");
    expect(claims[0]!.goal).toContain("a lane that fetches live web pages needs >= 300000 ms (max_duration_ms)");
    expect(claims[0]!.goal).toContain("Every declared criterion MUST have an evidence path - a verification command or a required artifact - or the contract is rejected.");
    const cards = kanban.kanbanList("*");
    expect(cards).toHaveLength(1);
    const root = cards[0]!;
    expect(root.type).toBe("O");
    expect(root.max_agents).toBe(4);
    expect(root.source).toBe("task");
    expect(root.source_id).toBe("daily-ai_1");
    expect(root.due_at).not.toBeNull();
    expect(Date.parse(root.due_at!)).toBeGreaterThan(Date.now());
    expect(control.cardId).toBe(root.id);
    expect(stateStore.readState("daily-ai")?.activeRun?.cardId).toBe(root.id);

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleAcceptance(root.id, "case-accept", { synthesis: "final synthesis text" }, "final synthesis text", undefined, "rd_test_accept");
    nerveBus.fire("card:done", root.id);

    const result = await pending;
    expect(result).toEqual(expect.objectContaining({ cardId: root.id, result: "final synthesis text" }));
  });

  it("rejects with the blocked reason when the project is blocked", async () => {
    fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleBlocked(root.id, "case-blocked", { synthesis: "x" }, "blocker_class_xyz");
    nerveBus.fire("card:failed", root.id);

    await expect(pending).rejects.toThrow(/blocker_class_xyz/);
  });

  it("#1588: a lane completing past its hard deadline yields supervision/lane_late_completion with full lane facts", async () => {
    fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const workerId = kanban.kanbanEnqueue("Lane 3 - Web Verification", "agent", undefined, {
      parent_id: root.id,
      type: "W",
      goal: "Browse three web pages and record results",
      delivery: "silent",
    });
    const supStore = new (await import("../worker-supervision-store.js")).WorkerSupervisionStore();
    const contract: import("../worker-contract.js").WorkerAcceptanceContractV1 = {
      schema_version: 1,
      id: "c_late",
      digest: "dg_late",
      goal: "Browse three web pages and record results",
      criteria: [{ id: "c1", description: "Three web pages browsed and results recorded" }],
      expected_artifacts: [{ id: "a1", kind: "file", ref: "notes/web-results.md", required: true, criterion_ids: ["c1"] }],
      verification_commands: [],
      required_capabilities: [],
      limits: { max_duration_ms: 120000 },
      provenance: { root_card_id: root.id, card_id: workerId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    supStore.insertContract(contract, workerId);
    supStore.insertAttempt({ id: "a_late", card_id: workerId, contract_id: contract.id, ordinal: 1, executor_kind: "agent", executor_id: "spin", status: "running", started_at: "2026-08-06T13:44:00.000Z" });
    supStore.lifecycleTransition("a_late", ["running"], "timed_out", {
      cancel_reason: "late_completion_timed_out: worker_completed",
      hard_deadline_at: "2026-08-06T13:46:38.195Z",
      settled_at: "2026-08-06T13:46:45.680Z",
    });

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleBlocked(root.id, "case-late", { synthesis: "x" }, "criteria failed");
    nerveBus.fire("card:failed", root.id);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as mod.SupervisedProjectFailure;
    expect(failure.diagnostic.category).toBe("supervision");
    expect(failure.diagnostic.code).toBe("lane_late_completion");
    const lane = failure.diagnostic.context!.lanes[0]!;
    expect(lane.cardId).toBe(workerId);
    expect(lane.contractId).toBe("c_late");
    expect(lane.attemptId).toBe("a_late");
    expect(lane.lifecycle).toBe("timed_out");
    expect(lane.cancelReason).toBe("late_completion_timed_out: worker_completed");
    expect(lane.hardDeadlineAt).toBe("2026-08-06T13:46:38.195Z");
    expect(lane.settledAt).toBe("2026-08-06T13:46:45.680Z");
    expect(lane.overrunMs).toBe(7485);
    expect(lane.bindingLimit).toEqual({ name: "max_duration_ms", value: 120000 });
    expect(lane.criteria).toEqual([{ id: "c1", status: "not_run" }]);
    expect(lane.missingEvidence).toEqual([]);
    expect(failure.factAt).toBeDefined();
  });

  it("#1588: an unevidenceable lane reports criterion_unevidenced before the lane outcome", async () => {
    fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const workerId = kanban.kanbanEnqueue("Lane 3 - Web Verification", "agent", undefined, {
      parent_id: root.id,
      type: "W",
      goal: "Browse three web pages and record results",
      delivery: "silent",
    });
    const supStore = new (await import("../worker-supervision-store.js")).WorkerSupervisionStore();
    const contract: import("../worker-contract.js").WorkerAcceptanceContractV1 = {
      schema_version: 1,
      id: "c_unev",
      digest: "dg_unev",
      goal: "Browse three web pages and record results",
      criteria: [{ id: "c1", description: "Three web pages browsed and results recorded" }],
      expected_artifacts: [],
      verification_commands: [],
      required_capabilities: [],
      limits: { max_duration_ms: 120000 },
      provenance: { root_card_id: root.id, card_id: workerId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    supStore.insertContract(contract, workerId);
    supStore.insertAttempt({ id: "a_unev", card_id: workerId, contract_id: contract.id, ordinal: 1, executor_kind: "agent", executor_id: "spin", status: "running", started_at: "2026-08-06T13:44:00.000Z" });
    supStore.lifecycleTransition("a_unev", ["running"], "timed_out", {
      cancel_reason: "late_completion_timed_out: worker_completed",
      hard_deadline_at: "2026-08-06T13:46:38.195Z",
      settled_at: "2026-08-06T13:46:45.680Z",
    });

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleBlocked(root.id, "case-unev", { synthesis: "x" }, "criteria failed");
    nerveBus.fire("card:failed", root.id);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as mod.SupervisedProjectFailure;
    expect(failure.diagnostic.category).toBe("supervision");
    expect(failure.diagnostic.code).toBe("criterion_unevidenced");
    expect(failure.diagnostic.context!.lanes[0]!.missingEvidence).toContain("c1");
  });

  it("aborts the project and rejects when the scheduled deadline is already exceeded", async () => {
    fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest({ deadlineAt: Date.now() - 1000 }));

    await expect(pending).rejects.toThrow(/deadline exceeded/);
    const root = kanban.kanbanList("*")[0]!;
    expect(root.status).toBe("failed");
  });

  it("aborts the project and rejects on execution-control cancellation", async () => {
    fakeCoordinator();
    await seedReservation();
    const control = makeControl("spr-cancel");
    const pending = mod.scheduledProjectRunner(makeRequest({ executionControl: control }));
    const root = kanban.kanbanList("*")[0]!;

    control.signalCancel("deadline");
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(kanban.kanbanGetCard(root.id)?.status).toBe("failed");
    expect(new reviewStoreMod.ProjectReviewStore().getSupervision(root.id)?.state).toBe("blocked");
    expect(() => new reviewStoreMod.ProjectReviewStore().settleAcceptance(
      root.id,
      "late-case",
      { synthesis: "late" },
      "late",
    )).toThrow(/already terminal/);
  });

  it("reattaches to the persisted card on duplicate admission and never creates a second project", async () => {
    const claims = fakeCoordinator();
    await seedReservation();
    const request = makeRequest();

    const p1 = mod.scheduledProjectRunner(request);
    const p2 = mod.scheduledProjectRunner(request);

    const roots = kanban.kanbanList("*").filter(c => c.type === "O");
    expect(roots).toHaveLength(1);
    expect(claims.map(c => c.projectCardId)).toEqual([roots[0]!.id, roots[0]!.id]);

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleAcceptance(roots[0]!.id, "case-dup", { synthesis: "dup synthesis" }, "dup synthesis", undefined, "rd_test_dup");
    nerveBus.fire("card:done", roots[0]!.id);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.cardId).toBe(roots[0]!.id);
    expect(r2.cardId).toBe(roots[0]!.id);
  });

  it("refuses admission when a different run owns the active reservation", async () => {
    fakeCoordinator();
    await seedReservation("daily-ai", "other-run");
    await expect(mod.scheduledProjectRunner(makeRequest({ runId: "daily-ai_1" }))).rejects.toThrow(/admission conflict/);
    expect(kanban.kanbanList("*")).toHaveLength(0);
  });

  it("#1588: the Orc goal carries the machine-derived lane duration budget when set", async () => {
    const claims = fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest({ laneDurationMs: 600000 } as never));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.goal).toContain("every lane carries a hard max_duration_ms of 600000 ms");
    const root = kanban.kanbanList("*")[0]!;
    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleAcceptance(root.id, "case-budget", { synthesis: "ok" }, "ok", undefined, "rd_budget");
    nerveBus.fire("card:done", root.id);
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root.id }));
  });

  it("refuses a persisted card whose durable source identity belongs to another run", async () => {
    fakeCoordinator();
    await seedReservation();
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "other-run", { type: "O", maxAgents: 4 });
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });

    await expect(mod.scheduledProjectRunner(makeRequest())).rejects.toThrow(/identity conflict/);
    expect(kanban.kanbanList("*")).toHaveLength(1);
  });

  it("resolves immediately when the persisted card is already terminal", async () => {
    fakeCoordinator();
    await seedReservation();
    const store = new reviewStoreMod.ProjectReviewStore();
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "daily-ai_1", { type: "O", maxAgents: 4 });
    store.ensureAwaitingContract(root);
    store.settleAcceptance(root, "case-reattach", { synthesis: "already accepted" }, "already accepted", undefined, "rd_test_reattach");
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });

    const result = await mod.scheduledProjectRunner(makeRequest());
    expect(result).toEqual(expect.objectContaining({ cardId: root, result: "already accepted" }));
    expect(kanban.kanbanGetCard(root)?.status).toBe("done");
  });
});

describe("scheduled-project-runner #1546 reattach routing", () => {
  function seedExecutingReattach(overrides: Record<string, unknown> = {}): { root: number; store: reviewStoreMod.ProjectReviewStore; claims: Array<{ projectCardId: number; goal: string }> } {
    const claims = fakeCoordinator();
    return seedReattach({ state: "executing", claims, ...overrides }) as { root: number; store: reviewStoreMod.ProjectReviewStore; claims: Array<{ projectCardId: number; goal: string }> };
  }

  function seedReattach(opts: { state?: string; claims: Array<{ projectCardId: number; goal: string }>; cardStatus?: string; retryMarker?: string | null }): { root: number; store: reviewStoreMod.ProjectReviewStore; claims: Array<{ projectCardId: number; goal: string }> } {
    const { claims } = opts;
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "daily-ai_1", { type: "O", maxAgents: 4 });
    const store = new reviewStoreMod.ProjectReviewStore();
    if (opts.state) {
      store.ensureAwaitingContract(root);
      if (opts.state !== "awaiting_contract") {
        // a valid non-awaiting supervision carries its root contract
        store.insertContract({
          schema_version: 1,
          id: `ct_${root}`,
          digest: `dg_${root}`,
          project_card_id: root,
          goal: "daily briefing",
          criteria: [{ id: "c1", description: "goal met", required: true, evidence_expectation: "synthesis" }],
          required_outputs: [],
          constraints: [],
          limits: {},
          provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
        } as never);
        store.setState(root, opts.state as never);
      }
    }
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });
    if (opts.cardStatus === "queued") {
      const marker = opts.retryMarker ?? new Date(Date.now() + 60_000).toISOString();
      kanban._kanbanExecForTest(`UPDATE kanban_board SET status = 'queued', next_retry_at = ? WHERE id = ?`, [marker, root]);
    } else {
      kanban.kanbanRunning(root);
    }
    return { root, store, claims };
  }

  it("keeps the synchronous goal-bearing claim on an awaiting_contract reattach", async () => {
    await seedReservation();
    const { root, claims } = seedReattach({ state: "awaiting_contract", claims: fakeCoordinator() });
    const pending = mod.scheduledProjectRunner(makeRequest());

    expect(claims).toHaveLength(1);
    expect(claims[0]!.projectCardId).toBe(root);
    expect(kanban.kanbanGetCard(root)?.status).toBe("running");

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleAcceptance(root, "case-a", { synthesis: "ok" }, "ok", undefined, "rd_a");
    nerveBus.fire("card:done", root);
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("reattach in a non-terminal non-awaiting state never authors and wakes the shared driver", async () => {
    await seedReservation();
    const { root, store, claims } = seedExecutingReattach();
    const pending = mod.scheduledProjectRunner(makeRequest());

    // the runner itself claims nothing; the driver claims the continuation
    // from the wake (executing + no children + no live Orc row)
    expect(claims).toHaveLength(0);
    await new Promise(r => setTimeout(r, 20));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.projectCardId).toBe(root);
    expect(store.getSupervision(root)?.state).toBe("executing");

    store.settleAcceptance(root, "case-e", { synthesis: "executing ok" }, "executing ok", undefined, "rd_e");
    nerveBus.fire("card:done", root);
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("terminal reattach reads terminal evidence without supervision insertion or a claim", async () => {
    await seedReservation();
    const claims = fakeCoordinator();
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "daily-ai_1", { type: "O", maxAgents: 4 });
    kanban.kanbanComplete(root, null, "already completed");
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });

    const result = await mod.scheduledProjectRunner(makeRequest());

    expect(result).toEqual(expect.objectContaining({ cardId: root, result: "already completed" }));
    expect(new reviewStoreMod.ProjectReviewStore().getSupervision(root)).toBeUndefined();
    expect(claims).toHaveLength(0);
  });

  it("a reattached due queued retry is promoted only by the driver, never directly", async () => {
    await seedReservation();
    const { root, store, claims } = seedReattach({
      state: "executing",
      cardStatus: "queued",
      retryMarker: new Date(Date.now() - 1000).toISOString(),
      claims: fakeCoordinator(),
    });
    const pending = mod.scheduledProjectRunner(makeRequest());
    expect(claims).toHaveLength(0);

    await new Promise(r => setTimeout(r, 20));
    // claim-before-promotion by the driver: exactly one claim, card running
    expect(claims).toHaveLength(1);
    expect(kanban.kanbanGetCard(root)?.status).toBe("running");
    expect(kanban.kanbanGetCard(root)?.next_retry_at).toBeNull();

    store.settleAcceptance(root, "case-q", { synthesis: "queued ok" }, "queued ok", undefined, "rd_q");
    nerveBus.fire("card:done", root);
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("a reattached future queued retry stays queued and keeps its marker", async () => {
    await seedReservation();
    const { root, claims } = seedReattach({
      state: "executing",
      cardStatus: "queued",
      retryMarker: new Date(Date.now() + 60_000).toISOString(),
      claims: fakeCoordinator(),
    });
    const control = makeControl("spr-future");
    const pending = mod.scheduledProjectRunner(makeRequest({ executionControl: control }));
    await new Promise(r => setTimeout(r, 20));

    expect(claims).toHaveLength(0);
    const card = kanban.kanbanGetCard(root)!;
    expect(card.status).toBe("queued");
    expect(card.next_retry_at).not.toBeNull();

    control.signalCancel("test");
    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
