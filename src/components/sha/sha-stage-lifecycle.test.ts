import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShaIncidentCoordinator } from "./sha-incident-coordinator.js";
import { ShaIncidentStore } from "./sha-incident-store.js";
import { ShaWorkspaceManager } from "./sha-workspace-manager.js";
import type { ScheduledFailureEvent } from "./sha-types.js";
import { makeTaskFailure } from "../tasks/task-failure.js";
import { requireTaskDatabase, kanbanTransition, kanbanGetCard, kanbanEnqueue } from "../tasks/kanban-board.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import type { WorkerResultEnvelopeV1 } from "../worker-contract.js";
import { nerve } from "../nerve.js";

let TEST_HOME: string;
let db: ReturnType<typeof requireTaskDatabase>;
let supervision: WorkerSupervisionStore;

const savedHome = process.env["ABTARS_HOME"];

function fakeWorkspace(): ShaWorkspaceManager {
  const preflight = { ok: true, canonicalPath: "/tmp/sha-ws", root: null, baselineCommit: "abc", clean: true } as const;
  return {
    preflight: vi.fn().mockResolvedValue(preflight),
    resolve: vi.fn().mockResolvedValue(preflight),
    prepareStage: vi.fn().mockResolvedValue({ ok: true }),
    assertAnalysisClean: vi.fn().mockResolvedValue({ ok: true }),
    assertAnalysisCleanExcluding: vi.fn().mockResolvedValue({ ok: true }),
    copyEvidence: vi.fn().mockResolvedValue({ ok: true }),
    protectedRoots: () => [],
  } as unknown as ShaWorkspaceManager;
}

beforeEach(async () => {
  TEST_HOME = join(tmpdir(), `sha-stage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env["ABTARS_HOME"] = TEST_HOME;
  mkdirSync(join(TEST_HOME, "config"), { recursive: true });
  mkdirSync(join(TEST_HOME, "kanban"), { recursive: true });
  writeFileSync(
    join(TEST_HOME, "config", "pi-executor.json"),
    JSON.stringify({
      enabled: true, command: "pi", fixedArgs: [], allowedEnv: [], maxConcurrent: 1,
      maxWallClockMs: 1800000, abortGraceMs: 10000, projectTrust: "never",
      workspaceAliases: { sha: { path: join(TEST_HOME, "sha-ws"), root: TEST_HOME, projectTrust: "never" } },
      sessionStorageRoot: join(TEST_HOME, "state"),
    }),
  );
  mkdirSync(join(TEST_HOME, "sha-ws"), { recursive: true });
  mkdirSync(join(TEST_HOME, "sha-ws", ".git"), { recursive: true });
  db = requireTaskDatabase();
  supervision = new WorkerSupervisionStore(db);
  for (const table of [
    "sha_incident_transitions", "sha_incident_events", "sha_incidents", "sha_fault_state",
    "worker_attempts", "worker_contracts", "worker_results", "project_contracts", "project_supervision",
    "kanban_card_transitions", "kanban_board",
  ]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* absent */ }
  }
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["ABTARS_HOME"];
  else process.env["ABTARS_HOME"] = savedHome;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function agentEvent(runId = "run-1"): ScheduledFailureEvent {
  return {
    source: "scheduled", entryId: "daily-ai", runId, taskKind: "agent",
    diagnostic: makeTaskFailure("execution", "model_error", "executing", "boom", "none"),
    occurredAt: Date.now(),
  };
}

function makeCoordinator(mode: "investigation" | "full" = "full"): ShaIncidentCoordinator {
  return new ShaIncidentCoordinator({
    db,
    workspaceManager: fakeWorkspace(),
    modeProvider: () => mode,
    policyView: () => ({ fixes: [], logAdmissionAllowed: true }),
    noticeSink: { send: vi.fn() },
  });
}

function completeStageEnvelope(attemptId: string, artifactId: string, digest = "d1"): WorkerResultEnvelopeV1 {
  const now = new Date().toISOString();
  const attempt = supervision.getAttempt(attemptId)!;
  const contract = supervision.getContract(attempt.contract_id)!;
  const contractJson = JSON.parse(contract.contract_json) as { digest?: string; id?: string };
  return {
    schema_version: 1,
    attempt: {
      id: attemptId, ordinal: attempt.ordinal, contract_id: attempt.contract_id,
      contract_digest: contractJson.digest ?? "digest", executor_kind: "pi", executor_id: "run-x",
      started_at: now, finished_at: now,
    },
    outcome: "completed",
    criteria: [{ criterion_id: "sha-rca", status: "passed", evidence_ids: [artifactId] }],
    checks: [],
    artifacts: [{ artifact_id: artifactId, exists: true, kind: "file", ref: `sha/${artifactId.replace("sha-", "")}`, digest }],
    worker_report: { summary: "done", claims: [], unresolved_risks: [] },
  };
}

function markStageDone(cardId: number, envelope: WorkerResultEnvelopeV1): void {
  supervision.insertResult(envelope.attempt.id, envelope);
  kanbanTransition({ cardId, from: ["queued", "running"], to: "done", actor: "test", reason: "stage complete" });
}

describe("full-mode stage progression (R5)", () => {
  it("RCA done → design bound; design done → solution bound; solution done → review; root done → accepted", async () => {
    const coordinator = makeCoordinator("full");
    const disposer = coordinator.subscribe();
    try {
      const outcome = coordinator.admit(agentEvent());
      expect(outcome.kind).toBe("project_created");
      if (outcome.kind !== "project_created") return;
      const store = new ShaIncidentStore(db);
      const incident = store.findById(outcome.incidentId)!;
      expect(incident.state).toBe("rca");
      const root = kanbanGetCard(incident.rootCardId!)!;
      const children = db.prepare("SELECT * FROM kanban_board WHERE parent_id = ? ORDER BY id").all(incident.rootCardId) as Array<Record<string, unknown>>;
      const [rca, design, solution] = children;
      const rcaAttempt = supervision.getLatestAttempt(rca?.["id"] as number)!;

      // RCA completes.
      markStageDone(rca?.["id"] as number, completeStageEnvelope(rcaAttempt.id, "sha-rca-json"));
      await vi.waitFor(() => {
        const i = store.findById(outcome.incidentId)!;
        expect(i.state).toBe("design");
        expect(i.currentStageCardId).toBe(design?.["id"]);
        expect(supervision.getContractByCardId(design?.["id"] as number)).toBeDefined();
        expect(supervision.getContractByCardId(solution?.["id"] as number)).toBeUndefined();
      });

      // Design completes.
      const designAttempt = supervision.getLatestAttempt(design?.["id"] as number)!;
      markStageDone(design?.["id"] as number, completeStageEnvelope(designAttempt.id, "sha-design-md", "d2"));
      await vi.waitFor(() => {
        const i = store.findById(outcome.incidentId)!;
        expect(i.state).toBe("solution");
        expect(supervision.getContractByCardId(solution?.["id"] as number)).toBeDefined();
      });

      // Solution completes → review.
      const solutionAttempt = supervision.getLatestAttempt(solution?.["id"] as number)!;
      markStageDone(solution?.["id"] as number, completeStageEnvelope(solutionAttempt.id, "sha-solution-patch", "d3"));
      await vi.waitFor(() => {
        const i = store.findById(outcome.incidentId)!;
        expect(i.state).toBe("review");
      });

      // Root done → accepted (full mode).
      kanbanTransition({ cardId: root.id, from: ["queued", "running"], to: "done", actor: "test", reason: "review accepted" });
      await vi.waitFor(() => {
        const i = store.findById(outcome.incidentId)!;
        expect(i.state).toBe("accepted");
        expect(i.terminalReason).toContain("root accepted");
      });
    } finally {
      disposer();
    }
  });

  it("duplicate card:done for the same stage binds at most once", async () => {
    const coordinator = makeCoordinator("full");
    const disposer = coordinator.subscribe();
    try {
      const outcome = coordinator.admit(agentEvent());
      if (outcome.kind !== "project_created") return;
      const store = new ShaIncidentStore(db);
      const incident = store.findById(outcome.incidentId)!;
      const children = db.prepare("SELECT * FROM kanban_board WHERE parent_id = ? ORDER BY id").all(incident.rootCardId) as Array<Record<string, unknown>>;
      const rcaAttempt = supervision.getLatestAttempt(children[0]?.["id"] as number)!;
      const envelope = completeStageEnvelope(rcaAttempt.id, "sha-rca-json");
      markStageDone(children[0]?.["id"] as number, envelope);
      nerve.fire("card:done", children[0]?.["id"] as number); // duplicate reordered event
      await vi.waitFor(() => {
        const i = store.findById(outcome.incidentId)!;
        expect(i.state).toBe("design");
      });
      const designContracts = db.prepare("SELECT COUNT(*) AS n FROM worker_contracts WHERE card_id = ?").get(children[1]?.["id"]) as { n: number };
      expect(Number(designContracts.n)).toBe(1);
    } finally {
      disposer();
    }
  });
});

describe("investigation-mode progression", () => {
  it("design done → review; root done → investigation_complete", async () => {
    const coordinator = makeCoordinator("investigation");
    const disposer = coordinator.subscribe();
    try {
      const outcome = coordinator.admit(agentEvent());
      expect(outcome.kind).toBe("project_created");
      if (outcome.kind !== "project_created") return;
      const store = new ShaIncidentStore(db);
      const incident = store.findById(outcome.incidentId)!;
      const children = db.prepare("SELECT * FROM kanban_board WHERE parent_id = ? ORDER BY id").all(incident.rootCardId) as Array<Record<string, unknown>>;
      expect(children).toHaveLength(2);
      const rcaAttempt = supervision.getLatestAttempt(children[0]?.["id"] as number)!;
      markStageDone(children[0]?.["id"] as number, completeStageEnvelope(rcaAttempt.id, "sha-rca-json"));
      await vi.waitFor(() => expect(store.findById(outcome.incidentId)!.state).toBe("design"));
      const designAttempt = supervision.getLatestAttempt(children[1]?.["id"] as number)!;
      markStageDone(children[1]?.["id"] as number, completeStageEnvelope(designAttempt.id, "sha-design-md"));
      await vi.waitFor(() => expect(store.findById(outcome.incidentId)!.state).toBe("review"));
      kanbanTransition({ cardId: incident.rootCardId!, from: ["queued", "running"], to: "done", actor: "test", reason: "review" });
      await vi.waitFor(() => expect(store.findById(outcome.incidentId)!.state).toBe("investigation_complete"));
    } finally {
      disposer();
    }
  });
});

describe("failure cascade (R5)", () => {
  it("stage failure blocks the project, cascades placeholders, and terminalizes the incident", async () => {
    const coordinator = makeCoordinator("full");
    const disposer = coordinator.subscribe();
    try {
      const outcome = coordinator.admit(agentEvent());
      if (outcome.kind !== "project_created") return;
      const store = new ShaIncidentStore(db);
      const incident = store.findById(outcome.incidentId)!;
      const children = db.prepare("SELECT * FROM kanban_board WHERE parent_id = ? ORDER BY id").all(incident.rootCardId) as Array<Record<string, unknown>>;
      kanbanTransition({ cardId: children[0]?.["id"] as number, from: ["queued", "running"], to: "failed", actor: "test", reason: "worker crashed" });
      await vi.waitFor(() => {
        const i = store.findById(outcome.incidentId)!;
        expect(i.state).toBe("blocked");
        expect(i.terminalReason).toContain("failed");
      });
      const supervisionRow = db.prepare("SELECT state FROM project_supervision WHERE project_card_id = ?").get(incident.rootCardId!) as { state: string };
      expect(supervisionRow.state).toBe("blocked");
      const root = kanbanGetCard(incident.rootCardId!)!;
      expect(["failed", "blocked"]).toContain(root.status);
      const designCard = kanbanGetCard(children[1]?.["id"] as number)!;
      expect(designCard.status).toBe("failed");
      const solutionCard = kanbanGetCard(children[2]?.["id"] as number)!;
      expect(solutionCard.status).toBe("failed");
    } finally {
      disposer();
    }
  });

  it("missing envelope on a done stage blocks without binding", async () => {
    const coordinator = makeCoordinator("full");
    const disposer = coordinator.subscribe();
    try {
      const outcome = coordinator.admit(agentEvent());
      if (outcome.kind !== "project_created") return;
      const store = new ShaIncidentStore(db);
      const incident = store.findById(outcome.incidentId)!;
      const children = db.prepare("SELECT * FROM kanban_board WHERE parent_id = ? ORDER BY id").all(incident.rootCardId) as Array<Record<string, unknown>>;
      kanbanTransition({ cardId: children[0]?.["id"] as number, from: ["queued", "running"], to: "done", actor: "test", reason: "done but no envelope" });
      await vi.waitFor(() => expect(store.findById(outcome.incidentId)!.state).toBe("blocked"));
      expect(supervision.getContractByCardId(children[1]?.["id"] as number)).toBeUndefined();
    } finally {
      disposer();
    }
  });
});

describe("boot recovery (R5)", () => {
  it("provisioning with a complete card set and missing RCA contract rebinds RCA", async () => {
    const coordinator = makeCoordinator("full");
    const outcome = coordinator.admit(agentEvent());
    if (outcome.kind !== "project_created") return;
    const store = new ShaIncidentStore(db);
    // Simulate a crash between provisioning and activation: delete RCA contract+attempt.
    const incident = store.findById(outcome.incidentId)!;
    const children = db.prepare("SELECT * FROM kanban_board WHERE parent_id = ? ORDER BY id").all(incident.rootCardId) as Array<Record<string, unknown>>;
    db.prepare("DELETE FROM worker_attempts WHERE card_id = ?").run(children[0]?.["id"]);
    db.prepare("DELETE FROM worker_contracts WHERE card_id = ?").run(children[0]?.["id"]);
    db.prepare("UPDATE sha_incidents SET state = 'provisioning', version = 1 WHERE id = ?").run(incident.id);
    coordinator.runBootRecovery();
    await vi.waitFor(() => {
      const i = store.findById(outcome.incidentId)!;
      expect(i.state).toBe("rca");
      expect(supervision.getContractByCardId(children[0]?.["id"] as number)).toBeDefined();
    });
  });

  it("terminal root terminalizes a stuck incident", async () => {
    const coordinator = makeCoordinator("full");
    const outcome = coordinator.admit(agentEvent());
    if (outcome.kind !== "project_created") return;
    const store = new ShaIncidentStore(db);
    const incident = store.findById(outcome.incidentId)!;
    // Force review state with a done root (crash before the root handler ran).
    db.prepare("UPDATE sha_incidents SET state = 'review', version = version + 1 WHERE id = ?").run(incident.id);
    kanbanTransition({ cardId: incident.rootCardId!, from: ["queued", "running"], to: "done", actor: "test", reason: "accepted" });
    coordinator.runBootRecovery();
    const i = store.findById(outcome.incidentId)!;
    expect(i.state).toBe("accepted");
  });
});