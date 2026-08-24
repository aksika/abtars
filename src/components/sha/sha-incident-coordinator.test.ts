import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShaIncidentCoordinator } from "./sha-incident-coordinator.js";
import { ShaIncidentStore } from "./sha-incident-store.js";
import type { ShaAdmissionOutcome, ScheduledFailureEvent } from "./sha-types.js";
import { makeTaskFailure } from "../tasks/task-failure.js";
import { nerve } from "../nerve.js";
import { requireTaskDatabase } from "../tasks/kanban-board.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

let TEST_HOME: string;
let db: TaskDatabase;
const savedHome = process.env["ABTARS_HOME"];

async function setup(): Promise<void> {
  TEST_HOME = join(tmpdir(), `sha-coord-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env["ABTARS_HOME"] = TEST_HOME;
  mkdirSync(join(TEST_HOME, "config"), { recursive: true });
  mkdirSync(join(TEST_HOME, "kanban"), { recursive: true });
  writeFileSync(
    join(TEST_HOME, "config", "pi-executor.json"),
    JSON.stringify({
      enabled: true,
      command: "pi",
      fixedArgs: [],
      allowedEnv: [],
      maxConcurrent: 1,
      maxWallClockMs: 1800000,
      abortGraceMs: 10000,
      projectTrust: "never",
      workspaceAliases: { sha: { path: join(TEST_HOME, "sha-ws"), root: TEST_HOME, projectTrust: "never" } },
      sessionStorageRoot: join(TEST_HOME, "state"),
    }),
  );
  mkdirSync(join(TEST_HOME, "sha-ws"), { recursive: true });
  mkdirSync(join(TEST_HOME, "sha-ws", ".git"), { recursive: true });
  db = requireTaskDatabase();
}

beforeEach(async () => {
  await setup();
  // The kanban singleton connection persists across tests — reset durable
  // rows so each test observes a fresh board (schema stays).
  for (const table of [
    "sha_incident_transitions", "sha_incident_events", "sha_incidents", "sha_fault_state",
    "worker_attempts", "worker_contracts", "project_contracts", "project_supervision",
    "kanban_card_transitions", "kanban_board",
  ]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* table absent on fresh DB */ }
  }
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["ABTARS_HOME"];
  else process.env["ABTARS_HOME"] = savedHome;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function agentEvent(runId = "run-1", overrides: Partial<ScheduledFailureEvent> = {}): ScheduledFailureEvent {
  return {
    source: "scheduled",
    entryId: "daily-ai",
    runId,
    taskKind: "agent",
    diagnostic: makeTaskFailure("execution", "model_error", "executing", "boom", "none"),
    occurredAt: Date.now(),
    ...overrides,
  };
}

function makeCoordinator(overrides: {
  mode?: "off" | "investigation" | "full";
  modeProvider?: () => "off" | "investigation" | "full";
  aliasAvailability?: () => string | null;
  policyFixes?: import("./sha-policy.js").FixRule[];
  store?: ShaIncidentStore;
} = {}): ShaIncidentCoordinator {
  return new ShaIncidentCoordinator({
    db,
    store: overrides.store,
    modeProvider: overrides.modeProvider ?? (() => overrides.mode ?? "full"),
    aliasAvailability: overrides.aliasAvailability,
    policyView: () => ({ fixes: overrides.policyFixes ?? [], logAdmissionAllowed: true }),
    noticeSink: { send: vi.fn() },
  });
}

describe("guarded outcomes perform zero store writes", () => {
  function throwingStore(): ShaIncidentStore {
    const proxy = new Proxy({} as ShaIncidentStore, {
      get() { throw new Error("store must not be touched for guarded outcomes"); },
    });
    return proxy;
  }

  it("system/credits/external/ambiguous/off/suppressed never touch the store", () => {
    const coordinator = makeCoordinator({ store: throwingStore(), mode: "full" });
    expect(coordinator.admit(agentEvent("s1", { taskKind: "system" })).kind).toBe("ignored");
    expect(coordinator.admit(agentEvent("s2", { diagnostic: makeTaskFailure("execution", "credits_exhausted", "executing", "no credits", "none") })).kind).toBe("ignored");
    expect(coordinator.admit(agentEvent("s3", { diagnostic: makeTaskFailure("routing", "target_unavailable", "routing", "gone", "permanent") })).kind).toBe("ignored");
    expect(coordinator.admit(agentEvent("s4", { diagnostic: makeTaskFailure("execution", "model_error", "executing", "", "none") })).kind).toBe("ignored");
    expect(makeCoordinator({ store: throwingStore(), mode: "off" }).admit(agentEvent("s5")).kind).toBe("ignored");
  });

  it("off mode suppresses with reason off", () => {
    const outcome = makeCoordinator({ store: throwingStore(), mode: "off" }).admit(agentEvent());
    expect(outcome).toMatchObject({ kind: "ignored", reason: "off" });
  });
});

describe("unknown actionable project admission (R5)", () => {
  it("turns an over-bound scheduled diagnostic into a no-write outcome", () => {
    const base = makeTaskFailure("execution", "model_error", "executing", "boom", "none");
    const oversized = agentEvent("oversized", {
      diagnostic: {
        ...base,
        context: {
          lanes: Array.from({ length: 8 }, (_, i) => ({
            cardId: i + 1,
            contractId: "c".repeat(1_000),
            attemptId: "a".repeat(1_000),
            lifecycle: "executing",
            criteria: [],
            missingEvidence: [],
          })),
        },
      },
    });
    const outcome = makeCoordinator().admit(oversized);
    expect(outcome).toMatchObject({ kind: "ignored", reason: "suppressed" });
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM sha_incidents").get()?.["n"])).toBe(0);
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM kanban_board").get()?.["n"])).toBe(0);
  });

  it("full mode creates one root, complete blocked placeholder chain, contract, and binds RCA", () => {
    const nerveFire = vi.spyOn(nerve, "fire");
    const outcome = makeCoordinator().admit(agentEvent());
    expect(outcome.kind).toBe("project_created");
    if (outcome.kind !== "project_created") return;
    expect(outcome.mode).toBe("full");

    const cards = db.prepare("SELECT * FROM kanban_board ORDER BY id").all();
    expect(cards).toHaveLength(4);
    const root = cards[0]!;
    expect(root["type"]).toBe("O");
    expect(root["source"]).toBe("sha");
    expect(root["source_id"]).toBeTruthy();
    expect(root["max_agents"]).toBe(2);
    expect(root["delivery_mode"]).toBe("silent");
    const [rca, design, solution] = cards.slice(1);
    expect(rca?.["type"]).toBe("W");
    expect(rca?.["parent_id"]).toBe(root["id"]);
    expect(design?.["blocked_by"]).toBe(String(rca?.["id"]));
    expect(solution?.["blocked_by"]).toBe(String(design?.["id"]));

    // Root contract v2 authored, supervision executing, incident in rca state.
    const contractRow = db.prepare("SELECT contract_json FROM project_contracts WHERE project_card_id = ?").get(root["id"]) as { contract_json: string };
    const contract = JSON.parse(contractRow.contract_json);
    expect(contract.schema_version).toBe(2);
    expect(contract.criteria.map((c: { id: string }) => c.id)).toEqual(["sha-rca", "sha-design", "sha-solution", "sha-final-review"]);
    expect(contract.limits.max_review_rounds).toBe(1);
    expect(contract.limits.max_repair_rounds).toBe(0);

    const supervision = db.prepare("SELECT * FROM project_supervision WHERE project_card_id = ?").get(root["id"]) as Record<string, unknown>;
    expect(supervision["state"]).toBe("executing");

    // RCA card has a bound contract and attempt; other placeholders have none.
    const rcaContract = db.prepare("SELECT 1 AS present FROM worker_contracts WHERE card_id = ?").get(rca?.["id"]) as { present: number } | undefined;
    expect(rcaContract).toBeDefined();
    const designContract = db.prepare("SELECT 1 AS present FROM worker_contracts WHERE card_id = ?").get(design?.["id"]);
    expect(designContract).toBeUndefined();
    const attempt = db.prepare("SELECT status FROM worker_attempts WHERE card_id = ?").get(rca?.["id"]) as { status: string };
    expect(attempt.status).toBe("pending");

    const incident = new ShaIncidentStore(db).findById(outcome.incidentId);
    expect(incident?.state).toBe("rca");
    expect(incident?.rootCardId).toBe(root["id"]);
    expect(incident?.currentStageCardId).toBe(rca?.["id"]);
    expect(incident?.occurrenceCount).toBe(1);

    // Exactly two queued events fired (root + rca), after commit.
    const queued = nerveFire.mock.calls.filter((c) => c[0] === "card:queued");
    expect(queued.map((c) => c[1]).sort()).toEqual([root["id"], rca?.["id"]].sort());
  });

  it("investigation mode omits the solution placeholder", () => {
    const outcome = makeCoordinator({ mode: "investigation" }).admit(agentEvent());
    expect(outcome.kind).toBe("project_created");
    const cards = db.prepare("SELECT type FROM kanban_board ORDER BY id").all();
    expect(cards).toHaveLength(3);
    expect(cards.every((c) => c["type"] !== undefined)).toBe(true);
  });

  it("duplicate event key is a no-op; a different event attaches", () => {
    const coordinator = makeCoordinator();
    const first = coordinator.admit(agentEvent("run-1"));
    expect(first.kind).toBe("project_created");
    if (first.kind !== "project_created") return;
    expect(coordinator.admit(agentEvent("run-1")).kind).toBe("duplicate_event");
    const attached = coordinator.admit(agentEvent("run-2"));
    expect(attached.kind).toBe("attached");
    if (attached.kind !== "attached") return;
    expect(attached.incidentId).toBe(first.incidentId);
    expect(attached.occurrenceCount).toBe(2);
    const incident = new ShaIncidentStore(db).findById(first.incidentId);
    expect(incident?.occurrenceCount).toBe(2);
  });

  it("concurrent same-fingerprint admission creates exactly one project", () => {
    const coordinator = makeCoordinator();
    const first = coordinator.admit(agentEvent("c1"));
    const second = coordinator.admit(agentEvent("c2"));
    expect(first.kind).toBe("project_created");
    expect(second.kind).toBe("attached");
    if (first.kind !== "project_created") return;
    const roots = db.prepare("SELECT COUNT(*) AS n FROM kanban_board WHERE type = 'O' AND source = 'sha'").get();
    expect(Number(roots?.["n"])).toBe(1);
  });

  it("blocks visibly when Pi/alias configuration is invalid", () => {
    const outcome = makeCoordinator({ aliasAvailability: () => "Pi executor is disabled — SHA stages require the configured Pi alias" }).admit(agentEvent());
    expect(outcome).toMatchObject({ kind: "blocked" });
    const events = db.prepare("SELECT COUNT(*) AS n FROM sha_incident_events").get();
    expect(Number(events?.["n"])).toBe(0);
  });
});

describe("known-fix admission (R8)", () => {
  const verifiedRule = {
    pattern: "rebuild me", action: "run" as const,
    command: ["abtars-edit", "--x"], verifyCommand: ["git", "status"],
    cooldownMin: 5, verified: true,
  };

  it("investigation mode reports recommendation only — no execution, no store rows", () => {
    const outcome = makeCoordinator({ mode: "investigation", policyFixes: [verifiedRule] })
      .admit(agentEvent("k1", { diagnostic: makeTaskFailure("execution", "model_error", "executing", "please rebuild me now", "none") }));
    expect(outcome.kind).toBe("known_fix_recommended");
    const events = db.prepare("SELECT COUNT(*) AS n FROM sha_incident_events").get();
    expect(Number(events?.["n"])).toBe(0);
  });

  it("uses the mode captured at classification for known-fix admission", () => {
    let calls = 0;
    const outcome = makeCoordinator({
      policyFixes: [verifiedRule],
      modeProvider: () => {
        calls += 1;
        return calls === 1 ? "investigation" : "full";
      },
    }).admit(agentEvent("k-captured", { diagnostic: makeTaskFailure("execution", "model_error", "executing", "please rebuild me now", "none") }));
    expect(outcome.kind).toBe("known_fix_recommended");
    expect(calls).toBe(1);
  });

  it("full mode admits a durable known_fix episode and starts bounded execution", async () => {
    const outcome = makeCoordinator({ policyFixes: [verifiedRule] })
      .admit(agentEvent("k2", { diagnostic: makeTaskFailure("execution", "model_error", "executing", "please rebuild me now", "none") }));
    expect(outcome.kind).toBe("known_fix_started");
    if (outcome.kind !== "known_fix_started") return;
    const incident = new ShaIncidentStore(db).findById(outcome.incidentId);
    expect(incident?.workflowKind).toBe("known_fix");
    expect(incident?.state).toBe("known_fix_running");
    await new Promise((r) => setTimeout(r, 10));
    const after = new ShaIncidentStore(db).findById(outcome.incidentId);
    expect(["known_fix_verified", "known_fix_unverified", "known_fix_failed"]).toContain(after?.state);
  });

  it("rules without a verifier are recommendation-only in full", () => {
    const outcome = makeCoordinator({ policyFixes: [{ ...verifiedRule, verifyCommand: undefined }] })
      .admit(agentEvent("k3", { diagnostic: makeTaskFailure("execution", "model_error", "executing", "please rebuild me now", "none") }));
    expect(outcome.kind).toBe("known_fix_recommended");
  });
});
